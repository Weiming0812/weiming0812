// 鐘點戰 (Time War) — 多人同時連線伺服器
// 啟動：npm install && npm start   然後開啟 http://localhost:3000
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ---- 遊戲參數 ----
const MIN_START_SEC = 10 * 60;   // 起始時間下限 10 分
const MAX_START_SEC = 20 * 60;   // 起始時間上限 20 分
const COUNTDOWN_MS = 3000;       // 開始前 3 秒倒數
const MAX_PLAYERS = 40;
const MAX_CARDS = 100;
const MAX_CARD_SEC = 3600;       // 單張卡片最多 ±60 分
const WRONG_LIMIT = 5;           // 連續輸錯幾次鎖定
const LOCK_MS = 15000;
const DISCONNECT_GRACE_MS = 30000;

// ---- 房間狀態（全站只有一間房） ----
const room = {
  phase: 'lobby',      // lobby | playing
  round: 0,
  startAt: 0,
  hostId: null,
  players: new Map(),  // id -> player
  cards: [],           // {id, code, seconds, usedBy, usedByName}
  shares: [],          // {code, seconds, fromId, usedBy, usedByName}
  codes: new Map(),    // code -> {type:'card'|'share', ref}
  log: [],
  lastWinner: null,
};

const rid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

function genCode() {
  if (room.codes.size >= 10000) return null;
  for (;;) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!room.codes.has(c)) return c;
  }
}

function addCard(seconds) {
  const code = genCode();
  if (!code) return null;
  const card = { id: rid(), code, seconds, usedBy: null, usedByName: null };
  room.cards.push(card);
  room.codes.set(code, { type: 'card', ref: card });
  return card;
}

function pushLog(text) {
  room.log.push({ t: now(), text });
  if (room.log.length > 30) room.log.shift();
}

// 預設卡片（房主可自行調整）
[300, 180, 120, 60, -60, -180].forEach(addCard);

// ---- 工具 ----
function send(p, msg) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}
function toast(p, kind, text, extra) {
  send(p, Object.assign({ type: 'toast', kind, text }, extra || {}));
}
function connectedPlayers() {
  return [...room.players.values()].filter((p) => p.connected);
}
function alivePlayers() {
  return [...room.players.values()].filter((p) => p.status === 'playing');
}
function ensureHost() {
  const h = room.players.get(room.hostId);
  if (h && h.connected) return;
  const next = [...room.players.values()]
    .filter((p) => p.connected)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostId = next ? next.id : null;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    connected: p.connected,
    isHost: p.id === room.hostId,
  };
}

function stateFor(p) {
  const isHost = p.id === room.hostId;
  const st = {
    type: 'state',
    now: now(),
    phase: room.phase,
    round: room.round,
    startAt: room.startAt,
    lastWinner: room.lastWinner,
    you: {
      id: p.id,
      name: p.name,
      status: p.status,
      deadline: p.deadline,
      initial: p.initial,
      isHost,
      lockUntil: p.lockUntil,
    },
    players: [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicPlayer),
    aliveCount: alivePlayers().length,
    log: room.log.slice(-8),
    myShares: room.shares
      .filter((s) => s.fromId === p.id)
      .map((s) => ({ code: s.code, seconds: s.seconds, used: !!s.usedBy, usedByName: s.usedByName })),
  };
  if (isHost) {
    st.cards = room.cards.map((c) => ({
      id: c.id, code: c.code, seconds: c.seconds, used: !!c.usedBy, usedByName: c.usedByName,
    }));
  }
  return st;
}

function broadcast() {
  for (const p of room.players.values()) if (p.connected) send(p, stateFor(p));
}

// ---- 勝負判定 ----
function checkEliminations() {
  if (room.phase !== 'playing') return;
  const t = now();
  if (t < room.startAt) return;
  const expired = alivePlayers().filter((p) => p.deadline <= t);
  if (!expired.length) return;
  for (const p of expired) {
    p.status = 'out';
    pushLog(`${p.name} 的時間歸零，被淘汰`);
  }
  const left = alivePlayers();
  if (left.length <= 1) {
    // 同時歸零時，撐最久的人視為最後存活者
    const winner = left[0] || expired.sort((a, b) => b.deadline - a.deadline)[0];
    winner.status = 'won';
    room.phase = 'lobby';
    room.lastWinner = winner.name;
    pushLog(`🏆 ${winner.name} 是最後的倖存者`);
  }
  ensureHost();
  broadcast();
}

