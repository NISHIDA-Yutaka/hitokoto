// 本物のサーバーと開発 DB（hitokoto_dev）で、2人の接続を通して確かめる
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import pg from 'pg';
import WebSocket from 'ws';
import { WORD_LISTS } from '../src/wordlists.js';

const PORT = 3171;
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT, PGHOST: process.env.PGHOST ?? '/var/run/postgresql', PGDATABASE: process.env.PGDATABASE ?? 'hitokoto_dev', TYPESAFE_API_KEY: '', MSG_RATE: '1000', MAX_ROOMS_PER_IP: '1000' };
const dbConfig = { host: env.PGHOST, database: env.PGDATABASE };
const prefix = 'テスト語';
let child;
let client;

before(async () => {
  client = new pg.Client(dbConfig);
  await client.connect();
  for (let i = 0; i < 30; i++) await client.query('insert into words (word) values ($1) on conflict do nothing', [`${prefix}${i}`]);
  child = spawn('node', ['src/server.js'], { env, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('サーバーが起動しません');
});

after(async () => {
  child?.kill();
  await client.query("delete from rooms where settings->>'test' is null and id in (select room_id from players where name like 'テスト%')");
  await client.query('delete from words where word like $1', [`${prefix}%`]);
  await client.end();
});

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};

function open({ origin = BASE } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin });
  ws.log = [];
  ws.waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    ws.log.push(data.toString());
    ws.last = msg.t === 'state' ? msg.state : ws.last;
    ws.waiters = ws.waiters.filter((w) => !w(msg));
  });
  return ws;
}

const until = (ws, pred, label = '') => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`待ちきれません ${label}`)), 3000);
  const check = (msg) => {
    if (!pred(msg)) return false;
    clearTimeout(timer);
    resolve(msg);
    return true;
  };
  ws.waiters.push(check);
});

async function login(room, code) {
  const ws = open();
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const got = until(ws, (m) => m.t === 'state' || m.t === 'authFailed', 'login');
  ws.send(JSON.stringify({ t: 'auth', code, token: room.token }));
  await got;
  return ws;
}

async function startRoom(settings = {}) {
  const a = (await post('/api/rooms', { name: 'テストA', settings })).data;
  const b = (await post(`/api/rooms/${a.code}/join`, { name: 'テストB' })).data;
  const wa = await login(a, a.code);
  const wb = await login(b, a.code);
  return { a, b, wa, wb, code: a.code };
}

