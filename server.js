// ============================================================
//  SINUCA ONLINE - SERVIDOR COMPLETO (DINHEIRO REAL + ESCROW)
//  Este arquivo já contém: Servidor, Pagamentos PIX e Lógica de Apostas
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// ============================================================
//  CONFIGURAÇÕES
// ============================================================
// O token vem da variável de ambiente MP_ACCESS_TOKEN (Render > Environment). Nunca escreva o token aqui.
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
if (!MP_ACCESS_TOKEN) console.warn('AVISO: MP_ACCESS_TOKEN não definido. Depósitos PIX não vão funcionar.');
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

// ============================================================
//  BANCO DE DADOS E SESSÕES
// ============================================================
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_MS = 30 * 24 * 3600 * 1000;
let DB = { users: {}, sessions: {}, ledger: [], escrows: {}, system: { saldo: 0 } };

try { 
  const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
  DB.users = d.users || {}; DB.sessions = d.sessions || {}; DB.ledger = d.ledger || []; DB.escrows = d.escrows || {}; DB.system = d.system || { saldo: 0 }; 
} catch (e) {}

const REMOTE_URL = process.env.UPSTASH_REDIS_REST_URL, REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN, REMOTE_KEY = 'sinuca:db';
const remote = cmd => fetch(REMOTE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }).then(r => r.json());
let remoteTimer = null;
const pushRemote = () => {
  if (!REMOTE_URL || !REMOTE_TOKEN || remoteTimer) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    remote(['SET', REMOTE_KEY, JSON.stringify(DB)]).then(r => { if (r.error) console.error('Erro Upstash:', r.error); }).catch(e => console.error('Erro Upstash:', e.message));
  }, 1000);
};
const saveDB = () => {
  pushRemote();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Erro ao salvar contas:', e.message); }
};

// ============================================================
//  LÓGICA DE CRÉDITOS E ESCROW (SISTEMA DE APOSTAS)
// ============================================================
const STAKE = { '0': 0, '0.25': 25, '1': 100, '2': 200, '5': 500, '10': 1000, '25': 2500, '50': 5000 };
const FEE_PCT = 7; 
const feeOf = stake => Math.round(stake * FEE_PCT / 100);
const stakeOf = room => STAKE[room] || 0;
const costOf = room => { const s = stakeOf(room); return s + feeOf(s); };
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const SYSTEM_ID = '__sistema__';

const saldoOf = u => (u && Number.isInteger(u.saldo) ? u.saldo : 0);
const cents = v => { const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : NaN; };

function ledgerAdd(email, type, c, extra) {
  DB.ledger.push(Object.assign({ id: crypto.randomBytes(8).toString('hex'), email, type, cents: c, ts: Date.now() }, extra));
  if (DB.ledger.length > 20000) DB.ledger.splice(0, DB.ledger.length - 20000);
}

function addSaldo(email, c, type, extra) {
  const u = DB.users[email]; if (!u) return;
  u.saldo = saldoOf(u) + c; ledgerAdd(email, type, c, extra); saveDB(); pushSaldo(email);
}

function moveCredits(email, c, type, extra) {
  const u = DB.users[email]; if (!u) return;
  u.saldo = saldoOf(u) + c;
  ledgerAdd(email, type, c, extra);
}

function moveFee(c, type, extra) {
  if (ADMIN_EMAIL && DB.users[ADMIN_EMAIL]) { moveCredits(ADMIN_EMAIL, c, type, extra); return ADMIN_EMAIL; }
  DB.system.saldo = (DB.system.saldo || 0) + c;
  ledgerAdd(SYSTEM_ID, type, c, extra);
  return null;
}

function escrowOpen(g) {
  const s = g.stake || 0;
  if (!s || g.solo || g.bot) return true;
  const fee = feeOf(s), cost = s + fee;
  const emails = g.sockets.map(w => w.email);
  if (emails.some(e => !e || !DB.users[e])) return false;
  if (emails.some(e => saldoOf(DB.users[e]) < cost)) return false;
  g.escrowId = crypto.randomBytes(8).toString('hex');
  g.settled = false;
  DB.escrows[g.escrowId] = { stake: s, fee, emails, ts: Date.now() };
  for (const e of emails) {
    moveCredits(e, -s, 'desafio-entrada', { game: g.escrowId });
    if (fee) moveCredits(e, -fee, 'desafio-taxa', { game: g.escrowId });
  }
  const adm = fee ? moveFee(fee * emails.length, 'taxa-recebida', { game: g.escrowId }) : null;
  saveDB();
  emails.forEach(pushSaldo);
  if (adm) pushSaldo(adm);
  return true;
}