// ---- 動作處理 ----
function parseSeconds(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const s = Math.round(n);
  if (s < min || s > max) return null;
  return s;
}

const handlers = {
  start(p) {
    if (p.id !== room.hostId) return toast(p, 'error', '只有房主可以開始遊戲');
    if (room.phase !== 'lobby') return toast(p, 'error', '遊戲進行中');
    const entrants = connectedPlayers().filter((x) => x.status === 'lobby');
    if (entrants.length < 2) return toast(p, 'error', '至少需要 2 位在等候室的玩家');

    // 重置密碼：卡片全部恢復未使用、清除上一局的分享密碼
    for (const s of room.shares) room.codes.delete(s.code);
    room.shares = [];
    for (const c of room.cards) { c.usedBy = null; c.usedByName = null; }

    room.round += 1;
    room.phase = 'playing';
    room.startAt = now() + COUNTDOWN_MS;
    room.lastWinner = null;
    room.log = [];
    for (const x of entrants) {
      const sec = crypto.randomInt(MIN_START_SEC, MAX_START_SEC + 1);
      x.initial = sec * 1000;
      x.deadline = room.startAt + x.initial;
      x.status = 'playing';
      x.wrong = 0;
      x.lockUntil = 0;
    }
    pushLog(`第 ${room.round} 局開始，共 ${entrants.length} 位玩家`);
    broadcast();
  },

  redeem(p, m) {
    if (room.phase !== 'playing' || p.status !== 'playing') return toast(p, 'error', '目前無法輸入密碼');
    const t = now();
    if (t < room.startAt) return toast(p, 'error', '遊戲尚未開始');
    if (t < p.lockUntil) {
      return toast(p, 'error', `輸入錯誤過多，請 ${Math.ceil((p.lockUntil - t) / 1000)} 秒後再試`);
    }
    const code = String(m.code || '');
    if (!/^\d{4}$/.test(code)) return toast(p, 'error', '請輸入 4 位數字密碼');

    const fail = (text) => {
      p.wrong += 1;
      if (p.wrong >= WRONG_LIMIT) {
        p.wrong = 0;
        p.lockUntil = t + LOCK_MS;
        text += `（連續錯誤，鎖定 ${LOCK_MS / 1000} 秒）`;
        send(p, stateFor(p));
      }
      toast(p, 'error', text);
    };

    const entry = room.codes.get(code);
    if (!entry) return fail('無效的密碼');
    const item = entry.ref;
    if (item.usedBy) return fail('這組密碼已被使用過');
    if (entry.type === 'share' && item.fromId === p.id) return fail('不能使用自己產生的密碼');

    item.usedBy = p.id;
    item.usedByName = p.name;
    p.wrong = 0;
    p.deadline += item.seconds * 1000;

    if (item.seconds >= 0) {
      toast(p, 'gain', entry.type === 'share' ? '隊友分享的時間' : '找到隱藏卡片！', { seconds: item.seconds });
    } else {
      toast(p, 'loss', '驚人的懲罰！', { seconds: item.seconds });
    }
    if (entry.type === 'share') {
      const from = room.players.get(item.fromId);
      if (from) toast(from, 'info', `${p.name} 已使用你分享的密碼 ${code}`);
    }
    checkEliminations();
    broadcast();
  },

  share(p, m) {
    if (room.phase !== 'playing' || p.status !== 'playing') return toast(p, 'error', '目前無法分享時間');
    const t = now();
    if (t < room.startAt) return toast(p, 'error', '遊戲尚未開始');
    const sec = parseSeconds(m.seconds, 1, 24 * 3600);
    if (!sec) return toast(p, 'error', '請輸入有效的分享時間');
    const remain = p.deadline - t;
    if (remain <= sec * 1000 + 1000) return toast(p, 'error', '時間不夠！分享後至少要留下 1 秒');
    const code = genCode();
    if (!code) return toast(p, 'error', '密碼已用盡，無法分享');
    p.deadline -= sec * 1000;
    const share = { code, seconds: sec, fromId: p.id, usedBy: null, usedByName: null };
    room.shares.push(share);
    room.codes.set(code, { type: 'share', ref: share });
    toast(p, 'share', '分享密碼已產生', { seconds: -sec, code });
    broadcast();
  },

  restart(p) {
    if (p.status === 'out' || p.status === 'won') {
      p.status = 'lobby';
      p.deadline = 0;
      p.initial = 0;
      broadcast();
    }
  },

  // ---- 房主：卡片設定 ----
  addCards(p, m) {
    if (p.id !== room.hostId) return;
    const sec = parseSeconds(m.seconds, -MAX_CARD_SEC, MAX_CARD_SEC);
    if (!sec) return toast(p, 'error', '請輸入有效的時間（不可為 0）');
    const count = parseSeconds(m.count || 1, 1, 50);
    if (!count) return toast(p, 'error', '數量需為 1~50');
    if (room.cards.length + count > MAX_CARDS) return toast(p, 'error', `卡片最多 ${MAX_CARDS} 張`);
    for (let i = 0; i < count; i++) if (!addCard(sec)) break;
    broadcast();
  },
  updateCard(p, m) {
    if (p.id !== room.hostId) return;
    const c = room.cards.find((x) => x.id === m.id);
    if (!c) return;
    if (c.usedBy) return toast(p, 'error', '已被使用的卡片無法修改');
    const sec = parseSeconds(m.seconds, -MAX_CARD_SEC, MAX_CARD_SEC);
    if (!sec) return toast(p, 'error', '請輸入有效的時間（不可為 0）');
    c.seconds = sec;
    broadcast();
  },
  deleteCard(p, m) {
    if (p.id !== room.hostId) return;
    const i = room.cards.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    room.codes.delete(room.cards[i].code);
    room.cards.splice(i, 1);
    broadcast();
  },
  regenCards(p) {
    if (p.id !== room.hostId) return;
    for (const c of room.cards) {
      if (c.usedBy) continue;
      room.codes.delete(c.code);
      const nc = genCode();
      if (nc) { c.code = nc; room.codes.set(nc, { type: 'card', ref: c }); }
      else room.codes.set(c.code, { type: 'card', ref: c });
    }
    broadcast();
  },
};

