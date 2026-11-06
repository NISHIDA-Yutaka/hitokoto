// PostgreSQL の読み書き。接続先は PGHOST / PGDATABASE / PGUSER から取る。
import { createHash, randomBytes, randomInt } from 'node:crypto';
import pg from 'pg';
import { GameError, newGame, normalizeSettings, shuffle } from './game.js';
import { WORD_LISTS } from './wordlists.js';

const pool = new pg.Pool({ max: 5, idleTimeoutMillis: 30000 });
pool.on('error', (e) => console.error('db pool', e.message));

export const close = () => pool.end();
export const ping = () => pool.query('select 1');

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newCode = () => randomBytes(12).toString('base64url');

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function countRooms() {
  const { rows } = await pool.query("select count(*)::int as n from rooms where last_active_at > now() - interval '1 day'");
  return rows[0].n;
}

export async function deleteIdleRooms(days = 30) {
  const { rowCount } = await pool.query("delete from rooms where last_active_at < now() - make_interval(days => $1)", [days]);
  return rowCount;
}

export async function createRoom(name, settings) {
  const code = newCode();
  const token = newToken();
  await tx(async (c) => {
    const { rows } = await c.query('insert into rooms (code, settings) values ($1, $2) returning id', [code, settings]);
    await c.query("insert into players (room_id, seat, name, token_hash) values ($1, 'A', $2, $3)", [rows[0].id, name, hashToken(token)]);
  });
  return { code, token, seat: 'A' };
}

// 標準の単語は wordlists.js から、身内ネタだけ DB から取る
async function pickWords(c, settings) {
  const { rows } = await c.query('select word from words where inside_joke');
  const jokes = shuffle(rows.map((r) => r.word)).slice(0, 2 + randomInt(2));
  const plain = shuffle(WORD_LISTS[normalizeSettings(settings).wordList].filter((w) => !jokes.includes(w)));
  const words = shuffle([...jokes, ...plain.slice(0, 25 - jokes.length)]);
  if (words.length < 25) throw new GameError('単語リストが足りません');
  return words;
}

async function insertGame(c, roomId, settings) {
  const g = newGame(await pickWords(c, settings), settings);
  const { rows } = await c.query(
    'insert into games (room_id, timer_bank, settings) values ($1, $2, $3) returning id',
    [roomId, g.timerBank, settings],
  );
  const gameId = rows[0].id;
  for (const [i, cell] of g.cells.entries()) {
    await c.query('insert into cells (game_id, idx, word, key_a, key_b) values ($1, $2, $3, $4, $5)',
      [gameId, i, cell.word, cell.key.A, cell.key.B]);
  }
}

// 2人目が入った時点でゲームを始める
export async function joinRoom(code, name) {
  return tx(async (c) => {
    const { rows } = await c.query('select id, settings from rooms where code = $1 for update', [code]);
    if (!rows[0]) throw new GameError('部屋が見つかりません');
    const { rows: seats } = await c.query('select seat from players where room_id = $1', [rows[0].id]);
    if (seats.length >= 2) throw new GameError('この部屋はもう2人そろっています');
    const token = newToken();
    await c.query("insert into players (room_id, seat, name, token_hash) values ($1, 'B', $2, $3)", [rows[0].id, name, hashToken(token)]);
    await insertGame(c, rows[0].id, rows[0].settings);
    return { code, token, seat: 'B' };
  });
}

export async function authPlayer(code, token) {
  const { rows } = await pool.query(
    'select p.seat, r.id as room_id from players p join rooms r on r.id = p.room_id where r.code = $1 and p.token_hash = $2',
    [code, hashToken(token)],
  );
  return rows[0] ?? null;
}

async function loadGame(c, row) {
  const { rows: cells } = await c.query('select * from cells where game_id = $1 order by idx', [row.id]);
  const { rows: turns } = await c.query('select * from turns where game_id = $1 order by turn_no', [row.id]);
  const { rows: picks } = await c.query(
    'select p.* from picks p join turns t on t.id = p.turn_id where t.game_id = $1 order by t.turn_no, p.seq', [row.id]);

  const game = {
    id: row.id,
    phase: row.phase,
    timerBank: row.timer_bank,
    outs: row.outs,
    settings: row.settings,
    cells: cells.map((x) => ({
      word: x.word, key: { A: x.key_a, B: x.key_b }, covered: x.covered, contact: false, marks: [],
    })),
    turns: turns.map((t) => ({
      id: t.id, no: t.turn_no, giver: t.giver, hint: t.hint, number: t.number,
      intended: t.intended, picks: [], end: t.end_reason, ai: t.ai,
    })),
  };
  const byId = new Map(game.turns.map((t) => [t.id, t]));
  for (const p of picks) {
    const t = byId.get(p.turn_id);
    t.picks.push({ by: p.picked_by, cell: p.cell_idx, result: p.result, saved: true });
    const cell = game.cells[p.cell_idx];
    if (p.result === 'green') cell.contact = true;
    else cell.marks.push({ pickedBy: p.picked_by, kind: p.result });
  }
  return game;
}

