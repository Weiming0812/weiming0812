(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 七段式顯示器 ----------
const SEG = { // a b c d e f g
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};
function hseg(cx, cy, len, th) {
  const l = cx - len / 2, r = cx + len / 2, h = th / 2;
  return `${l},${cy} ${l + h},${cy - h} ${r - h},${cy - h} ${r},${cy} ${r - h},${cy + h} ${l + h},${cy + h}`;
}
function vseg(cx, cy, len, th) {
  const t = cy - len / 2, b = cy + len / 2, h = th / 2;
  return `${cx},${t} ${cx + h},${t + h} ${cx + h},${b - h} ${cx},${b} ${cx - h},${b - h} ${cx - h},${t + h}`;
}
const TH = 7, W = 44, H = 80;
const SEG_POLY = {
  a: hseg(W / 2, TH / 2 + 1, 33, TH), g: hseg(W / 2, H / 2, 33, TH), d: hseg(W / 2, H - TH / 2 - 1, 33, TH),
  f: vseg(TH / 2 + 1, H / 4 + 1, 34, TH), b: vseg(W - TH / 2 - 1, H / 4 + 1, 34, TH),
  e: vseg(TH / 2 + 1, H * 3 / 4 - 1, 34, TH), c: vseg(W - TH / 2 - 1, H * 3 / 4 - 1, 34, TH),
};
function makeDigit() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('dg');
  const segs = {};
  for (const k of 'abcdefg') {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    p.setAttribute('points', SEG_POLY[k]);
    p.classList.add('ghost');
    svg.appendChild(p);
    segs[k] = p;
  }
  svg._segs = segs; svg._v = -1;
  return svg;
}
const clock = $('clock');
const digits = [];
['hh', 'mm', 'ss', 'cc'].forEach((_, g) => {
  if (g) { const c = document.createElement('span'); c.className = 'col'; c.innerHTML = '<i></i><i></i>'; clock.appendChild(c); }
  for (let i = 0; i < 2; i++) { const d = makeDigit(); clock.appendChild(d); digits.push(d); }
});
function setDigit(d, v) {
  if (d._v === v) return; d._v = v;
  const on = SEG[v] || '';
  for (const k in d._segs) d._segs[k].classList.toggle('on', on.includes(k));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function parts(ms) {
  ms = Math.max(0, Math.floor(ms));
  const cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000);
  return [pad2(Math.min(h, 99)) + pad2(m) + pad2(s) + pad2(cs)];
}
function fmtMS(sec) { sec = Math.abs(sec); return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60); }

// ---------- 狀態 ----------
let S = null, offset = 0, ws = null, joined = false, myName = store.get('tw_name') || '';

const serverNow = () => Date.now() + offset;
function remaining() {
  if (!S) return 0;
  const y = S.you;
  if (y.status !== 'playing') return 0;
  return y.deadline - Math.max(serverNow(), S.startAt);
}

function tickClock() {
  if (S && S.you.status === 'playing') {
    const ms = remaining();
    const str = parts(ms)[0];
    for (let i = 0; i < 8; i++) setDigit(digits[i], +str[i]);
    clock.classList.toggle('danger', ms < 10000 && ms > 0);
    clock.classList.toggle('warn', ms >= 10000 && ms < 60000);
    clock.classList.toggle('dead', ms <= 0);
    // 倒數畫面
    const left = S.startAt - serverNow();
    const cd = $('countdown');
    if (left > 0) {
      cd.classList.remove('hidden');
      $('cd-num').textContent = Math.ceil(left / 1000);
      $('cd-time').textContent = parts(S.you.initial)[0].replace(/(..)(..)(..)(..)/, '$1:$2:$3:$4');
    } else cd.classList.add('hidden');
  } else {
    $('countdown').classList.add('hidden');
  }
  const lock = S && S.you.lockUntil - serverNow();
  const lm = $('lock-msg');
  if (lock > 0) { lm.textContent = `輸入錯誤過多，鎖定中 ${Math.ceil(lock / 1000)} 秒`; lm.classList.remove('hidden'); }
  else lm.classList.add('hidden');
  requestAnimationFrame(tickClock);
}

