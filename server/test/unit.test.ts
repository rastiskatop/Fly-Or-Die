import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrame, CLOSE, parseCreateRoom } from '../src/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { binaryCodec } from '@flyordie/shared/net/codec.ts';
import { asSeq } from '@flyordie/shared/ids.ts';
import type { MatchLog } from '../src/log/matchlog.ts';

const player = (id: string, name: string) => ({ id, name, joinedAt: 0 });
import { TokenBucket } from '../src/rate-limit.ts';
import { Room, RoomManager } from '../src/rooms.ts';
import { startMatchLog } from '../src/log/matchlog.ts';
import { readReplay, replayPath } from '../src/log/replay.ts';
import { z } from 'zod';

const json = (obj: unknown) => Buffer.from(JSON.stringify(obj));

// (The message-level validation tests live in shared/test — the schemas are shared now.)
test('parseFrame: JSON control messages, binary inputs, and garbage', () => {
  const join = parseFrame(
    json({ v: 1, type: 'join', room: 'eu-1', name: '  Ace  ', extra: 1 }),
    false,
  );
  assert.deepEqual(join, {
    ok: true,
    value: { v: 1, type: 'join', room: 'eu-1', name: 'Ace', codec: 'json' },
  });
  const inputs = parseFrame(
    Buffer.from(binaryCodec.encodeInputs([{ seq: asSeq(7), buttons: 12 }])),
    true,
  );
  assert.deepEqual(inputs, {
    ok: true,
    value: { type: 'inputs', inputs: [{ seq: 7, buttons: 12 }] },
  });
  const jsonInputs = parseFrame(json({ v: 1, type: 'inputs', inputs: [[8, 4]] }), false);
  assert.deepEqual(jsonInputs, {
    ok: true,
    value: { type: 'inputs', inputs: [{ seq: 8, buttons: 4 }] },
  });
  const bad = parseFrame(Buffer.from([1, 2, 3]), true);
  assert.ok(!bad.ok && bad.error.code === CLOSE.BAD_MESSAGE);
});

test('POST /api/rooms body validation', () => {
  assert.deepEqual(parseCreateRoom({ name: ' Mine ', arena: 'rocks' }), {
    ok: true,
    value: { name: 'Mine', arena: 'rocks' },
  });
  assert.equal(parseCreateRoom({ name: '' }).ok, false);
  assert.equal(parseCreateRoom({ name: 'x', arena: 'moon' }).ok, false);
  assert.equal(parseCreateRoom('nope').ok, false);
});

test('config: env strings are parsed, validated and defaulted', () => {
  const c = loadConfig({
    PORT: '9000',
    MAX_ROOMS: '5',
    DEBUG_ROUTES: 'false',
    NODE_ENV: 'production',
  });
  assert.equal(c.port, 9000);
  assert.equal(c.maxRooms, 5);
  assert.equal(c.debugRoutes, false);
  assert.equal(c.heartbeatMs, 15000);
  assert.throws(() => loadConfig({ PORT: 'eighty' }), /PORT/);
  assert.throws(() => loadConfig({ MAX_ROOMS: '0' }), /MAX_ROOMS/);
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
  const seen: string[] = [];
  room.on('event', (e) => seen.push(e.type));
  room.on('matchStart', () => seen.push('<matchStart>'));
  room.on('empty', () => seen.push('<empty>'));
  room.on('join', () => {
    if (room.size === 1) room.startMatch();
  });
  room.join(player('a', 'A'));
  room.join(player('b', 'B'));
  assert.throws(() => room.join(player('c', 'C')), /full/);
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
  temp.join(player('p', 'P'));
  temp.leave('p');
  assert.equal(m.get(temp.id), undefined);
  keep.join(player('p', 'P'));
  keep.leave('p');
  assert.equal(m.get(keep.id), keep);
});

test('match log: object-mode Transform → NDJSON file → replay generator round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flyordie-'));
  const room = new Room({ id: 'eu-1', name: 'R', arena: 'classic', maxPlayers: 8 });
  let matchLog: MatchLog | undefined;
  room.on('matchStart', () => (matchLog = startMatchLog(room, dir)));
  room.on('join', () => {
    if (room.size === 1) room.startMatch();
  });

  room.join(player('a', 'Ace'));
  room.chat('a', 'привіт 👋');
  room.leave('a'); // → match_end → 'matchEnd' closes the iterator → pipeline ends
  assert.ok(matchLog, 'the match log started');
  await matchLog.done;

  const text = await readFile(matchLog.file, 'utf8');
  assert.equal(text.trim().split('\n').length, 5);

  // Replay lines are `unknown` (a file is untrusted input) — validate them like any other boundary.
  const LogLine = z.object({ type: z.string(), seq: z.number(), text: z.string().optional() });
  const events: z.infer<typeof LogLine>[] = [];
  for await (const e of readReplay(matchLog.file)) events.push(LogLine.parse(e));
  assert.deepEqual(
    events.map((e) => e.type),
    ['match_start', 'join', 'chat', 'leave', 'match_end'],
  );
  assert.equal(events[2]?.text, 'привіт 👋');
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

test('replay ids cannot escape the log directory', () => {
  assert.equal(replayPath('/logs', '../../etc/passwd'), null);
  assert.equal(replayPath('/logs', 'a/b'), null);
  assert.ok(replayPath('/logs', 'eu-1-2026-11-26_10-00-00-abcd1234')?.endsWith('.ndjson'));
});
