// Two browser contexts = two players with separate storage and sockets, one room.
// Client → server → protocol → other client, end to end.
import { expect, test, type Page } from '@playwright/test';

/** What the test reads from the dev build's `window.net` (see client/src/globals.d.ts). */
interface NetProbe {
  selfShipId: number | null;
  latest: { entities: readonly { kind: string; id: number; x: number; y: number }[] } | null;
}
declare global {
  interface Window {
    net?: NetProbe;
  }
}

const ROOM = 'eu-1';

async function join(page: Page, name: string): Promise<number> {
  await page.goto(`/?join=${ROOM}&name=${name}`);
  await expect(page.locator('#chat')).toBeVisible({ timeout: 15_000 }); // the match screen
  await expect
    .poll(() => page.evaluate(() => window.net?.selfShipId ?? null), { timeout: 10_000 })
    .not.toBeNull();
  const id = await page.evaluate(() => window.net?.selfShipId ?? null);
  if (id === null) throw new Error(`${name} has no ship`);
  return id;
}

/** Where `viewer` currently sees ship `id` (from its latest snapshot). */
function seenAt(viewer: Page, id: number): Promise<{ x: number; y: number } | null> {
  return viewer.evaluate((shipId) => {
    const e = window.net?.latest?.entities.find((s) => s.kind === 'ship' && s.id === shipId);
    return e ? { x: e.x, y: e.y } : null;
  }, id);
}

test('two pilots: same room, roster in both, movement seen across clients, chat delivered', async ({
  browser,
}) => {
  const alpha = await (await browser.newContext()).newPage();
  const bravo = await (await browser.newContext()).newPage();
  const alphaShip = await join(alpha, 'Alpha');
  await join(bravo, 'Bravo');

  // Roster: both names on both screens.
  for (const page of [alpha, bravo]) {
    await expect(page.locator('#chat-roster')).toContainText('Alpha');
    await expect(page.locator('#chat-roster')).toContainText('Bravo');
  }

  // Movement: Alpha thrusts; Bravo must see Alpha's ship move within 500 ms.
  await expect.poll(() => seenAt(bravo, alphaShip)).not.toBeNull();
  const start = await seenAt(bravo, alphaShip);
  if (!start) throw new Error('Bravo never saw Alpha');
  await alpha.locator('body').focus();
  await alpha.keyboard.down('KeyW');
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = await seenAt(bravo, alphaShip);
        return now ? Math.hypot(now.x - start.x, now.y - start.y) : 0;
      },
      { timeout: 500, intervals: [25] },
    )
    .toBeGreaterThan(2);
  const seenAfterMs = Date.now() - t0;
  await alpha.keyboard.up('KeyW');
  test.info().annotations.push({ type: 'movement seen after', description: `${seenAfterMs} ms` });

  // Chat: Alpha says something, Bravo's log shows it.
  const text = `contact bearing ${Date.now() % 1000}`;
  await alpha.locator('#chat-input').fill(text);
  await alpha.locator('#chat-input').press('Enter');
  await expect(bravo.locator('#chat-log')).toContainText(text, { timeout: 2000 });
  await expect(bravo.locator('#chat-log')).toContainText('Alpha');
});
