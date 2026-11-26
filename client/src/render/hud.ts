import { PICKUP_TYPES, type PickupEffect } from '@flyordie/shared/sim/pickup.ts';
import type { Bus, AbortSignalLike } from '@flyordie/shared/bus.ts';
import type { GameEvents } from '@flyordie/shared/sim/events.ts';
import type { EntityId } from '@flyordie/shared/ids.ts';
import type { ShipEffect } from '@flyordie/shared/sim/ship.ts';
import type { LoopStats } from '../loop.ts';
import type { Audio } from '../audio/audio.ts';

// Readable over any terrain: warm white text with a dark drop shadow.
const NEON = '#f4ecd0';
const HP_OK = '#9fd14a';
// Record<Union, …>: the compiler insists every effect has a label — a new pickup can't be forgotten here.
const EFFECT_NAMES: Record<ShipEffect, string> = { speed: 'SPEED x2', bullets: 'BULLETS x2' };
const PICKUP_BANNER: Record<PickupEffect, string> = {
  speed: 'SPEED x2!',
  bullets: 'BULLETS x2!',
  repair: 'FULL REPAIR!',
};

/** What the HUD reads every frame — the offline Ship and the online predicted ship both fit. */
export interface HudPlayer {
  readonly name: string;
  readonly score: number;
  readonly deaths: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly effects: ReadonlyMap<ShipEffect, number>;
  readonly destroyed: boolean;
  readonly respawnIn: number;
}

export interface HudFrame {
  readonly stats: Readonly<LoopStats>;
  readonly player: HudPlayer;
  readonly width: number;
  readonly height: number;
  readonly room: string;
  readonly audio: Pick<Audio, 'muted' | 'state'>;
  readonly entities: number;
}

interface Popup {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly born: number;
}

/**
 * HUD = reads the player's state every frame + reacts to sim EVENTS for one-off effects
 * (score popups, pickup banners, damage flash). Like audio, the sim doesn't know it exists.
 */
export interface Hud {
  draw(ctx: CanvasRenderingContext2D, frame: HudFrame): void;
}

export function createHud(
  events: Bus<GameEvents>,
  { playerId, signal }: { playerId: EntityId | (() => EntityId | null); signal?: AbortSignalLike },
): Hud {
  const popups: Popup[] = [];
  let banner: { text: string; color: string; born: number } | null = null;
  let scoreFlash = 0;
  let damageFlash = 0;
  const now = () => performance.now() / 1000;
  const pid = () => (typeof playerId === 'function' ? playerId() : playerId); // value or getter
  // "is this event about my ship?" — events name the ship shipId (scored, pickup) or id (hit)
  const mine = (shipId: EntityId) => shipId === pid();
  const opts = signal ? { signal } : {};

  events.on(
    'scored',
    (d) => {
      if (!mine(d.shipId)) return;
      popups.push({ x: d.x, y: d.y, text: `+${d.points}`, color: NEON, born: now() });
      scoreFlash = now();
    },
    opts,
  );
  events.on(
    'pickup',
    (d) => {
      if (!mine(d.shipId)) return;
      banner = { text: PICKUP_BANNER[d.effect], color: PICKUP_TYPES[d.effect].color, born: now() };
    },
    opts,
  );
  events.on(
    'hit',
    (d) => {
      if (d.kind === 'ship' && mine(d.id)) {
        damageFlash = now();
        popups.push({ x: d.x, y: d.y - 20, text: `-${d.damage}`, color: '#ff4d4d', born: now() });
      }
    },
    opts,
  );

  return {
    draw(ctx, { stats, player, width, height, room, audio, entities }) {
      const t = now();
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;

      // Red vignette when we get hit
      const dmgAge = t - damageFlash;
      if (dmgAge < 0.35) {
        ctx.fillStyle = `rgba(255, 0, 0, ${0.25 * (1 - dmgAge / 0.35)})`;
        ctx.fillRect(0, 0, width, height);
      }

      // Floating score popups (render-only, age out after 0.9 s)
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px "Russo One", monospace';
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        if (!p) continue;
        const age = t - p.born;
        if (age > 0.9) {
          popups.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = 1 - age / 0.9;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y - age * 40);
      }
      ctx.globalAlpha = 1;

      // Stats (top left)
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = NEON;
      ctx.font = '14px "Russo One", monospace';
      ctx.fillText(`frames/s: ${stats.fps}`, 16, 24);
      ctx.fillText(`steps/s:  ${stats.ups}`, 16, 44);
      ctx.fillText(`frame ms: ${stats.frameTime.toFixed(2)}`, 16, 64);
      ctx.fillText(`entities: ${entities}`, 16, 84);

      // Pilot + room (top centre)
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8dcb5';
      ctx.fillText(`${player.name} · ${room}`, width / 2, 24);

      // Score (top right), flashes on change
      ctx.textAlign = 'right';
      const flash = t - scoreFlash < 0.25;
      ctx.font = `bold ${flash ? 25 : 22}px "Russo One", monospace`;
      ctx.fillStyle = flash ? '#ffffff' : NEON;
      ctx.fillText(`SCORE ${String(player.score).padStart(6, '0')}`, width - 16, 32);
      ctx.font = '14px "Russo One", monospace';
      ctx.fillStyle = NEON;
      ctx.fillText(`deaths: ${player.deaths}`, width - 16, 54);

      // HP bar + active effects (bottom left)
      ctx.textAlign = 'left';
      const barW = 200;
      const y = height - 40;
      ctx.fillText('HP', 16, y + 11);
      ctx.strokeStyle = NEON;
      ctx.lineWidth = 1;
      ctx.strokeRect(44, y, barW, 14);
      ctx.fillStyle = player.hp > 30 ? HP_OK : '#ff4d4d';
      ctx.fillRect(46, y + 2, ((barW - 4) * player.hp) / player.maxHp, 10);
      let ex = 260;
      for (const [name, left] of player.effects) {
        ctx.fillStyle = PICKUP_TYPES[name]?.color ?? '#fff';
        const label = `${EFFECT_NAMES[name] ?? name} ${left.toFixed(1)}s`;
        ctx.fillText(label, ex, y + 11);
        ex += ctx.measureText(label).width + 20;
      }

      // Controls + sound state (bottom right)
      ctx.fillStyle = 'rgba(244, 236, 208, 0.7)';
      ctx.textAlign = 'right';
      ctx.font = '12px "Russo One", monospace';
      const sound = audio.muted ? 'muted' : audio.state;
      ctx.fillText(
        `W/↑ thrust · A D/← → turn · SPACE fire · M sound (${sound}) · N netgraph · Esc lobby`,
        width - 16,
        height - 16,
      );

      // Pickup banner (centre, 1.2 s)
      if (banner) {
        const age = t - banner.born;
        if (age > 1.2) banner = null;
        else {
          ctx.textAlign = 'center';
          ctx.globalAlpha = Math.min(1, (1.2 - age) * 3);
          ctx.fillStyle = banner.color;
          ctx.font = `bold ${30 + age * 10}px "Russo One", monospace`;
          ctx.fillText(banner.text, width / 2, height / 2 - 120);
          ctx.globalAlpha = 1;
        }
      }

      if (player.destroyed) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ff4d4d';
        ctx.font = 'bold 36px "Russo One", monospace';
        ctx.fillText('SHOT DOWN', width / 2, height / 2 - 10);
        ctx.font = '18px "Russo One", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(
          `respawn in ${Math.max(0, player.respawnIn).toFixed(1)}s`,
          width / 2,
          height / 2 + 24,
        );
      }
      ctx.restore();
    },
  };
}