// ---------- 連線 ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    $('conn').classList.add('hidden');
    const token = store.get('tw_token');
    if (token || joined) ws.send(JSON.stringify({ type: 'join', name: myName, token }));
    syncTime();
  };
  ws.onclose = () => { if (joined) $('conn').classList.remove('hidden'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function syncTime() {
  if (ws && ws.readyState === 1) send({ type: 'ping', t: Date.now() });
}
setInterval(syncTime, 8000);

function handle(m) {
  if (m.type === 'welcome') { store.set('tw_token', m.token); joined = true; }
  else if (m.type === 'pong') { const rtt = Date.now() - m.t; offset = m.now + rtt / 2 - Date.now(); }
  else if (m.type === 'fatal') { alert(m.text); }
  else if (m.type === 'state') {
    offset = m.now - Date.now();
    S = m; render();
  } else if (m.type === 'toast') onToast(m);
}

// ---------- 畫面 ----------
function show(id) {
  for (const s of ['join', 'lobby', 'game', 'over']) $('screen-' + s).classList.toggle('hidden', s !== id);
}
let lastCardSig = '';
function render() {
  const y = S.you;
  if (!joined) return;
  if (y.status === 'lobby') show('lobby');
  else if (y.status === 'playing') show('game');
  else show('over');

  // 等候室
  $('lobby-count').textContent = `${S.players.length} 人`;
  const ul = $('player-list'); ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    if (p.id === y.id) li.classList.add('me');
    if (!p.connected) li.classList.add('off');
    const tags = [];
    if (p.isHost) tags.push('<span class="tag host">房主</span>');
    if (p.status === 'playing') tags.push('<span class="tag play">遊戲中</span>');
    if (p.status === 'out') tags.push('<span class="tag out">已淘汰</span>');
    if (p.status === 'won') tags.push('<span class="tag">結算中</span>');
    li.innerHTML = `<span class="nm"></span>${tags.join('')}`;
    li.querySelector('.nm').textContent = p.name + (p.id === y.id ? '（你）' : '') + (p.connected ? '' : ' · 離線');
    ul.appendChild(li);
  }
  const entrants = S.players.filter((p) => p.status === 'lobby' && p.connected).length;
  const notice = $('lobby-notice');
  if (S.phase === 'playing') { notice.textContent = '⏳ 遊戲進行中，請等候本局結束'; notice.classList.remove('hidden'); }
  else if (S.lastWinner) { notice.textContent = `🏆 上一局勝者：${S.lastWinner}`; notice.classList.remove('hidden'); }
  else notice.classList.add('hidden');
  const startBtn = $('btn-start');
  startBtn.classList.toggle('hidden', !y.isHost);
  startBtn.disabled = S.phase !== 'lobby' || entrants < 2;
  startBtn.textContent = S.phase === 'playing' ? '遊戲進行中…' : entrants < 2 ? '遊戲開始（至少 2 人）' : '遊戲開始';
  $('lobby-wait').textContent = y.isHost ? '' : '等待房主開始遊戲…';
  $('btn-host-panel').classList.toggle('hidden', !y.isHost);
  $('btn-host-panel2').classList.toggle('hidden', !y.isHost);

  // 遊戲中
  $('me-name').textContent = y.name;
  $('alive').textContent = `${S.aliveCount} 人`;
  $('initial').textContent = fmtMS(Math.round(y.initial / 1000));
  const lg = $('log'); lg.innerHTML = '';
  for (const l of S.log.slice().reverse()) { const li = document.createElement('li'); li.textContent = l.text; lg.appendChild(li); }

  // 結束畫面
  const over = $('screen-over');
  if (y.status === 'out') {
    over.className = 'screen over lose';
    $('over-title').textContent = 'GAME OVER';
    $('over-sub').textContent = S.phase === 'playing'
      ? `你的時間歸零了。還有 ${S.aliveCount} 位玩家在戰鬥中…`
      : `遊戲已結束，勝者：${S.lastWinner || '無'}`;
  } else if (y.status === 'won') {
    over.className = 'screen over win';
    $('over-title').textContent = 'YOU WIN';
    $('over-sub').textContent = '你是最後的倖存者！';
  }

  // 分享紀錄 / 房主面板
  renderShares();
  if (y.isHost) renderCards(); else $('modal-host').classList.add('hidden');
  if (y.status !== 'playing') $('modal-share').classList.add('hidden');
}

function renderShares() {
  const box = $('my-shares');
  if (!S.myShares.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div>我發出的密碼</div>';
  for (const s of S.myShares) {
    const d = document.createElement('div');
    d.className = s.used ? 'u' : '';
    d.textContent = `${s.code} · ${fmtMS(s.seconds)} · ${s.used ? '已被 ' + s.usedByName + ' 使用' : '尚未使用'}`;
    box.appendChild(d);
  }
}

function renderCards(force) {
  const sig = JSON.stringify(S.cards);
  const list = $('card-list');
  if (!force && sig === lastCardSig) return;
  if (!force && list.contains(document.activeElement)) return; // 編輯中不重繪
  lastCardSig = sig;
  list.innerHTML = '';
  for (const c of S.cards) {
    const row = document.createElement('div');
    row.className = 'card-row' + (c.used ? ' used' : '') + (c.seconds < 0 ? ' neg' : '');
    row.innerHTML = `<span class="cc">${c.code}</span><span class="card-amount"><input type="number" step="0.5" ${c.used ? 'disabled' : ''}> 分鐘</span><span class="st"></span><button class="x" title="刪除">×</button>`;
    const inp = row.querySelector('input');
    inp.value = +(c.seconds / 60).toFixed(2);
    inp.onchange = () => {
      const v = Math.round(parseFloat(inp.value) * 60);
      send({ type: 'updateCard', id: c.id, seconds: v });
    };
    inp.onblur = () => { lastCardSig = ''; setTimeout(() => S && S.you.isHost && renderCards(), 50); };
    row.querySelector('.st').textContent = c.used ? `已被 ${c.usedByName} 使用` : '未使用';
    row.querySelector('.x').onclick = () => send({ type: 'deleteCard', id: c.id });
    list.appendChild(row);
  }
  if (!S.cards.length) list.innerHTML = '<p class="dim center">尚無卡片</p>';
}

// ---------- 提示 ----------
function toastEl(kind, text) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3700);
}
function onToast(m) {
  const sign = m.seconds > 0 ? '+' : '−';
  if (m.kind === 'gain' || m.kind === 'loss') {
    toastEl(m.kind, `${m.text} ${sign}${fmtMS(m.seconds)}`);
    flash(m.kind, `${sign}${fmtMS(m.seconds)}`);
    $('code').value = '';
  } else if (m.kind === 'share') {
    flash('loss', `${sign}${fmtMS(m.seconds)}`);
    $('share-form').classList.add('hidden');
    $('share-result').classList.remove('hidden');
    $('share-code').textContent = m.code;
  } else toastEl(m.kind, m.text);
}
function flash(kind, text) {
  clock.classList.remove('flash-gain', 'flash-loss'); void clock.offsetWidth;
  clock.classList.add(kind === 'gain' ? 'flash-gain' : 'flash-loss');
  const f = $('float'); f.className = 'float'; void f.offsetWidth;
  f.textContent = text; f.classList.add('show', kind);
  if (navigator.vibrate) navigator.vibrate(kind === 'loss' ? [120, 60, 120] : 60);
}

