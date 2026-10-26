// ============================================================
//  SINUCA ONLINE - servidor (VERSÃO DINHEIRO REAL)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// ============================================================
//  CONFIGURAÇÕES DE PAGAMENTO - COLE SEU TOKEN AQUI
// ============================================================
const MP_ACCESS_TOKEN = 'COLE_AQUI_SEU_ACCESS_TOKEN_APP_USR'; 
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

// --- Banco de Dados e Sessões ---
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

// --- Auxiliares de Saldo ---
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
    notification_url: `https://${process.env.RENDER_EXTERNAL_URL || 'seu-dominio.com'}/api/mp-webhook`
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify(body)
  });

  return res.json();
}

// ============================================================
//  LÓGICA DE API
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
    const s = t && DB.sessions[crypto.createHash('sha256').update(t).toString('hex'));
    return s && s.exp > Date.now() && DB.users[s.email] ? s.email : null;
  };

  try {
    if (p === '/api/me' && req.method === 'GET') { 
      const e = sessionEmail(req); 
      if (!e) fail(401, 'Não autenticado.'); 
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
        const paymentId = data.id;
        const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
        });
        const pData = await res.json();
        if (pData.status === 'approved') {
          const email = pData.payer.email;
          const valor = Math.round(pData.transaction_amount * 100);
          addSaldo(email, valor, 'deposito-pix', { mp_id: paymentId });
        }
      }
      return reply(200, { status: 'ok' });
    }

    // ... demais rotas de login/perfil mantidas conforme original ...
    
  } catch (e) {
    res.writeHead(e.status || 500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============================================================
//  INICIALIZAÇÃO DO SERVIDOR
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
