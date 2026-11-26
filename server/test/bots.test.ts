import { describe, expect, test } from 'vitest';
import { botDecide, Bot, type BotPersonality } from '../src/bots.ts';
import {
  BUTTON,
  type EntityState,
  type Input,
  type ShipState,
} from '@flyordie/shared/net/protocol.ts';
import { asEntityId, asTick } from '@flyordie/shared/ids.ts';

const P: BotPersonality = { caution: 100, trigger: 0.2, range: 200 };

function ship(
  id: number,
  x: number,
  y: number,
  angle = 0,
  over: Partial<ShipState> = {},
): ShipState {
  return {
    kind: 'ship',
    id: asEntityId(id),
    x,
    y,
    angle,
    vx: 0,
    vy: 0,
    hp: 100,
    score: 0,
    deaths: 0,
    destroyed: false,
    thrusting: false,
    hitFlash: false,
    speed: 0,
    bullets: 0,
    invulnerable: 0,
    respawnIn: 0,
    fireCooldown: 0,
    ...over,
  };
}
const rock = (id: number, x: number, y: number, size: 1 | 2 | 3 = 2): EntityState => ({
  kind: 'asteroid',
  id: asEntityId(id),
  x,
  y,
  angle: 0,
  size,
  seeker: false,
  hitFlash: false,
});

describe('botDecide', () => {
  test('no ship / destroyed → no buttons', () => {
    expect(botDecide(undefined, [], P, 0)).toBe(0);
    expect(botDecide(ship(1, 0, 0, 0, { destroyed: true }), [], P, 0)).toBe(0);
  });

  test('CHASE + SHOOT: an enemy straight ahead and in range → fire, no turning', () => {
    const me = ship(1, 100, 300);
    const b = botDecide(me, [me, ship(2, 400, 300)], P, 1);
    expect(b & BUTTON.fire).toBeTruthy();
    expect(b & (BUTTON.left | BUTTON.right)).toBe(0);
  });

  test('CHASE: an enemy behind → turn, hold fire', () => {
    const me = ship(1, 400, 300, 0);
    const b = botDecide(me, [me, ship(2, 100, 320)], P, 1);
    expect(b & (BUTTON.left | BUTTON.right)).toBeTruthy();
    expect(b & BUTTON.fire).toBe(0);
  });

  test('EVADE beats CHASE: a rock inside the caution radius → turn away and thrust', () => {
    const me = ship(1, 400, 300, 0); // facing +x, the rock is right in front
    const b = botDecide(me, [me, ship(2, 900, 300), rock(3, 460, 300)], P, 1);
    expect(b & BUTTON.thrust).toBeTruthy();
    expect(b & BUTTON.fire).toBe(0);
    expect(b & (BUTTON.left | BUTTON.right)).toBeTruthy();
  });

  test('ignores spawn-protected and destroyed enemies; falls back to rocks', () => {
    const me = ship(1, 100, 300);
    const b = botDecide(
      me,
      [me, ship(2, 300, 300, 0, { invulnerable: 1.5 }), rock(3, 100, 700)],
      P,
      1,
    );
    expect(b & (BUTTON.left | BUTTON.right)).toBeTruthy(); // turning toward the rock below
  });

  test('aims through the arena wrap', () => {
    const me = ship(1, 1270, 300, 0); // enemy at x = 30 is 40 px ahead through the right edge
    expect(botDecide(me, [me, ship(2, 30, 300)], P, 1) & BUTTON.fire).toBeTruthy();
  });
});

test('Bot: one input per snapshot through the SAME door as players, seq 1, 2, 3, …', () => {
  const sent: Input[] = [];
  const bot = new Bot(
    {
      pushInputs: (id, inputs) => {
        expect(id).toBe(bot.playerId);
        sent.push(...inputs);
      },
    },
    0,
    () => 0.5,
  );
  const me = ship(7, 100, 100);
  for (let t = 0; t < 3; t++)
    bot.onSnapshot({ tick: asTick(t), entities: [me], events: [] }, me.id);
  expect(sent.map((i) => i.seq)).toEqual([1, 2, 3]);
  expect(bot.player.name.startsWith('BOT ')).toBe(true);
});
