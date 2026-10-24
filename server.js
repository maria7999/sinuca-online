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
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

// ---------- servidor do site ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Pagina nao encontrada'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- mesa ----------
const W = 800, H = 400, R = 10, M = 30, PR = 21;
const PK = [[24, 24], [400, 20], [776, 24], [24, 376], [400, 380], [776, 376]];
const hyp = (a, b) => Math.sqrt(a * a + b * b);
const grpOf = n => (n < 8 ? 'solid' : 'stripe');

class Game {
  constructor(a, b, solo) {
    this.solo = !!solo;
    this.names = [a.name, solo ? 'Treino' : b.name];
    this.sockets = solo ? [a] : [a, b];
    this.starter = 0;
    this.rematch = new Set();
    this.reset();
  }
  reset() {
    const nums = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15].sort(() => Math.random() - 0.5);
    nums.splice(4, 0, 8);
    this.B = [{ x: 230, y: 200, vx: 0, vy: 0, n: 0, a: 1 }];
    let k = 0;
    for (let c = 0; c < 5; c++)
      for (let r = 0; r <= c; r++)
        this.B.push({ x: 560 + c * R * 1.75, y: 200 + (r - c / 2) * R * 2.04, vx: 0, vy: 0, n: nums[k++], a: 1 });
    this.turn = this.starter; this.grp = [null, null];
    this.moving = false; this.over = false; this.winner = null;
    this.info = { p: [], f: null };
    this.rematch.clear();
  }
  left(g) { return this.B.filter(b => b.a && b.n && b.n !== 8 && grpOf(b.n) === g).length; }
  shoot(vx, vy) {
    const c = this.B[0];
    c.vx = vx; c.vy = vy; this.moving = true; this.info = { p: [], f: null };
  }
  step() {
    for (const b of this.B) {
      if (!b.a) continue;
      b.x += b.vx; b.y += b.vy; b.vx *= 0.9925; b.vy *= 0.9925;
      if (hyp(b.vx, b.vy) < 0.03) { b.vx = 0; b.vy = 0; }
    }
    for (let i = 0; i < this.B.length; i++) {
      const a = this.B[i]; if (!a.a) continue;
      for (let j = i + 1; j < this.B.length; j++) {
        const b = this.B[j]; if (!b.a) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy);
        if (d < 2 * R && d > 0) {
          if (this.info.f === null && (a.n === 0 || b.n === 0)) this.info.f = a.n === 0 ? b.n : a.n;
          const nx = dx / d, ny = dy / d, o = (2 * R - d) / 2;
          a.x -= nx * o; a.y -= ny * o; b.x += nx * o; b.y += ny * o;
          const p = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (p > 0) { a.vx -= p * nx; a.vy -= p * ny; b.vx += p * nx; b.vy += p * ny; }
        }
      }
    }
    for (const b of this.B) {
      if (!b.a) continue;
      for (const p of PK) if (hyp(b.x - p[0], b.y - p[1]) < PR) { b.a = 0; b.vx = b.vy = 0; this.info.p.push(b.n); }
      if (!b.a) continue;
      if (PK.some(p => hyp(b.x - p[0], b.y - p[1]) < R * 3.2)) continue;
      if (b.x < M + R) { b.x = M + R; b.vx = -b.vx * 0.9; }
      if (b.x > W - M - R) { b.x = W - M - R; b.vx = -b.vx * 0.9; }
      if (b.y < M + R) { b.y = M + R; b.vy = -b.vy * 0.9; }
      if (b.y > H - M - R) { b.y = H - M - R; b.vy = -b.vy * 0.9; }
    }
  }
  allStopped() { return this.B.every(b => !b.a || (b.vx === 0 && b.vy === 0)); }
  // Regras: roda quando todas as bolas param. Devolve a mensagem da jogada.
  endTurn() {
    this.moving = false;
    const cue = this.B[0], p = this.info.p, me = this.turn, N = this.names;
    let foul = !cue.a || this.info.f === null;
    if (!foul && this.grp[me] && this.info.f !== null) {
      const need = this.left(this.grp[me]) > 0 ? this.grp[me] : 'eight';
      if (need === 'eight' ? this.info.f !== 8 : (this.info.f === 8 || grpOf(this.info.f) !== need)) foul = true;
    }
    if (p.includes(8)) {
      const ok = !foul && this.grp[me] && this.left(this.grp[me]) === 0;
      this.over = true; this.winner = ok ? me : 1 - me;
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
    if (!cue.a) {
      cue.a = 1; cue.x = 230; cue.y = 200; cue.vx = cue.vy = 0;
      while (this.B.some(b => b !== cue && b.a && hyp(b.x - cue.x, b.y - cue.y) < 2 * R)) cue.x -= 2 * R;
    }
    if (!keep) this.turn = 1 - this.turn;
    this.info = { p: [], f: null };
    return (foul ? 'Falta! ' : '') + 'Vez de ' + N[this.turn] + '.';
  }
  snap(m) {
    return {
      t: 'state',
      b: this.B.map(b => [b.n, +b.x.toFixed(1), +b.y.toFixed(1), b.a]),
      turn: this.turn, grp: this.grp, moving: this.moving, over: this.over, winner: this.winner,
      names: this.names, m
    };
  }
  send(obj) {
    const s = JSON.stringify(obj);
    for (const ws of new Set(this.sockets)) if (ws.readyState === 1) ws.send(s);
  }
}

