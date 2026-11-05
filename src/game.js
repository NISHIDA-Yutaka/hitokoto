// ルール判定。DB や通信を知らない純粋な処理だけを置く。
import { randomInt } from 'node:crypto';

export class GameError extends Error {}

export const DEFAULT_SETTINGS = Object.freeze({
  timers: 9,
  assassinPenalty: 2,
  maxOuts: 1,
  timerShortage: 'pay', // pay: あるだけ払う / lose: 払えなければ敗北
  aiReveal: 'afterTurn', // afterTurn: 手番後に通じ度 / afterGame: ゲーム後だけ
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function normalizeSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    timers: clampInt(input.timers, 9, 11, d.timers),
    assassinPenalty: clampInt(input.assassinPenalty, 1, 3, d.assassinPenalty),
    maxOuts: clampInt(input.maxOuts, 0, 2, d.maxOuts),
    timerShortage: input.timerShortage === 'lose' ? 'lose' : d.timerShortage,
    aiReveal: input.aiReveal === 'afterGame' ? 'afterGame' : d.aiReveal,
  };
}

// 両面の組み合わせと枚数。合計25枚、どちらかの面で緑なのは15枚
const KEY_PAIRS = [
  ['green', 'green', 3],
  ['green', 'bystander', 5],
  ['green', 'assassin', 1],
  ['bystander', 'green', 5],
  ['assassin', 'green', 1],
  ['assassin', 'assassin', 1],
  ['assassin', 'bystander', 1],
  ['bystander', 'assassin', 1],
  ['bystander', 'bystander', 7],
];

export function shuffle(items, rand = randomInt) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeKeys(rand = randomInt) {
  const swap = rand(2) === 1;
  const keys = KEY_PAIRS.flatMap(([a, b, n]) =>
    Array.from({ length: n }, () => (swap ? { A: b, B: a } : { A: a, B: b })));
  return shuffle(keys, rand);
}

export const other = (seat) => (seat === 'A' ? 'B' : 'A');

export function newGame(words, settings, rand = randomInt) {
  if (words.length !== 25) throw new GameError('単語が25語ありません');
  const keys = makeKeys(rand);
  return {
    cells: words.map((word, i) => ({ word, key: keys[i], covered: false, contact: false, marks: [] })),
    timerBank: settings.timers,
    outs: 0,
    turns: [],
    phase: 'playing',
    settings,
  };
}

// seat の面で、まだ覆われていない緑（＝相方に当ててもらう残り）
export const remaining = (g, seat) =>
  g.cells.filter((c) => !c.covered && c.key[seat] === 'green').length;

export const currentTurn = (g) => {
  const t = g.turns.at(-1);
  return t && !t.end ? t : null;
};

const isOver = (g) => g.phase === 'won' || g.phase === 'lost';
const allFound = (g) => !g.cells.some((c) => !c.covered && (c.key.A === 'green' || c.key.B === 'green'));

export function nextGivers(g) {
  if (g.phase !== 'playing' || currentTurn(g)) return [];
  const last = g.turns.at(-1);
  const preferred = (last ? [other(last.giver)] : ['A', 'B']).filter((s) => remaining(g, s) > 0);
  if (preferred.length) return preferred;
  return last && remaining(g, last.giver) > 0 ? [last.giver] : [];
}

export const suddenGuessers = (g) =>
  g.phase === 'sudden_death' ? ['A', 'B'].filter((s) => remaining(g, other(s)) > 0) : [];

export const canPick = (g, seat, idx) => {
  const c = Number.isInteger(idx) ? g.cells[idx] : null;
  return Boolean(c) && !c.covered && !c.marks.some((m) => m.pickedBy === seat);
};

const fold = (s) => s.normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

export function hintProblem(g, word) {
  if (typeof word !== 'string') return 'ヒントを入力してください';
  const hint = word.trim();
  if (!hint) return 'ヒントを入力してください';
  if ([...hint].length > 20) return 'ヒントは20文字までです';
  if (/\s/.test(hint)) return 'ヒントは1語にしてください';
  if (/^[\d０-９]+$/.test(hint)) return '数字そのものはヒントに使えません';
  const h = fold(hint);
  for (const c of g.cells) {
    if (c.covered) continue;
    const w = fold(c.word);
    if (h === w || (w.length >= 2 && h.includes(w)) || (h.length >= 2 && w.includes(h))) {
      return `場にある「${c.word}」に重なるヒントは使えません`;
    }
  }
  return null;
}

