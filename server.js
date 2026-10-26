// ============================================================
//  SINUCA ONLINE - servidor
//  Faz 3 coisas: entrega o site, junta jogadores em partidas
//  e calcula a fisica das bolas (assim ninguem consegue trapacear).
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};


// ============================================================
//  CONTAS: cadastro, login e apelido
//  - senha guardada so como hash (scrypt + sal), nunca em texto
//  - sessao por cookie HttpOnly (o JavaScript do site nao consegue ler)
//  - as contas ficam no arquivo users.json (pasta DATA_DIR, ou a pasta do servidor)
// ============================================================
const crypto = require('crypto');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_MS = 30 * 24 * 3600 * 1000;
let DB = { users: {}, sessions: {}, ledger: [], holds: {}, deposits: {}, saques: {} };
const adopt = d => { DB.users = d.users || {}; DB.sessions = d.sessions || {}; DB.ledger = d.ledger || []; DB.holds = d.holds || {}; DB.deposits = d.deposits || {}; DB.saques = d.saques || {}; };
try { adopt(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
// ---- armazenamento externo (Upstash Redis, gratis): no Render gratis o disco e apagado a cada deploy/reinicio ----
const REMOTE_URL = process.env.UPSTASH_REDIS_REST_URL, REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN, REMOTE_KEY = 'sinuca:db';
const remote = cmd => fetch(REMOTE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }).then(r => r.json());
let remoteTimer = null;
const pushRemote = () => {
  if (!REMOTE_URL || !REMOTE_TOKEN || remoteTimer) return;
  remoteTimer = setTimeout(() => {          // junta varias gravacoes seguidas numa so
    remoteTimer = null;
    remote(['SET', REMOTE_KEY, JSON.stringify(DB)]).then(r => { if (r.error) console.error('Erro ao salvar contas (Upstash):', r.error); }).catch(e => console.error('Erro ao salvar contas (Upstash):', e.message));
  }, 1000);
};
const loadRemote = async () => {
  if (!REMOTE_URL || !REMOTE_TOKEN) { console.log('Aviso: UPSTASH_REDIS_REST_URL/TOKEN nao definidos - as contas ficam so no arquivo local (apagado no Render gratis).'); return; }
  try {
    const r = await remote(['GET', REMOTE_KEY]);
    if (r.error) throw new Error(r.error);   // erro NAO e "vazio": nunca comecar do zero por engano (sobrescreveria os saldos)
    if (r.result) { adopt(JSON.parse(r.result)); console.log('Contas carregadas do Upstash:', Object.keys(DB.users).length); }
    else console.log('Upstash vazio: comecando sem contas.');
  } catch (e) { console.error('Erro ao ler contas do Upstash:', e.message); throw e; }
};
// grava no Upstash AGORA e espera confirmar (usado nos movimentos de dinheiro: deposito creditado, saque, PIX criado)
const flushRemote = async () => {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  if (remoteTimer) { clearTimeout(remoteTimer); remoteTimer = null; }
  const r = await remote(['SET', REMOTE_KEY, JSON.stringify(DB)]);
  if (r.error) throw new Error(r.error);
};
const saveDB = () => {
  pushRemote();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DB_FILE);   // grava num arquivo temporario e troca: nunca fica pela metade
  } catch (e) { console.error('Erro ao salvar contas:', e.message); }
};
const pruneSessions = () => { const now = Date.now(); let ch = false; for (const k in DB.sessions) if (DB.sessions[k].exp < now) { delete DB.sessions[k]; ch = true; } if (ch) saveDB(); };
pruneSessions(); setInterval(pruneSessions, 3600 * 1000);

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
// ---- ACESSO: o servidor e PUBLICO (qualquer e-mail pode criar conta). Para voltar a ser privado, defina no Render SERVIDOR_PRIVADO=1
//      e liste os e-mails liberados em ALLOWED_EMAILS (separados por virgula). Sem SERVIDOR_PRIVADO=1, ALLOWED_EMAILS e ignorado. ----
// Sem a lista, ninguem entra (fica trancado de proposito). Quem nao esta na lista nao cria conta, nao loga e nem joga.
const ALLOWED = new Set(String(process.env.ALLOWED_EMAILS || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean));
const SERVER_PRIVATE = process.env.SERVIDOR_PRIVADO === '1';
const allowed = e => !SERVER_PRIVATE || ALLOWED.has(String(e || '').trim().toLowerCase());
const PRIVATE_MSG = 'Acesso restrito: este jogo é privado.';
if (!SERVER_PRIVATE) console.log('Servidor PUBLICO: qualquer e-mail pode criar conta.');
else if (!ALLOWED.size) console.log('ATENCAO: SERVIDOR_PRIVADO=1 mas ALLOWED_EMAILS vazio - ninguem consegue entrar.');
else console.log('Servidor privado. E-mails liberados:', ALLOWED.size);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NICK_RE = /^[\p{L}\p{N}._-]{3,16}$/u;
const AV_IDS = Array.from({ length: 19 }, (_, i) => 'a' + String(i + 1).padStart(2, '0'));   // imagens em public/avatars/a01.webp ... a19.webp (o site usa a mesma lista)
const avatarOf = u => (u && u.avatar && AV_IDS.includes(u.avatar.id) ? { id: u.avatar.id } : null);   // avatares antigos (emoji) deixam de valer
{ let ch = false; for (const k in DB.users) { const a = DB.users[k].avatar; if (a && !AV_IDS.includes(a.id)) { delete DB.users[k].avatar; ch = true; } } if (ch) saveDB(); }   // limpa os avatares antigos (emoji) das contas
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');   // para o login demorar igual com e-mail que nao existe

const cookieOf = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : null; };
const sessionEmail = req => { const t = cookieOf(req, 'sid'); const s = t && DB.sessions[sha(t)]; return s && s.exp > Date.now() && DB.users[s.email] && allowed(s.email) ? s.email : null; };
const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

// ticket de uso unico: o site troca o login (cookie) pela identidade na conexao do jogo (WebSocket)
const tickets = new Map();
const newTicket = email => { const t = crypto.randomBytes(24).toString('hex'); tickets.set(t, { email, exp: Date.now() + 60000 }); return t; };
const redeemTicket = t => { const k = tickets.get(t); tickets.delete(t); return k && k.exp > Date.now() && allowed(k.email) ? k.email : null; };
setInterval(() => { const now = Date.now(); for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k); }, 60000);

// trava por CONTA: 8 senhas erradas seguidas = 15 min sem poder tentar (protege contra ataque vindo de varios IPs)
const loginFails = new Map();
const lockedOut = email => { const f = loginFails.get(email); return !!f && f.n >= 8 && Date.now() - f.t < 15 * 60000; };
const noteLoginFail = email => { const f = loginFails.get(email); const now = Date.now(); loginFails.set(email, { n: f && now - f.t < 15 * 60000 ? f.n + 1 : 1, t: now }); };
setInterval(() => { const now = Date.now(); for (const [k, v] of loginFails) if (now - v.t > 15 * 60000) loginFails.delete(k); }, 600000);
// limite de tentativas por IP (evita adivinhar senha na forca bruta)
const hits = new Map();
const tooMany = req => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 10 * 60000); h.push(now); hits.set(ip, h);
  return h.length > 20;
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 10 * 60000)) hits.delete(k); }, 600000);


// ============================================================
//  CARTEIRA: perfil (nome/CPF/PIX), saldo, deposito e saque
//  - saldo em CENTAVOS (inteiro), guardado na conta; cada movimento vai para DB.ledger
//  - WALLET_TEST=1  -> deposito SIMULADO (credita sozinho depois de 5 s, sem dinheiro real). So para testar.
//  - sem WALLET_TEST e sem provedor de PIX ligado, o deposito responde "indisponivel" e nada e creditado.
//  - saque: so registra o pedido e tira o valor do saldo; o pagamento e feito/aprovado por voce (nada sai sozinho).
//  - PIX real: Mercado Pago (ver MP_* abaixo). O saldo so e creditado depois que a API do Mercado Pago confirma "approved".
//  - salas com valor: a aposta de cada jogador e RESERVADA (custodia) ao entrar na fila e paga ao vencedor no fim da partida.
// ============================================================
// ---- Mercado Pago (PIX de verdade) ----
//  MP_ACCESS_TOKEN   : Access Token de producao (Render > Environment). NUNCA escreva no codigo.
//  MP_WEBHOOK_SECRET : "Assinatura secreta" do webhook (painel do Mercado Pago > Suas integracoes > Webhooks)
//  PUBLIC_URL        : endereco do site, ex. https://seujogo.onrender.com (o Render ja informa RENDER_EXTERNAL_URL)
//  ADMIN_TOKEN       : chave sua para a pagina /admin (lista de saques a pagar). Use 20+ caracteres aleatorios.
//  RAKE_PCT          : taxa do dono do jogo, em % do total das duas apostas (padrao 7). Ex.: sala de R$ 10 -> pote R$ 20 -> taxa R$ 1,40 -> vencedor recebe R$ 18,60
const MP_TOKEN = String(process.env.MP_ACCESS_TOKEN || '').trim();
const MP_SECRET = String(process.env.MP_WEBHOOK_SECRET || '').trim();
const MP_API = process.env.MP_API_URL || 'https://api.mercadopago.com';
const PUBLIC_URL = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const RAKE_PCT = Math.min(30, Math.max(0, process.env.RAKE_PCT === undefined || process.env.RAKE_PCT === '' ? 7 : (+process.env.RAKE_PCT || 0)));   // padrao 7% do total das duas apostas
const PERSIST = !!(REMOTE_URL && REMOTE_TOKEN) || !!process.env.DATA_DIR;   // sem armazenamento que sobreviva a reinicios, dinheiro real NAO e ligado
const MP_ON = !!MP_TOKEN && PERSIST;
const WALLET_TEST = process.env.WALLET_TEST === '1' && !MP_TOKEN;   // o modo de teste (saldo falso) NUNCA liga quando existe MP_ACCESS_TOKEN
if (process.env.WALLET_TEST === '1' && MP_TOKEN) console.error('ATENCAO: WALLET_TEST ignorado porque MP_ACCESS_TOKEN esta definido. Remova WALLET_TEST do Render.');
if (MP_TOKEN && !PERSIST) console.error('ATENCAO: MP_ACCESS_TOKEN definido, mas sem Upstash (nem DATA_DIR): o deposito por PIX fica DESLIGADO para nao perder saldos num reinicio.');
if (MP_ON) console.log('Mercado Pago ligado (PIX real). Webhook:', PUBLIC_URL ? PUBLIC_URL + '/api/mp/webhook' : 'sem PUBLIC_URL (so conferencia a cada 60 s)', '| assinatura:', MP_SECRET ? 'ativa' : 'SEM MP_WEBHOOK_SECRET', '| taxa:', RAKE_PCT + '%');
if (ADMIN_TOKEN && ADMIN_TOKEN.length < 16) console.error('ATENCAO: ADMIN_TOKEN muito curto (use 20+ caracteres).');
const adminOk = req => {
  if (!ADMIN_TOKEN) return false;
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(t).digest(), crypto.createHash('sha256').update(ADMIN_TOKEN).digest());
};
const MIN_DEP = 100, MAX_DEP = 100000, MIN_SAQ = 100;    // centavos
const onlyDigits = v => String(v || '').replace(/\D/g, '');
const cpfValid = c => {
  c = onlyDigits(c); if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) { let t = 0; for (let i = 0; i < n; i++) t += +c[i] * (n + 1 - i); if ((t * 10 % 11) % 10 !== +c[n]) return false; }
  return true;
};
const telValid = t => { t = onlyDigits(t); return t.length === 11 && t[2] === '9' && +t.slice(0, 2) >= 11; };
const nameValid = n => { n = String(n || '').trim(); return n.length <= 80 && n.split(/\s+/).filter(x => x.length > 1).length >= 2; };
const cents = v => { const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : NaN; };
const saldoOf = u => (u && Number.isInteger(u.saldo) ? u.saldo : 0);
const perfilOf = u => (u && u.perfil ? { nome: u.perfil.nome, cpf: u.perfil.cpf, celular: u.perfil.celular || '', pix: u.perfil.pix === 'tel' ? 'tel' : 'cpf' } : null);
const perfilOk = u => !!(u && u.perfil && nameValid(u.perfil.nome) && cpfValid(u.perfil.cpf));
function ledgerAdd(email, type, c, extra) {
  DB.ledger.push(Object.assign({ id: crypto.randomBytes(8).toString('hex'), email, type, cents: c, ts: Date.now() }, extra));
  if (DB.ledger.length > 20000) DB.ledger.splice(0, DB.ledger.length - 20000);
}
// credita/debita e avisa o jogador na hora (todas as abas dele)
function addSaldo(email, c, type, extra) {
  const u = DB.users[email]; if (!u) return;
  u.saldo = saldoOf(u) + c; ledgerAdd(email, type, c, extra); saveDB(); pushSaldo(email);
}
function pushSaldo(email) {
  const u = DB.users[email]; if (!u || typeof wss === 'undefined') return;
  const o = JSON.stringify({ t: 'saldo', v: saldoOf(u) / 100 });
  for (const c of wss.clients) if (c.readyState === 1 && c.email === email) c.send(o);
}