// ---- WebSocket ----
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  let player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t, now: now() }));

    if (m.type === 'join') {
      if (player) return;
      let existing = null;
      if (typeof m.token === 'string') {
        existing = [...room.players.values()].find((x) => x.token === m.token);
      }
      if (existing) {
        if (existing.ws && existing.ws !== ws) { try { existing.ws.close(); } catch {} }
        existing.ws = ws;
        existing.connected = true;
        existing.disconnectedAt = 0;
        player = existing;
      } else {
        if (room.players.size >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'fatal', text: '房間已滿' }));
          return ws.close();
        }
        const name = String(m.name || '').trim().slice(0, 12) || `玩家${room.players.size + 1}`;
        player = {
          id: rid(), token: crypto.randomBytes(16).toString('hex'), name, ws, connected: true,
          status: 'lobby', deadline: 0, initial: 0, joinedAt: now(), wrong: 0, lockUntil: 0, disconnectedAt: 0,
        };
        room.players.set(player.id, player);
      }
      ensureHost();
      send(player, { type: 'welcome', token: player.token, id: player.id });
      broadcast();
      return;
    }

    if (!player) return;
    const h = handlers[m.type];
    if (h) h(player, m);
  });

  ws.on('close', () => {
    if (!player || player.ws !== ws) return;
    player.connected = false;
    player.disconnectedAt = now();
    ensureHost();
    broadcast();
  });
  ws.on('error', () => {});
});

// 遊戲主迴圈：淘汰判定 + 清理斷線玩家
setInterval(checkEliminations, 200);
setInterval(() => {
  const t = now();
  let changed = false;
  for (const p of [...room.players.values()]) {
    if (!p.connected && p.status !== 'playing' && t - p.disconnectedAt > DISCONNECT_GRACE_MS) {
      room.players.delete(p.id);
      changed = true;
    }
  }
  if (changed) { ensureHost(); broadcast(); }
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

server.listen(PORT, () => console.log(`鐘點戰 server running: http://localhost:${PORT}`));
