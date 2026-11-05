// 受け取る人ごとに送る内容を作る。相方の面と狙いは、ゲームが終わるまで入れない。
import { canPick, currentTurn, isGuesser, nextGivers, other, remaining, score, turnKey } from './game.js';
import { buildReview, tsukkomi } from './review.js';

export function viewFor({ room, players, game }, seat, online = {}, candidates = {}) {
  const you = { seat, name: players[seat]?.name ?? '' };
  const partner = { name: players[other(seat)]?.name ?? null, online: Boolean(online[other(seat)]) };
  const base = { code: room.code, you, partner, settings: room.settings };
  if (!game) return { ...base, game: null };

  const over = game.phase === 'won' || game.phase === 'lost';
  const turn = currentTurn(game);
  const revealAi = game.settings.aiReveal === 'afterTurn';
  // 選んだ語と結果は盤面に出ている内容なので、ゲーム中も2人に見せてよい
  const pickList = (t) => t.picks.map((p) => ({ word: game.cells[p.cell].word, result: p.result }));
  const pickable = isGuesser(game, seat);
  // 候補は推理する側の印で、秘密ではない。今の手番のものだけ、2人に同じものを見せる
  const marked = (s) => {
    const m = candidates[s];
    return !over && m?.turn === turnKey(game) && isGuesser(game, s) ? m.cells.filter((i) => canPick(game, s, i)) : [];
  };

  return {
    ...base,
    game: {
      phase: game.phase,
      timerBank: game.timerBank,
      timers: game.settings.timers,
      outs: game.outs,
      maxOuts: game.settings.maxOuts,
      penalty: game.settings.assassinPenalty,
      found: game.cells.filter((c) => c.contact).length,
      cells: game.cells.map((c, i) => ({
        word: c.word,
        mine: c.key[seat],
        covered: c.covered,
        contact: c.contact,
        marks: c.marks.map((m) => ({ mine: m.pickedBy === seat, kind: m.kind })),
        selectable: pickable && canPick(game, seat, i),
        ...(over ? { theirs: c.key[other(seat)] } : {}),
      })),
      turns: game.turns.filter((t) => t.hint !== '').map((t) => ({
        no: t.no,
        mine: t.giver === seat,
        hint: t.hint,
        number: t.number,
        correct: t.picks.filter((p) => p.result === 'green').length,
        picks: pickList(t),
        end: t.end,
        ...(revealAi && t.end ? { ai: tsukkomi(t) } : {}),
      })),
      suddenPicks: game.turns.filter((t) => t.hint === '').flatMap(pickList),
      current: turn && turn.hint !== '' ? { mine: turn.giver === seat, hint: turn.hint, number: turn.number } : null,
      candidates: { mine: marked(seat), partner: marked(other(seat)) },
      canGive: nextGivers(game).includes(seat),
      canPick: pickable,
      canStop: game.phase === 'playing' && pickable && turn.picks.some((p) => p.result === 'green'),
      myGreensDone: remaining(game, seat) === 0,
      partnerGreensDone: remaining(game, other(seat)) === 0,
      ...(over ? { score: score(game), review: buildReview(game) } : {}),
    },
  };
}
