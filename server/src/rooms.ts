import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { EntityId } from '@flyordie/shared/ids.ts';
import type { RoomInfo, RosterPlayer } from '@flyordie/shared/net/messages.ts';

export interface Player {
  readonly id: string;
  readonly name: string;
  readonly joinedAt: number;
  /** Set by the Match when it spawns the player's ship. */
  shipId?: EntityId;
}

/** One line of the match log (NDJSON). */
export interface RoomLogEvent {
  readonly seq: number;
  readonly t: number;
  readonly type: string;
  readonly room: string;
  readonly [field: string]: unknown;
}

/**
 * Event name → listener arguments. Node's EventEmitter is generic over this map (@types/node),
 * so `room.on('leave', (player, reason) => …)` gets typed arguments and `room.emit('join')`
 * without a player is a compile error.
 */
export interface RoomEvents {
  join: [player: Player];
  leave: [player: Player, reason: string];
  chat: [player: Player, text: string];
  event: [event: RoomLogEvent];
  matchStart: [];
  matchEnd: [];
  empty: [];
}

export class Room extends EventEmitter<RoomEvents> {
  #seq = 0;
  readonly id: string;
  readonly name: string;
  readonly arena: string;
  readonly maxPlayers: number;
  readonly region: string;
  /** Default rooms survive being empty. */
  readonly persistent: boolean;
  readonly players = new Map<string, Player>();
  readonly createdAt = Date.now();
  matchId: string | null = null;
  matchStartedAt = 0;

  constructor({
    id,
    name,
    arena,
    maxPlayers,
    region = 'eu',
    persistent = false,
  }: {
    id: string;
    name: string;
    arena: string;
    maxPlayers: number;
    region?: string;
    persistent?: boolean;
  }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.region = region;
    this.persistent = persistent;
  }

  get size(): number {
    return this.players.size;
  }

  get full(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  /** Records a log event. `t` = ms since the match started, `seq` = order within the match. */
  record(type: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const t = this.matchStartedAt ? Date.now() - this.matchStartedAt : 0;
    this.emit('event', { seq: this.#seq++, t, type, room: this.id, ...fields });
  }

  startMatch(): void {
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

  endMatch(reason: string): void {
    if (!this.matchId) return;
    this.record('match_end', { match: this.matchId, reason, players: this.size });
    this.matchId = null;
    this.emit('matchEnd');
  }

  join(player: Player): void {
    if (this.full) throw new Error(`room ${this.id} is full`);
    this.players.set(player.id, player);
    this.emit('join', player); // the manager may start a match (and its log) here
    this.record('join', { player: player.id, name: player.name });
  }

  leave(playerId: string, reason = 'left'): void {
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

  chat(playerId: string, text: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.emit('chat', player, text);
    this.record('chat', { player: player.id, text });
  }

  roster(): RosterPlayer[] {
    return [...this.players.values()].map(({ id, name, shipId }) =>
      shipId === undefined ? { id, name } : { id, name, shipId },
    );
  }

  toJSON(): RoomInfo {
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

interface ManagerEvents {
  roomCreated: [room: Room];
  roomDeleted: [room: Room];
}

/** Owns all rooms. Non-persistent rooms are deleted when they become empty. */
export class RoomManager extends EventEmitter<ManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  #seq = 0;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;

  constructor({ maxRooms, maxPlayersPerRoom }: { maxRooms: number; maxPlayersPerRoom: number }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.#rooms.values()) n += r.size;
    return n;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  create({
    id,
    name,
    arena,
    region,
    persistent = false,
    maxPlayers,
  }: {
    id?: string;
    name: string;
    arena: string;
    region?: string;
    persistent?: boolean;
    maxPlayers?: number;
  }): Room {
    if (this.#rooms.size >= this.maxRooms) throw new RoomLimitError(this.maxRooms);
    const roomId = id ?? `r${(++this.#seq).toString(36)}-${randomUUID().slice(0, 4)}`;
    const room = new Room({
      id: roomId,
      name,
      arena,
      ...(region === undefined ? {} : { region }),
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

  delete(id: string): void {
    const room = this.#rooms.get(id);
    if (!room) return;
    room.endMatch('deleted');
    this.#rooms.delete(id);
    this.emit('roomDeleted', room);
    room.removeAllListeners();
  }

  /** Shutdown: end every running match so the logs get their final line. */
  endAllMatches(reason: string): void {
    for (const room of this.#rooms.values()) room.endMatch(reason);
  }
}

export class RoomLimitError extends Error {
  constructor(max: number) {
    super(`room limit reached (${max})`);
    this.name = 'RoomLimitError';
  }
}

export const ARENAS = ['classic', 'rocks', 'calm'] as const;

export function seedDefaultRooms(manager: RoomManager): void {
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
