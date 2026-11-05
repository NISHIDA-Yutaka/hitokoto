import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, giveHint, newGame, pick } from '../src/game.js';
import { tsukkomi, turnOutcome } from '../src/review.js';
import { viewFor } from '../src/view.js';

const words = Array.from({ length: 25 }, (_, i) => `語${String.fromCharCode(0x4e00 + i * 7)}`);
const room = { code: 'x', settings: DEFAULT_SETTINGS };
const players = { A: { name: 'あ' }, B: { name: 'い' } };
const view = (game, seat) => viewFor({ room, players, game }, seat);
const setup = (settings = DEFAULT_SETTINGS) => {
  const g = newGame(words, settings);
  const target = g.cells.findIndex((c) => c.key.A === 'green');
  const turn = giveHint(g, 'A', { word: '海', number: 1, intended: [target] });
  return { g, target, turn };
};
const ai = (tsujido, target) => ({ probs: { [target]: tsujido }, tsujido, topPicks: [target], decoy: null, danger: 0.9 });

test('ゲーム中は相方の面も狙いも送らない', () => {
  const { g, target } = setup();
  for (const seat of ['A', 'B']) {
    const v = view(g, seat);
    assert.ok(v.game.cells.every((c, i) => c.mine === g.cells[i].key[seat] && !('theirs' in c)));
    const text = JSON.stringify(v);
    assert.ok(!text.includes('intended') && !text.includes('"key"'));
    assert.ok(!('review' in v.game));
  }
  assert.ok(target >= 0);
});

test('手番中はAIの結果を出さず、手番後は丸めた通じ度とセリフだけ出す', () => {
  const { g, target, turn } = setup();
  turn.ai = ai(0.64, target);
  assert.equal(view(g, 'B').game.turns[0].ai, undefined);
  pick(g, 'B', target);
  turn.end = 'stop';
  const shown = view(g, 'B').game.turns[0].ai;
  assert.deepEqual(shown, { tsujido: 60, line: 'AIも納得の名ヒント' });
  const text = JSON.stringify(view(g, 'B'));
  assert.ok(!text.includes('danger') && !text.includes('topPicks') && !text.includes('decoy'));
});

test('ゲーム後だけの設定では手番後に何も出さない', () => {
  const { g, target, turn } = setup({ ...DEFAULT_SETTINGS, aiReveal: 'afterGame' });
  turn.ai = ai(0.64, target);
  pick(g, 'B', target);
  turn.end = 'stop';
  assert.equal(view(g, 'A').game.turns[0].ai, undefined);
});

test('ゲームが終わったら両面と感想戦を出す', () => {
  const { g, target, turn } = setup();
  turn.ai = ai(0.1, target);
  pick(g, 'B', target);
  g.phase = 'lost';
  turn.end = 'gameover';
  const v = view(g, 'B');
  assert.ok(v.game.cells.every((c) => 'theirs' in c));
  assert.deepEqual(v.game.review.turns[0].intended, [g.cells[target].word]);
  assert.equal(v.game.review.lowestHit.tsujido, 10);
});

test('手番の結果は枚数と終わり方だけで決まる', () => {
  const green = { result: 'green' };
  const miss = { result: 'bystander' };
  assert.equal(turnOutcome({ number: 2, picks: [green, green, miss], end: 'bystander' }), 'hit');
  assert.equal(turnOutcome({ number: 2, picks: [green, miss], end: 'bystander' }), 'miss');
  assert.equal(turnOutcome({ number: 2, picks: [green], end: 'stop' }), 'stop');
  assert.equal(tsukkomi({ ai: null }), null);
});
