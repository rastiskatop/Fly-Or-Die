import { PICKUP_TYPES } from '../sim/pickup.js';

const NEON = '#00ff66';
const EFFECT_NAMES = { speed: 'SPEED x2', bullets: 'BULLETS x2' };
const PICKUP_BANNER = { speed: 'SPEED x2!', bullets: 'BULLETS x2!', repair: 'FULL REPAIR!' };

/**
 * HUD = reads the player's state every frame + reacts to sim EVENTS for one-off effects
 * (score popups, pickup banners, damage flash). Like audio, the sim doesn't know it exists.
 */
export function createHud(world, { playerId, signal } = {}) {
  const popups = []; // { x, y, text, color, born }
  let banner = null; // { text, color, born }
  let scoreFlash = 0;
  let damageFlash = 0;
  const now = () => performance.now() / 1000;
  const mine = (d) => d.shipId === undefined || d.shipId === playerId || d.id === playerId;
  const on = (type, fn) => world.addEventListener(type, (e) => fn(e.detail), { signal });

  on('scored', (d) => {
    if (!mine(d)) return;
    popups.push({ x: d.x, y: d.y, text: `+${d.points}`, color: NEON, born: now() });
    scoreFlash = now();
  });
  on('pickup', (d) => {
    if (!mine(d)) return;
    const color = PICKUP_TYPES[d.effect]?.color ?? '#fff';
    banner = { text: PICKUP_BANNER[d.effect] ?? d.effect, color, born: now() };
  });
  on('hit', (d) => {
    if (d.kind === 'ship' && mine(d)) {
      damageFlash = now();
      popups.push({ x: d.x, y: d.y - 20, text: `-${d.damage}`, color: '#ff4d4d', born: now() });
    }
  });

  return {
    draw(ctx, { stats, player, width, height, room, audio }) {
      const t = now();

      // Red vignette when we get hit
      const dmgAge = t - damageFlash;
      if (dmgAge < 0.35) {
        ctx.fillStyle = `rgba(255, 0, 0, ${0.25 * (1 - dmgAge / 0.35)})`;
        ctx.fillRect(0, 0, width, height);
      }

      // Floating score popups (render-only, age out after 0.9 s)
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px monospace';
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
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
      ctx.font = '14px monospace';
      ctx.fillText(`frames/s: ${stats.fps}`, 16, 24);
      ctx.fillText(`steps/s:  ${stats.ups}`, 16, 44);
      ctx.fillText(`frame ms: ${stats.frameTime.toFixed(2)}`, 16, 64);
      ctx.fillText(`entities: ${world.size}`, 16, 84);

      // Pilot + room (top centre)
      ctx.textAlign = 'center';
      ctx.fillStyle = '#9fb';
      ctx.fillText(`${player.name} · ${room}`, width / 2, 24);

      // Score (top right), flashes on change
      ctx.textAlign = 'right';
      const flash = t - scoreFlash < 0.25;
      ctx.font = `bold ${flash ? 25 : 22}px monospace`;
      ctx.fillStyle = flash ? '#ffffff' : NEON;
      ctx.fillText(`SCORE ${String(player.score).padStart(6, '0')}`, width - 16, 32);
      ctx.font = '14px monospace';
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
      ctx.fillStyle = player.hp > 30 ? NEON : '#ff4d4d';
      ctx.fillRect(46, y + 2, ((barW - 4) * player.hp) / player.maxHp, 10);
      let ex = 260;
      for (const [name, left] of player.effects) {
        ctx.fillStyle = PICKUP_TYPES[name]?.color ?? '#fff';
        const label = `${EFFECT_NAMES[name] ?? name} ${left.toFixed(1)}s`;
        ctx.fillText(label, ex, y + 11);
        ex += ctx.measureText(label).width + 20;
      }

      // Controls + sound state (bottom right)
      ctx.fillStyle = '#555';
      ctx.textAlign = 'right';
      ctx.font = '12px monospace';
      const sound = audio.muted ? 'muted' : audio.state;
      ctx.fillText(
        `W/↑ thrust · A D/← → turn · SPACE fire · M sound (${sound}) · Esc lobby`,
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
          ctx.font = `bold ${30 + age * 10}px monospace`;
          ctx.fillText(banner.text, width / 2, height / 2 - 120);
          ctx.globalAlpha = 1;
        }
      }

      if (player.destroyed) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ff4d4d';
        ctx.font = 'bold 36px monospace';
        ctx.fillText('SHOT DOWN', width / 2, height / 2 - 10);
        ctx.font = '18px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(
          `respawn in ${Math.max(0, player.respawnIn).toFixed(1)}s`,
          width / 2,
          height / 2 + 24,
        );
      }
    },
  };
}
