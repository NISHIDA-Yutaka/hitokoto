// HTTP と WebSocket を1プロセスで持つ。判定と秘密情報の出し分けは全部ここで行う。
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as db from './db.js';
import { GameError, candidateCells, giveHint, normalizeSettings, pick, stopTurn, turnKey } from './game.js';
import { askJev, computeAi } from './jev.js';
import { viewFor } from './view.js';

const PORT = Number(process.env.PORT ?? 3071);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.TYPESAFE_API_KEY ?? '';
const LIMITS = {
  roomsPerDay: Number(process.env.MAX_ROOMS ?? 300),
  roomsPerIpHour: Number(process.env.MAX_ROOMS_PER_IP ?? 10),
  sockets: 200,
  socketsPerIp: 20,
  msgPerSecond: Number(process.env.MSG_RATE ?? 10),
  jevPerDay: Number(process.env.MAX_JEV ?? 3000),
};

const TYPES = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map(readdirSync(PUBLIC_DIR).map((f) => [`/${f}`, { body: readFileSync(join(PUBLIC_DIR, f)), type: TYPES[extname(f)] ?? 'application/octet-stream' }]));
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

// Caddy が付ける X-Forwarded-For の末尾が実際の接続元
const clientIp = (req) => (req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').at(-1).trim();

const roomHits = new Map();
function allowRoomCreate(ip) {
  const now = Date.now();
  const hits = (roomHits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (hits.length >= LIMITS.roomsPerIpHour) return false;
  hits.push(now);
  roomHits.set(ip, hits);
  return true;
}

let jevDay = '';
let jevCount = 0;
function allowJev() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== jevDay) { jevDay = today; jevCount = 0; }
  if (jevCount >= LIMITS.jevPerDay) return false;
  jevCount += 1;
  return true;
}

const cleanName = (value) => {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name || [...name].length > 12) throw new GameError('名前は1〜12文字にしてください');
  return name;
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) { reject(new GameError('送信内容が大きすぎます')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new GameError('送信内容を読めません')); }
    });
    req.on('error', reject);
  });
}

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function handleApi(req, res, url) {
  if (url.pathname === '/api/rooms') {
    const body = await readJson(req);
    const name = cleanName(body.name);
    if (!allowRoomCreate(clientIp(req)) || (await db.countRooms()) >= LIMITS.roomsPerDay) {
      return sendJson(res, 429, { error: '部屋を作りすぎています。時間をおいてください' });
    }
    return sendJson(res, 200, await db.createRoom(name, normalizeSettings(body.settings)));
  }
  const m = url.pathname.match(/^\/api\/rooms\/([\w-]{8,32})\/join$/);
  if (m) {
    const body = await readJson(req);
    const joined = await db.joinRoom(m[1], cleanName(body.name));
    sendJson(res, 200, joined);
    const auth = await db.authPlayer(joined.code, joined.token);
    if (auth) await broadcast(auth.room_id);
    return undefined;
  }
  return sendJson(res, 404, { error: 'not found' });
}

// 終わった対局を、遊ばずに読み返すための読み取り専用の入口。部屋の URL を知っている人だけが開ける
async function sendRecord(res, code, query) {
  const found = await db.loadFinished(code, query.has('game') ? Number(query.get('game')) : undefined);
  if (!found) return sendJson(res, 404, { error: '記録が見つかりません' });
  const seat = query.get('seat') === 'B' ? 'B' : 'A';
  return sendJson(res, 200, { ...viewFor(found, seat, { A: true, B: true }), record: { no: found.no, total: found.total } });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') {
      await db.ping();
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const record = url.pathname.match(/^\/api\/rooms\/([\w-]{8,32})\/review$/);
    if (record) {
      await sendRecord(res, record[1], url.searchParams);
      return;
    }
    const path = url.pathname === '/' || url.pathname.startsWith('/r/') ? '/index.html' : url.pathname;
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': asset.type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  } catch (e) {
    if (e instanceof GameError) { sendJson(res, 400, { error: e.message }); return; }
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'サーバーで問題が起きました' });
  }
});

// 部屋ごとの接続。1プロセスなのでメモリ上で配信する
const sockets = new Map(); // roomId → Set<ws>
const ipCounts = new Map();

// 候補の印。手番中だけの目印なので DB には入れない
const candidates = new Map(); // roomId → { A: { turn, cells }, B: … }

const onlineSeats = (roomId) => Object.fromEntries([...(sockets.get(roomId) ?? [])].map((ws) => [ws.seat, true]));

async function broadcast(roomId) {
  const conns = sockets.get(roomId);
  if (!conns?.size) return;
  const state = await db.loadRoom(roomId);
  if (!state) return;
  const online = onlineSeats(roomId);
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'state', state: viewFor(state, ws.seat, online, candidates.get(roomId)) }));
  }
}

