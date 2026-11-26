import { describe, expect, test } from 'vitest';
import { botButtons } from '../src/bot.ts';
import { BUTTON } from '../src/net/protocol.ts';
import { codecFor, binaryCodec, jsonCodec } from '../src/net/codec.ts';

describe('botButtons (the headless autopilot)', () => {
  test('no ship → no buttons; no targets → cruise', () => {
    expect(botButtons(null, [])).toBe(0);
    expect(botButtons({ x: 0, y: 0, angle: 0 }, []) & BUTTON.thrust).toBeTruthy();
  });

  test('turns toward the nearest target and fires when lined up and close', () => {
    const me = { x: 100, y: 100, angle: 0 };
    const ahead = botButtons(me, [
      { x: 300, y: 100 },
      { x: 100, y: 900 },
    ]);
    expect(ahead & BUTTON.fire).toBeTruthy();
    expect(ahead & (BUTTON.left | BUTTON.right)).toBe(0);
    expect(botButtons(me, [{ x: 100, y: 300 }]) & BUTTON.right).toBeTruthy(); // +y is clockwise
    expect(botButtons(me, [{ x: 100, y: -100 }]) & BUTTON.left).toBeTruthy();
  });
});

test('codecFor picks the implementation by name', () => {
  expect(codecFor('binary')).toBe(binaryCodec);
  expect(codecFor('json')).toBe(jsonCodec);
});