// ---------- 事件 ----------
$('name').value = myName;
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  myName = $('name').value.trim(); store.set('tw_name', myName);
  joined = true;
  send({ type: 'join', name: myName, token: store.get('tw_token') });
};
$('btn-start').onclick = () => send({ type: 'start' });
$('btn-restart').onclick = () => send({ type: 'restart' });
function redeem() {
  const code = $('code').value.trim();
  if (!/^\d{4}$/.test(code)) return toastEl('error', '請輸入 4 位數字密碼');
  send({ type: 'redeem', code });
}
$('btn-redeem').onclick = redeem;
$('code').onkeydown = (e) => { if (e.key === 'Enter') redeem(); };
$('code').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };

// 分享
$('btn-share').onclick = () => {
  $('share-form').classList.remove('hidden'); $('share-result').classList.add('hidden');
  $('modal-share').classList.remove('hidden');
};
const closeShare = () => $('modal-share').classList.add('hidden');
$('share-cancel').onclick = closeShare; $('share-done').onclick = closeShare;
$('share-chips').onclick = (e) => {
  const s = +e.target.dataset.s; if (!s) return;
  $('share-min').value = Math.floor(s / 60); $('share-sec').value = s % 60;
};
$('share-confirm').onclick = () => {
  const sec = (+$('share-min').value || 0) * 60 + (+$('share-sec').value || 0);
  if (sec < 1) return toastEl('error', '請輸入要分享的時間');
  send({ type: 'share', seconds: sec });
};

// 房主面板
const openHost = () => { $('modal-host').classList.remove('hidden'); if (S && S.cards) renderCards(true); };
$('btn-host-panel').onclick = openHost; $('btn-host-panel2').onclick = openHost;
$('host-close').onclick = () => $('modal-host').classList.add('hidden');
$('card-chips').onclick = (e) => { const m = e.target.dataset.m; if (m) $('card-min').value = m; };
$('card-add').onclick = () => {
  const sec = Math.round(parseFloat($('card-min').value) * 60);
  if (!sec) return toastEl('error', '請輸入非 0 的分鐘數（負數為懲罰）');
  send({ type: 'addCards', seconds: sec, count: +$('card-count').value || 1 });
};
$('card-regen').onclick = () => send({ type: 'regenCards' });

// PWA + 遊戲中保持螢幕常亮
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let wake = null;
async function keepAwake() {
  try {
    const playing = S && S.you.status === 'playing';
    if (playing && !wake && navigator.wakeLock) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!playing && wake) { wake.release(); wake = null; }
  } catch {}
}
setInterval(keepAwake, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); syncTime(); } });

requestAnimationFrame(tickClock);
show('join');
connect();
// 有保存的 token 就自動回到房間
if (store.get('tw_token') && myName) joined = true;
})();