// ---- cliente da API do Mercado Pago ----
let lastMpErr = null;   // ultimo erro do Mercado Pago (aparece so na pagina /admin)
async function mp(method, p, body, idem) {
  const r = await fetch(MP_API + p, {
    method, signal: AbortSignal.timeout(15000),
    headers: Object.assign({ Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' }, idem ? { 'X-Idempotency-Key': idem } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Mercado Pago ' + r.status + ': ' + (j.message || j.error || '')), { mpStatus: r.status, mp: j });
  return j;
}
// Confere o pagamento DIRETO na API do Mercado Pago (nunca confia no que chegou pelo webhook) e credita UMA vez so.
async function creditDeposit(id) {
  id = String(id);
  const d = DB.deposits[id]; if (!d) return 'desconhecido';
  if (d.status === 'cancelado' || d.status === 'expirado') return d.status;
  let pay;
  try { pay = await mp('GET', '/v1/payments/' + id); } catch (e) { if (e.mpStatus === 404) return 'desconhecido'; throw e; }
  if (String(pay.external_reference) !== d.ref || Math.round(Number(pay.transaction_amount) * 100) !== d.cents || pay.payment_method_id !== 'pix') {
    console.error('ATENCAO: pagamento ' + id + ' nao confere com o deposito registrado (referencia/valor). Nada foi creditado.');
    return 'divergente';
  }
  if (pay.status === 'approved' && d.status === 'pendente') {       // d.status e conferido DEPOIS do await: nao existe credito duplo
    d.status = 'creditado'; d.paid = Date.now();
    addSaldo(d.email, d.cents, 'deposito', { mp: id });
    console.log('DEPOSITO CREDITADO:', d.email, (d.cents / 100).toFixed(2), 'mp=' + id);
    await flushRemote().catch(e => console.error('Aviso: falha ao gravar no Upstash apos deposito:', e.message));
    return 'creditado';
  }
  if ((pay.status === 'refunded' || pay.status === 'charged_back') && d.status === 'creditado' && !d.estornado) {
    d.estornado = true;
    const x = Math.min(d.cents, Math.max(0, saldoOf(DB.users[d.email])));
    if (x > 0) addSaldo(d.email, -x, 'deposito-estornado', { mp: id }); else saveDB();
    console.error('ATENCAO: deposito ' + id + ' foi ' + pay.status + '. Descontado R$ ' + (x / 100).toFixed(2) + ' de R$ ' + (d.cents / 100).toFixed(2) + ' (' + d.email + ').');
    return 'estornado';
  }
  if ((pay.status === 'cancelled' || pay.status === 'rejected') && d.status === 'pendente') { d.status = 'cancelado'; saveDB(); return 'cancelado'; }
  return d.status;
}
// rede de seguranca: se o aviso (webhook) falhar, a cada 60 s confere os PIX ainda pendentes
async function reconcileDeposits() {
  if (!MP_ON) return;
  const now = Date.now(); let n = 0;
  for (const id of Object.keys(DB.deposits)) {
    const d = DB.deposits[id];
    if (d.status !== 'pendente') { if (now - d.ts > 30 * 86400000) delete DB.deposits[id]; continue; }
    if (now - d.ts > 36 * 3600000) { d.status = 'expirado'; saveDB(); continue; }
    if (now - d.ts < 15000 || n >= 20) continue;
    n++;
    try { await creditDeposit(id); } catch (e) { console.error('Conferencia de deposito falhou:', id, e.message); }
  }
}
setInterval(() => reconcileDeposits().catch(() => {}), 60000);
// assinatura do webhook: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" com a assinatura secreta
function mpSigOk(req, dataId) {
  const sig = String(req.headers['x-signature'] || ''), rid = String(req.headers['x-request-id'] || '');
  const ts = (/(?:^|,)\s*ts=([^,\s]+)/.exec(sig) || [])[1], v1 = (/(?:^|,)\s*v1=([^,\s]+)/.exec(sig) || [])[1];
  if (!ts || !v1 || !dataId) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const want = Buffer.from(crypto.createHmac('sha256', MP_SECRET).update('id:' + id + ';request-id:' + rid + ';ts:' + ts + ';').digest('hex')), got = Buffer.from(v1);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const readBody = req => new Promise((ok, no) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > 16384) { no(Object.assign(new Error('Pedido grande demais.'), { status: 413 })); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch (e) { no(Object.assign(new Error('Pedido inválido.'), { status: 400 })); } });
  req.on('error', () => no(Object.assign(new Error('Pedido inválido.'), { status: 400 })));
});

// ---- Login com Google: confere o token (JWT) assinado pelo Google, sem biblioteca extra ----
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '376912142963-tolqn18eb0oo2261e4tgqgsvl6uvaugb.apps.googleusercontent.com';   // o ID nao e segredo
let gKeys = { keys: [], exp: 0 };
async function googleKeys(force) {
  if (!force && gKeys.exp > Date.now()) return gKeys.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('certs ' + r.status);
  const j = await r.json(), cc = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  gKeys = { keys: j.keys || [], exp: Date.now() + (cc ? +cc[1] * 1000 : 3600000) };
  return gKeys.keys;
}
async function verifyGoogle(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('formato');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url')), pay = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (head.alg !== 'RS256') throw new Error('alg');
  let jwk = (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === head.kid);
  if (!jwk) throw new Error('kid');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('assinatura');
  if (pay.aud !== GOOGLE_CLIENT_ID) throw new Error('aud');
  if (pay.iss !== 'https://accounts.google.com' && pay.iss !== 'accounts.google.com') throw new Error('iss');
  if (!(pay.exp * 1000 > Date.now())) throw new Error('exp');
  if (pay.email_verified !== true && pay.email_verified !== 'true') throw new Error('email nao verificado');
  if (typeof pay.email !== 'string' || typeof pay.sub !== 'string') throw new Error('dados');
  return pay;
}

