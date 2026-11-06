// 表示と入力だけを受け持つ。判定はすべてサーバーが行う。
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const slipSlot = document.getElementById('slip-slot');

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 保存できなくても遊べる */ } },
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 4500);
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? '送信に失敗しました');
  return data;
}

const roomCode = location.pathname.match(/^\/r\/([\w-]+)$/)?.[1] ?? null;
const recordCode = location.pathname.match(/^\/r\/([\w-]+)\/review$/)?.[1] ?? null;
const tokenKey = (code) => `hitokoto.token.${code}`;
// 一人で動作確認するときの、もう片方の席のトークン
const soloKey = (code) => `hitokoto.solo.${code}`;
const isSolo = () => Boolean(roomCode && store.get(soloKey(roomCode)));

const NAMES = { green: '協力者', assassin: '黒幕', bystander: '通行人' };

// ---------- 絵の部品 ----------

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter(Boolean));
  return node;
}

// 虫眼鏡の形をした吹き出し。レンズの中に「たった1語」の棒
const markSvg = () => svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
  svg('path', { d: 'M38 40 L55 57', stroke: '#d9432a', 'stroke-width': 10, 'stroke-linecap': 'square' }),
  svg('circle', { cx: 27, cy: 27, r: 22, fill: '#f4b93e' }),
  svg('path', { d: 'M14 27 H40', stroke: '#0e1b28', 'stroke-width': 7 }));

const WAX = 'M20 2C24 1 27 5 30 5C34 6 35 10 37 13C39 17 38 21 38 24C38 28 35 30 33 33C30 36 27 36 24 38C20 39 17 37 13 37C9 36 7 33 5 30C2 27 3 23 2 20C1 16 4 13 6 10C8 6 12 6 15 4C17 3 18 3 20 2Z';
function waxSeal(attrs = {}) {
  return svg('svg', { viewBox: '0 0 40 40', ...attrs },
    svg('path', { d: WAX, fill: '#d9432a' }),
    svg('circle', { cx: 20, cy: 20, r: 12.5, fill: '#b5321c' }),
    svg('text', { x: 20, y: 26, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 800, 'font-family': 'Kaisei Tokumin, serif', fill: '#f8e7cf' }, '封'));
}

function matchesSvg(total, left, burning = 0) {
  const parts = [];
  for (let i = 0; i < total; i += 1) {
    const x = i * 16 + 6;
    if (i < left) {
      parts.push(svg('rect', { class: 'stick', x, y: 11, width: 5, height: 43 }));
      parts.push(svg('ellipse', { class: 'head', cx: x + 2.5, cy: 10, rx: 4.6, ry: 7 }));
    } else {
      parts.push(svg('rect', { class: 'burnt', x, y: 36, width: 5, height: 18 }));
      if (i < left + burning) parts.push(svg('path', { class: 'flame', d: `M${x + 2.5} 8C${x + 9} 20 ${x + 9} 34 ${x + 2.5} 36C${x - 4} 34 ${x - 4} 20 ${x + 2.5} 8Z` }));
    }
  }
  return svg('svg', { class: 'matches', viewBox: `0 0 ${total * 16} 56`, preserveAspectRatio: 'xMinYMid meet', role: 'img', 'aria-label': `マッチ 残り${left}本` }, parts);
}

// 正の字の書き順
const SEI = ['M6 7H34', 'M20 7V34', 'M20 20H31', 'M10 20V34', 'M4 34H36'];
function tally(found, fresh = 0) {
  return el('div', { class: 'tally', role: 'img', 'aria-label': `正解 ${found}枚` }, [0, 1, 2].map((k) =>
    svg('svg', { viewBox: '0 0 40 40', 'aria-hidden': 'true' }, SEI.map((d, i) => {
      const n = k * 5 + i;
      const on = n < found;
      return svg('path', { d, pathLength: 1, class: `${on ? 'on' : ''}${on && n >= found - fresh ? ' fresh' : ''}` });
    }))));
}

function dial(percent) {
  const needle = svg('g', { class: 'needle' },
    svg('path', { d: 'M56 58 L53 54 L56 14 L59 54Z', fill: '#17141b' }));
  needle.style.setProperty('--a', `${percent * 1.8 - 90}deg`);
  return svg('svg', { class: 'dial', viewBox: '0 0 112 68', 'aria-hidden': 'true' },
    svg('path', { d: 'M10 58A46 46 0 0 1 32 19', fill: 'none', stroke: '#d9432a', 'stroke-width': 10 }),
    svg('path', { d: 'M34 18A46 46 0 0 1 78 18', fill: 'none', stroke: '#d99a1e', 'stroke-width': 10 }),
    svg('path', { d: 'M80 19A46 46 0 0 1 102 58', fill: 'none', stroke: '#1f7a55', 'stroke-width': 10 }),
    needle,
    svg('circle', { cx: 56, cy: 58, r: 6, fill: '#17141b' }));
}

const catSvg = () => svg('svg', { viewBox: '0 0 34 44', 'aria-hidden': 'true' },
  svg('path', { d: 'M5 44C3 34 5 25 9 20C7 14 7 8 8 2L14 8C16 7 18 7 20 8L26 2C27 8 27 14 25 20C28 25 29 31 28 38C30 38 31 37 31 35L33 35C34 40 31 44 26 44Z' }));

function teleLine(word, number) {
  const chars = [...word];
  const size = chars.length <= 4 ? '' : chars.length <= 8 ? ' m' : ' s';
  return el('div', { class: `tele-line${size}`, 'aria-label': `ヒント ${word}、${number}` }, chars.map((ch, i) => {
    const cell = el('span', { class: 'tele-char', 'aria-hidden': 'true' }, ch);
    cell.style.setProperty('--i', i);
    return cell;
  }), el('span', { class: 'tele-num', 'aria-hidden': 'true' }, String(number)));
}

// ---------- 入口 ----------

function field(label, control) {
  return el('label', { class: 'field' }, el('span', {}, label), control);
}