export function giveHint(g, seat, { word, number, intended }) {
  if (!nextGivers(g).includes(seat)) throw new GameError('今はヒントを出す番ではありません');
  const problem = hintProblem(g, word);
  if (problem) throw new GameError(problem);
  if (!Number.isInteger(number) || number < 0 || number > 9) throw new GameError('数字は0〜9にしてください');
  const targets = [...new Set(Array.isArray(intended) ? intended : [])];
  if (targets.length > 9 || targets.some((i) => !Number.isInteger(i) || !g.cells[i] || g.cells[i].covered)) {
    throw new GameError('狙いのカードを選び直してください');
  }
  if (number > 0 && targets.length === 0) throw new GameError('狙いのカードを選んでください');
  const turn = { no: g.turns.length + 1, giver: seat, hint: word.trim(), number, intended: targets, picks: [], end: null, ai: null };
  g.turns.push(turn);
  return turn;
}

function finish(g, phase) {
  g.phase = phase;
  const t = currentTurn(g);
  if (t) t.end = 'gameover';
}

function endTurn(g, reason) {
  currentTurn(g).end = reason;
  if (g.timerBank > 0) return;
  g.phase = 'sudden_death';
  g.turns.push({ no: g.turns.length + 1, giver: 'A', hint: '', number: 0, intended: [], picks: [], end: null, ai: null });
}

function addMark(cell, pickedBy, kind) {
  cell.marks.push({ pickedBy, kind });
  if (new Set(cell.marks.map((m) => m.pickedBy)).size === 2) cell.covered = true;
}

// 今この席が単語を選べる番か
export function isGuesser(g, seat) {
  if (g.phase === 'sudden_death') return suddenGuessers(g).includes(seat);
  const turn = currentTurn(g);
  return Boolean(turn) && other(turn.giver) === seat;
}

// 候補の印は手番ごとに持つ。手番が変われば消える
export const turnKey = (g) => `${g.id}:${currentTurn(g)?.no ?? '-'}`;

export function candidateCells(g, seat, cells) {
  if (isOver(g) || !isGuesser(g, seat)) throw new GameError('今は選ぶ番ではありません');
  if (!Array.isArray(cells) || cells.length > g.cells.length) throw new GameError('候補の指定が正しくありません');
  return [...new Set(cells)].filter((i) => Number.isInteger(i) && canPick(g, seat, i));
}

export function pick(g, seat, idx) {
  if (isOver(g)) throw new GameError('ゲームは終わっています');
  const turn = currentTurn(g);
  const sudden = g.phase === 'sudden_death';
  if (!isGuesser(g, seat)) throw new GameError('今は選ぶ番ではありません');
  if (!canPick(g, seat, idx)) throw new GameError('その単語はもう選べません');

  const cell = g.cells[idx];
  const result = cell.key[other(seat)];
  turn.picks.push({ by: seat, cell: idx, result });

  if (result === 'green') {
    cell.covered = true;
    cell.contact = true;
    if (allFound(g)) finish(g, 'won');
    return result;
  }
  addMark(cell, seat, result);
  if (sudden) {
    finish(g, 'lost');
    return result;
  }
  if (result === 'bystander') {
    g.timerBank -= 1;
    endTurn(g, 'bystander');
    return result;
  }
  g.outs += 1;
  const { maxOuts, assassinPenalty, timerShortage } = g.settings;
  if (g.outs > maxOuts || (timerShortage === 'lose' && g.timerBank < assassinPenalty)) {
    finish(g, 'lost');
    return result;
  }
  g.timerBank = Math.max(0, g.timerBank - assassinPenalty);
  endTurn(g, 'assassin');
  return result;
}

export function stopTurn(g, seat) {
  const turn = currentTurn(g);
  if (g.phase !== 'playing' || !turn || other(turn.giver) !== seat) throw new GameError('今は終えられません');
  if (!turn.picks.some((p) => p.result === 'green')) throw new GameError('1つ当てるまでは終えられません');
  g.timerBank -= 1;
  endTurn(g, 'stop');
}

// タイマー9枚で勝ったときだけ採点する
export function score(g) {
  if (g.phase !== 'won' || g.settings.timers !== 9) return null;
  const stops = g.turns.filter((t) => t.end === 'stop').length;
  const sudden = g.turns.some((t) => t.hint === '');
  return g.timerBank * 3 + stops - (sudden ? 1 : 0);
}