async function handleApi(req, res, p) {
  const reply = (code, o, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra)); res.end(JSON.stringify(o)); };
  const fail = (code, msg) => { throw Object.assign(new Error(msg), { status: code }); };
  const view = email => ({ email, nick: DB.users[email].nick || null, avatar: avatarOf(DB.users[email]), perfil: perfilOf(DB.users[email]), saldo: saldoOf(DB.users[email]) / 100, ticket: newTicket(email) });
  const startSession = email => {
    const t = crypto.randomBytes(32).toString('hex');
    DB.sessions[sha(t)] = { email, exp: Date.now() + SESSION_MS }; saveDB();
    return { 'Set-Cookie': 'sid=' + t + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + SESSION_MS / 1000 + (isHttps(req) ? '; Secure' : '') };
  };
  try {
    if (p === '/api/me' && req.method === 'GET') { const e = sessionEmail(req); if (!e) fail(401, 'Não autenticado.'); return reply(200, view(e)); }
    // aviso de pagamento do Mercado Pago (sem login: quem garante e a assinatura + a conferencia direto na API deles)
    if (p === '/api/mp/webhook') {
      if (req.method !== 'POST') fail(405, 'Método não permitido.');
      if (!MP_ON) fail(404, 'Não encontrado.');
      const qs = new URL(req.url, 'http://x').searchParams;
      let body = {}; try { body = await readBody(req); } catch (e) {}
      const dataId = String(qs.get('data.id') || (MP_SECRET ? '' : (body.data && body.data.id) || '')).trim();
      if (MP_SECRET && !mpSigOk(req, dataId)) { console.error('Webhook recusado: assinatura invalida.'); fail(401, 'Assinatura inválida.'); }
      const type = qs.get('type') || qs.get('topic') || body.type || body.topic;
      if ((type && type !== 'payment') || !/^\d{1,20}$/.test(dataId)) return reply(200, { ok: true });
      try { await creditDeposit(dataId); } catch (e) { console.error('Webhook: erro ao conferir pagamento', dataId, e.message); fail(500, 'Erro.'); }   // 500 faz o Mercado Pago tentar de novo
      return reply(200, { ok: true });
    }
    if (p === '/api/deposito/status' && req.method === 'GET') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      const id = String(new URL(req.url, 'http://x').searchParams.get('id') || ''), d = DB.deposits[id];
      if (!d || d.email !== email) fail(404, 'Depósito não encontrado.');
      if (d.status === 'pendente' && Date.now() - (d.chk || 0) > 4000) { d.chk = Date.now(); try { await creditDeposit(id); } catch (e) { console.error('Status do deposito:', e.message); } }
      return reply(200, { status: d.status, saldo: saldoOf(DB.users[email]) / 100 });
    }
    if (p === '/api/admin/diag' && req.method === 'GET') {
      if (tooMany(req)) fail(429, 'Muitas tentativas.');
      if (!adminOk(req)) fail(401, 'Chave inválida.');
      const o = { mpLigado: MP_ON, temToken: !!MP_TOKEN, armazenamentoPersistente: PERSIST, publicUrl: PUBLIC_URL || null, webhookSecretDefinido: !!MP_SECRET, taxaPct: RAKE_PCT, ultimoErro: lastMpErr };
      if (MP_TOKEN) { try { const me = await mp('GET', '/users/me'); o.conta = { id: me.id, apelido: me.nickname, pais: me.site_id, email: me.email }; o.token = 'valido'; } catch (e) { o.token = 'RECUSADO pelo Mercado Pago'; o.tokenErro = e.message; } }
      return reply(200, o);
    }
    if (p === '/api/admin/saques' && req.method === 'GET') {
      if (tooMany(req)) fail(429, 'Muitas tentativas.');
      if (!adminOk(req)) fail(401, 'Chave inválida.');
      const saques = Object.entries(DB.saques).filter(([, x]) => x.status === 'pendente').map(([id, x]) => ({ id, cents: x.cents, nome: x.nome, email: x.email, chave: x.chave, ts: x.ts })).sort((a, b) => a.ts - b.ts);
      return reply(200, { saques });
    }
    if (req.method !== 'POST') fail(405, 'Método não permitido.');
    if (!String(req.headers['content-type'] || '').includes('application/json')) fail(415, 'Pedido inválido.');
    const b = await readBody(req);

    if (p === '/api/admin/saque') {
      if (tooMany(req)) fail(429, 'Muitas tentativas.');
      if (!adminOk(req)) fail(401, 'Chave inválida.');
      const sq = DB.saques[String(b.id)];
      if (!sq || sq.status !== 'pendente') fail(404, 'Saque não encontrado ou já tratado.');
      if (b.acao === 'pago') { sq.status = 'pago'; sq.done = Date.now(); ledgerAdd(sq.email, 'saque-pago', 0, { saque: String(b.id) }); saveDB(); }
      else if (b.acao === 'estornar') { sq.status = 'estornado'; sq.done = Date.now(); addSaldo(sq.email, sq.cents, 'saque-estornado', { saque: String(b.id) }); }
      else fail(400, 'Ação inválida.');
      await flushRemote().catch(e => console.error('Aviso: falha ao gravar no Upstash:', e.message));
      return reply(200, { ok: true });
    }
    if (p === '/api/register' || p === '/api/login') {
      if (tooMany(req)) fail(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
      const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
      if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'Digite um e-mail válido.');
      if (!allowed(email)) fail(403, PRIVATE_MSG);
      if (pw.length < 6 || pw.length > 128) fail(400, 'A senha precisa ter entre 6 e 128 caracteres.');
      if (p === '/api/register' && pw.length < 8) fail(400, 'A senha precisa ter pelo menos 8 caracteres.');
      if (p === '/api/login' && lockedOut(email)) fail(429, 'Muitas tentativas erradas nesta conta. Espere 15 minutos e tente de novo.');
      if (p === '/api/register') {
        if (DB.users[email]) fail(409, 'Este e-mail já está cadastrado. Tente entrar.');
        const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(pw, salt)).toString('hex');
        if (DB.users[email]) fail(409, 'Este e-mail já está cadastrado. Tente entrar.');   // alguem pode ter cadastrado durante o calculo
        DB.users[email] = { salt, hash, nick: null, created: Date.now() };
        return reply(201, view(email), startSession(email));
      }
      const u = DB.users[email], hash = await scrypt(pw, u && u.salt ? u.salt : DUMMY_SALT);
      if (u && !u.hash) fail(401, 'Esta conta entra com o Google. Use o botão "Continuar com Google".');
      if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) { noteLoginFail(email); fail(401, 'E-mail ou senha incorretos.'); }
      loginFails.delete(email);
      return reply(200, view(email), startSession(email));
    }
    if (p === '/api/google') {
      if (tooMany(req)) fail(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
      let g; try { g = await verifyGoogle(b.credential); } catch (e) { console.error('Login Google recusado:', e.message); fail(401, 'Não foi possível entrar com o Google. Tente de novo.'); }
      const email = String(g.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'E-mail inválido.');
      if (!allowed(email)) fail(403, PRIVATE_MSG);
      let u = DB.users[email];
      if (!u) u = DB.users[email] = { nick: null, created: Date.now(), google: g.sub };
      else { delete u.hash; delete u.salt; u.google = g.sub; }   // o Google provou que o e-mail e seu: a senha antiga (que podia ser de outra pessoa) deixa de valer
      return reply(200, view(email), startSession(email));       // startSession ja salva as contas
    }
    if (p === '/api/nick') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      const nick = String(b.nick || '').trim();
      if (!NICK_RE.test(nick)) fail(400, 'Use de 3 a 16 caracteres: letras, números, ponto, hífen ou _ (sem espaços).');
      for (const k in DB.users) if (k !== email && String(DB.users[k].nick || '').toLowerCase() === nick.toLowerCase()) fail(409, 'Este apelido já está em uso. Escolha outro.');
      DB.users[email].nick = nick; saveDB();
      return reply(200, view(email));
    }
    if (p === '/api/avatar') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      if (!AV_IDS.includes(b.id)) fail(400, 'Avatar inválido.');
      DB.users[email].avatar = { id: b.id }; saveDB();
      return reply(200, view(email));
    }
    if (p === '/api/perfil') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      const nome = String(b.nome || '').trim().replace(/\s+/g, ' '), cpf = onlyDigits(b.cpf), cel = onlyDigits(b.celular);
      if (!nameValid(nome)) fail(400, 'Digite seu nome completo.');
      if (!cpfValid(cpf)) fail(400, 'CPF inválido. Confira os 11 dígitos.');
      if (cel && !telValid(cel)) fail(400, 'Celular inválido. Use DDD + 9 dígitos.');
      const pix = b.pix === 'tel' && cel ? 'tel' : 'cpf';
      for (const k in DB.users) if (k !== email && DB.users[k].perfil && DB.users[k].perfil.cpf === cpf) fail(409, 'Este CPF já está cadastrado em outra conta.');
      DB.users[email].perfil = { nome, cpf, celular: cel, pix }; saveDB();
      return reply(200, view(email));
    }
    if (p === '/api/deposito') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      if (!MP_ON && !WALLET_TEST) fail(404, 'Depósito indisponível.');
      const u = DB.users[email];
      if (!perfilOk(u)) fail(400, 'Cadastre nome e CPF antes de depositar.');
      const c = cents(b.valor);
      if (!(c >= MIN_DEP)) fail(400, 'O valor mínimo é R$ 1,00.');
      if (c > MAX_DEP) fail(400, 'O valor máximo por depósito é R$ 1.000,00.');
      const abertos = Object.values(DB.deposits).filter(d => d.email === email && d.status === 'pendente' && Date.now() - d.ts < 60 * 60000).length;
      if (abertos >= 5) fail(429, 'Você já tem vários PIX aguardando pagamento. Pague um deles ou espere expirar (1 hora).');
      if (!MP_ON) {   // so com WALLET_TEST=1 e SEM MP_ACCESS_TOKEN
        const id = crypto.randomBytes(6).toString('hex');
        setTimeout(() => addSaldo(email, c, 'deposito-teste', { ref: id }), 5000);
        return reply(200, { id, teste: true, codigo: 'TESTE-SEM-VALOR-REAL-' + id });
      }
      const ref = crypto.randomBytes(12).toString('hex'), partes = u.perfil.nome.split(' ');
      const expira = new Date(Date.now() + 60 * 60000 - 3 * 3600000).toISOString().replace('Z', '-03:00');   // 1 hora (o Mercado Pago exige no minimo 30 min), horario de Brasilia
      let pay;
      try {
        pay = await mp('POST', '/v1/payments', Object.assign({
          transaction_amount: c / 100, description: 'Deposito Sinuca Online', payment_method_id: 'pix',
          external_reference: ref, date_of_expiration: expira,
          payer: { email, first_name: partes[0], last_name: partes.slice(1).join(' '), identification: { type: 'CPF', number: u.perfil.cpf } }
        }, PUBLIC_URL.startsWith('https://') ? { notification_url: PUBLIC_URL + '/api/mp/webhook' } : {}), ref);
      } catch (e) { lastMpErr = { quando: new Date().toISOString(), http: e.mpStatus || null, mensagem: e.message, detalhe: JSON.stringify(e.mp || {}).slice(0, 700) }; console.error('Erro ao criar PIX no Mercado Pago:', e.message, JSON.stringify(e.mp || {}).slice(0, 400)); fail(502, 'Não foi possível gerar o PIX agora. Tente de novo em instantes.'); }
      const td = pay.point_of_interaction && pay.point_of_interaction.transaction_data;
      if (!pay.id || !td || !td.qr_code) { lastMpErr = { quando: new Date().toISOString(), http: 200, mensagem: 'Resposta do Mercado Pago veio sem QR Code', detalhe: JSON.stringify({ status: pay.status, status_detail: pay.status_detail, id: pay.id }).slice(0, 700) }; console.error('Resposta do Mercado Pago sem QR Code:', JSON.stringify(pay).slice(0, 400)); fail(502, 'Não foi possível gerar o PIX agora. Tente de novo em instantes.'); }
      DB.deposits[String(pay.id)] = { email, cents: c, ref, status: 'pendente', ts: Date.now() };
      saveDB();
      await flushRemote().catch(e => console.error('Aviso: falha ao gravar no Upstash:', e.message));   // o registro precisa existir ANTES de a pessoa pagar
      return reply(200, { id: String(pay.id), teste: false, codigo: td.qr_code, qr: td.qr_code_base64 || null, valor: c / 100, expira: pay.date_of_expiration || expira });
    }
    if (p === '/api/saque') {
      const email = sessionEmail(req); if (!email) fail(401, 'Sua sessão expirou. Entre de novo.');
      const u = DB.users[email];
      if (!perfilOk(u)) fail(400, 'Cadastre nome e CPF antes de sacar.');
      const c = cents(b.valor);
      if (!(c >= MIN_SAQ)) fail(400, 'O valor mínimo do saque é R$ 1,00.');
      if (c > saldoOf(u)) fail(400, 'Valor maior que o saldo sacável.');
      const key = u.perfil.pix === 'tel' && telValid(u.perfil.celular) ? { tipo: 'celular', chave: onlyDigits(u.perfil.celular) } : { tipo: 'cpf', chave: u.perfil.cpf };
      const sid = crypto.randomBytes(6).toString('hex');
      DB.saques[sid] = { email, cents: c, nome: u.perfil.nome, chave: key, ts: Date.now(), status: 'pendente' };
      addSaldo(email, -c, 'saque-pendente', { saque: sid, chavePix: key, status: 'pendente' });   // o pagamento e feito por voce, na pagina /admin
      await flushRemote().catch(e => console.error('Aviso: falha ao gravar no Upstash:', e.message));
      console.log('SAQUE PENDENTE:', email, (c / 100).toFixed(2), key.tipo, 'id=' + sid);
      return reply(200, { ok: true, saldo: saldoOf(u) / 100 });
    }
    if (p === '/api/logout') {
      const t = cookieOf(req, 'sid'); if (t && DB.sessions[sha(t)]) { delete DB.sessions[sha(t)]; saveDB(); }
      return reply(200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    fail(404, 'Não encontrado.');
  } catch (e) {
    reply(e.status || 500, { error: e.status ? e.message : 'Erro no servidor. Tente de novo.' });
    if (!e.status) console.error(e);
  }
}

