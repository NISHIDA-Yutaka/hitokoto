// 手番後のツッコミと、ゲーム後の感想戦の組み立て。
const LINES = {
  high: { hit: 'AIも納得の名ヒント', miss: 'AIには伝わってたっぽい。もう一回考えてみて', stop: 'AIならもう一枚いってたかも' },
  mid: { hit: 'いい読み', miss: 'AIも半信半疑だった', stop: '堅実な引き際' },
  low: { hit: '人間の勝利。AIには読めなかった', miss: 'AIも首をかしげてた', stop: 'AIも手が止まってた' },
};

const correctCount = (t) => t.picks.filter((p) => p.result === 'green').length;

// 2人に見えている結果（枚数と終わり方）だけで決める。狙いと一致したかは使わない
export function turnOutcome(t) {
  const correct = correctCount(t);
  if (correct >= t.number && t.number > 0) return 'hit';
  if (t.end === 'stop') return 'stop';
  return t.end === 'gameover' && t.picks.at(-1)?.result === 'green' ? 'hit' : 'miss';
}

export function tsukkomi(t) {
  if (!t.ai || t.ai.tsujido === null) return null;
  const level = t.ai.tsujido >= 0.6 ? 'high' : t.ai.tsujido >= 0.3 ? 'mid' : 'low';
  return { tsujido: Math.round(t.ai.tsujido * 10) * 10, line: LINES[level][turnOutcome(t)] };
}

// 狙いのうち AI の確率が盤面の下位半分だった単語を、相方がその手番に当てた回数
function beatAi(t) {
  if (!t.ai) return [];
  const ranked = Object.keys(t.ai.probs).map(Number).sort((x, y) => t.ai.probs[y] - t.ai.probs[x]);
  const half = ranked.length / 2;
  const hits = new Set(t.picks.filter((p) => p.result === 'green').map((p) => p.cell));
  return t.intended.filter((i) => hits.has(i) && ranked.indexOf(i) >= half);
}

export function buildReview(g) {
  const word = (i) => g.cells[i].word;
  const turns = g.turns.filter((t) => t.hint !== '').map((t) => {
    const ai = t.ai && {
      tsujido: t.ai.tsujido === null ? null : Math.round(t.ai.tsujido * 100),
      topPicks: t.ai.topPicks.map(word),
      decoy: t.ai.decoy === null ? null : word(t.ai.decoy),
      danger: Math.round(t.ai.danger * 100),
    };
    return {
      no: t.no,
      giver: t.giver,
      hint: t.hint,
      number: t.number,
      intended: t.intended.map(word),
      picks: t.picks.map((p) => ({ word: word(p.cell), result: p.result })),
      ai,
      beat: beatAi(t).map(word),
    };
  });

  const scored = g.turns.filter((t) => t.ai && t.ai.tsujido !== null);
  const landed = scored.filter((t) => t.picks.some((p) => p.result === 'green' && t.intended.includes(p.cell)));
  const lowest = landed.sort((x, y) => x.ai.tsujido - y.ai.tsujido)[0];

  // 狙いより AI が強く推した単語のうち、差が一番大きいもの
  let gap = null;
  for (const t of scored) {
    if (t.ai.decoy === null || !t.intended.length) continue;
    const best = Math.max(...t.intended.map((i) => t.ai.probs[i] ?? 0));
    const diff = t.ai.probs[t.ai.decoy] - best;
    if (diff > 0 && (!gap || diff > gap.diff)) gap = { diff, hint: t.hint, word: word(t.ai.decoy) };
  }

  return {
    turns,
    beatCount: turns.reduce((n, t) => n + t.beat.length, 0),
    lowestHit: lowest ? { hint: lowest.hint, tsujido: Math.round(lowest.ai.tsujido * 100) } : null,
    biggestGap: gap && { hint: gap.hint, word: gap.word },
  };
}
