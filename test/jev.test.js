import assert from 'node:assert/strict';
import test from 'node:test';
import { askJev, buildRequest, computeAi } from '../src/jev.js';

test('リクエストは盤面の単語とヒントだけで、順番違いの質問を2つ持つ', () => {
  const req = buildRequest('海', 2, ['クジラ', '銀行', '砂漠']);
  assert.deepEqual(Object.keys(req.questions.pick_a.criteria), ['クジラ', '銀行', '砂漠']);
  assert.deepEqual(Object.keys(req.questions.pick_b.criteria), ['砂漠', '銀行', 'クジラ']);
  assert.deepEqual(req.state, { hint: '海', number: 2, board: ['クジラ', '銀行', '砂漠'] });
  assert.ok(!JSON.stringify(req).match(/green|assassin|intended/));
});

test('2回の確率を平均して、通じ度・予想・迷わせ・危険度を出す', () => {
  const answers = {
    pick_a: { probabilities: { クジラ: 0.6, 銀行: 0.3, 砂漠: 0.1 } },
    pick_b: { probabilities: { クジラ: 0.4, 銀行: 0.5, 砂漠: 0.1 } },
  };
  const words = ['クジラ', '銀行', '砂漠'];
  const ai = computeAi({ answers }, { board: [0, 1, 2], wordOf: (i) => words[i], intended: [0], number: 2, assassins: [2] });
  assert.ok(Math.abs(ai.tsujido - 0.5) < 1e-9);
  assert.deepEqual(ai.topPicks, [0, 1]);
  assert.equal(ai.decoy, 1);
  assert.ok(Math.abs(ai.danger - 0.1) < 1e-9);
});

test('応答に確率がなければ失敗として扱う', () => {
  assert.throws(() => computeAi({}, { board: [], wordOf: () => '', intended: [], number: 1, assassins: [] }), /確率/);
});

test('エラー応答は例外になる', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(askJev({ apiKey: 'k', hint: '海', number: 1, words: ['a'], fetchImpl }), /500/);
});
