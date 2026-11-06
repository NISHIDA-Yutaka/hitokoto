import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, GameError, currentTurn, giveHint, hintProblem, makeKeys, newGame, nextGivers, normalizeSettings, other, pick, remaining, score, stopTurn, suddenGuessers } from '../src/game.js';

const words = Array.from({ length: 25 }, (_, i) => `語${String.fromCharCode(0x4e00 + i * 7)}`);
const game = (s = {}) => newGame(words, { ...DEFAULT_SETTINGS, ...s });
const find = (g, pred) => g.cells.findIndex((c) => !c.covered && pred(c));
const hint = (g, seat, intended = []) => giveHint(g, seat, { word: 'ヒント', number: 1, intended: intended.length ? intended : [find(g, () => true)] });

test('両面の内訳は表どおり', () => {
  for (let n = 0; n < 50; n++) {
    const count = {};
    for (const k of makeKeys()) {
      const id = [k.A, k.B].sort().join('/');
      count[id] = (count[id] ?? 0) + 1;
    }
    assert.deepEqual(count, {
      'green/green': 3, 'bystander/green': 10, 'assassin/green': 2,
      'assassin/assassin': 1, 'assassin/bystander': 2, 'bystander/bystander': 7,
    });
  }
});

test('各面は緑9・黒3、当てる単語は15個', () => {
  const g = game();
  for (const s of ['A', 'B']) {
    assert.equal(g.cells.filter((c) => c.key[s] === 'green').length, 9);
    assert.equal(g.cells.filter((c) => c.key[s] === 'assassin').length, 3);
  }
  assert.equal(g.cells.filter((c) => c.key.A === 'green' || c.key.B === 'green').length, 15);
});

test('設定は範囲外を既定値に戻す', () => {
  assert.deepEqual(normalizeSettings({ timers: 99, assassinPenalty: 3, maxOuts: 5, aiReveal: 'afterGame' }),
    { timers: 9, assassinPenalty: 3, maxOuts: 1, timerShortage: 'pay', aiReveal: 'afterGame', wordList: 'mild' });
});

test('場の単語に重なるヒントと数字だけのヒントは拒む', () => {
  const g = game();
  g.cells[0].word = 'ドライバー';
  assert.match(hintProblem(g, 'どらいばー'), /重なる/);
  assert.match(hintProblem(g, 'ドライバー工具'), /重なる/);
  assert.match(hintProblem(g, '１２'), /数字/);
  assert.match(hintProblem(g, '海 山'), /1語/);
  assert.equal(hintProblem(g, '海'), null);
});

test('緑は続けて選べ、1つ当てれば止められ、タイマーは1枚減る', () => {
  const g = game();
  hint(g, 'A');
  assert.throws(() => stopTurn(g, 'B'), GameError);
  assert.equal(pick(g, 'B', find(g, (c) => c.key.A === 'green')), 'green');
  assert.ok(currentTurn(g));
  stopTurn(g, 'B');
  assert.equal(g.timerBank, 8);
  assert.deepEqual(nextGivers(g), ['B']);
});

test('通行人は手番終了で片側だけの印、両側で覆われる', () => {
  const g = game();
  const i = find(g, (c) => c.key.A === 'bystander' && c.key.B === 'bystander');
  hint(g, 'A');
  assert.equal(pick(g, 'B', i), 'bystander');
  assert.equal(g.timerBank, 8);
  assert.equal(g.cells[i].covered, false);
  hint(g, 'B');
  assert.equal(pick(g, 'A', i), 'bystander');
  assert.equal(g.cells[i].covered, true);
});

test('同じ人は印の付いた単語をもう選べない', () => {
  const g = game();
  const i = find(g, (c) => c.key.A === 'bystander');
  hint(g, 'A');
  pick(g, 'B', i);
  hint(g, 'B');
  stopOrMiss(g);
  hint(g, 'A');
  assert.throws(() => pick(g, 'B', i), /選べません/);
});

function stopOrMiss(g) {
  const t = currentTurn(g);
  const seat = other(t.giver);
  pick(g, seat, find(g, (c) => c.key[t.giver] === 'bystander' && !c.marks.some((m) => m.pickedBy === seat)));
}

