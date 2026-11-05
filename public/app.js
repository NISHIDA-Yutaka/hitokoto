// 表示と入力だけを受け持つ。判定はすべてサーバーが行う。
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

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
const tokenKey = (code) => `hitokoto.token.${code}`;

// ---------- 入口 ----------

function field(label, control) {
  return el('label', { class: 'field' }, el('span', {}, label), control);
}

function select(name, options, value) {
  return el('select', { name }, options.map(([v, text]) => el('option', { value: v, selected: String(v) === String(value) }, text)));
}

function rulesBox() {
  return el('section', { class: 'rules' },
    el('h2', {}, '遊び方'),
    el('ul', {},
      el('li', {}, '2人で協力して、盤面に隠れた協力者15人に接触します。'),
      el('li', {}, 'ヒントは「1語＋数字」だけ。見えている色はお互い違います。'),
      el('li', {}, '黒幕に触れるのは1回まで。2回目で事件は迷宮入りです。'),
      el('li', {}, '話すなら通話で。自分の面の色は口にしないでください。'),
    ));
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
          },
        });
        store.set(tokenKey(res.code), res.token);
        store.set('hitokoto.name', f.get('name'));
        location.href = `/r/${res.code}`;
      } catch (err) { error.textContent = err.message; }
    },
  },
  field('あなたの名前', el('input', { name: 'name', required: true, maxlength: 12, autocomplete: 'nickname', value: store.get('hitokoto.name') ?? '' })),
  field('タイマー枚数', select('timers', [[9, '9枚（標準）'], [10, '10枚'], [11, '11枚']], 9)),
  field('黒幕で没収する枚数', select('assassinPenalty', [[1, '1枚'], [2, '2枚（標準）'], [3, '3枚']], 2)),
  field('AIツッコミ', select('aiReveal', [['afterTurn', '手番のあとに通じ度を出す'], ['afterGame', 'ゲーム後にまとめて出す']], 'afterTurn')),
  el('details', { class: 'more' }, el('summary', {}, '細かい設定'),
    field('黒幕を許す回数', select('maxOuts', [[0, '0回（1回で負け）'], [1, '1回（標準）'], [2, '2回']], 1)),
    field('没収分のタイマーが足りないとき', select('timerShortage', [['pay', 'あるだけ払う（標準）'], ['lose', '払えなければ負け']], 'pay'))),
  error,
  el('button', { class: 'btn primary', type: 'submit' }, '部屋を作る'));
  app.replaceChildren(el('div', { class: 'entry' },
    el('h1', {}, 'ひとこと探偵'),
    el('p', { class: 'lead' }, '深夜の事務所で、1語のヒントだけを頼りに。'),
    form,
    rulesBox()));
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
  field('あなたの名前', el('input', { name: 'name', required: true, maxlength: 12, autocomplete: 'nickname', value: store.get('hitokoto.name') ?? '' })),
  error,
  el('button', { class: 'btn primary', type: 'submit' }, '部屋に入る'));
  app.replaceChildren(el('div', { class: 'entry' },
    el('h1', {}, 'ひとこと探偵'),
    el('p', { class: 'lead' }, '相方があなたを待っています。'),
    form,
    rulesBox()));
}

function renderWaiting(state) {
  const url = location.href;
  const input = el('input', { value: url, readonly: true, 'aria-label': '相方に送るURL' });
  app.replaceChildren(el('div', { class: 'entry' },
    el('h1', {}, 'ひとこと探偵'),
    el('p', { class: 'lead' }, `${state.you.name}さんの部屋。相方を待っています。`),
    el('p', {}, 'このURLを相方に送ってください。入るとすぐに始まります。'),
    el('div', { class: 'share' }, input,
      el('button', {
        class: 'btn',
        onclick: async () => {
          try { await navigator.clipboard.writeText(url); toast('コピーしました'); } catch { input.select(); }
        },
      }, 'コピー'))));
}

// ---------- 接続 ----------

let ws;
let state = null;
let retry = 0;
const ui = { candidate: null, confirming: false, targets: new Set(), tab: 'input', hintWord: '', hintNumber: 1 };
const shownAi = new Set();
let seenOuts = null;
let seenPhase = null;

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