const act = async (ws, msg, pred) => {
  const got = until(ws, (m) => (m.t === 'state' && pred(m.state)) || m.t === 'error', JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
  return got;
};

const indexOf = (state, color) => state.game.cells.findIndex((c) => c.mine === color && !c.covered);

test('2人そろうと始まり、片方の面しか届かない', async () => {
  const { a, b, wa, wb, code } = await startRoom();
  assert.equal(a.seat, 'A');
  assert.equal(b.seat, 'B');
  assert.equal(wa.last.game.cells.length, 25);
  assert.ok(wa.last.game.cells.some((c, i) => c.mine !== wb.last.game.cells[i].mine));
  assert.ok(!wb.log.join('').includes('key_a') && !wb.log.join('').includes('intended'));

  const third = await post(`/api/rooms/${code}/join`, { name: 'テストC' });
  assert.equal(third.status, 400);
  wa.close();
  wb.close();
});

test('合言葉が違う接続と、ほかのサイトからの接続は入れない', async () => {
  const { a, wa, wb, code } = await startRoom();
  const bad = open();
  await new Promise((r) => bad.once('open', r));
  const denied = until(bad, (m) => m.t === 'authFailed');
  bad.send(JSON.stringify({ t: 'auth', code, token: 'wrong' }));
  await denied;

  const evil = open({ origin: 'https://example.com' });
  await new Promise((r) => { evil.once('error', r); evil.once('close', r); });
  assert.notEqual(evil.readyState, WebSocket.OPEN);
  assert.ok(a.token);
  wa.close();
  wb.close();
});

test('ヒント、当てる、止める、再接続、2アウトの敗北、感想戦、もう一局', async () => {
  const { b, wa, wb, code } = await startRoom();
  const target = indexOf(wa.last, 'green');

  await act(wa, { t: 'hint', word: 'ヒント', number: 1, intended: [target] }, (s) => s.game.current);
  await until(wb, (m) => m.t === 'state' && m.state.game.current?.hint === 'ヒント').catch(() => {});
  assert.equal(wb.last.game.current.number, 1);
  assert.ok(!wb.log.join('').includes('intended'));

  const denied = await act(wa, { t: 'pick', cell: target }, () => false);
  assert.equal(denied.t, 'error');

  await act(wb, { t: 'pick', cell: target }, (s) => s.game.found === 1);
  await act(wb, { t: 'stop' }, (s) => !s.game.current);
  assert.equal(wb.last.game.timerBank, 8);

  wb.close();
  const again = await login(b, code);
  assert.equal(again.last.game.found, 1);
  assert.equal(again.last.game.timerBank, 8);

  // A は B の面の黒を知らないので、B がヒントを出して A に踏ませる形で2回アウトにする
  const blacks = again.last.game.cells.flatMap((c, i) => (c.mine === 'assassin' && !c.covered ? [i] : []));
  await until(wa, (m) => m.t === 'state' && !m.state.game.current).catch(() => {});
  await act(again, { t: 'hint', word: 'ひとつ', number: 1, intended: [indexOf(again.last, 'green')] }, (s) => s.game.current);
  await act(wa, { t: 'pick', cell: blacks[0] }, (s) => s.game.outs === 1);
  assert.equal(wa.last.game.timerBank, 6);

  const pass = indexOf(wa.last, 'bystander');
  await act(wa, { t: 'hint', word: 'ふたつ', number: 1, intended: [indexOf(wa.last, 'green')] }, (s) => s.game.current);
  const byPick = wa.last.game.cells.findIndex((c, i) => c.mine === 'bystander' && !c.covered && again.last.game.cells[i].selectable);
  await act(again, { t: 'pick', cell: byPick >= 0 ? byPick : pass }, (s) => !s.game.current);

  await act(again, { t: 'hint', word: 'みっつ', number: 1, intended: [indexOf(again.last, 'green')] }, (s) => s.game.current);
  await act(wa, { t: 'pick', cell: blacks[1] }, (s) => s.game.phase === 'lost');
  assert.equal(wa.last.game.phase, 'lost');
  assert.ok(wa.last.game.cells.every((c) => c.theirs));
  assert.equal(wa.last.game.review.turns.length, 4);
  assert.equal(wa.last.game.review.turns[0].intended.length, 1);

  await act(wa, { t: 'rematch', wordList: 'kana' }, (s) => s.game.phase === 'playing');
  assert.equal(wa.last.game.timerBank, 9);
  assert.equal(wa.last.game.wordList, 'kana');
  assert.equal(wa.last.settings.wordList, 'kana');
  assert.ok(wa.last.game.cells.every((c) => WORD_LISTS.kana.includes(c.word)));

  // 読み返せるのは終わった対局だけ。次の対局が進行中でも、そちらは出さない
  const record = await (await fetch(`${BASE}/api/rooms/${wa.last.code}/review?seat=B`)).json();
  assert.equal(record.game.phase, 'lost');
  assert.equal(record.you.seat, 'B');
  assert.deepEqual(record.record, { no: 1, total: 1 });
  assert.equal(record.game.review.turns.length, 4);
  assert.equal((await fetch(`${BASE}/api/rooms/${wa.last.code}/review?game=2`)).status, 404);
  wa.close();
  again.close();
});

test('進行中の対局は読み返せない', async () => {
  const { wa, wb } = await startRoom();
  assert.equal((await fetch(`${BASE}/api/rooms/${wa.last.code}/review`)).status, 404);
  wa.close();
  wb.close();
});

test('同時に選んでも記録は崩れない', async () => {
  const { wa, wb } = await startRoom();
  const target = indexOf(wa.last, 'green');
  await act(wa, { t: 'hint', word: 'ヒント', number: 2, intended: [target] }, (s) => s.game.current);
  await until(wb, (m) => m.t === 'state' && m.state.game.current).catch(() => {});
  const cells = wa.last.game.cells.flatMap((c, i) => (c.mine === 'green' ? [i] : [])).slice(0, 4);
  await Promise.all(cells.map((cell) => wb.send(JSON.stringify({ t: 'pick', cell }))));
  await until(wb, (m) => m.t === 'state' && m.state.game.found === 4);
  assert.equal(wb.last.game.found, 4);
  wa.close();
  wb.close();
});
