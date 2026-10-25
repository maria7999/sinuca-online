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

// ---------- efeito na bola branca ----------
// sy < 0 (parte de cima da bola): "seguir"  -> a branca anda para frente depois de bater
// sy > 0 (parte de baixo da bola): "puxar" -> a branca volta depois de bater
// sx (esquerda/direita): efeito lateral -> muda o angulo do rebote nas almofadas
// Os valores sao sempre em relacao a direcao da tacada (como no taco de verdade).
const FRICTION = 0.9995;  // atrito do pano (proporcional): mais perto de 1 = as bolas rolam mais
const DECEL = 0.012;       // atrito extra do pano. Ele vai ficando mais fraco quando a bola esta devagar (ver DECEL_K), por isso a bola nao "freia"
const DECEL_K = 0.15;      // quanto menor, mais cedo o atrito extra some e a bola termina rolando devagarzinho
const SUB = 4;             // subpassos por passo de fisica: movimento mais liso e bolas rapidas nao atravessam umas as outras
const POCKET_ZONE = 28;    // raio da boca da cacapa (sem almofada). Maior = cacapa mais "gulosa"
const POCKET_SLOW = 2;     // bola mais devagar que isso, dentro da boca, cai na cacapa
const POCKET_PULL = 0.1;   // puxao leve para dentro da cacapa
const BALL_E = 0.96;       // quicada entre bolas (1 = perfeita, menor = perde um pouco de energia)
const POWER = 1.45;        // multiplica a forca da tacada (1 = original). A tacada mais forte vira 13 em vez de 9
const POWER_CURVE = 0.7;   // curva da forca: 1 = linear; menor que 1 = tacadas medias andam mais (a forte continua igual)
const BOUNCE = 0.72;       // quanto da velocidade a bola guarda ao bater na almofada devagar; batida forte perde mais (ver cb). Menor = almofada mais "fofa" (a bola nao fica quicando)
const cb = v => Math.max(0.50, BOUNCE - 0.010 * Math.abs(v));
const SPIN_MAX = 0.72;       // mesmo limite do seletor no site
const SPIN_VERT = 0.8;       // forca do seguir/puxar no primeiro contato
const SPIN_CUSHION = 0.35;   // forca do efeito lateral nas almofadas
const TURN_MS = +process.env.TURN_MS || 20000;   // tempo para cada jogada
const SPIN_DECAY = 0.9993;   // o efeito lateral vai acabando com o tempo