// ---------- pagina de administracao: saques pendentes (so funciona com a ADMIN_TOKEN certa) ----------
const ADMIN_HTML = String.raw`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saques</title>
<body style="font-family:sans-serif;max-width:760px;margin:20px auto;padding:0 12px"><h2>Saques pendentes</h2>
<p style="color:#555">Pague pelo seu app do banco/Mercado Pago usando a chave PIX abaixo e depois clique em <b>Marcar como pago</b>. Se não for pagar, use <b>Devolver ao saldo</b>.</p>
<div id="l">Carregando…</div>
<h2>Diagnóstico do Mercado Pago</h2><pre id="d" style="white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:10px;border-radius:8px">Carregando…</pre>
<script>
var T = sessionStorage.getItem('adm') || prompt('Chave de administrador:') || '';
function api(u, o) { return fetch(u, Object.assign({ headers: { 'Authorization': 'Bearer ' + T, 'Content-Type': 'application/json' } }, o)).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); }); }
function load() {
  var l = document.getElementById('l'); l.textContent = 'Carregando…';
  api('/api/admin/saques').then(function (j) {
    sessionStorage.setItem('adm', T); l.textContent = '';
    if (!j.saques.length) l.textContent = 'Nenhum saque pendente.';
    j.saques.forEach(function (s) {
      var d = document.createElement('div'); d.style.cssText = 'border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0';
      d.textContent = 'R$ ' + (s.cents / 100).toFixed(2).replace('.', ',') + '  |  ' + s.nome + '  |  PIX (' + s.chave.tipo + '): ' + s.chave.chave + '  |  ' + new Date(s.ts).toLocaleString('pt-BR') + '  ';
      [['pago', 'Marcar como pago'], ['estornar', 'Devolver ao saldo']].forEach(function (a) {
        var b = document.createElement('button'); b.textContent = a[1]; b.style.margin = '4px';
        b.onclick = function () { if (!confirm(a[1] + '?')) return; api('/api/admin/saque', { method: 'POST', body: JSON.stringify({ id: s.id, acao: a[0] }) }).then(load).catch(function (e) { alert(e.message); }); };
        d.appendChild(b);
      });
      l.appendChild(d);
    });
  }).catch(function (e) { sessionStorage.removeItem('adm'); l.textContent = 'Erro: ' + e.message + ' (recarregue a página para tentar de novo)'; });
}
function diag() { api('/api/admin/diag').then(function (j) { document.getElementById('d').textContent = JSON.stringify(j, null, 2); }).catch(function (e) { document.getElementById('d').textContent = 'Erro: ' + e.message; }); }
load(); diag();
</script></body></html>`;

// ---------- servidor do site ----------
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end(); return; }   // endereco malformado nao derruba o servidor
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (p === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(ADMIN_HTML); return; }
  if (p.startsWith('/api/')) { handleApi(req, res, p); return; }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Pagina nao encontrada'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...(file.endsWith('.webp') ? { 'Cache-Control': 'public, max-age=604800' } : {}) });
    res.end(data);
  });
});

// ---------- mesa ----------
const W = 800, H = 400, R = 10, M = 30, PR = 21, POCKET_MOUTH = 28;
const PK = [[24, 24], [400, 20], [776, 24], [24, 376], [400, 380], [776, 376]];
const hyp = (a, b) => Math.sqrt(a * a + b * b);
function pocketed(b, ox, oy) {
  if (PK.some(p => hyp(p[0] - b.x, p[1] - b.y) < PR)) return true;
  const edge = M + R;
  return PK.some(([px, py]) =>
    (py < H / 2 && oy > edge && b.y <= edge && Math.abs(b.x - px) <= POCKET_MOUTH) ||
    (py > H / 2 && oy < H - edge && b.y >= H - edge && Math.abs(b.x - px) <= POCKET_MOUTH) ||
    (px < W / 2 && ox > edge && b.x <= edge && Math.abs(b.y - py) <= POCKET_MOUTH) ||
    (px > W / 2 && ox < W - edge && b.x >= W - edge && Math.abs(b.y - py) <= POCKET_MOUTH)
  );
}
const grpOf = n => (n < 8 ? 'solid' : 'stripe');

// ---------- efeito na bola branca ----------
// sy < 0 (parte de cima da bola): "seguir"  -> a branca anda para frente depois de bater
// sy > 0 (parte de baixo da bola): "puxar" -> a branca volta depois de bater
// sx (esquerda/direita): efeito lateral -> muda o angulo do rebote nas almofadas
// Os valores sao sempre em relacao a direcao da tacada (como no taco de verdade).
const FRICTION = 0.99972; // atrito do pano (proporcional, por passo): mais perto de 1 = as bolas rolam mais. Medido no video: ~0.07 por segundo
const DECEL = 0.00042;     // atrito constante do pano quando a bola ja esta ROLANDO (por passo; 240 passos = 1 s, ~24 unidades/s2 no video). Fica mais fraco quando a bola esta devagar (ver DECEL_K)
const OBJECT_DECEL = 0.0015; // bolas lisas e listradas perdem velocidade mais rapido depois do impacto
const DECEL_K = 0.05;      // quanto menor, mais cedo o atrito extra some e a bola termina rolando devagarzinho
const SLIDE_DECEL = 0.00465; // a branca logo depois da tacada ESCORREGA no pano (freia mais, ~270 unidades/s2) ate cair para 5/7 da velocidade; ai passa a rolar (medido no video)
const SLIDE_FRAC = 5 / 7;
const SUB = 4;             // subpassos por passo de fisica: movimento mais liso e bolas rapidas nao atravessam umas as outras
const BALL_E = 0.90;       // quicada entre bolas (1 = perfeita, menor = perde um pouco de energia)
// Forca da tacada medida no video: a velocidade da bola e proporcional ao numero da barra (20 -> 30 -> 40 ... ).
// Cada 1 da barra = SPEED_PER_PCT unidades por passo (0.075 = 18 unidades/s). Barra 100 = 7.5. O cliente manda 0..9 (= barra 0..100).
const SPEED_PER_PCT = 0.075;
const POWER = SPEED_PER_PCT * 100 / 9;   // multiplica o 0..9 que vem do cliente
const POWER_CURVE = 1;     // 1 = linear (igual ao video). Menor que 1 = tacadas fracas/medias andam mais
// Tabela da forca (barra 0..100 -> velocidade da bola em unidades por passo), medida no video de referencia (barra 1, 2, 3, 5, 7, 9, 13, 17, 19, 20, 23 e 26).
// Barra 1 = a bola anda ~2 bolas (~0,06 da mesa) e para; barra 5 ~0,3 da mesa; barra 13 ~1,1 mesa; barra 26 ~2,6 mesas. Entre 26 e 100 sobe em linha reta ate 7.5 (barra 100, como antes).
const POWER_KNOTS = [[0,0], [1,0.223], [2,0.37], [3,0.452], [4,0.525], [5,0.594], [6,0.657], [7,0.716], [8,0.81], [9,0.925], [10,1.005], [11,1.08], [12,1.155], [13,1.23], [14,1.3], [15,1.37], [16,1.44], [17,1.51], [18,1.578], [19,1.645], [20,1.712], [21,1.777], [22,1.842], [23,1.906], [24,1.97], [25,2.033], [26,2.096], [100,7.5]];
// Freio nas tacadas fracas e medianas: as bolas andavam demais. Multiplica a velocidade da tacada (barra -> fator); de barra 50 pra cima nao muda nada.
// A distancia que a bola anda cai com o QUADRADO do fator (ex.: fator 0,70 = anda uns 50%). Mais perto de 1 = anda mais; menor = anda menos.
const WEAK_KNOTS = [[0, 0.40], [1, 1], [2, 1], [5, 0.95], [15, 0.8], [30, 0.9], [50, 1], [100, 1]];   // [barra %, fator]
function weakScale(pct) {
  for (let i = 1; i < WEAK_KNOTS.length; i++) {
    const a = WEAK_KNOTS[i - 1], b = WEAK_KNOTS[i];
    if (pct <= b[0]) return a[1] + (b[1] - a[1]) * (pct - a[0]) / (b[0] - a[0]);
  }
  return 1;
}
function powerSpeed(s9) { return powerSpeedBase(s9) * weakScale(Math.min(100, Math.max(0, s9 / 9 * 100))); }
function powerSpeedBase(s9) {   // s9 = 0..9 (o que o cliente manda; 9 = barra 100)
  const pct = Math.min(100, Math.max(0, s9 / 9 * 100));
  for (let i = 1; i < POWER_KNOTS.length; i++) {
    const a = POWER_KNOTS[i - 1], b = POWER_KNOTS[i];
    if (pct <= b[0]) return a[1] + (b[1] - a[1]) * (pct - a[0]) / (b[0] - a[0]);
  }
  return POWER_KNOTS[POWER_KNOTS.length - 1][1];
}
function powerVec(vx, vy) { const s = hyp(vx, vy); if (s < 1e-9) return [0, 0]; const u = powerSpeed(s); return [vx / s * u, vy / s * u]; }
const BOUNCE = 0.72;       // quanto da velocidade a bola guarda ao bater na almofada devagar; batida forte perde mais (ver cb). Menor = almofada mais "fofa" (a bola nao fica quicando)
const cb = v => Math.max(0.48, 0.68 - 0.02 * Math.abs(v));   // quique mais contido nas almofadas para reduzir rebotes em sequencia
const SPIN_MAX = 0.72;       // mesmo limite do seletor no site
const SPIN_VERT = 0.8;       // forca do seguir/puxar no primeiro contato
const SPIN_CUSHION = 0.35;   // forca do efeito lateral nas almofadas
const TURN_MS = +process.env.TURN_MS || 20000;   // tempo para cada jogada
const PEN_SPEED = 1.2;    // velocidade (unidades por passo) da bola do castigo indo para a cacapa
const SPIN_DECAY = 0.9993;   // o efeito lateral vai acabando com o tempo