function onState(next) {
  const g = next.game;
  if (g) {
    for (const t of g.turns) {
      if (!t.ai || shownAi.has(t.no)) continue;
      shownAi.add(t.no);
      if (state) toast(`通じ度 ${t.ai.tsujido}%　${t.ai.line}`);
    }
    if (seenOuts !== null && g.outs > seenOuts && g.phase !== 'lost') {
      toast(`黒幕！ ${g.outs}アウト。タイマー −${g.penalty}`);
      app.classList.add('shake');
      setTimeout(() => app.classList.remove('shake'), 320);
    }
    if (seenPhase && seenPhase !== g.phase && g.phase === 'lost') {
      document.body.append(el('div', { class: 'blackout' }, '迷宮入り'));
      setTimeout(() => document.querySelector('.blackout')?.remove(), 1700);
    }
    seenOuts = g.outs;
    seenPhase = g.phase;
    if (!g.cells[ui.candidate]?.selectable) { ui.candidate = null; ui.confirming = false; }
    if (!g.canGive) { ui.targets.clear(); ui.hintWord = ''; ui.hintNumber = 1; }
  }
  state = next;
  render();
}

// ---------- ゲーム画面 ----------

const SYMBOLS = { green: '●', assassin: '×', bystander: '' };
const colorAssist = () => store.get('hitokoto.assist') === '1';
const footSvg = (mine) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `foot ${mine ? 'mine' : 'theirs-side'}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', mine ? '自分が外した印' : '相方が外した印');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 1c2.2 0 3.4 2 3.4 4.2 0 1.7-.9 3-1.2 4.3H6c-.4-1.4-1.4-2.6-1.4-4.3C4.6 3 5.8 1 8 1zm-2 9.6h4.1c.1 2.4-.8 4.4-2 4.4-1.3 0-2.2-2-2.1-4.4z');
  svg.append(path);
  return svg;
};

function wordSize(word) {
  const n = [...word].length;
  return n >= 6 ? 'clamp(10px, 1.45vw, 17px)' : n === 5 ? 'clamp(11px, 1.65vw, 19px)' : null;
}

function cardNode(c, i, g) {
  const hinting = g.canGive;
  const interactive = hinting ? !c.covered : c.selectable;
  const classes = ['card', `mine-${c.mine}`];
  if (c.covered) classes.push('covered');
  if (c.contact) classes.push('contact');
  if (interactive) classes.push('interactive');
  if (ui.candidate === i) classes.push('candidate');
  if (ui.targets.has(i)) classes.push('target');

  const word = el('span', { class: 'word' }, c.word);
  const size = wordSize(c.word);
  if (size) word.style.setProperty('--word-size', size);

  const parts = [word];
  if (colorAssist() && SYMBOLS[c.mine] && !c.contact) parts.push(el('span', { class: 'symbol', 'aria-hidden': 'true' }, SYMBOLS[c.mine]));
  for (const m of c.marks) {
    if (m.kind === 'bystander') parts.push(footSvg(m.mine));
    else parts.push(el('span', { class: 'seal', title: m.mine ? '自分が踏んだ黒幕の印' : '相方が踏んだ黒幕の印' }, '封'));
  }
  if (c.contact) parts.push(el('span', { class: 'stamp' }, el('span', {}, '接触')));
  if (c.theirs) {
    const name = { green: '協力者', assassin: '黒幕', bystander: '通行人' }[c.theirs];
    parts.push(el('span', { class: 'theirs', title: `相方の面: ${name}` },
      el('span', { class: 'long' }, `相方: ${name}`),
      el('span', { class: 'short' }, name[0])));
  }

  const label = [c.word, { green: '協力者', assassin: '黒幕', bystander: '通行人' }[c.mine], c.covered ? '覆われた' : ''].filter(Boolean).join('、');
  return el('button', {
    class: classes.join(' '),
    type: 'button',
    disabled: !interactive,
    'aria-label': label,
    'aria-pressed': ui.candidate === i || ui.targets.has(i) ? 'true' : 'false',
    onclick: () => {
      if (hinting) {
        if (ui.targets.has(i)) ui.targets.delete(i); else ui.targets.add(i);
      } else {
        ui.candidate = ui.candidate === i ? null : i;
        ui.confirming = false;
      }
      render();
    },
  }, parts);
}

function statusText(g) {
  if (g.phase === 'won') return '事件解決！ 協力者15人に接触しました';
  if (g.phase === 'lost') return '迷宮入り';
  if (g.phase === 'sudden_death') return g.canPick ? 'タイムアップ。ヒントなしで残りを当ててください。1回外せば負けです' : 'タイムアップ。相方の推理を待っています';
  if (g.current) {
    const h = `「${g.current.hint}」: ${g.current.number}`;
    return g.current.mine ? `${h} を送りました。相方が選んでいます` : `ヒント ${h}　単語を選んでください`;
  }
  if (g.canGive) return g.turns.length ? 'あなたがヒントを出す番です' : 'どちらからでもヒントを出せます';
  return '相方のヒントを待っています';
}

function hintForm(g) {
  const error = el('p', { class: 'hint-note' }, `狙いのカードをクリックで選んでください（${ui.targets.size}枚）。相方には見えません。`);
  const word = el('input', {
    name: 'word', required: true, maxlength: 20, autocomplete: 'off', value: ui.hintWord,
    oninput: (e) => { ui.hintWord = e.target.value; },
  });
  const number = el('input', {
    name: 'number', type: 'number', min: 0, max: 9, required: true, value: ui.hintNumber,
    oninput: (e) => { ui.hintNumber = Number(e.target.value); render(); },
  });
  return el('form', {
    class: 'actions-form',
    onsubmit: (e) => {
      e.preventDefault();
      send({ t: 'hint', word: ui.hintWord, number: ui.hintNumber, intended: [...ui.targets] });
    },
  },
  el('div', { class: 'hint-form' },
    field('ヒント（1語）', word),
    field('数字', number),
    el('button', { class: 'btn primary', type: 'submit', disabled: ui.hintNumber > 0 && ui.targets.size === 0 }, '送る')),
  error);
}

function pickBar(g) {
  const c = g.cells[ui.candidate];
  const desktop = matchMedia('(min-width: 861px)').matches;
  const decide = () => {
    if (desktop && !ui.confirming) { ui.confirming = true; render(); return; }
    send({ t: 'pick', cell: ui.candidate });
    ui.candidate = null;
    ui.confirming = false;
  };
  return el('div', { class: 'choose' },
    c
      ? el('button', { class: `btn ${ui.confirming ? 'warn' : 'primary'}`, type: 'button', onclick: decide },
        ui.confirming ? `本当に「${c.word}」でいい？` : `「${c.word}」に決定`)
      : el('span', { class: 'hint-note' }, 'カードをクリックすると付箋が付きます'),
    g.canStop && el('button', { class: 'btn', type: 'button', onclick: () => send({ t: 'stop' }) }, '手番を終える'));
}

function historyBox(g) {
  const items = [...g.turns].reverse().map((t) => el('li', {},
    el('div', { class: 'hint' }, `${t.hint}: ${t.number}`),
    el('div', { class: 'sub' }, `${t.mine ? '自分' : '相方'}のヒント・${t.correct}人に接触${t.end ? '' : '（進行中）'}`),
    t.ai && [
      el('div', { class: 'sub' }, `通じ度 ${t.ai.tsujido}%　${t.ai.line}`),
      gauge(t.ai.tsujido),
    ]));
  return el('section', { class: 'box' }, el('h2', {}, 'ヒントの履歴'),
    items.length ? el('ul', { class: 'history' }, items) : el('p', { class: 'hint-note' }, 'まだありません'));
}

function gauge(percent) {
  const bar = el('i');
  bar.style.width = `${percent}%`;
  return el('div', { class: 'gauge' }, bar);
}

function metersBox(g) {
  const outs = Array.from({ length: g.maxOuts + 1 }, (_, i) => (i < g.outs ? '●' : '○')).join(' ');
  return el('section', { class: 'box meters-box' },
    el('div', { class: 'meters' },
      el('div', {}, el('h2', {}, '残りタイマー'), el('div', { class: 'meter-value' }, `${g.timerBank}`)),
      el('div', {}, el('h2', {}, 'アウト'), el('div', { class: 'outs', 'aria-label': `${g.outs}アウト` }, outs)),
      el('div', {}, el('h2', {}, '接触'), el('div', { class: 'meter-value' }, `${g.found}/15`))));
}

function reviewNode(g) {
  const r = g.review;
  const picksText = (t) => t.picks.map((p) => el('span', { class: p.result === 'green' ? 'tag-green' : 'tag-bad' },
    `${p.word}${p.result === 'green' ? '' : p.result === 'assassin' ? '（黒幕）' : '（通行人）'} `));
  return el('section', { class: 'review box' },
    el('h2', {}, g.phase === 'won' ? '事件解決' : '迷宮入り'),
    el('p', { class: 'hint-note' }, 'カードの右下は相方の面です。'),
    g.score !== null && g.score !== undefined && el('p', {}, `スコア ${g.score}点${g.score >= 9 ? '　お見事' : g.score > 5 ? '　上出来' : ''}`),
    el('div', { class: 'awards' },
      el('div', { class: 'box award' }, el('h2', {}, 'AI超え'), el('div', { class: 'big' }, `${r.beatCount}回`)),
      r.lowestHit && el('div', { class: 'box award' }, el('h2', {}, '通じ度が一番低かったのに当たった'), el('div', { class: 'big' }, `${r.lowestHit.hint}（${r.lowestHit.tsujido}%）`)),
      r.biggestGap && el('div', { class: 'box award' }, el('h2', {}, 'AIがなぜか推した単語'), el('div', { class: 'big' }, `「${r.biggestGap.hint}」で ${r.biggestGap.word}`))),
    el('div', { class: 'review-wrap' }, el('table', { class: 'review-table' },
      el('thead', {}, el('tr', {}, ['ヒント', '狙い', '相方の選択', 'AIの予想', '迷わせ', '通じ度', '危険度'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, r.turns.map((t) => el('tr', {},
        el('td', {}, `${t.hint}: ${t.number}`),
        el('td', {}, t.intended.join('、') || '—'),
        el('td', {}, picksText(t)),
        el('td', {}, t.ai?.topPicks.join('、') ?? '—'),
        el('td', {}, t.ai?.decoy ?? '—'),
        el('td', {}, t.ai?.tsujido === null || !t.ai ? '—' : `${t.ai.tsujido}%`),
        el('td', {}, t.ai ? `${t.ai.danger}%` : '—')))))),
    el('p', {}, el('button', { class: 'btn primary', type: 'button', onclick: () => send({ t: 'rematch' }) }, 'もう一局')));
}

function render() {
  if (!state) return;
  const g = state.game;
  if (!g) { renderWaiting(state); return; }
  const active = document.activeElement;
  const keepFocus = active?.name === 'word' || active?.name === 'number' ? active.name : null;
  const selection = keepFocus === 'word' ? [active.selectionStart, active.selectionEnd] : null;

  const over = g.phase === 'won' || g.phase === 'lost';
  const notices = [
    g.myGreensDone && !over && el('p', { class: 'hint-note' }, 'あなたの面の協力者はすべて接触済みです。ヒントは相方が出します。'),
    g.partnerGreensDone && !over && el('p', { class: 'hint-note' }, '相方の面の協力者はすべて接触済みです。'),
  ];
  const action = over ? null : g.canGive ? hintForm(g) : g.canPick ? pickBar(g) : null;

  const tabs = el('div', { class: 'tabs' }, [['input', '入力'], ['history', '履歴']].map(([id, text]) =>
    el('button', { type: 'button', 'aria-pressed': ui.tab === id ? 'true' : 'false', onclick: () => { ui.tab = id; render(); } }, text)));

  const assist = el('label', { class: 'settings-row' },
    el('input', {
      type: 'checkbox',
      checked: colorAssist(),
      onchange: (e) => { store.set('hitokoto.assist', e.target.checked ? '1' : '0'); render(); },
    }), '色覚サポート');

  const table = el('div', { class: 'table', 'data-tab': ui.tab },
    el('header', { class: 'status-line' },
      el('span', { class: 'title' }, 'ひとこと探偵'),
      el('span', { class: 'state' }, statusText(g)),
      el('span', { class: 'hint-note' }, `タイマー ${g.timerBank}・${g.outs}アウト`),
      !state.partner.online && el('span', { class: 'hint-note' }, '相方は接続していません')),
    el('div', { class: 'board' }, g.cells.map((c, i) => cardNode(c, i, g))),
    el('aside', { class: 'panel' }, metersBox(g), historyBox(g), assist),
    el('div', { class: 'actions' }, tabs, el('div', { class: 'actions-body' }, notices, action)),
    over && reviewNode(g));
  app.replaceChildren(table);

  if (keepFocus) {
    const node = app.querySelector(`[name="${keepFocus}"]`);
    node?.focus();
    if (selection) node?.setSelectionRange(...selection);
  }
}

if (roomCode) connect();
else renderCreate();