test('1アウト目はタイマー2枚で手番が終わり、追加の消費はない', () => {
  const g = game();
  const i = find(g, (c) => c.key.A === 'assassin');
  hint(g, 'A');
  assert.equal(pick(g, 'B', i), 'assassin');
  assert.equal(g.outs, 1);
  assert.equal(g.timerBank, 7);
  assert.equal(g.phase, 'playing');
  assert.equal(g.cells[i].covered, false);
  assert.equal(g.turns[0].end, 'assassin');
});

test('2アウト目は敗北', () => {
  const g = game();
  const [x, y] = g.cells.flatMap((c, i) => (c.key.A === 'assassin' ? [i] : []));
  hint(g, 'A');
  pick(g, 'B', x);
  hint(g, 'B');
  stopOrMiss(g);
  hint(g, 'A');
  pick(g, 'B', y);
  assert.equal(g.phase, 'lost');
});

test('許容アウト0なら1回で敗北', () => {
  const g = game({ maxOuts: 0 });
  hint(g, 'A');
  pick(g, 'B', find(g, (c) => c.key.A === 'assassin'));
  assert.equal(g.phase, 'lost');
});

test('暗殺者の印が付いた単語は、ヒント側が相方の面で判定して選べる', () => {
  const g = game();
  const i = find(g, (c) => c.key.A === 'assassin' && c.key.B === 'green');
  hint(g, 'A');
  pick(g, 'B', i);
  hint(g, 'B');
  assert.equal(pick(g, 'A', i), 'green');
  assert.equal(g.cells[i].covered, true);
});

test('タイマーが足りなければあるだけ払ってサドンデスへ', () => {
  const g = game();
  g.timerBank = 1;
  hint(g, 'A');
  pick(g, 'B', find(g, (c) => c.key.A === 'assassin'));
  assert.equal(g.timerBank, 0);
  assert.equal(g.phase, 'sudden_death');
});

test('公式準拠の設定では払えなければ敗北', () => {
  const g = game({ timerShortage: 'lose' });
  g.timerBank = 1;
  hint(g, 'A');
  pick(g, 'B', find(g, (c) => c.key.A === 'assassin'));
  assert.equal(g.phase, 'lost');
});

test('サドンデスは1回外せば負け、残っている側だけが選べる', () => {
  const g = game();
  g.timerBank = 1;
  hint(g, 'A');
  pick(g, 'B', find(g, (c) => c.key.A === 'bystander'));
  assert.equal(g.phase, 'sudden_death');
  assert.deepEqual(suddenGuessers(g), ['A', 'B']);
  for (const c of g.cells) if (c.key.A === 'green') { c.covered = true; c.contact = true; }
  assert.deepEqual(suddenGuessers(g), ['A']);
  assert.throws(() => pick(g, 'B', 0), /番ではありません/);
  pick(g, 'A', find(g, (c) => c.key.B === 'bystander' && !c.marks.some((m) => m.pickedBy === 'A')));
  assert.equal(g.phase, 'lost');
});

test('サドンデスの暗殺者はアウト数に関係なく負け', () => {
  const g = game({ maxOuts: 2 });
  g.timerBank = 1;
  hint(g, 'A');
  pick(g, 'B', find(g, (c) => c.key.A === 'bystander'));
  pick(g, 'B', find(g, (c) => c.key.A === 'assassin'));
  assert.equal(g.phase, 'lost');
});

test('緑15個で勝ち、点数はタイマー3点・止めた回数1点', () => {
  const g = game();
  hint(g, 'A');
  for (let i = 0; remaining(g, 'A') > 0; i++) pick(g, 'B', find(g, (c) => c.key.A === 'green'));
  stopTurn(g, 'B');
  assert.equal(g.timerBank, 8);
  hint(g, 'B');
  for (; remaining(g, 'B') > 0;) pick(g, 'A', find(g, (c) => c.key.B === 'green'));
  assert.equal(g.phase, 'won');
  assert.equal(score(g), 8 * 3 + 1);
});

test('自分の緑が尽きたらヒントは相方だけが出す', () => {
  const g = game();
  hint(g, 'A');
  for (; remaining(g, 'A') > 0;) pick(g, 'B', find(g, (c) => c.key.A === 'green'));
  stopTurn(g, 'B');
  assert.deepEqual(nextGivers(g), ['B']);
  hint(g, 'B');
  stopOrMiss(g);
  assert.deepEqual(nextGivers(g), ['B']);
});