class Game {
  constructor(a, b, solo, bot) {
    this.solo = !!solo;
    this.bot = !!bot;                       // partida contra o robo (ele joga pelo assento 1)
    this.botBusy = false;
    const bi = bot ? botIdentity(a.name) : null;   // o robo entra com nome e avatar sorteados, como um jogador
    this.names = [a.name, bot ? bi.name : solo ? 'Treino' : b.name];
    const avOf = w => avatarOf(w && w.email && DB.users[w.email]);
    this.avatars = [avOf(a), bot ? bi.av : solo ? null : avOf(b)];   // avatar de cada jogador na partida
    this.sockets = (solo || bot) ? [a] : [a, b];
    this.starter = 0;
    this.rematch = new Set();
    this.reset();
  }
  reset() {
    this.pen = null; this.scr = 0;
    const nums = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15].sort(() => Math.random() - 0.5);
    nums.splice(4, 0, 8);
    this.B = [{ x: 230, y: 200, vx: 0, vy: 0, n: 0, a: 1, ux: 0, uy: 0, top: 0, w: 0 }];
    let k = 0;
    for (let c = 0; c < 5; c++)
      for (let r = 0; r <= c; r++)
        this.B.push({ x: 560 + c * R * 1.75, y: 200 + (r - c / 2) * R * 2.04, vx: 0, vy: 0, n: nums[k++], a: 1 });
    this.turn = this.starter; this.grp = [null, null];
    this.moving = false; this.over = false; this.winner = null;
    this.spun = false;
    this.info = { p: [], f: null };
    this.rematch.clear();
    this.armTimer();
  }
  // liga o relogio da vez (nao vale no treino nem na vez do robo)
  armTimer() {
    this.deadline = (this.over || this.solo || (this.bot && this.turn === 1)) ? 0 : Date.now() + TURN_MS;
  }
  left(g) { return this.B.filter(b => b.a && b.n && b.n !== 8 && grpOf(b.n) === g).length; }
  shoot(vx, vy, sx, sy) {
    const c = this.B[0], s = hyp(vx, vy) || 1;
    c.vx = vx; c.vy = vy;
    c.ux = vx / s; c.uy = vy / s;           // direcao original da tacada
    c.top = -sy;                            // + seguir, - puxar
    c.sv = c.top > 0 ? 0 : s * SLIDE_FRAC;  // velocidade em que ela para de escorregar e comeca a rolar (0 = ja rola: tacada com "seguir")
    c.w = -sx;                              // efeito lateral (+ = giro horario visto de cima)
    this.spun = false; this.scr = 0;
    this.moving = true; this.deadline = 0; this.info = { p: [], f: null };
    this.tick = 0;                          // quantos relogios de 1/60 s se passaram desde a tacada
  }
  // empurra a branca de lado quando ela bate na almofada com efeito lateral
  // (rx, ry) = direcao da almofada em relacao a bola; vn = velocidade que bateu nela
  cushionKick(b, rx, ry, vn) {
    if (b.n !== 0 || !b.w) return;
    const f = b.w * SPIN_CUSHION * Math.abs(vn);
    b.vx += ry * f; b.vy += -rx * f;
    b.w *= 0.5;
  }
  step() { for (let k = 0; k < SUB; k++) this.sub(1 / SUB); }
  sub(h) {
    // castigo da falta: a bola vai sozinha, em linha reta e em velocidade constante, ate a cacapa (nao bate nas outras)
    const pn = this.pen && this.pen.st === 1 && this.pen.b.a ? this.pen : null;
    if (pn) { const q = pn.pk, dx = q[0] - pn.b.x, dy = q[1] - pn.b.y, d = hyp(dx, dy) || 1; pn.b.vx = dx / d * PEN_SPEED; pn.b.vy = dy / d * PEN_SPEED; pn.b.sv = 0; }
    for (const b of this.B) {
      if (!b.a) continue;
      b.ox = b.x; b.oy = b.y;
      b.x += b.vx * h; b.y += b.vy * h;
      if (b.sv) {   // fase de escorregar (so a branca, logo apos a tacada)
        const s0 = hyp(b.vx, b.vy), t = s0 - SLIDE_DECEL * h;
        if (t <= b.sv) b.sv = 0; else { const k = t / s0; b.vx *= k; b.vy *= k; }
      }
      const sp = hyp(b.vx, b.vy);
      if (sp > 0) { const decel = b.n === 0 ? DECEL : OBJECT_DECEL, ns = sp * Math.pow(FRICTION, h) - decel * h * sp / (sp + DECEL_K), k = ns > 0.01 ? ns / sp : 0; b.vx *= k; b.vy *= k; }
      if (b.n === 0) b.w *= Math.pow(SPIN_DECAY, h);
      if (hyp(b.vx, b.vy) < 0.02) { b.vx = 0; b.vy = 0; }
    }
    for (let i = 0; i < this.B.length; i++) {
      const a = this.B[i]; if (!a.a) continue;
      for (let j = i + 1; j < this.B.length; j++) {
        const b = this.B[j]; if (!b.a) continue;
        if (pn && (a === pn.b || b === pn.b)) continue;   // a bola do castigo passa sem bater nas outras
        const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy);
        if (d < 2 * R && d > 0) {
          if (this.info.f === null && (a.n === 0 || b.n === 0)) this.info.f = a.n === 0 ? b.n : a.n;
          const nx = dx / d, ny = dy / d, o = (2 * R - d) / 2;
          a.sv = 0; b.sv = 0;                // bateu em outra bola: acaba o escorregar
          a.x -= nx * o; a.y -= ny * o; b.x += nx * o; b.y += ny * o;
          const p = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (p > 0) {
            const q = p * (1 + BALL_E) / 2;
            a.vx -= q * nx; a.vy -= q * ny; b.vx += q * nx; b.vy += q * ny;
            // efeito vertical: so no primeiro contato da branca com outra bola
            if ((a.n === 0 || b.n === 0) && !this.spun) {
              const c = a.n === 0 ? a : b;
              this.spun = true;
              if (c.top) { c.vx += c.ux * c.top * SPIN_VERT * p; c.vy += c.uy * c.top * SPIN_VERT * p; c.top = 0; }
              c.w *= 0.7;
            }
          }
        }
      }
    }
    for (const b of this.B) {
      if (!b.a) continue;
      if (pocketed(b, b.ox, b.oy)) { b.a = 0; b.vx = b.vy = 0; this.info.p.push(b.n); }
      if (!b.a) continue;
      if (b.x < M + R) { const v = b.vx; b.x = M + R; b.vx = -b.vx * cb(v); b.sv = b.n === 0 ? hyp(b.vx, b.vy) * SLIDE_FRAC : 0; this.cushionKick(b, -1, 0, v); }
      if (b.x > W - M - R) { const v = b.vx; b.x = W - M - R; b.vx = -b.vx * cb(v); b.sv = b.n === 0 ? hyp(b.vx, b.vy) * SLIDE_FRAC : 0; this.cushionKick(b, 1, 0, v); }
      if (b.y < M + R) { const v = b.vy; b.y = M + R; b.vy = -b.vy * cb(v); b.sv = b.n === 0 ? hyp(b.vx, b.vy) * SLIDE_FRAC : 0; this.cushionKick(b, 0, -1, v); }
      if (b.y > H - M - R) { const v = b.vy; b.y = H - M - R; b.vy = -b.vy * cb(v); b.sv = b.n === 0 ? hyp(b.vx, b.vy) * SLIDE_FRAC : 0; this.cushionKick(b, 0, 1, v); }
    }
  }
  allStopped() { return this.B.every(b => !b.a || (b.vx === 0 && b.vy === 0)); }
  // Regras: roda quando todas as bolas param. Devolve a mensagem da jogada.
  endTurn() {
    if (this.pen) return this.penStep();   // castigo da branca encacapada em andamento
    this.moving = false;
    const cue = this.B[0], p = this.info.p, me = this.turn, N = this.names;
    cue.top = 0; cue.w = 0;
    let foul = !cue.a || this.info.f === null;
    if (!foul && this.grp[me] && this.info.f !== null) {
      const need = this.left(this.grp[me]) > 0 ? this.grp[me] : 'eight';
      if (need === 'eight' ? this.info.f !== 8 : (this.info.f === 8 || grpOf(this.info.f) !== need)) foul = true;
    }
    if (p.includes(8)) {
      const ok = !foul && this.grp[me] && this.left(this.grp[me]) === 0;
      this.over = true; this.deadline = 0; this.winner = ok ? me : 1 - me;
      return 'Bola 8 cacapada! ' + N[this.winner] + ' venceu a partida!';
    }
    const real = p.filter(n => n > 0);
    let keep = false;
    if (!foul && real.length) {
      if (!this.grp[me]) {
        this.grp[me] = grpOf(real[0]);
        this.grp[1 - me] = this.grp[me] === 'solid' ? 'stripe' : 'solid';
        keep = true;
      } else keep = real.some(n => grpOf(n) === this.grp[me]);
    }
    const scratch = !cue.a;
    if (!cue.a) {
      cue.a = 1; cue.x = 230; cue.y = 200; cue.vx = cue.vy = 0;
      while (this.B.some(b => b !== cue && b.a && hyp(b.x - cue.x, b.y - cue.y) < 2 * R)) cue.x -= 2 * R;
    }
    if (!keep) this.turn = 1 - this.turn;
    this.info = { p: [], f: null };
    this.armTimer();
    const msg = (foul ? 'Falta! ' : '') + 'Vez de ' + N[this.turn] + '.';
    if (scratch) {
      this.scr = 1;   // o site mostra o "FALTA!" vermelho
      // castigo: a menor bola do ADVERSARIO de quem errou (nunca a 8) fica com luz vermelha e depois anda sozinha ate a cacapa
      // (sem grupos definidos ainda nao da para saber qual e a do adversario: so aparece o FALTA!)
      const og = this.grp[1 - me];
      let v = null;
      if (og) for (const b of this.B) if (b.a && b.n > 0 && b.n !== 8 && grpOf(b.n) === og && (!v || b.n < v.n)) v = b;
      if (v) { this.pen = { b: v, st: 0, t0: Date.now(), msg }; this.moving = true; this.deadline = 0; }
    }
    return msg;
  }
  // castigo da falta: espera a luz vermelha, empurra a bola para a cacapa mais perto e, quando ela cai, devolve a vez
  penStep() {
    const pen = this.pen, b = pen.b;
    if (pen.st === 0) {
      if (Date.now() - pen.t0 < 1300) return null;
      let bi = 0; PK.forEach((q, j) => { if (hyp(q[0] - b.x, q[1] - b.y) < hyp(PK[bi][0] - b.x, PK[bi][1] - b.y)) bi = j; });
      pen.pk = PK[bi]; b.sv = 0;
      pen.st = 1;
      return null;
    }
    if (b.a) { b.a = 0; b.vx = b.vy = 0; }   // parou antes de cair: some do mesmo jeito
    this.pen = null; this.moving = false; this.info = { p: [], f: null }; this.armTimer();
    return pen.msg;
  }
  snap(m) {
    const o = {
      t: 'state',
      b: this.B.map(b => [b.n, +b.x.toFixed(1), +b.y.toFixed(1), b.a]),
      pen: this.pen ? this.pen.b.n : 0, scr: this.scr || 0,
      turn: this.turn, grp: this.grp, moving: this.moving, over: this.over, winner: this.winner,
      names: this.names, av: this.avatars, m,
      tl: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      k: this.tick || 0
    };
    // a cada 6 relogios (e no primeiro) manda tambem velocidades e efeito da branca: o navegador refaz a fisica a partir dai
    if (this.moving && (this.tick || 0) % 6 === 1) {
      const c = this.B[0];
      o.v = this.B.map(b => [+b.vx.toFixed(4), +b.vy.toFixed(4)]);
      o.cs = [+c.w.toFixed(4), +c.top.toFixed(4), +c.ux.toFixed(4), +c.uy.toFixed(4), this.spun ? 1 : 0, +(c.sv || 0).toFixed(4)];
    }
    return o;
  }
  send(obj) {
    const s = JSON.stringify(obj);
    for (const ws of new Set(this.sockets)) if (ws.readyState === 1) ws.send(s);
  }
}