class Game {
  constructor(a, b, solo, bot) {
    this.solo = !!solo;
    this.bot = !!bot;                       // partida contra o robo (ele joga pelo assento 1)
    this.botBusy = false;
    this.names = [a.name, bot ? 'Robô' : solo ? 'Treino' : b.name];
    this.sockets = (solo || bot) ? [a] : [a, b];
    this.starter = 0;
    this.rematch = new Set();
    this.reset();
  }
  reset() {
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
    c.w = -sx;                              // efeito lateral (+ = giro horario visto de cima)
    this.spun = false;
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
    for (const b of this.B) {
      if (!b.a) continue;
      b.x += b.vx * h; b.y += b.vy * h;
      const sp = hyp(b.vx, b.vy);
      if (sp > 0) { const ns = sp * Math.pow(FRICTION, h) - DECEL * h * sp / (sp + DECEL_K), k = ns > 0.01 ? ns / sp : 0; b.vx *= k; b.vy *= k; }
      if (b.n === 0) b.w *= Math.pow(SPIN_DECAY, h);
      if (hyp(b.vx, b.vy) < 0.02) { b.vx = 0; b.vy = 0; }
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
      // cacapas: dentro do raio PR a bola cai. Na boca da cacapa (ate POCKET_ZONE) nao tem almofada:
      // a bola que passou da linha da almofada, ou que esta devagar, cai; as outras sao puxadas de leve para dentro.
      // Assim nao existe mais bola parada na boca da cacapa nem "entra e volta".
      const outside = b.x < M + R || b.x > W - M - R || b.y < M + R || b.y > H - M - R;
      let inMouth = false;
      for (const p of PK) {
        const dx = p[0] - b.x, dy = p[1] - b.y, d = hyp(dx, dy);
        if (d < PR || (d < POCKET_ZONE && (outside || hyp(b.vx, b.vy) < POCKET_SLOW))) {
          b.a = 0; b.vx = b.vy = 0; this.info.p.push(b.n); inMouth = true; break;
        }
        if (d < POCKET_ZONE) { inMouth = true; b.vx += dx / d * POCKET_PULL * h; b.vy += dy / d * POCKET_PULL * h; }
      }
      if (!b.a || inMouth) continue;
      if (b.x < M + R) { const v = b.vx; b.x = M + R; b.vx = -b.vx * cb(v); this.cushionKick(b, -1, 0, v); }
      if (b.x > W - M - R) { const v = b.vx; b.x = W - M - R; b.vx = -b.vx * cb(v); this.cushionKick(b, 1, 0, v); }
      if (b.y < M + R) { const v = b.vy; b.y = M + R; b.vy = -b.vy * cb(v); this.cushionKick(b, 0, -1, v); }
      if (b.y > H - M - R) { const v = b.vy; b.y = H - M - R; b.vy = -b.vy * cb(v); this.cushionKick(b, 0, 1, v); }
    }
  }
  allStopped() { return this.B.every(b => !b.a || (b.vx === 0 && b.vy === 0)); }
  // Regras: roda quando todas as bolas param. Devolve a mensagem da jogada.
  endTurn() {
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
    if (!cue.a) {
      cue.a = 1; cue.x = 230; cue.y = 200; cue.vx = cue.vy = 0;
      while (this.B.some(b => b !== cue && b.a && hyp(b.x - cue.x, b.y - cue.y) < 2 * R)) cue.x -= 2 * R;
    }
    if (!keep) this.turn = 1 - this.turn;
    this.info = { p: [], f: null };
    this.armTimer();
    return (foul ? 'Falta! ' : '') + 'Vez de ' + N[this.turn] + '.';
  }
  snap(m) {
    const o = {
      t: 'state',
      b: this.B.map(b => [b.n, +b.x.toFixed(1), +b.y.toFixed(1), b.a]),
      turn: this.turn, grp: this.grp, moving: this.moving, over: this.over, winner: this.winner,
      names: this.names, m,
      tl: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      k: this.tick || 0
    };
    // a cada 6 relogios (e no primeiro) manda tambem velocidades e efeito da branca: o navegador refaz a fisica a partir dai
    if (this.moving && (this.tick || 0) % 6 === 1) {
      const c = this.B[0];
      o.v = this.B.map(b => [+b.vx.toFixed(4), +b.vy.toFixed(4)]);
      o.cs = [+c.w.toFixed(4), +c.top.toFixed(4), +c.ux.toFixed(4), +c.uy.toFixed(4), this.spun ? 1 : 0];
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
const BOT_THINK_MS = 1100;   // tempo que o robo "pensa" antes de tacar
const BOT_SPEEDS = [3, 4.5, 6.5, 9];   // forcas testadas (antes do POWER)
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
  s.shoot(vx * POWER, vy * POWER, 0, 0);
  for (let i = 0; i < 2500 && !s.allStopped(); i++) s.step();
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
function botHumanize(p) {
  const s = hyp(p.vx, p.vy), a0 = Math.atan2(p.vy, p.vx);
  if (Math.random() >= BOT_MISS) {                                          // tacada "certa": so com uma tremidinha
    const a = a0 + gauss() * BOT_JITTER;
    return { vx: Math.cos(a) * s, vy: Math.sin(a) * s };
  }
  const sg = Math.random() < 0.5 ? -1 : 1;
  const a = a0 + sg * (BOT_ERR_MIN + Math.random() * (BOT_ERR_MAX - BOT_ERR_MIN));   // erra a mira
  const v = Math.min(9, s * (0.8 + Math.random() * 0.4));                   // e a forca em +-20%
  return { vx: Math.cos(a) * v, vy: Math.sin(a) * v };
}

// planeja e toca a vez do robo (sem travar as outras partidas: trabalha em pedacinhos de 5 ms)
function botSchedule(g) {
  if (!g.bot || g.over || g.turn !== 1 || g.moving || g.botBusy) return;
  g.botBusy = true;
  const t0 = Date.now(), it = botPlanGen(g, 1);
  const work = () => {
    if (!games.has(g) || g.over) { g.botBusy = false; return; }
    const end = Date.now() + 5; let r;
    do { r = it.next(); } while (!r.done && Date.now() < end);
    if (!r.done) { setImmediate(work); return; }
    setTimeout(() => {
      g.botBusy = false;
      if (!games.has(g) || g.over || g.moving || g.turn !== 1) return;
      let { vx, vy } = botHumanize(r.value); const s = hyp(vx, vy);
      if (s > 9) { vx = vx / s * 9; vy = vy / s * 9; }
      g.shoot(vx * POWER, vy * POWER, 0, 0);
    }, Math.max(0, BOT_THINK_MS - (Date.now() - t0)));
  };
  setImmediate(work);
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
    g.over = true; g.moving = false; g.deadline = 0; g.winner = 1 - ws.seat;
    const other = g.sockets[1 - ws.seat];
    if (other) send(other, g.snap(g.names[ws.seat] + ' saiu da partida. Voce venceu!'));
  }
}

// avisa todo mundo quantos jogadores estao conectados (aparece no lobby)
const bcOnline = () => { const o = JSON.stringify({ t: 'online', n: wss.clients.size }); for (const c of wss.clients) if (c.readyState === 1) c.send(o); };

wss.on('connection', ws => {
  bcOnline();
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
    } else if (m.t === 'bot') {
      leave(ws);
      const g = new Game(ws, null, false, true); ws.game = g; ws.seat = 0; games.add(g);
      send(ws, { t: 'match', seat: 0, bot: true });
      g.send(g.snap('Partida contra o Robô! Vez de ' + g.names[g.turn] + '.'));
      botSchedule(g);
    } else if (m.t === 'shot') {
      const g = ws.game;
      if (!g || g.moving || g.over) return;
      if (!g.solo && g.turn !== ws.seat) return;
      let vx = +m.vx, vy = +m.vy;
      if (!isFinite(vx) || !isFinite(vy)) return;
      const s = hyp(vx, vy);
      if (s < 0.2) return;
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
      g.shoot(vx * POWER, vy * POWER, sx, sy);
    } else if (m.t === 'again') {
      const g = ws.game;
      if (!g || !g.over) return;
      if (g.solo) { g.reset(); g.send(g.snap('Nova partida de treino!')); return; }
      if (g.bot) { g.starter = 1 - g.starter; g.reset(); g.send(g.snap('Nova partida! Vez de ' + g.names[g.turn] + '.')); botSchedule(g); return; }
      g.rematch.add(ws.seat);
      if (g.rematch.size === 2) { g.starter = 1 - g.starter; g.reset(); g.send(g.snap('Nova partida! Vez de ' + g.names[g.turn] + '.')); }
      else send(ws, { t: 'info', m: 'Esperando o adversario aceitar...' });
    } else if (m.t === 'leave') {
      leave(ws); send(ws, { t: 'lobby' });
    }
  });
  ws.on('close', () => { leave(ws); bcOnline(); });
  ws.on('error', () => {});
});

// ---------- relogio da fisica: 60x por segundo ----------
setInterval(() => {
  const now = Date.now();
  for (const g of games) {
    if (!g.moving && g.deadline && !g.over && now >= g.deadline) {
      // tempo esgotado: passa a vez
      g.turn = 1 - g.turn; g.armTimer();
      g.send(g.snap('Tempo esgotado! Vez de ' + g.names[g.turn] + '.'));
      botSchedule(g);
      continue;
    }
    if (!g.moving) continue;
    for (let s = 0; s < 4; s++) g.step();
    g.tick++;
    if (g.allStopped()) { const msg = g.endTurn(); g.send(g.snap(msg)); botSchedule(g); }
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