function settle(g, winSeat) {
  if (!g.escrowId || g.settled) return;
  g.settled = true;
  const e = DB.escrows[g.escrowId]; if (!e) return;
  if (winSeat === 0 || winSeat === 1) {
    moveCredits(e.emails[winSeat], e.stake * 2, 'desafio-premio', { game: g.escrowId });
    delete DB.escrows[g.escrowId];
  } else {
    for (const em of e.emails) {
      moveCredits(em, e.stake, 'desafio-reembolso', { game: g.escrowId });
      if (e.fee) moveCredits(em, e.fee, 'taxa-estornada', { game: g.escrowId });
    }
    moveFee(-e.fee * e.emails.length, 'taxa-estornada', { game: g.escrowId });
    delete DB.escrows[g.escrowId];
  }
  saveDB();
  e.emails.forEach(pushSaldo);
}

function pushSaldo(email) {
  const u = DB.users[email]; if (!u || typeof wss === 'undefined') return;
  const o = JSON.stringify({ t: 'saldo', v: saldoOf(u) / 100 });
  for (const c of wss.clients) if (c.readyState === 1 && c.email === email) c.send(o);
}

// ============================================================
//  INTEGRAÇÃO MERCADO PAGO (PIX REAL)
// ============================================================
async function createPixPayment(email, valorCentavos) {
  const url = 'https://api.mercadopago.com/v1/payments';
  const body = {
    transaction_amount: valorCentavos / 100,
    description: `Depósito Sinuca - ${email}`,
    payment_method_id: 'pix',
    payer: { email: email },
    notification_url: `${(process.env.RENDER_EXTERNAL_URL || 'https://sinuca-online.onrender.com').replace(/\/$/, '')}/api/mp-webhook`
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ============================================================
//  API E ROTAS
// ============================================================
const readBody = req => new Promise((ok, no) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > 16384) { no(Object.assign(new Error('Pedido grande demais.'), { status: 413 })); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch (e) { no(Object.assign(new Error('Pedido inválido.'), { status: 400 })); } });
});

async function handleApi(req, res, p) {
  const reply = (code, o, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra)); res.end(JSON.stringify(o)); };
  const fail = (code, msg) => { throw Object.assign(new Error(msg), { status: code }); };
  
  const sessionEmail = req => { 
    const cookie = String(req.headers.cookie || '').match(/sid=([^;]+)/);
    const t = cookie ? cookie[1] : null;
    const s = t && DB.sessions[crypto.createHash('sha256').update(t).digest('hex')];
    return s && s.exp > Date.now() && DB.users[s.email] ? s.email : null;
  };

  try {
    if (p === '/api/me' && req.method === 'GET') { 
      const e = sessionEmail(req); if (!e) fail(401, 'Não autenticado.'); 
      return reply(200, { email: e, saldo: saldoOf(DB.users[e]) / 100 }); 
    }

    if (req.method !== 'POST') fail(405, 'Método não permitido.');
    const b = await readBody(req);

    if (p === '/api/deposito') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sessão expirou.');
      const c = cents(b.valor);
      if (!(c >= 100 && c <= 100000)) fail(400, 'Valor entre R$ 1,00 e R$ 1.000,00.');

      const payment = await createPixPayment(email, c);
      if (payment.error) fail(500, 'Erro no Mercado Pago: ' + payment.message);

      return reply(200, { 
        id: payment.id, 
        codigo: payment.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64 
      });
    }

    if (p === '/api/mp-webhook') {
      const { action, data } = b;
      if (action === 'payment.created' || action === 'payment.updated') {
        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
          headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
        });
        const pData = await mpRes.json();
        const jaCreditado = DB.ledger.some(l => l.type === 'deposito-pix' && String(l.mp_id) === String(data.id));
        if (pData.status === 'approved' && !jaCreditado) {
          addSaldo(pData.payer.email, Math.round(pData.transaction_amount * 100), 'deposito-pix', { mp_id: data.id });
        }
      }
      return reply(200, { status: 'ok' });
    }
    
    // Outras rotas (login, register, etc) devem ser mantidas aqui...
    
  } catch (e) {
    res.writeHead(e.status || 500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============================================================
//  INICIALIZAÇÃO
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p.startsWith('/api')) return handleApi(req, res, p);
  
  const ext = path.extname(p);
  const file = path.join(PUB, p === '/' ? 'index.html' : p);
  if (fs.existsSync(file) && fs.lstatSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