// ============================================================
//  ROBO
//  Ele enxerga a mesa inteira e testa as tacadas numa copia da fisica
//  do jogo (a mesma que os jogadores usam) antes de escolher.
//  Depois, em uma parte das tacadas, ele erra de proposito (BOT_MISS),
//  para ser um adversario e nao uma maquina perfeita.
//  BOT_MISS = 0.10 -> executa 90% das tacadas certinhas e erra 10%.
//  Mais perto de 0 = robo mais forte. Mais perto de 1 = robo mais fraco.
// ============================================================
const BOT_MISS = 0.45;       // chance de errar a tacada de proposito (0.10 = quase perfeito, 0.45 = jogador normal, 0.7 = fraco)
const BOT_ERR_MIN = 0.03;    // tamanho do erro de mira quando erra, em radianos (0.03 = ~1.7 graus)
const BOT_ERR_MAX = 0.11;    // erro maximo (0.11 = ~6 graus). Maior = erra mais feio
const BOT_JITTER = 0.006;    // tremida pequena que existe ate nas tacadas "certas" (~0.3 grau): tacadas longas e dificeis falham as vezes
const BOT_THINK_MIN = 1500;  // tempo minimo que o robo "pensa" antes de tacar (ms)
const BOT_THINK_MAX = 3800;  // tempo maximo (cada tacada sorteia um valor entre os dois, como uma pessoa)
// Nome e avatar do robo: cada partida sorteia um nome diferente e um dos avatares do jogo.
// Nao repete nome das ultimas 12 partidas e nunca usa o mesmo nome de quem esta jogando.
const BOT_NAMES = ['João Paulo','Maria','Pedro','Ana Clara','Lucas','Fernanda','Rafael','Juliana','Gabriel','Camila','Matheus','Beatriz','Thiago','Larissa','Bruno','Mariana','Felipe','Patrícia','Rodrigo','Aline','Gustavo','Carla','Diego','Vanessa','Leandro','Renata','Marcos','Tatiane','André','Luciana','Eduardo','Cristina','Vinícius','Sandra','Leonardo','Priscila','Daniel','Paula','Henrique','Débora','Wellington','Rosana','Anderson','Jéssica','Marcelo','Simone','Fábio','Elaine','Sérgio','Natália','José Carlos','Maria Eduarda','Antônio','Francisca','Paulo','Adriana','Ricardo','Kelly','Jorge','Letícia'];
const botRecent = [];
function botIdentity(playerName) {
  const me = String(playerName || '').trim().toLowerCase();
  const free = BOT_NAMES.filter(n => !botRecent.includes(n) && n.toLowerCase() !== me);
  const pool = free.length ? free : BOT_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  botRecent.push(name); if (botRecent.length > 12) botRecent.shift();
  return { name, av: { id: AV_IDS[Math.floor(Math.random() * AV_IDS.length)] } };
}
const BOT_JOIN_MS = 10000;   // sala Gratis: se ninguem entrar em ate 10 s, o robo joga contra quem esta esperando
const BOT_SPEEDS = [2, 3.5, 5.5, 9];   // forcas testadas (antes do POWER): barra ~22, 39, 61 e 100
const BOT_TOP = 10;          // quantas tacadas candidatas ele simula de verdade

function simClone(g) {
  const s = Object.create(Game.prototype);
  s.B = g.B.map(b => Object.assign({}, b));
  s.info = { p: [], f: null }; s.spun = false; s.moving = true;
  s.grp = g.grp; s.turn = g.turn;
  return s;
}
function simShot(g, vx, vy) {
  const s = simClone(g);
  { const [px, py] = powerVec(vx, vy); s.shoot(px, py, 0, 0); }
  for (let i = 0; i < 3600 && !s.allStopped(); i++) s.step();
  return s;
}
function botNeed(g, me) {
  const grp = g.grp[me];
  if (!grp) return null;
  return g.left(grp) > 0 ? grp : 'eight';
}
function botLegal(n, need) {
  if (n <= 0) return false;
  if (need === null) return n !== 8;
  if (need === 'eight') return n === 8;
  return n !== 8 && grpOf(n) === need;
}
// nota da tacada depois de simular
function botScore(s, need) {
  const cue = s.B[0], p = s.info.p, f = s.info.f;
  const foul = !cue.a || f === null || !botLegal(f, need);
  if (p.includes(8)) return (need === 'eight' && !foul) ? 1000 : -1000;
  if (foul) return -100;
  let sc = 0;
  for (const n of p) if (n > 0) sc += botLegal(n, need) ? 100 : -30;
  return sc;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
  return hyp(px - (ax + t * dx), py - (ay + t * dy));
}
function botClear(g, ax, ay, bx, by, skipA, skipB) {
  for (const b of g.B) if (b.a && b !== skipA && b !== skipB && segDist(b.x, b.y, ax, ay, bx, by) < 2 * R - 0.5) return false;
  return true;
}
// primeira bola que o raio da branca encontra (para descartar tacadas que ja comecam em falta)
function botFirstHit(g, ax, ay) {
  const c = g.B[0]; let best = null, bt = 1e9;
  for (const b of g.B) {
    if (!b.a || b === c) continue;
    const dx = b.x - c.x, dy = b.y - c.y, t = dx * ax + dy * ay;
    if (t <= 0) continue;
    const d2 = dx * dx + dy * dy - t * t;
    if (d2 > 4 * R * R) continue;
    const tt = t - Math.sqrt(4 * R * R - d2);
    if (tt < bt) { bt = tt; best = b; }
  }
  return best;
}
// planeja a tacada. E um "gerador": entre uma simulacao e outra ele devolve o controle (yield),
// assim o servidor continua tocando as outras partidas sem travar.
// resultado: { sc, vx, vy, aimed }  (aimed = tacada que mira cacapar uma bola)
function* botPlanGen(g, me) {
  const need = botNeed(g, me), cue = g.B[0];
  const targets = g.B.filter(b => b.a && botLegal(b.n, need));
  const ROB = 0.012;                                  // quanto a tacada tem que aguentar de erro de mira
  let best = null;
  const consider = (sc, vx, vy, aimed) => { if (!best || sc > best.sc) best = { sc, vx, vy, aimed }; };
  // tacada com teste de robustez: simula tambem com a mira um pouco para cada lado
  function* robust(ax, ay, v) {
    const sc = botScore(simShot(g, ax * v, ay * v), need); yield;
    if (sc < 100) return sc;
    let tot = sc;
    for (const e of [-ROB, ROB]) {
      const a = Math.atan2(ay, ax) + e;
      if (botScore(simShot(g, Math.cos(a) * v, Math.sin(a) * v), need) >= 100) tot += 50;
      yield;
    }
    return tot;
  }
  // 1) tacadas diretas: bola -> cacapa (mira na "bola fantasma")
  const cands = [];
  for (const t of targets) {
    for (const p of PK) {
      let ux = p[0] - t.x, uy = p[1] - t.y; const ul = hyp(ux, uy) || 1; ux /= ul; uy /= ul;
      const gx = t.x - ux * 2 * R, gy = t.y - uy * 2 * R;
      if (gx < M + R - 1 || gx > W - M - R + 1 || gy < M + R - 1 || gy > H - M - R + 1) continue;
      let ax = gx - cue.x, ay = gy - cue.y; const al = hyp(ax, ay); if (al < 1) continue; ax /= al; ay /= al;
      const cut = Math.acos(Math.max(-1, Math.min(1, ax * ux + ay * uy)));
      if (cut > 1.22) continue;
      if (!botClear(g, cue.x, cue.y, gx, gy, cue, t)) continue;
      if (!botClear(g, t.x, t.y, p[0], p[1], t, null)) continue;
      cands.push({ ax, ay, rank: cut * 100 + al * 0.05 + ul * 0.1 });
    }
  }
  cands.sort((a, b) => a.rank - b.rank);
  for (const c of cands.slice(0, BOT_TOP)) {
    for (const v of BOT_SPEEDS) {
      const tot = yield* robust(c.ax, c.ay, v);
      if (tot >= 100) consider(tot, c.ax * v, c.ay * v, true);
    }
    if (best && best.sc >= 200) break;                // robusta nos dois lados: serve
  }
  // 2) nada bom? varre a mesa inteira de 2 em 2 graus (pega tabelas e cortes dificeis)
  if (!best || best.sc < 200) {
    let n = 0;
    const off = Math.random() * 0.035;
    for (let k = 0; k < 180 && n < 140; k++) {
      const a = off + k * 0.0349, ax = Math.cos(a), ay = Math.sin(a);
      const fh = botFirstHit(g, ax, ay);
      if (!fh || !botLegal(fh.n, need)) continue;     // ja comecaria em falta
      for (const v of [5, 8]) {
        n++;
        const tot = yield* robust(ax, ay, v);
        if (tot >= 100) consider(tot, ax * v, ay * v, true);
      }
      if (best && best.sc >= 200) break;
    }
  }
  // 3) sem tacada boa: joga seguro, bate de leve em uma bola dele (sem falta)
  if (!best || best.sc < 100) {
    const near = targets.slice().sort((a, b) => hyp(a.x - cue.x, a.y - cue.y) - hyp(b.x - cue.x, b.y - cue.y));
    for (const t of near.slice(0, 4)) {
      const dx = t.x - cue.x, dy = t.y - cue.y, d = hyp(dx, dy) || 1;
      for (const v of [2.5, 4]) {
        const sc = botScore(simShot(g, dx / d * v, dy / d * v), need); yield;
        if (!best || sc > best.sc) best = { sc, vx: dx / d * v, vy: dy / d * v, aimed: false };
      }
    }
  }
  if (!best) { const a = Math.random() * 6.283; best = { sc: -100, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, aimed: false }; }
  return best;
}
function botPlan(g, me) { const it = botPlanGen(g, me); let r; while (!(r = it.next()).done); return r.value; }
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * v); };
function botHumanize(p, dist) {
  const s = hyp(p.vx, p.vy), a0 = Math.atan2(p.vy, p.vx);
  const d = Math.min(1, (dist || 300) / 500);                               // 0 = bola colada, 1 = tacada longa (500+ unidades)
  const pMiss = Math.max(0.15, Math.min(0.75, BOT_MISS * (0.6 + 0.8 * d)));   // tacada longa erra mais, tacada curta erra menos
  const pw = Math.min(9, s * (1 + gauss() * 0.03));                         // ninguem repete a forca exata duas vezes
  if (Math.random() >= pMiss) {                                             // tacada "certa": so com uma tremidinha
    const a = a0 + gauss() * BOT_JITTER * (1 + d);
    return { vx: Math.cos(a) * pw, vy: Math.sin(a) * pw };
  }
  const sg = Math.random() < 0.5 ? -1 : 1;
  const a = a0 + sg * (BOT_ERR_MIN + Math.random() * (BOT_ERR_MAX - BOT_ERR_MIN)) * (0.7 + 0.6 * d);   // erra a mira (mais em tacada longa)
  const v = Math.min(9, s * (0.8 + Math.random() * 0.4));                   // e a forca em +-20%
  return { vx: Math.cos(a) * v, vy: Math.sin(a) * v };
}