async function queryJev(roomId, game, turn) {
  if (!API_KEY || !allowJev()) return;
  try {
    const board = game.cells.flatMap((c, i) => (c.covered ? [] : [i]));
    const response = await askJev({ apiKey: API_KEY, hint: turn.hint, number: turn.number, words: board.map((i) => game.cells[i].word) });
    const ai = computeAi(response, {
      board,
      wordOf: (i) => game.cells[i].word,
      intended: turn.intended,
      number: turn.number,
      assassins: board.filter((i) => game.cells[i].key[turn.giver] === 'assassin'),
    });
    await db.saveAi(turn.id, ai);
    await broadcast(roomId);
  } catch (e) {
    // 失敗してもゲームは止めず、その手番はツッコミなしで進める
    console.error('jev', e.message);
  }
}

async function handleMessage(ws, msg) {
  const { roomId, seat } = ws;
  switch (msg.t) {
    case 'hint': {
      const { game, turn } = await db.withGame(roomId, (g) => ({ game: g, turn: giveHint(g, seat, msg) }));
      await broadcast(roomId);
      queryJev(roomId, game, turn);
      return;
    }
    case 'pick':
      await db.withGame(roomId, (g) => pick(g, seat, msg.cell));
      break;
    case 'candidates': {
      const state = await db.loadRoom(roomId);
      if (!state?.game) throw new GameError('ゲームが始まっていません');
      const cells = candidateCells(state.game, seat, msg.cells);
      candidates.set(roomId, { ...candidates.get(roomId), [seat]: { turn: turnKey(state.game), cells } });
      break;
    }
    case 'stop':
      await db.withGame(roomId, (g) => stopTurn(g, seat));
      break;
    case 'rematch':
      await db.rematch(roomId, msg.wordList);
      break;
    default:
      throw new GameError('不明な操作です');
  }
  await broadcast(roomId);
}

function allowMessage(ws) {
  const now = Date.now();
  ws.tokens = Math.min(LIMITS.msgPerSecond, ws.tokens + ((now - ws.lastTick) / 1000) * LIMITS.msgPerSecond);
  ws.lastTick = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req);
  let originOk = false;
  try { originOk = new URL(req.headers.origin).host === req.headers.host; } catch { /* Origin なし */ }
  const total = [...ipCounts.values()].reduce((a, b) => a + b, 0);
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !originOk || total >= LIMITS.sockets || (ipCounts.get(ip) ?? 0) >= LIMITS.socketsPerIp) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
    ws.ip = ip;
    ws.tokens = LIMITS.msgPerSecond;
    ws.lastTick = Date.now();
    ws.alive = true;
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async (data) => {
    if (!allowMessage(ws)) return;
    try {
      const msg = JSON.parse(data.toString());
      if (!ws.roomId) {
        const auth = msg.t === 'auth' && typeof msg.code === 'string' && typeof msg.token === 'string'
          ? await db.authPlayer(msg.code, msg.token) : null;
        if (!auth) { ws.send(JSON.stringify({ t: 'authFailed' })); ws.close(); return; }
        ws.roomId = auth.room_id;
        ws.seat = auth.seat;
        if (!sockets.has(ws.roomId)) sockets.set(ws.roomId, new Set());
        sockets.get(ws.roomId).add(ws);
        await broadcast(ws.roomId);
        return;
      }
      await handleMessage(ws, msg);
    } catch (e) {
      if (e instanceof GameError) ws.send(JSON.stringify({ t: 'error', message: e.message }));
      else if (e instanceof SyntaxError) ws.close();
      else { console.error(e); ws.send(JSON.stringify({ t: 'error', message: 'サーバーで問題が起きました' })); }
    }
  });
  ws.on('close', () => {
    const left = (ipCounts.get(ws.ip) ?? 1) - 1;
    if (left > 0) ipCounts.set(ws.ip, left); else ipCounts.delete(ws.ip);
    const conns = sockets.get(ws.roomId);
    if (!conns) return;
    conns.delete(ws);
    if (conns.size) broadcast(ws.roomId).catch((e) => console.error(e));
    else {
      sockets.delete(ws.roomId);
      candidates.delete(ws.roomId);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

const sweep = () => {
  const now = Date.now();
  for (const [ip, hits] of roomHits) if (hits.every((t) => now - t >= 3600_000)) roomHits.delete(ip);
  return db.deleteIdleRooms().catch((e) => console.error('sweep', e.message));
};
setInterval(sweep, 3600_000).unref();
sweep();

server.listen(PORT, HOST, () => console.log(`hitokoto: http://${HOST}:${PORT} (AI ${API_KEY ? 'on' : 'off'})`));