async function saveGame(c, g) {
  await c.query(
    `update games set phase = $2, timer_bank = $3, outs = $4,
       ended_at = case when $2 in ('won','lost') then now() else null end where id = $1`,
    [g.id, g.phase, g.timerBank, g.outs],
  );
  const covered = g.cells.flatMap((x, i) => (x.covered ? [i] : []));
  await c.query('update cells set covered = true where game_id = $1 and idx = any($2::smallint[])', [g.id, covered]);
  for (const t of g.turns) {
    if (t.id) {
      await c.query('update turns set end_reason = $2 where id = $1', [t.id, t.end]);
    } else {
      const { rows } = await c.query(
        `insert into turns (game_id, turn_no, giver, hint, number, intended, end_reason)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [g.id, t.no, t.giver, t.hint, t.number, t.intended, t.end],
      );
      t.id = rows[0].id;
    }
    for (const [seq, p] of t.picks.entries()) {
      if (p.saved) continue;
      await c.query('insert into picks (turn_id, seq, picked_by, cell_idx, result) values ($1, $2, $3, $4, $5)',
        [t.id, seq, p.by, p.cell, p.result]);
      p.saved = true;
    }
  }
}

const latestGameQuery = 'select * from games where room_id = $1 order by started_at desc limit 1';

// ゲーム行をロックして1回の操作を処理する。2人が同時に選んでも順番が崩れない
export async function withGame(roomId, fn) {
  return tx(async (c) => {
    const { rows } = await c.query(`${latestGameQuery} for update`, [roomId]);
    if (!rows[0]) throw new GameError('ゲームが始まっていません');
    const game = await loadGame(c, rows[0]);
    const result = await fn(game);
    await saveGame(c, game);
    await c.query('update rooms set last_active_at = now() where id = $1', [roomId]);
    return result;
  });
}

export async function saveAi(turnId, ai) {
  await pool.query('update turns set ai = $2 where id = $1', [turnId, ai]);
}

export async function rematch(roomId, wordList) {
  return tx(async (c) => {
    const { rows: rooms } = await c.query('select settings from rooms where id = $1 for update', [roomId]);
    const { rows } = await c.query(latestGameQuery, [roomId]);
    if (rows[0] && !['won', 'lost'].includes(rows[0].phase)) throw new GameError('まだゲーム中です');
    const settings = normalizeSettings({ ...rooms[0].settings, wordList: wordList ?? rooms[0].settings.wordList });
    await insertGame(c, roomId, settings);
    await c.query('update rooms set settings = $2, last_active_at = now() where id = $1', [roomId, settings]);
  });
}

async function loadPlayers(c, roomId) {
  const { rows } = await c.query('select seat, name from players where room_id = $1', [roomId]);
  return Object.fromEntries(rows.map((p) => [p.seat, { name: p.name }]));
}

export async function loadRoom(roomId) {
  const client = await pool.connect();
  try {
    const { rows: rooms } = await client.query('select id, code, settings from rooms where id = $1', [roomId]);
    if (!rooms[0]) return null;
    const { rows } = await client.query(latestGameQuery, [roomId]);
    return {
      room: rooms[0],
      players: await loadPlayers(client, roomId),
      game: rows[0] ? await loadGame(client, rows[0]) : null,
    };
  } finally {
    client.release();
  }
}

// 終わった対局を読み返す。no は古い方から数えた番号で、省くと最新。
// 進行中の対局は両方の面が見えてしまうので、ここからは決して返さない
export async function loadFinished(code, no) {
  const client = await pool.connect();
  try {
    const { rows: rooms } = await client.query('select id, code, settings from rooms where code = $1', [code]);
    if (!rooms[0]) return null;
    const { rows } = await client.query(
      "select * from games where room_id = $1 and phase in ('won', 'lost') order by started_at", [rooms[0].id]);
    const index = (no ?? rows.length) - 1;
    if (!rows[index]) return null;
    return {
      room: rooms[0],
      players: await loadPlayers(client, rooms[0].id),
      game: await loadGame(client, rows[index]),
      no: index + 1,
      total: rows.length,
    };
  } finally {
    client.release();
  }
}