// planeja e toca a vez do robo (sem travar as outras partidas: trabalha em pedacinhos de 5 ms)
function botSchedule(g) {
  if (!g.bot || g.over || g.turn !== 1 || g.moving || g.botBusy) return;
  g.botBusy = true;
  const t0 = Date.now(), it = botPlanGen(g, 1), think = BOT_THINK_MIN + Math.random() * (BOT_THINK_MAX - BOT_THINK_MIN);
  const work = () => {
    if (!games.has(g) || g.over) { g.botBusy = false; return; }
    const end = Date.now() + 5; let r;
    do { r = it.next(); } while (!r.done && Date.now() < end);
    if (!r.done) { setImmediate(work); return; }
    setTimeout(() => {
      g.botBusy = false;
      if (!games.has(g) || g.over || g.moving || g.turn !== 1) return;
      const p0 = r.value, ps = hyp(p0.vx, p0.vy) || 1, cue0 = g.B[0];
      const fh = botFirstHit(g, p0.vx / ps, p0.vy / ps), dist = fh ? hyp(fh.x - cue0.x, fh.y - cue0.y) : 300;
      let { vx, vy } = botHumanize(p0, dist); const s = hyp(vx, vy);
      if (s > 9) { vx = vx / s * 9; vy = vy / s * 9; }
      { const [px, py] = powerVec(vx, vy); g.shoot(px, py, 0, 0); }
    }, Math.max(0, think - (Date.now() - t0)));
  };
  setImmediate(work);
}

// inicia uma partida contra o robo (sempre sem aposta: nunca vale dinheiro)
function startBotMatch(ws) {
  const g = new Game(ws, null, false, true); ws.game = g; ws.seat = 0; games.add(g);
  send(ws, { t: 'match', seat: 0, bot: true });
  g.send(g.snap('Partida iniciada! Vez de ' + g.names[g.turn] + '.'));
  botSchedule(g);
}

// ---------- conexoes, fila e salas ----------
const games = new Set();
// salas por valor da aposta: cada sala tem a sua propria fila de quem esta procurando partida
const ROOM_IDS = ['0', '0.25', '1', '2', '5', '10', '25', '50'];
const queues = new Map(ROOM_IDS.map(r => [r, []]));
const rooms = new Map();

// ============================================================
//  CUSTODIA (escrow) das salas com valor
//  1) ao entrar na fila de uma sala paga, a aposta sai do saldo e vira uma RESERVA (DB.holds)
//  2) quando a partida comeca, as duas reservas ficam presas na partida (g.holds)
//  3) no fim, o vencedor recebe as duas apostas menos a taxa (RAKE_PCT). Quem sai/some perde (WO).
//  4) saiu da fila, cancelou ou o servidor reiniciou: a reserva volta inteira para o saldo.
// ============================================================
const stakeOf = room => Math.round(parseFloat(room) * 100) || 0;
function holdStake(email, c, room) {
  const u = DB.users[email];
  if (!u || !(c > 0) || saldoOf(u) < c) return null;
  const id = crypto.randomBytes(8).toString('hex');
  DB.holds[id] = { email, cents: c, room, ts: Date.now() };
  addSaldo(email, -c, 'aposta-reserva', { hold: id, room });
  return id;
}
function releaseHold(id, type) {
  const h = DB.holds[id]; if (!h) return;
  delete DB.holds[id];
  addSaldo(h.email, h.cents, type || 'aposta-devolvida', { hold: id, room: h.room });
}
function settleGame(g) {
  if (!g.holds) return;
  const ids = g.holds; g.holds = null;                       // zera ANTES: impossivel pagar duas vezes
  const hs = ids.map(id => DB.holds[id]);
  const w = g.winner;
  if ((w !== 0 && w !== 1) || !hs[0] || !hs[1]) { ids.forEach(id => releaseHold(id)); return; }   // sem vencedor claro: devolve tudo
  const pot = hs[0].cents + hs[1].cents, fee = Math.floor(pot * RAKE_PCT / 100), prize = pot - fee;
  ids.forEach(id => delete DB.holds[id]);
  ledgerAdd(hs[1 - w].email, 'aposta-perdida', 0, { room: g.room, vs: hs[w].email, perdeu: hs[1 - w].cents });
  if (fee > 0) ledgerAdd('casa', 'taxa', fee, { room: g.room, pot });
  addSaldo(hs[w].email, prize, 'aposta-ganha', { room: g.room, pot, taxa: fee, vs: hs[1 - w].email });
  console.log('PARTIDA PAGA:', hs[w].email, 'ganhou R$', (prize / 100).toFixed(2), 'de', hs[1 - w].email, '(sala R$', g.room + ', taxa R$', (fee / 100).toFixed(2) + ')');
  flushRemote().catch(e => console.error('Aviso: falha ao gravar no Upstash apos partida:', e.message));
}
// revanche em sala paga: cada um precisa reservar a aposta de novo
function rematchEscrow(g) {
  const ids = [];
  for (const sk of [0, 1]) {
    const w = g.sockets[sk];
    const id = w && w.readyState === 1 && w.game === g ? holdStake(w.email, g.stake, g.room) : null;
    if (!id) {
      ids.forEach(i => releaseHold(i));
      g.rematch.clear();
      for (const x of g.sockets) if (x) send(x, { t: 'info', m: 'Revanche cancelada: saldo insuficiente.' });
      return false;
    }
    ids.push(id);
  }
  g.holds = ids; g.misses = [0, 0];
  return true;
}
// servidor reiniciou: nenhuma partida sobrevive, entao toda reserva restante e devolvida
function refundOrphanHolds() {
  const ids = Object.keys(DB.holds);
  for (const id of ids) releaseHold(id, 'aposta-devolvida-reinicio');
  if (ids.length) console.log('Reservas devolvidas apos reinicio:', ids.length);
}

const wss = new WebSocketServer({ server });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const cleanName = n => String(n || 'Jogador').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Jogador';

function startMatch(a, b, room) {
  const stake = room ? stakeOf(room) : 0;
  if (stake && (!a.hold || !b.hold)) {   // nao deveria acontecer: sem as duas reservas nao ha partida valendo
    if (a.hold) { releaseHold(a.hold); a.hold = null; } if (b.hold) { releaseHold(b.hold); b.hold = null; }
    send(a, { t: 'error', m: 'Não foi possível iniciar a partida. Tente de novo.' }); send(b, { t: 'error', m: 'Não foi possível iniciar a partida. Tente de novo.' });
    return;
  }
  const g = new Game(a, b, false);
  g.room = room;
  if (stake) { g.stake = stake; g.holds = [a.hold, b.hold]; g.misses = [0, 0]; a.hold = null; b.hold = null; }
  a.game = g; a.seat = 0; b.game = g; b.seat = 1;
  games.add(g);
  send(a, { t: 'match', seat: 0, stake: stake / 100 }); send(b, { t: 'match', seat: 1, stake: stake / 100 });
  g.send(g.snap('Partida iniciada! Vez de ' + g.names[g.turn] + '.'));
  bcLobby();
}
function leave(ws) {
  if (ws.botTimer) { clearTimeout(ws.botTimer); ws.botTimer = null; }   // saiu da fila: cancela a entrada do robo
  if (ws.hold) { releaseHold(ws.hold); ws.hold = null; }   // saiu da fila: a reserva volta para o saldo
  if (ws.room) { const q = queues.get(ws.room); if (q) { const i = q.indexOf(ws); if (i >= 0) q.splice(i, 1); } ws.room = null; bcLobby(); }
  for (const [code, w] of rooms) if (w === ws) rooms.delete(code);
  const g = ws.game;
  if (!g) return;
  ws.game = null;
  games.delete(g);
  bcLobby();
  if (!g.solo && !g.over) {
    g.over = true; g.moving = false; g.deadline = 0; g.winner = 1 - ws.seat;
    settleGame(g);   // quem sai de uma partida valendo dinheiro perde a aposta
    const other = g.sockets[1 - ws.seat];
    if (other) send(other, g.snap(g.names[ws.seat] + ' saiu da partida. Voce venceu!'));
  }
}