const WORD_LISTS = [['mild', 'ひらがな控えめ'], ['kana', 'ひらがな多め']];

function seg(name, legend, options, value) {
  return el('fieldset', { class: 'seg' }, el('legend', {}, legend),
    el('div', { class: 'seg-row' }, options.map(([v, text]) => el('label', {},
      el('input', { type: 'radio', name, value: v, checked: String(v) === String(value) }),
      el('span', {}, text)))));
}

function plainCard(word, kind, who) {
  return el('div', { class: `card mine-${kind}`, role: 'img', 'aria-label': `${who}の面では${word}は${NAMES[kind]}` },
    el('span', { class: 'word' }, word),
    el('span', { class: 'theirs t-bystander', 'aria-hidden': 'true' }, who));
}

function howto() {
  let order = 0;
  const step = (demo, title, text) => {
    const node = el('div', { class: 'rise' }, el('div', { class: 'demo' }, demo), el('h3', {}, title), el('p', {}, text));
    node.style.setProperty('--i', order);
    order += 1;
    return node;
  };
  return el('section', { class: 'howto', 'aria-labelledby': 'howto-h' }, el('div', { class: 'howto-in' },
    el('h2', { id: 'howto-h' }, '遊び方は、電報を打つだけ'),
    el('div', { class: 'howto-grid' },
      step(el('div', { class: 'tele-mini' }, teleLine('夜食', 2)), 'ヒントは1語と数字だけ', '当ててほしい語の数を添えて、相方に電報を打ちます。交代でヒントを出し合います。'),
      step([plainCard('砂漠', 'green', 'あなた'), plainCard('砂漠', 'assassin', '相方')], '見えている色は2人で違う', '同じ語が、あなたには協力者、相方には黒幕かもしれません。15人全員を当てれば解決です。'),
      step(matchesSvg(9, 6), 'マッチが尽きる前に', '手番のたびに1本燃えます。尽きたらヒントなしの勝負。1回外せば負けです。'),
      step(waxSeal({ class: 'mark-lg', 'aria-hidden': 'true' }), '黒幕に触れるのは1回まで', '2回目で事件は迷宮入り。話すなら通話で、自分の面の色だけは口にしないでください。')))
  );
}

function entryShell(tag, sheet) {
  document.body.classList.remove('playing');
  app.replaceChildren(
    el('div', { class: 'entry' },
      el('section', { class: 'cover' },
        el('img', { src: '/poster.svg', alt: 'ブラインド越しの灯りの中で向き合う、帽子の2人の探偵' }),
        el('h1', {}, 'ひとこと探偵'),
        el('p', { class: 'tag' }, tag)),
      el('div', { class: 'desk' }, el('p', { class: 'lead-mobile' }, tag), sheet)),
    howto());
  riseOnView();
}

// 遊び方は、見えてから順に立ち上がる
function riseOnView() {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { threshold: 0.15 });
  for (const node of app.querySelectorAll('.rise')) {
    node.classList.add('pre');
    io.observe(node);
  }
}

function renderCreate() {
  const error = el('p', { class: 'error' });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        const res = await post('/api/rooms', {
          name: f.get('name'),
          settings: {
            timers: Number(f.get('timers')),
            assassinPenalty: Number(f.get('assassinPenalty')),
            maxOuts: Number(f.get('maxOuts')),
            timerShortage: f.get('timerShortage'),
            aiReveal: f.get('aiReveal'),
            wordList: f.get('wordList'),
          },
        });
        store.set(tokenKey(res.code), res.token);
        store.set('hitokoto.name', f.get('name'));
        location.href = `/r/${res.code}`;
      } catch (err) { error.textContent = err.message; }
    },
  },
  field('あなたの名前', el('input', { name: 'name', required: true, maxlength: 12, autocomplete: 'nickname', placeholder: '呼ばれたい名前', value: store.get('hitokoto.name') ?? '' })),
  seg('timers', 'マッチの本数', [[9, '9本'], [10, '10本'], [11, '11本']], 9),
  seg('assassinPenalty', '黒幕に触れると燃えるマッチ', [[1, '1本'], [2, '2本'], [3, '3本']], 2),
  seg('aiReveal', 'AIのツッコミ', [['afterTurn', '手番ごとに'], ['afterGame', '最後にまとめて']], 'afterTurn'),
  seg('wordList', '単語リスト', WORD_LISTS, 'mild'),
  el('details', { class: 'more' }, el('summary', {}, '細かい設定'),
    seg('maxOuts', '黒幕を許す回数', [[0, '0回'], [1, '1回'], [2, '2回']], 1),
    seg('timerShortage', '燃やすマッチが足りないとき', [['pay', 'あるだけ払う'], ['lose', '払えなければ負け']], 'pay')),
  error,
  el('button', { class: 'btn primary wide', type: 'submit' }, '事件を開く'));
  entryShell('1語のヒントだけで、協力者15人を探し出す。2人用の協力推理ゲーム。',
    el('section', { class: 'sheet paper' },
      el('h2', {}, '今夜の事件を開く'),
      el('p', { class: 'lead' }, '部屋を作って、相方にURLを送ります。'),
      form));
}

function renderJoin(message = '') {
  const error = el('p', { class: 'error' }, message);
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = new FormData(form).get('name');
      try {
        const res = await post(`/api/rooms/${roomCode}/join`, { name });
        store.set(tokenKey(roomCode), res.token);
        store.set('hitokoto.name', name);
        connect();
      } catch (err) { error.textContent = err.message; }
    },
  },
  field('あなたの名前', el('input', { name: 'name', required: true, maxlength: 12, autocomplete: 'nickname', placeholder: '呼ばれたい名前', value: store.get('hitokoto.name') ?? '' })),
  error,
  el('button', { class: 'btn primary wide', type: 'submit' }, '捜査に加わる'));
  entryShell('1語のヒントだけで、協力者15人を探し出す。2人用の協力推理ゲーム。',
    el('section', { class: 'sheet paper' },
      el('h2', {}, '相方があなたを待っています'),
      el('p', { class: 'lead' }, '名前を入れると、すぐに捜査が始まります。'),
      form));
}

