import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClientMessage, CLOSE, parseCreateRoom } from '../src/protocol.js';
import { TokenBucket } from '../src/rate-limit.js';
import { Room, RoomManager } from '../src/rooms.js';
import { startMatchLog } from '../src/log/matchlog.js';
import { readReplay, replayPath } from '../src/log/replay.js';

const raw = (obj) => Buffer.from(JSON.stringify(obj));

test('protocol: valid join and chat are accepted and cleaned', () => {
  const join = parseClientMessage(
    raw({ v: 1, type: 'join', room: 'eu-1', name: '  Ace  ', extra: 1 }),
  );
  assert.deepEqual(join, {
    ok: true,
    msg: { type: 'join', room: 'eu-1', name: 'Ace', codec: 'json' },
  });
  const chat = parseClientMessage(raw({ v: 1, type: 'chat', text: 'привіт' }));
  assert.deepEqual(chat, { ok: true, msg: { type: 'chat', text: 'привіт' } });
});

test('protocol: bad input is rejected with the right close code', () => {
  assert.equal(parseClientMessage(Buffer.from('{oops')).code, CLOSE.BAD_MESSAGE);
  assert.equal(parseClientMessage(raw([1, 2])).code, CLOSE.BAD_MESSAGE);
  assert.equal(parseClientMessage(raw({ v: 2, type: 'chat', text: 'x' })).code, CLOSE.BAD_VERSION);
  assert.equal(parseClientMessage(raw({ v: 1, type: 'hack' })).code, CLOSE.UNKNOWN_TYPE);
  assert.equal(parseClientMessage(raw({ v: 1, type: '__proto__' })).code, CLOSE.UNKNOWN_TYPE);
  assert.equal(
    parseClientMessage(raw({ v: 1, type: 'chat', text: 'x'.repeat(201) })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parseClientMessage(raw({ v: 1, type: 'chat', text: 'a\nb' })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parseClientMessage(raw({ v: 1, type: 'join', room: '../etc', name: 'x' })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(parseClientMessage(Buffer.from([1, 2, 3]), true).code, CLOSE.BAD_MESSAGE);
});

test('protocol: POST /api/rooms body validation', () => {
  assert.deepEqual(parseCreateRoom({ name: ' Mine ', arena: 'rocks' }, ['classic', 'rocks']), {
    name: 'Mine',
    arena: 'rocks',
  });
  assert.equal(typeof parseCreateRoom({ name: '' }, ['classic']), 'string');
  assert.equal(typeof parseCreateRoom({ name: 'x', arena: 'moon' }, ['classic']), 'string');
});

test('token bucket: allows a burst, then refills at the rate', () => {
  const b = new TokenBucket({ ratePerSec: 10, burst: 3, now: 0 });
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), false); // burst used up
  assert.equal(b.take(100), true); // 100 ms at 10/s = 1 token
  assert.equal(b.take(100), false);
});

test('room: events, match start/end, empty', () => {
  const room = new Room({ id: 'r', name: 'R', arena: 'classic', maxPlayers: 2 });
  const seen = [];
  room.on('event', (e) => seen.push(e.type));
  room.on('matchStart', () => seen.push('<matchStart>'));
  room.on('empty', () => seen.push('<empty>'));
  room.on('join', () => {
    if (room.size === 1) room.startMatch();
  });
  room.join({ id: 'a', name: 'A' });
  room.join({ id: 'b', name: 'B' });
  assert.throws(() => room.join({ id: 'c', name: 'C' }), /full/);
  room.chat('a', 'hi');
  room.leave('a');
  room.leave('b');
  assert.deepEqual(seen, [
    '<matchStart>',
    'match_start',
    'join',
    'join',
    'chat',
    'leave',
    'leave',
    'match_end',
    '<empty>',
  ]);
});

test('room manager: non-persistent rooms are deleted when empty; room cap', () => {
  const m = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 4 });
  const keep = m.create({ name: 'keep', arena: 'classic', persistent: true });
  const temp = m.create({ name: 'temp', arena: 'classic' });
  assert.throws(() => m.create({ name: 'third', arena: 'classic' }), /room limit/);
  temp.join({ id: 'p', name: 'P' });
  temp.leave('p');
  assert.equal(m.get(temp.id), undefined);
  keep.join({ id: 'p', name: 'P' });
  keep.leave('p');
  assert.equal(m.get(keep.id), keep);
});

test('match log: object-mode Transform → NDJSON file → replay generator round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flyordie-'));
  const room = new Room({ id: 'eu-1', name: 'R', arena: 'classic', maxPlayers: 8 });
  let matchLog;
  room.on('matchStart', () => (matchLog = startMatchLog(room, dir)));
  room.on('join', () => {
    if (room.size === 1) room.startMatch();
  });

  room.join({ id: 'a', name: 'Ace' });
  room.chat('a', 'привіт 👋');
  room.leave('a'); // → match_end → 'matchEnd' closes the iterator → pipeline ends
  await matchLog.done;

  const text = await readFile(matchLog.file, 'utf8');
  assert.equal(text.trim().split('\n').length, 5);

  const events = [];
  for await (const e of readReplay(matchLog.file)) events.push(e);
  assert.deepEqual(
    events.map((e) => e.type),
    ['match_start', 'join', 'chat', 'leave', 'match_end'],
  );
  assert.equal(events[2].text, 'привіт 👋');
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

test('replay ids cannot escape the log directory', () => {
  assert.equal(replayPath('/logs', '../../etc/passwd'), null);
  assert.equal(replayPath('/logs', 'a/b'), null);
  assert.ok(replayPath('/logs', 'eu-1-2026-11-26_10-00-00-abcd1234').endsWith('.ndjson'));
});