// avisa todo mundo como estao as salas: quantos tem em cada uma e quem esta procurando partida (aparece no lobby)
let lobbyPending = false;
function lobbyState() {
  const r = {};
  for (const id of ROOM_IDS) {
    const q = queues.get(id).filter(w => w.readyState === 1);
    let n = q.length;
    for (const g of games) if (g.room === id) n += g.sockets.filter(w => w.readyState === 1).length;
    r[id] = { n, p: q.slice(0, 2).map(w => ({ nick: w.name, av: avatarOf(w.email && DB.users[w.email]) })) };
  }
  return JSON.stringify({ t: 'rooms', r });
}
function bcLobby() {
  if (lobbyPending) return;
  lobbyPending = true;
  setImmediate(() => { lobbyPending = false; const o = lobbyState(); for (const c of wss.clients) if (c.readyState === 1) c.send(o); });
}
// avisa todo mundo quantos jogadores estao conectados (aparece no lobby)
const bcOnline = () => { const o = JSON.stringify({ t: 'online', n: wss.clients.size }); for (const c of wss.clients) if (c.readyState === 1) c.send(o); };

wss.on('connection', (ws, req) => {
  bcOnline();
  ws.send(lobbyState());
  ws.alive = true; ws.name = 'Jogador'; ws.game = null; ws.seat = 0;
  // quem ja tem sessao (cookie) e reconhecido na hora, inclusive quando a conexao cai e volta
  ws.email = req ? sessionEmail(req) : null;
  { const u = ws.email && DB.users[ws.email]; if (u && u.nick) ws.name = u.nick; }
  if (ws.email) pushSaldo(ws.email);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    // identidade: quem esta logado usa sempre o apelido da conta (o site nao consegue "mentir" o nome)
    if (m.t === 'auth') {
      ws.email = redeemTicket(m.ticket);
      const u = ws.email && DB.users[ws.email]; if (u && u.nick) ws.name = u.nick;
      send(ws, { t: 'authed', ok: !!(u && u.nick) }); if (ws.email) pushSaldo(ws.email); return;
    }
    if (m.t === 'unauth') { ws.email = null; return; }
    const acc = ws.email && DB.users[ws.email];
    if (acc && acc.nick) ws.name = acc.nick;
    else if (m.name !== undefined) ws.name = cleanName(m.name);

    // so joga quem entrou na propria conta e ja escolheu o apelido
    if (['queue', 'create', 'join', 'practice', 'bot'].includes(m.t) && !(acc && acc.nick)) {
      send(ws, { t: 'needlogin' }); send(ws, { t: 'error', m: 'Entre na sua conta para jogar.' }); return;
    }

    if (m.t === 'queue') {
      leave(ws);
      const room = ROOM_IDS.includes(String(m.room)) ? String(m.room) : '0';
      const stake = stakeOf(room);
      if (stake) {
        if (!MP_ON) { send(ws, { t: 'error', m: 'Salas com valor estão indisponíveis no momento.' }); return; }
        if (!perfilOk(acc)) { send(ws, { t: 'error', m: 'Cadastre nome e CPF na carteira antes de jogar valendo dinheiro.' }); return; }
        if (saldoOf(acc) < stake) { send(ws, { t: 'error', m: 'Saldo insuficiente para esta sala.' }); return; }
        ws.hold = holdStake(ws.email, stake, room);
        if (!ws.hold) { send(ws, { t: 'error', m: 'Saldo insuficiente para esta sala.' }); return; }
      }
      const q = queues.get(room); let opp; const skipped = [];
      while ((opp = q.shift())) {
        if (opp === ws || opp.readyState !== 1) continue;
        if (stake && opp.email === ws.email) { skipped.push(opp); continue; }   // a mesma conta nunca joga contra si mesma
        break;
      }
      q.unshift(...skipped);
      if (opp) { opp.room = null; if (opp.botTimer) { clearTimeout(opp.botTimer); opp.botTimer = null; } startMatch(opp, ws, room); }
      else {
        q.push(ws); ws.room = room; send(ws, { t: 'wait', m: 'Procurando adversario...' }); bcLobby();
        if (!stake) {   // so a sala Gratis tem robo; salas com valor nunca
          ws.botTimer = setTimeout(() => {
            ws.botTimer = null;
            if (ws.readyState !== 1 || ws.room !== room || ws.game) return;
            const qq = queues.get(room), i = qq ? qq.indexOf(ws) : -1;
            if (i < 0) return;
            qq.splice(i, 1); ws.room = null; bcLobby();
            startBotMatch(ws);
          }, BOT_JOIN_MS);
        }
      }
    } else if (m.t === 'create') {
      leave(ws);
      const al = 'abcdefghjkmnpqrstuvwxyz23456789'; let code;
      do { code = ''; for (let i = 0; i < 4; i++) code += al[Math.floor(Math.random() * al.length)]; } while (rooms.has(code));
      rooms.set(code, ws);
      send(ws, { t: 'wait', m: 'Sala criada! Codigo: ' + code.toUpperCase() + ' (passe para seu amigo)' });
    } else if (m.t === 'join') {
      leave(ws);
      const code = String(m.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const host = rooms.get(code);
      if (!host || host.readyState !== 1 || host === ws) { send(ws, { t: 'error', m: 'Sala nao encontrada. Confira o codigo.' }); return; }
      rooms.delete(code); startMatch(host, ws);
    } else if (m.t === 'practice') {
      leave(ws);
      const g = new Game(ws, null, true); ws.game = g; ws.seat = 0; games.add(g);
      send(ws, { t: 'match', seat: 0, solo: true });
      g.send(g.snap('Treino livre: voce joga pelos dois lados.'));
    } else if (m.t === 'bot') {
      leave(ws);
      startBotMatch(ws);
    } else if (m.t === 'aim') {
      // repassa a mira (angulo + forca) de quem esta na vez para o adversario ver o taco e a linha
      const g = ws.game;
      if (!g || g.solo || g.over || g.moving || g.turn !== ws.seat || !g.sockets) return;
      const a = +m.a, p = +m.p;
      if (!isFinite(a) || !isFinite(p)) return;
      const o = JSON.stringify({ t: 'aim', a: +a.toFixed(4), p: +Math.max(0, Math.min(1, p)).toFixed(3) });
      for (const c of new Set(g.sockets)) if (c !== ws && c.readyState === 1) c.send(o);
    } else if (m.t === 'shot') {
      const g = ws.game;
      if (!g || g.moving || g.over) return;
      if (!g.solo && g.turn !== ws.seat) return;
      let vx = +m.vx, vy = +m.vy;
      if (!isFinite(vx) || !isFinite(vy)) return;
      const s = hyp(vx, vy);
      if (s < 0.03) return;   // barra 1 = 0.09, entao tacadas bem fracas passam
      if (s > 9) { vx = vx / s * 9; vy = vy / s * 9; }
      // curva de forca: so muda tacadas fracas/medias (forca 100% continua 9)
      const pw = Math.min(1, hyp(vx, vy) / 9), pf = Math.pow(pw, POWER_CURVE) / pw;
      vx *= pf; vy *= pf;
      // efeito escolhido no site (sx = lado, sy = cima/baixo); valores invalidos viram "centro"
      let sx = +m.sx, sy = +m.sy;
      if (!isFinite(sx)) sx = 0;
      if (!isFinite(sy)) sy = 0;
      const sl = hyp(sx, sy);
      if (sl > SPIN_MAX) { sx = sx / sl * SPIN_MAX; sy = sy / sl * SPIN_MAX; }
      if (g.misses) g.misses[ws.seat] = 0;
      { const [px, py] = powerVec(vx, vy); g.shoot(px, py, sx, sy); }
    } else if (m.t === 'again') {
      const g = ws.game;
      if (!g || !g.over) return;
      if (g.solo) { g.reset(); g.send(g.snap('Nova partida de treino!')); return; }
      if (g.bot) { g.starter = 1 - g.starter; g.reset(); g.send(g.snap('Nova partida! Vez de ' + g.names[g.turn] + '.')); botSchedule(g); return; }
      g.rematch.add(ws.seat);
      if (g.rematch.size === 2) { if (g.stake && !rematchEscrow(g)) return; g.starter = 1 - g.starter; g.reset(); g.send(g.snap('Nova partida! Vez de ' + g.names[g.turn] + '.')); }
      else send(ws, { t: 'info', m: 'Esperando o adversario aceitar...' });
    } else if (m.t === 'leave') {
      leave(ws); send(ws, { t: 'lobby' });
    }
  });
  ws.on('close', () => { leave(ws); bcOnline(); bcLobby(); });
  ws.on('error', () => {});
});

// ---------- relogio da fisica: 60x por segundo ----------
setInterval(() => {
  const now = Date.now();
  for (const g of games) {
    if (!g.moving && g.deadline && !g.over && now >= g.deadline) {
      // tempo esgotado: passa a vez (em sala paga, 3 vezes seguidas sem jogar = perde, para a aposta nao ficar presa)
      if (g.holds && g.misses && ++g.misses[g.turn] >= 3) {
        g.over = true; g.deadline = 0; g.winner = 1 - g.turn; settleGame(g);
        g.send(g.snap(g.names[g.turn] + ' ficou sem jogar e perdeu a partida.'));
        continue;
      }
      g.turn = 1 - g.turn; g.armTimer();
      g.send(g.snap('Tempo esgotado! Vez de ' + g.names[g.turn] + '.'));
      botSchedule(g);
      continue;
    }
    if (!g.moving) continue;
    for (let s = 0; s < 4; s++) g.step();
    g.tick++;
    if (g.allStopped()) { const msg = g.endTurn(); if (msg !== null) { if (g.over) settleGame(g); g.send(g.snap(msg)); botSchedule(g); } }
    else g.send(g.snap());
  }
}, 1000 / 60);

// ---------- limpa conexoes mortas (e mantem o servidor acordado) ----------
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 25000);

(async () => {
  // se o Upstash estiver configurado mas nao responder, NAO abre o servidor (comecar do zero apagaria os saldos de todo mundo)
  for (let i = 1; ; i++) {
    try { await loadRemote(); break; }
    catch (e) {
      if (i >= 5) { console.error('Nao foi possivel ler as contas do Upstash. Encerrando para NAO sobrescrever os saldos. O Render tenta de novo sozinho.'); process.exit(1); }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  refundOrphanHolds();
  server.listen(PORT, () => console.log('Sinuca online rodando na porta ' + PORT));
  setTimeout(() => reconcileDeposits().catch(() => {}), 5000);
})();