function renderWaiting(state) {
  const url = location.href;
  const input = el('input', { value: url, readonly: true, 'aria-label': '相方に送るURL' });
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast('コピーしました'); } catch { input.select(); }
  };
  entryShell(`${state.you.name}さんの事件。相方の到着を待っています。`,
    el('section', { class: 'sheet paper' },
      el('p', { class: 'case-no' }, `事件番号 ${state.code.slice(0, 4).toUpperCase()}`),
      el('h2', {}, '相方を呼ぶ', el('span', { class: 'waiting-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))),
      el('p', { class: 'lead' }, 'このURLを相方に送ってください。入った瞬間に捜査が始まります。'),
      el('div', { class: 'share' }, input, el('button', { class: 'btn primary', type: 'button', onclick: copy }, 'コピー')),
      navigator.share && el('button', { class: 'btn wide', type: 'button', onclick: () => navigator.share({ title: 'ひとこと探偵', url }).catch(() => {}) }, 'ほかのアプリで送る'),
      el('p', {}, el('button', { class: 'btn ghost', type: 'button', onclick: startSolo }, '一人で動作確認する')),
      el('p', { class: 'note' }, '相方の席もこのブラウザが取り、2つの席を交代しながら最後まで遊べます。この部屋に友達は入れなくなります。')));
}

async function startSolo() {
  try {
    const res = await post(`/api/rooms/${roomCode}/join`, { name: '相方役' });
    store.set(soloKey(roomCode), res.token);
    render();
  } catch (err) { toast(err.message); }
}

function switchSeat() {
  const current = store.get(tokenKey(roomCode));
  store.set(tokenKey(roomCode), store.get(soloKey(roomCode)));
  store.set(soloKey(roomCode), current);
  ui.targets.clear();
  ui.hintWord = '';
  ui.hintNumber = 1;
  ui.numberTouched = false;
  if (ws) { ws.onclose = null; ws.close(); }
  connect();
}

// ---------- 接続 ----------

let ws;
let state = null;
let retry = 0;
const noFresh = () => ({ contacts: new Set(), misses: new Set(), found: 0, burned: 0, telegram: false, ring: null, deal: false });
const ui = { touchedAt: 0, targets: new Set(), tab: 'input', hintWord: '', hintNumber: 1, numberTouched: false, fresh: noFresh() };
const shownAi = new Set();
let seenOuts = null;
let seenPhase = null;
let seenHint;

function connect() {
  const token = store.get(tokenKey(roomCode));
  if (!token) { renderJoin(); return; }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ t: 'auth', code: roomCode, token })); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'state') onState(msg.state);
    else if (msg.t === 'error') toast(msg.message);
    else if (msg.t === 'authFailed') { ws.onclose = null; renderJoin('この端末の記録が見つかりません。部屋に入り直してください'); }
  };
  ws.onclose = () => {
    retry += 1;
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry));
  };
}

const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

// 再描画のたびに動かないよう、前の状態と比べて新しく起きたことだけ動かす
function noteChanges(prev, g) {
  const fresh = noFresh();
  const over = (x) => x.phase === 'won' || x.phase === 'lost';
  if (!prev || (over(prev) && !over(g))) { fresh.deal = true; fresh.telegram = Boolean(prev); ui.fresh = fresh; return; }
  g.cells.forEach((c, i) => {
    const before = prev.cells[i];
    if (c.contact && !before.contact) fresh.contacts.add(i);
    if (c.marks.length > before.marks.length) fresh.misses.add(i);
  });
  fresh.found = Math.max(0, g.found - prev.found);
  fresh.burned = Math.max(0, prev.timerBank - g.timerBank);
  fresh.telegram = Boolean(g.current) && (!prev.current || g.turns.length !== prev.turns.length);
  ui.fresh = fresh;
}

function showSlip(ai) {
  const node = el('aside', { class: 'slip paper', role: 'status' },
    dial(ai.tsujido),
    el('div', {}, el('div', { class: 'label' }, '通じる度'), el('div', { class: 'pct' }, String(ai.tsujido), el('small', {}, '%'))),
    el('div', { class: 'said' }, catSvg(), el('span', {}, ai.line)),
    el('button', { class: 'close', type: 'button', 'aria-label': '閉じる', onclick: () => dismiss() }, '×'));
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  timer = setTimeout(dismiss, 8000);
  slipSlot.replaceChildren(node);
}

function curtain(kind, text) {
  const node = el('div', { class: `curtain ${kind}`, 'aria-hidden': 'true' }, el('span', {}, text));
  document.body.append(node);
  setTimeout(() => node.remove(), 2350);
}

// 相方の電報が届いたことを、画面の真ん中に一瞬出して知らせる。最後は電報欄の方へ落ちていく
function hintFlash(t) {
  const node = el('div', { class: 'flash', role: 'status' },
    el('div', { class: 'flash-sheet' },
      el('span', { class: 'flash-head' }, `${state.partner.name ?? '相方'}さんから電報`),
      teleLine(t.hint, t.number)));
  document.body.append(node);
  setTimeout(() => node.remove(), 2100);
}

// 開き直しでは出さない。別のタブを見ていた間に届いた電報は、戻ったときに出す
function flashNewHint() {
  const g = state?.game;
  if (!g || document.hidden) return;
  const over = g.phase === 'won' || g.phase === 'lost';
  const no = g.current && !g.current.mine && !over ? g.turns.at(-1).no : null;
  if (seenHint !== undefined && no !== null && no !== seenHint) hintFlash(g.current);
  seenHint = no;
}

document.addEventListener('visibilitychange', flashNewHint);