// ---------- conexoes, fila e salas ----------
const games = new Set();
let waiting = null;
const rooms = new Map();

const wss = new WebSocketServer({ server });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const cleanName = n => String(n || 'Jogador').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Jogador';

function startMatch(a, b) {
  const g = new Game(a, b, false);
  a.game = g; a.seat = 0; b.game = g; b.seat = 1;
  games.add(g);
  send(a, { t: 'match', seat: 0 }); send(b, { t: 'match', seat: 1 });
  g.send(g.snap('Partida iniciada! Vez de ' + g.names[g.turn] + '.'));
}
function leave(ws) {
  if (waiting === ws) waiting = null;
  for (const [code, w] of rooms) if (w === ws) rooms.delete(code);
  const g = ws.game;
  if (!g) return;
  ws.game = null;
  games.delete(g);
  if (!g.solo && !g.over) {
    g.over = true; g.moving = false; g.winner = 1 - ws.seat;
    const other = g.sockets[1 - ws.seat];
    if (other) send(other, g.snap(g.names[ws.seat] + ' saiu da partida. Voce venceu!'));
  }
}

wss.on('connection', ws => {
  ws.alive = true; ws.name = 'Jogador'; ws.game = null; ws.seat = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.name !== undefined) ws.name = cleanName(m.name);

    if (m.t === 'queue') {
      leave(ws);
      if (waiting && waiting !== ws && waiting.readyState === 1) { const o = waiting; waiting = null; startMatch(o, ws); }
      else { waiting = ws; send(ws, { t: 'wait', m: 'Procurando adversario...' }); }
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
    } else if (m.t === 'shot') {
      const g = ws.game;
      if (!g || g.moving || g.over) return;
      if (!g.solo && g.turn !== ws.seat) return;
      let vx = +m.vx, vy = +m.vy;
      if (!isFinite(vx) || !isFinite(vy)) return;
      const s = hyp(vx, vy);
      if (s < 0.2) return;
      if (s > 9) { vx = vx / s * 9; vy = vy / s * 9; }
      g.shoot(vx, vy);
    } else if (m.t === 'again') {
      const g = ws.game;
      if (!g || !g.over) return;
      if (g.solo) { g.reset(); g.send(g.snap('Nova partida de treino!')); return; }
      g.rematch.add(ws.seat);
      if (g.rematch.size === 2) { g.starter = 1 - g.starter; g.reset(); g.send(g.snap('Nova partida! Vez de ' + g.names[g.turn] + '.')); }
      else send(ws, { t: 'info', m: 'Esperando o adversario aceitar...' });
    } else if (m.t === 'leave') {
      leave(ws); send(ws, { t: 'lobby' });
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// ---------- relogio da fisica: 60x por segundo ----------
setInterval(() => {
  for (const g of games) {
    if (!g.moving) continue;
    for (let s = 0; s < 4; s++) g.step();
    if (g.allStopped()) { const msg = g.endTurn(); g.send(g.snap(msg)); }
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

server.listen(PORT, () => console.log('Sinuca online rodando na porta ' + PORT));
