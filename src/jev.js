// Jev（TypeSafe AI）への問い合わせ。キーカードの情報は渡さない。
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const INSTRUCTIONS = '連想ゲームで、hint のヒントを聞いた人が board の中から最初に選ぶ単語はどれか';

export function buildRequest(hint, number, words) {
  const criteria = (list) => Object.fromEntries(list.map((w) => [w, null]));
  const question = (list) => ({ type: 'choice', instructions: INSTRUCTIONS, criteria: criteria(list) });
  return {
    model: 'jev-latest',
    state: { hint, number, board: words },
    // 選択肢の順番で答えが偏るので、逆順の質問と平均する
    questions: { pick_a: question(words), pick_b: question([...words].reverse()) },
  };
}

export async function askJev({ apiKey, hint, number, words, fetchImpl = fetch, timeoutMs = 8000 }) {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(hint, number, words)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Jev が ${res.status} を返しました`);
  return res.json();
}

// board: 問い合わせた盤面番号の配列。word(i) で単語を引く
export function computeAi(response, { board, wordOf, intended, number, assassins }) {
  const a = response?.answers?.pick_a?.probabilities;
  const b = response?.answers?.pick_b?.probabilities;
  if (!a || !b) throw new Error('Jev の応答に確率がありません');
  const probs = {};
  for (const i of board) {
    const w = wordOf(i);
    probs[i] = ((Number(a[w]) || 0) + (Number(b[w]) || 0)) / 2;
  }
  const ranked = [...board].sort((x, y) => probs[y] - probs[x]);
  const sum = (list) => list.reduce((s, i) => s + (probs[i] ?? 0), 0);
  return {
    probs,
    tsujido: intended.length ? sum(intended) : null,
    topPicks: ranked.slice(0, Math.max(1, number)),
    decoy: ranked.find((i) => !intended.includes(i)) ?? null,
    danger: sum(assassins),
    usage: response.usage ?? null,
  };
}