function onState(next) {
  const g = next.game;
  if (g) {
    noteChanges(state?.game, g);
    if (state?.game && Date.now() - ui.touchedAt < 500) {
      g.candidates.mine = state.game.candidates.mine.filter((i) => g.cells[i].selectable);
    }
    for (const t of g.turns) {
      if (!t.ai || shownAi.has(t.no)) continue;
      shownAi.add(t.no);
      if (state) showSlip(t.ai);
    }
    if (seenOuts !== null && g.outs > seenOuts && g.phase !== 'lost') {
      toast(`黒幕！ ${g.outs}アウト。マッチ −${g.penalty}本`);
      app.classList.add('shake');
      setTimeout(() => app.classList.remove('shake'), 360);
    }
    if (seenPhase && seenPhase !== g.phase && g.phase === 'lost') curtain('blackout', '迷宮入り');
    if (seenPhase && seenPhase !== g.phase && g.phase === 'won') curtain('solved', '事件解決');
    seenOuts = g.outs;
    seenPhase = g.phase;
    if (!g.canGive) { ui.targets.clear(); ui.hintWord = ''; ui.hintNumber = 1; ui.numberTouched = false; }
  }
  state = next;
  render();
  flashNewHint();
}

// 終わった対局を読み返す画面。接続せず、1回読むだけ
async function openRecord() {
  const res = await fetch(`/api/rooms/${recordCode}/review${location.search}`);
  if (!res.ok) {
    entryShell('1語のヒントだけで、協力者15人を探し出す。2人用の協力推理ゲーム。',
      el('section', { class: 'sheet paper' },
        el('h2', {}, '記録が見つかりません'),
        el('p', { class: 'lead' }, '終わった対局だけを読み返せます。部屋は30日使わないと消えます。')));
    return;
  }
  state = await res.json();
  render();
}

function recordNav() {
  const { no, total } = state.record;
  const seat = state.you.seat;
  const link = (text, game, s, on) => el('a', { href: `?game=${game}&seat=${s}`, 'aria-current': on ? 'page' : null }, text);
  const games = Array.from({ length: total }, (_, i) => link(`第${i + 1}局`, i + 1, seat, i + 1 === no));
  const names = { [seat]: state.you.name, [seat === 'A' ? 'B' : 'A']: state.partner.name };
  const seats = ['A', 'B'].map((s) => link(`${names[s]}の面`, no, s, s === seat));
  return el('nav', { class: 'record-nav', 'aria-label': '読み返す対局と面' }, games, el('i', { 'aria-hidden': 'true' }), seats);
}

// ---------- ゲーム画面 ----------

const SYMBOLS = { green: '●', assassin: '×', bystander: '' };
const colorAssist = () => store.get('hitokoto.assist') === '1';

// 朱肉のかすれた丸い検印。インクの荒れは index.html の #ink フィルター
const stampSvg = (fresh) => svg('svg', { class: `stamp${fresh ? ' fresh' : ''}`, viewBox: '0 0 100 100', 'aria-hidden': 'true' },
  svg('g', { filter: 'url(#ink)' },
    svg('circle', { cx: 50, cy: 50, r: 45, fill: 'none', 'stroke-width': 7 }),
    svg('circle', { cx: 50, cy: 50, r: 37, fill: 'none', 'stroke-width': 2.4 }),
    svg('path', { d: 'M15 33H85M15 67H85', fill: 'none', 'stroke-width': 3 }),
    svg('text', { x: 50, y: 28, class: 'small' }, '捜査'),
    svg('text', { x: 50, y: 60.5, class: 'big' }, '正解'),
    svg('text', { x: 50, y: 82, class: 'small' }, '探偵社')));

