// The allocation-free render path: same view objects frame after frame, correct interpolation.
import { describe, expect, test } from 'vitest';
import { RemoteViews, createDrawLists, clearDrawLists } from '../src/net/remote-views.ts';
import type { EntityState } from '@flyordie/shared/net/protocol.ts';
import { asEntityId } from '@flyordie/shared/ids.ts';

const BOUNDS = { width: 1280, height: 720 };
const rock = (id: number, x: number, y: number): EntityState => ({
  kind: 'asteroid',
  id: asEntityId(id),
  x,
  y,
  angle: 0,
  size: 2,
  seeker: false,
  hitFlash: false,
});
const never = () => false;

describe('RemoteViews', () => {
  test('blends between two snapshots and reuses the SAME object next frame', () => {
    const views = new RemoteViews();
    const lists = createDrawLists();
    const a = [rock(5, 100, 100)];
    const b = [rock(5, 200, 100)];
    views.update(a, b, 0.25, BOUNDS, never, lists);
    const first = lists.asteroid[0];
    expect(first?.pos).toEqual({ x: 125, y: 100 });
    clearDrawLists(lists);
    views.update(a, b, 0.5, BOUNDS, never, lists);
    expect(lists.asteroid[0]).toBe(first); // no new object
    expect(first?.pos.x).toBe(150);
  });

  test('no streak through the wrap; vanished entities are dropped; skip() hides predicted ones', () => {
    const views = new RemoteViews();
    const lists = createDrawLists();
    views.update(
      [rock(1, 1275, 50)],
      [rock(1, 5, 50), rock(2, 300, 300)],
      0.5,
      BOUNDS,
      (e) => e.id === 2,
      lists,
    );
    expect(lists.asteroid).toHaveLength(1);
    expect(lists.asteroid[0]?.pos.x).toBe(5); // jumped through the edge: no blend
    clearDrawLists(lists);
    views.update([], [], 1, BOUNDS, never, lists);
    expect(views.size).toBe(0);
  });

  test('views are pooled: a vanished rock view is recycled for the next rock, with its own id/shape', () => {
    const views = new RemoteViews();
    const lists = createDrawLists();
    views.update([], [rock(1, 10, 10)], 1, BOUNDS, never, lists);
    const first = lists.asteroid[0];
    clearDrawLists(lists);
    views.update([], [], 1, BOUNDS, never, lists); // rock 1 is gone → its view goes to the pool
    views.update([], [rock(2, 500, 400)], 1, BOUNDS, never, lists);
    const second = lists.asteroid[0];
    expect(second).toBe(first); // the same object…
    expect(second?.kind === 'asteroid' && second.id).toBe(2); // …now describing rock 2
    expect(second?.pos).toEqual({ x: 500, y: 400 });
    expect(views.reused).toBe(1);
  });

  test('an id reused by a different kind gets a fresh view of the right kind', () => {
    const views = new RemoteViews();
    const lists = createDrawLists();
    views.update([], [rock(9, 0, 0)], 1, BOUNDS, never, lists);
    clearDrawLists(lists);
    const pickup: EntityState = {
      kind: 'pickup',
      id: asEntityId(9),
      x: 1,
      y: 1,
      angle: 0,
      effect: 'repair',
      lifeLeft: 10,
    };
    views.update([], [pickup], 1, BOUNDS, never, lists);
    expect(lists.pickup).toHaveLength(1);
    expect(lists.asteroid).toHaveLength(0);
  });
});
