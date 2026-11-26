import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * A room. Emits:
 *   'join'  (player)            'leave' (player, reason)      'chat' (player, text)
 *   'event' ({ t, type, ... })  — every fact worth logging; the match log consumes this
 *   'matchStart' ()            — first player joined; emitted BEFORE the first 'event' so a log can subscribe
 *   'matchEnd' ()               — last player left (or shutdown): ends the current match log
 *   'empty' ()                  — no players left
 * Listeners run synchronously, in registration order, inside emit().
 */
export class Room extends EventEmitter {
  #seq = 0;

  constructor({ id, name, arena, maxPlayers, region = 'eu', persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.region = region;
    this.persistent = persistent; // default rooms survive being empty
    this.players = new Map(); // playerId -> { id, name, joinedAt }
    this.createdAt = Date.now();
    this.matchId = null;
  }

  get size() {
    return this.players.size;
  }

  get full() {
    return this.players.size >= this.maxPlayers;
  }

  /** Records a log event. `t` = ms since the match started, `seq` = order within the match. */
  record(type, fields = {}) {
    const t = this.matchStartedAt ? Date.now() - this.matchStartedAt : 0;
    this.emit('event', { seq: this.#seq++, t, type, room: this.id, ...fields });
  }

  startMatch() {
    this.matchId = randomUUID().slice(0, 8);
    this.matchStartedAt = Date.now();
    this.#seq = 0;
    this.emit('matchStart'); // subscribers (the match log) attach here, synchronously
    this.record('match_start', {
      match: this.matchId,
      arena: this.arena,
      at: new Date().toISOString(),
    });
  }

  endMatch(reason) {
    if (!this.matchId) return;
    this.record('match_end', { match: this.matchId, reason, players: this.size });
    this.matchId = null;
    this.emit('matchEnd');
  }

  join(player) {
    if (this.full) throw new Error(`room ${this.id} is full`);
    this.players.set(player.id, player);
    this.emit('join', player); // the manager may start a match log here (first player)
    this.record('join', { player: player.id, name: player.name });
  }

  leave(playerId, reason = 'left') {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit('leave', player, reason);
    this.record('leave', { player: player.id, name: player.name, reason });
    if (this.players.size === 0) {
      this.endMatch('empty');
      this.emit('empty');
    }
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.emit('chat', player, text);
    this.record('chat', { player: player.id, text });
  }

  roster() {
    return [...this.players.values()].map(({ id, name, shipId }) => ({ id, name, shipId }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      region: this.region,
      players: this.size,
      maxPlayers: this.maxPlayers,
    };
  }
}

/**
 * Owns all rooms. Emits 'roomCreated' (room) and 'roomDeleted' (room).
 * Non-persistent rooms are deleted when they become empty.
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #seq = 0;

  constructor({ maxRooms, maxPlayersPerRoom }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  get size() {
    return this.#rooms.size;
  }

  get playerCount() {
    let n = 0;
    for (const r of this.#rooms.values()) n += r.size;
    return n;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  create({ id, name, arena, region, persistent = false, maxPlayers }) {
    if (this.#rooms.size >= this.maxRooms) throw new RoomLimitError(this.maxRooms);
    const roomId = id ?? `r${(++this.#seq).toString(36)}-${randomUUID().slice(0, 4)}`;
    const room = new Room({
      id: roomId,
      name,
      arena,
      region,
      persistent,
      maxPlayers: Math.min(maxPlayers ?? this.maxPlayersPerRoom, this.maxPlayersPerRoom),
    });
    room.on('join', () => {
      if (room.size === 1) room.startMatch();
    });
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.#rooms.set(room.id, room);
    this.emit('roomCreated', room);
    return room;
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return;
    room.endMatch('deleted');
    this.#rooms.delete(id);
    this.emit('roomDeleted', room);
    room.removeAllListeners();
  }

  /** Shutdown: end every running match so the logs get their final line. */
  endAllMatches(reason) {
    for (const room of this.#rooms.values()) room.endMatch(reason);
  }
}

export class RoomLimitError extends Error {
  constructor(max) {
    super(`room limit reached (${max})`);
    this.name = 'RoomLimitError';
  }
}

export const ARENAS = ['classic', 'rocks', 'calm'];

export function seedDefaultRooms(manager) {
  manager.create({
    id: 'eu-1',
    name: 'Kyiv Dogfight',
    arena: 'classic',
    region: 'eu',
    persistent: true,
  });
  manager.create({
    id: 'eu-2',
    name: 'Asteroid Belt',
    arena: 'rocks',
    region: 'eu',
    persistent: true,
  });
  manager.create({
    id: 'us-1',
    name: 'Calm Skies (training)',
    arena: 'calm',
    region: 'us',
    persistent: true,
    maxPlayers: 4,
  });
}