// 赤鉛筆で2本引いた×。語の下に敷く
const crossSvg = (fresh) => svg('svg', { class: `cross${fresh ? ' fresh' : ''}`, viewBox: '0 0 160 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
  svg('path', { pathLength: 1, d: 'M10 12C50 34 104 64 151 90' }),
  svg('path', { pathLength: 1, d: 'M152 10C106 36 56 62 8 91' }));

// 押しピンで留めた付箋。角が折れていて、札の上に被さる
const pinSvg = (partner) => svg('svg', {
  class: `pin${partner ? ' partner' : ''}`,
  viewBox: '0 0 60 72',
  role: 'img',
  'aria-label': partner ? '相方の候補' : '自分の候補',
},
svg('path', { class: 'note', d: 'M5 12L55 7L57 50L41 66L8 63Z' }),
svg('path', { class: 'fold', d: 'M57 50L43 49L41 66Z' }),
svg('text', { x: 30, y: 49, class: 'q' }, partner ? '相' : '？'),
svg('ellipse', { class: 'pin-shadow', cx: 33, cy: 15, rx: 7, ry: 3.5 }),
svg('circle', { class: 'pin-head', cx: 30, cy: 10, r: 8 }),
svg('circle', { class: 'pin-shine', cx: 27.5, cy: 7.5, r: 2.4 }));

// 赤鉛筆でぐるっと囲んだ線。始まりと終わりをわざと重ねない
const ringSvg = (fresh) => svg('svg', { class: `ring${fresh ? ' fresh' : ''}`, viewBox: '0 0 160 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
  svg('path', { pathLength: 1, d: 'M22 60C16 30 52 12 88 13C124 14 150 30 146 56C142 82 100 92 66 89C36 86 12 70 26 40' }));

const lenClass = (word) => {
  const n = [...word].length;
  return n >= 6 ? ' len6' : n === 5 ? ' len5' : '';
};

function cardNode(c, i, g) {
  const hinting = g.canGive;
  const interactive = hinting ? !c.covered : c.selectable;
  const classes = ['card', `mine-${c.mine}`];
  if (c.covered) classes.push('covered');
  if (c.contact) classes.push('contact');
  if (interactive) classes.push('interactive');
  if (ui.targets.has(i)) classes.push('target');
  const misses = c.marks.filter((m) => m.kind === 'bystander');
  const hits = c.marks.filter((m) => m.kind !== 'bystander');
  // 外しても、自分の面の協力者は相方に当ててもらう札のまま。元の見た目を残す。黒幕の札も同じ
  const struck = misses.length > 0 || hits.length > 0;
  const kept = struck && !c.contact && (c.mine === 'green' || (c.mine === 'assassin' && !hits.length));
  if (kept) classes.push('kept');
  else {
    if (misses.length && !c.contact) classes.push('missed');
    if (hits.length) classes.push('exposed');
  }
  if (c.theirs || colorAssist()) classes.push('no-mark');

  const parts = [el('span', { class: `word${lenClass(c.word)}` }, c.word)];
  if (colorAssist() && SYMBOLS[c.mine] && !c.contact) parts.push(el('span', { class: 'symbol', 'aria-hidden': 'true' }, SYMBOLS[c.mine]));
  const who = (list) => (list.length === 2 ? '2人とも' : list[0].mine ? '自分が' : '相方が');
  if (hits.length) {
    parts.push(el('span', { class: `tape${ui.fresh.misses.has(i) ? ' fresh' : ''}`, 'aria-hidden': 'true' }, el('b', {}, '黒幕　黒幕　黒幕　黒幕　黒幕　黒幕')));
  } else if (kept) {
    parts.push(el('span', { class: `miss-band${ui.fresh.misses.has(i) ? ' fresh' : ''}` },
      el('i', { 'aria-hidden': 'true' }, '×'),
      el('span', { class: 'long' }, `${who(misses)}外した`),
      el('span', { class: 'short' }, '外れ')));
  } else if (misses.length && !c.contact) {
    parts.push(crossSvg(ui.fresh.misses.has(i)));
    parts.push(el('span', { class: 'miss-tag' }, el('span', { class: 'long' }, `${who(misses)}外した`), el('span', { class: 'short' }, '外れ')));
  }
  if (c.contact) parts.push(stampSvg(ui.fresh.contacts.has(i)));
  if (ui.targets.has(i)) parts.push(ringSvg(ui.fresh.ring === i));
  if (c.theirs) {
    const name = NAMES[c.theirs];
    parts.push(el('span', { class: `theirs t-${c.theirs}`, title: `相方の面: ${name}` },
      el('span', { class: 'long' }, `相方: ${name}`),
      el('span', { class: 'short' }, name[0])));
  }

  const mine = g.candidates.mine.includes(i);
  const label = [
    c.word,
    NAMES[c.mine],
    c.contact ? '正解' : '',
    hits.length ? `${who(hits)}黒幕に触れた` : '',
    misses.length && !c.contact ? `${who(misses)}外した` : '',
    mine ? '候補' : '',
  ].filter(Boolean).join('、');
  const node = el('button', {
    class: classes.join(' '),
    type: 'button',
    disabled: !interactive,
    'aria-label': label,
    'aria-pressed': mine || ui.targets.has(i) ? 'true' : 'false',
  }, parts);
  // 札は作り直さず使い回すので、押したときの動きは差し替えられる形で持つ
  node.onclick = () => {
    if (hinting) {
      if (ui.targets.has(i)) ui.targets.delete(i);
      else { ui.targets.add(i); ui.fresh.ring = i; }
      if (!ui.numberTouched) ui.hintNumber = Math.max(1, ui.targets.size);
    } else {
      toggleCandidate(g, i);
    }
    render();
  };
  node.style.setProperty('--i', i);
  return node;
}

// 手元はすぐ変え、相方にはサーバー経由で届ける
function toggleCandidate(g, i) {
  const list = g.candidates.mine;
  if (list.includes(i)) list.splice(list.indexOf(i), 1);
  else list.push(i);
  ui.touchedAt = Date.now();
  send({ t: 'candidates', cells: list });
}

// ---------- 札の更新 ----------

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const signature = (card) => card.innerHTML.replaceAll(' fresh', '');

function paintCard(card, next) {
  const flipping = card.classList.contains('flip');
  card.className = next.className;
  if (flipping) card.classList.add('flip');
  const sig = signature(next);
  if (card.sig !== sig) {
    card.sig = sig;
    card.replaceChildren(...next.childNodes);
  }
}

// 付箋と確定ボタンは、付くときも外れるときも動かす
function syncExtra(cell, next, selector) {
  const now = cell.querySelector(`${selector}:not(.out)`);
  const incoming = next.querySelector(selector);
  if (now && incoming) {
    if (now.getAttribute('class') !== incoming.getAttribute('class')) now.replaceWith(incoming);
  } else if (now) {
    now.classList.add('out');
    setTimeout(() => now.remove(), calm() ? 0 : 200);
  } else if (incoming) {
    cell.append(incoming);
  }
}

function morphCell(cell, next, flip) {
  const card = cell.querySelector('.card');
  const nextCard = next.querySelector('.card');
  cell.className = next.className;
  card.onclick = nextCard.onclick;
  card.disabled = nextCard.disabled;
  card.setAttribute('aria-label', nextCard.getAttribute('aria-label'));
  card.setAttribute('aria-pressed', nextCard.getAttribute('aria-pressed'));
  syncExtra(cell, next, '.pin');
  syncExtra(cell, next, '.confirm');

  card.turn = (card.turn ?? 0) + 1;
  if (!flip || calm()) { paintCard(card, nextCard); return; }
  // 裏返って真横を向いた瞬間に結果へ差し替える
  const turn = card.turn;
  card.classList.add('flip');
  setTimeout(() => { if (card.turn === turn) paintCard(card, nextCard); }, 210);
  setTimeout(() => card.classList.remove('flip'), 500);
}

function morphBoard(board, next) {
  const fresh = ui.fresh;
  [...next.children].forEach((cell, i) => {
    morphCell(board.children[i], cell, fresh.contacts.has(i) || fresh.misses.has(i));
  });
}

function cellNode(c, i, g) {
  const mine = g.candidates.mine.includes(i);
  const partner = g.candidates.partner.includes(i);
  const canConfirm = mine && c.selectable;
  const classes = ['cell'];
  if (mine) classes.push('marked');
  if (partner && !mine) classes.push('marked-partner');
  if (canConfirm) classes.push('can-confirm');
  return el('div', { class: classes.join(' ') },
    cardNode(c, i, g),
    (mine || partner) && pinSvg(!mine),
    canConfirm && el('button', {
      class: 'confirm',
      type: 'button',
      'aria-label': `「${c.word}」で確定`,
      onclick: () => send({ t: 'pick', cell: i }),
    }, '確定'));
}

function statusText(g) {
  if (g.phase === 'won') return '事件解決！ 協力者15人を見つけました';
  if (g.phase === 'lost') return '迷宮入り';
  if (g.phase === 'sudden_death') return g.canPick ? 'マッチ切れ。ヒントなしで残りを当ててください。1回外せば負けです' : 'マッチ切れ。相方の推理を待っています';
  if (g.current) {
    const h = `「${g.current.hint}」${g.current.number}`;
    return g.current.mine ? `${h} を打電しました。相方が選んでいます` : `${h} 単語を選んでください`;
  }
  if (g.canGive) return g.turns.length ? 'あなたが電報を打つ番です' : 'どちらからでも電報を打てます';
  return '相方の電報を待っています';
}

function hintForm(g) {
  const word = el('input', {
    name: 'word', required: true, maxlength: 20, autocomplete: 'off', value: ui.hintWord,
    oninput: (e) => { ui.hintWord = e.target.value; },
  });
  const number = el('input', {
    name: 'number', type: 'number', min: 0, max: 9, required: true, value: ui.hintNumber, 'aria-label': '数字',
    oninput: (e) => { ui.hintNumber = Number(e.target.value); ui.numberTouched = true; render(); },
  });
  const step = (by, text, label) => el('button', {
    type: 'button',
    'aria-label': label,
    onclick: () => {
      ui.hintNumber = Math.min(9, Math.max(0, ui.hintNumber + by));
      ui.numberTouched = true;
      render();
    },
  }, text);
  const note = ui.targets.size
    ? `赤丸 ${ui.targets.size}枚。相方には見えません。`
    : '盤面で、当ててほしい語に赤丸を付けてください。';
  return el('form', {
    class: 'actions-form telegram',
    onsubmit: (e) => {
      e.preventDefault();
      send({ t: 'hint', word: ui.hintWord, number: ui.hintNumber, intended: [...ui.targets] });
    },
  },
  el('div', { class: 'tele-side' }, el('h2', {}, '電報を打つ'), el('p', { class: 'hint-note' }, note)),
  el('div', { class: 'hint-form' },
    field('ヒント（1語）', word),
    el('div', { class: 'field' }, el('span', {}, '数字'), el('div', { class: 'stepper' }, step(-1, '−', '数字を減らす'), number, step(1, '+', '数字を増やす'))),
    el('button', { class: 'btn primary', type: 'submit', disabled: ui.hintNumber > 0 && ui.targets.size === 0 }, '打電する')));
}

function pickBar(g) {
  const n = g.candidates.mine.length;
  return el('div', { class: 'choose' },
    el('span', { class: 'hint-note' }, n
      ? `候補 ${n}枚。札の「確定」で答えます。`
      : '札を選ぶと付箋が付きます。相方にも見えます。'),
    g.canStop && el('button', { class: 'btn', type: 'button', onclick: () => send({ t: 'stop' }) }, '手番を終える'));
}

function telegramNode(g) {
  const t = g.current;
  if (t) {
    return el('section', { class: `telegram${ui.fresh.telegram ? ' fresh' : ''}` },
      el('div', { class: 'telegram-head' }, el('span', {}, t.mine ? '打電済み' : '電報が届きました'), el('span', {}, `第${g.turns.length}報`)),
      teleLine(t.hint, t.number));
  }
  if (g.phase === 'sudden_death') {
    return el('section', { class: 'telegram idle' }, el('h2', {}, 'マッチが尽きました'), el('p', { class: 'hint-note' }, '残りの協力者を、ヒントなしで当てます。'));
  }
  return el('section', { class: 'telegram idle' },
    el('h2', {}, '受信待ち', el('span', { class: 'waiting-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))),
    el('p', { class: 'hint-note' }, `${state.partner.name ?? '相方'}さんが電報を考えています。`));
}

const RESULTS = { green: ['正解', 'ok'], bystander: ['不正解', 'ng'], assassin: ['黒幕', 'bad'] };

function pickChips(picks, pop) {
  if (!picks.length) return null;
  return el('ul', { class: 'picks' }, picks.map((p, i) => {
    const [label, kind] = RESULTS[p.result];
    return el('li', { class: `pick ${kind}${pop && i === picks.length - 1 ? ' pop' : ''}` }, el('span', {}, p.word), el('b', {}, label));
  }));
}

function historyBox(g) {
  const pop = ui.fresh.contacts.size > 0 || ui.fresh.misses.size > 0;
  const sudden = g.suddenPicks.length > 0;
  const items = [...g.turns].reverse().map((t, i) => el('li', {},
    el('div', { class: 'hint' }, t.hint, el('b', {}, String(t.number))),
    el('div', { class: 'sub' }, `第${t.no}報・${t.mine ? '自分' : '相方'}のヒント${t.end ? '' : '（回答中）'}`),
    pickChips(t.picks, pop && !sudden && i === 0),
    t.ai && [
      gauge(t.ai.tsujido),
      el('div', { class: 'line' }, `通じる度 ${t.ai.tsujido}%　${t.ai.line}`),
    ]));
  if (sudden) {
    items.unshift(el('li', {}, el('div', { class: 'hint' }, 'ヒントなしの勝負'), pickChips(g.suddenPicks, pop)));
  }
  return el('section', { class: 'box', 'data-slot': 'memo' }, el('h2', {}, '捜査メモ'),
    items.length ? el('ul', { class: 'history' }, items) : el('p', { class: 'notice' }, '打った電報がここに残ります'));
}

function gauge(percent) {
  const bar = el('i');
  bar.style.width = `${percent}%`;
  return el('div', { class: 'gauge' }, bar);
}

function ledgerNode(g) {
  const slots = Array.from({ length: g.maxOuts + 1 }, (_, i) => (i < g.outs
    ? waxSeal({ 'aria-hidden': 'true' })
    : svg('svg', { viewBox: '0 0 40 40', 'aria-hidden': 'true' }, svg('circle', { class: 'slot', cx: 20, cy: 20, r: 16 }))));
  return el('section', { class: 'ledger', 'aria-label': '捜査の状況', 'data-slot': 'ledger' },
    el('div', { class: 'tally-box' }, el('h2', {}, '正解', el('span', { class: 'num' }, `${g.found}/15`)), tally(g.found, ui.fresh.found)),
    el('div', {}, el('h2', {}, 'マッチ', el('span', { class: 'num' }, `${g.timerBank}本`)), matchesSvg(g.timers, g.timerBank, ui.fresh.burned)),
    el('div', {}, el('h2', {}, '黒幕', el('span', { class: 'num' }, `${g.outs}回`)), el('div', { class: 'seals', role: 'img', 'aria-label': `${g.outs}アウト` }, slots)));
}

const AI_HELP = [
  ['AI予想', 'このヒントを聞いた人が選びそうな語です。有力な順に、ヒントの枚数ぶん並べています。'],
  ['もしかして', '狙い以外で一番選ばれそうな語です。相方が引っかかるとしたらこの語、という読みです。'],
  ['通じる度', '狙った語が選ばれそうな度合いです。高いほど、ヒントの意図が伝わりやすかったことになります。'],
  ['危険度', 'ヒントを出した人の面の黒幕が選ばれそうな度合いです。高いほど、黒幕に触れやすい危ないヒントだったことになります。'],
];

const hideTip = () => document.querySelector('.tip')?.remove();

// 表は横にはみ出すと切れるので、説明は表の外に出して画面に固定する
function showTip(anchor, text) {
  hideTip();
  const node = el('div', { class: 'tip', role: 'tooltip' }, text);
  document.body.append(node);
  const box = anchor.getBoundingClientRect();
  node.style.setProperty('left', `${Math.max(8, Math.min(box.left, innerWidth - node.offsetWidth - 8))}px`);
  node.style.setProperty('top', `${box.bottom + 8}px`);
  addEventListener('scroll', hideTip, { once: true, capture: true });
}

function reviewTable(r) {
  const nameOf = (seat) => (seat === state.you.seat ? state.you.name : state.partner.name ?? '相方');
  const who = (seat) => el('span', { class: `who who-${seat}` }, nameOf(seat));
  const picksText = (t) => t.picks.map((p) => el('span', { class: p.result === 'green' ? 'tag-green' : 'tag-bad' },
    `${p.word}${p.result === 'green' ? '' : p.result === 'assassin' ? '（黒幕）' : '（不正解）'} `));
  const aiCell = (i, value) => el('td', { class: `ai${i === 0 ? ' ai-start' : ''}`, 'data-label': AI_HELP[i][0] }, value);
  const helpHead = ([label, text], i) => el('th', { class: `ai${i === 0 ? ' ai-start' : ''}`, scope: 'col' },
    el('button', {
      class: 'ai-term',
      type: 'button',
      'aria-label': `${label}: ${text}`,
      onmouseenter: (e) => showTip(e.currentTarget, text),
      onmouseleave: hideTip,
      onfocus: (e) => showTip(e.currentTarget, text),
      onblur: hideTip,
    }, label, el('i', { 'aria-hidden': 'true' }, '?')));

  return el('table', { class: 'review-table' },
    el('thead', {},
      el('tr', { class: 'groups' },
        el('th', { colspan: 3, scope: 'colgroup' }, 'プレイヤーの判断'),
        el('th', { colspan: 4, scope: 'colgroup', class: 'ai ai-start' }, 'AIの読み')),
      el('tr', {},
        ['ヒント', '狙い', '回答'].map((h) => el('th', { scope: 'col' }, h)),
        AI_HELP.map(helpHead))),
    el('tbody', {}, r.turns.map((t) => el('tr', {},
      el('td', { 'data-label': 'ヒント' }, el('span', {}, who(t.giver), `${t.hint}: ${t.number}`)),
      el('td', { 'data-label': '狙い' }, t.intended.join('、') || '—'),
      el('td', { 'data-label': '回答' }, el('span', {}, who(t.giver === 'A' ? 'B' : 'A'), t.picks.length ? picksText(t) : '—')),
      el('td', { class: 'ai ai-title', 'aria-hidden': 'true' }, 'AIの読み'),
      aiCell(0, t.ai?.topPicks.join('、') ?? '—'),
      aiCell(1, t.ai?.decoy ?? '—'),
      aiCell(2, t.ai?.tsujido === null || !t.ai ? '—' : `${t.ai.tsujido}%`),
      aiCell(3, t.ai ? `${t.ai.danger}%` : '—')))));
}

// 次の対局の単語リスト。感想戦の間だけ手元で覚える
function nextList() {
  const node = seg('nextList', '次の単語リスト', WORD_LISTS, ui.nextList ?? state.settings.wordList ?? 'mild');
  node.addEventListener('change', (e) => { ui.nextList = e.target.value; });
  return node;
}

function rematch() {
  send({ t: 'rematch', wordList: ui.nextList ?? state.settings.wordList });
  ui.nextList = null;
}

function reviewNode(g) {
  const r = g.review;
  const listName = WORD_LISTS.find(([id]) => id === g.wordList)?.[1];
  const hasScore = g.score !== null && g.score !== undefined;
  return el('section', { class: 'review paper', id: 'review', 'data-slot': 'review' },
    el('div', { class: 'review-head' },
      el('h2', { class: g.phase === 'won' ? 'verdict-won' : 'verdict-lost' }, g.phase === 'won' ? '事件解決' : '迷宮入り'),
      hasScore && el('p', { class: 'score' }, el('b', {}, String(g.score)), `点${g.score >= 9 ? '　お見事' : g.score > 5 ? '　上出来' : ''}`)),
    el('p', { class: 'note' }, el('span', {}, '盤面のカードの右下に、相方の面が出ています。'), listName && el('span', {}, `単語リスト: ${listName}`)),
    el('div', { class: 'awards' },
      el('div', { class: 'award' }, el('h3', {}, 'AI超え'), el('div', { class: 'big' }, `${r.beatCount}回`)),
      r.lowestHit && el('div', { class: 'award' }, el('h3', {}, '通じる度が一番低かったのに当たった'), el('div', { class: 'big' }, `${r.lowestHit.hint}（${r.lowestHit.tsujido}%）`)),
      r.biggestGap && el('div', { class: 'award' }, el('h3', {}, 'AIがなぜか推した単語'), el('div', { class: 'big' }, `「${r.biggestGap.hint}」で ${r.biggestGap.word}`))),
    el('details', { class: 'ai-help' }, el('summary', {}, 'AIの項目の見方'),
      el('dl', {}, AI_HELP.flatMap(([label, text]) => [el('dt', {}, label), el('dd', {}, text)]))),
    el('div', { class: 'review-wrap' }, reviewTable(r)),
    !state.record && el('div', { class: 'review-end' }, nextList(), el('button', { class: 'btn primary', type: 'button', onclick: rematch }, 'もう一局')));
}

function render() {
  if (!state) return;
  hideTip();
  const g = state.game;
  if (!g) { renderWaiting(state); return; }
  document.body.classList.add('playing');
  const active = document.activeElement;
  const keepFocus = active?.name === 'word' || active?.name === 'number' ? active.name : null;
  const selection = keepFocus === 'word' ? [active.selectionStart, active.selectionEnd] : null;

  const over = g.phase === 'won' || g.phase === 'lost';
  const notices = [
    g.myGreensDone && !over && el('p', { class: 'notice' }, 'あなたの面の協力者はすべて見つかりました。電報は相方が打ちます。'),
    g.partnerGreensDone && !over && el('p', { class: 'notice' }, '相方の面の協力者はすべて見つかりました。'),
  ];
  const solo = isSolo();
  const seatButton = (cls) => el('button', { class: `btn ${cls}`, type: 'button', onclick: switchSeat }, '相方の席に替わる');
  let action;
  if (over) {
    action = el('div', { class: 'ended' },
      el('section', { class: `telegram${g.phase === 'won' ? '' : ' idle'}` },
        el('h2', {}, g.phase === 'won' ? '事件解決' : '迷宮入り'),
        el('p', { class: 'hint-note' }, '相方の面と、AIの読みを見比べられます。')),
      el('button', { class: 'btn', type: 'button', onclick: () => document.getElementById('review')?.scrollIntoView({ behavior: 'smooth' }) }, '事件簿を読む'));
  } else if (g.canGive) {
    action = hintForm(g);
  } else {
    action = [telegramNode(g), g.canPick ? pickBar(g) : solo && seatButton('primary')];
  }

  const tabs = el('div', { class: 'tabs' }, [['input', '電報'], ['history', '捜査メモ']].map(([id, text]) =>
    el('button', { type: 'button', 'aria-pressed': ui.tab === id ? 'true' : 'false', onclick: () => { ui.tab = id; render(); } }, text)));

  const assist = el('label', { class: 'settings-row' },
    el('input', {
      type: 'checkbox',
      checked: colorAssist(),
      onchange: (e) => { store.set('hitokoto.assist', e.target.checked ? '1' : '0'); render(); },
    }), '色覚サポート');

  const slots = {
    head: el('header', { class: 'status-line', 'data-slot': 'head' },
      el('span', { class: 'brand' }, markSvg(), el('span', { class: 'title' }, 'ひとこと探偵')),
      el('span', { class: 'state' }, statusText(g)),
      state.record && recordNav(),
      solo && el('span', { class: 'meta' }, `動作確認中・${state.you.name}の席`),
      solo && (over || g.canGive || g.canPick) && seatButton('small'),
      !solo && !state.partner.online && el('span', { class: 'meta off' }, '相方は接続していません')),
    ledger: ledgerNode(g),
    actions: el('div', { class: 'actions', 'data-slot': 'actions' }, tabs, el('div', { class: 'actions-body' }, notices, action)),
    panel: el('aside', { class: 'panel', 'data-slot': 'panel' }, historyBox(g), assist),
    review: over ? reviewNode(g) : null,
  };
  const board = el('div', { class: `board${ui.fresh.deal ? ' deal' : ''}` }, g.cells.map((c, i) => cellNode(c, i, g)));
  for (const cell of board.children) {
    const card = cell.querySelector('.card');
    card.sig = signature(card);
  }

  // 盤面は置いたまま、周りだけ入れ替える。札の動きがつながるようにするため
  const current = app.querySelector(':scope > .table');
  if (current && !ui.fresh.deal) {
    current.dataset.tab = ui.tab;
    morphBoard(current.querySelector('.board'), board);
    for (const [name, node] of Object.entries(slots)) {
      const old = current.querySelector(`:scope > [data-slot="${name}"]`);
      if (old && node) old.replaceWith(node);
      else if (old) old.remove();
      else if (node) current.append(node);
    }
  } else {
    app.replaceChildren(el('div', { class: 'table', 'data-tab': ui.tab },
      slots.head, slots.ledger, el('div', { class: 'board-wrap' }, board), slots.actions, slots.panel, slots.review));
    setTimeout(() => board.classList.remove('deal'), 1000);
  }
  ui.fresh = noFresh();

  if (keepFocus) {
    const node = app.querySelector(`[name="${keepFocus}"]`);
    node?.focus();
    if (selection) node?.setSelectionRange(...selection);
  }
}

if (recordCode) openRecord();
else if (roomCode) connect();
else renderCreate();
