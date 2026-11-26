import { PICKUP_TYPES } from '../sim/pickup.js';

const NEON = '#00ff66';

export function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;
  return a + diff * t;
}

// Interpolated render position; no lerp across an arena wrap (it would streak across the screen).
function renderPos(e, alpha, width, height) {
  let x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
  let y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
  if (Math.abs(e.pos.x - e.prevPos.x) > width / 2) x = e.pos.x;
  if (Math.abs(e.pos.y - e.prevPos.y) > height / 2) y = e.pos.y;
  return { x, y, angle: lerpAngle(e.prevAngle, e.angle, alpha) };
}

export function drawGrid(ctx, width, height) {
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x += 50) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y < height; y += 50) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

export function drawWorld(ctx, world, alpha, time) {
  const { width, height } = world;
  // Draw order by kind: effects under everything, ships on top.
  for (const kind of ['explosion', 'pickup', 'asteroid', 'bullet', 'ship']) {
    for (const e of world.ofKind(kind)) {
      if (!e.alive && kind !== 'explosion') continue;
      const p = renderPos(e, alpha, width, height);
      ctx.save();
      ctx.translate(p.x, p.y);
      DRAW[kind](ctx, e, p.angle, time);
      ctx.restore();
    }
  }
}

const DRAW = {
  ship: drawShip,
  bullet: drawBullet,
  asteroid: drawAsteroid,
  pickup: drawPickup,
  explosion: drawExplosion,
};

// Top-down jet fighter, nose pointing along +x.
function drawShip(ctx, ship, angle, time) {
  if (ship.destroyed) return;
  // Spawn protection: blink.
  if (ship.invulnerableFor > 0 && Math.floor(time * 12) % 2 === 0) ctx.globalAlpha = 0.35;

  ctx.save();
  ctx.rotate(angle);
  ctx.scale(1.3, 1.3);

  if (ship.thrusting) {
    const flicker = 0.75 + Math.random() * 0.5; // render-only randomness, not simulation
    ctx.beginPath();
    ctx.moveTo(-14, -3);
    ctx.lineTo(-14 - 14 * flicker, 0);
    ctx.lineTo(-14, 3);
    ctx.closePath();
    ctx.fillStyle = ship.effects.has('speed') ? '#4fc3ff' : '#ff7a1a'; // afterburner
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-14, -1.5);
    ctx.lineTo(-14 - 7 * flicker, 0);
    ctx.lineTo(-14, 1.5);
    ctx.closePath();
    ctx.fillStyle = '#ffe08a';
    ctx.fill();
  }

  const hit = ship.hitFlash > 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = hit ? '#ffffff' : NEON;
  ctx.fillStyle = hit ? '#ff4d4d' : '#123222';

  // Main swept wings
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-4, -17);
  ctx.lineTo(-9, -17);
  ctx.lineTo(-6, -3);
  ctx.lineTo(-6, 3);
  ctx.lineTo(-9, 17);
  ctx.lineTo(-4, 17);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Tail stabilizers
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.lineTo(-15, -8);
  ctx.lineTo(-18, -8);
  ctx.lineTo(-15, 0);
  ctx.lineTo(-18, 8);
  ctx.lineTo(-15, 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Fuselage
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.quadraticCurveTo(12, -4, 2, -4);
  ctx.lineTo(-15, -3);
  ctx.lineTo(-15, 3);
  ctx.lineTo(2, 4);
  ctx.quadraticCurveTo(12, 4, 20, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Cockpit canopy
  ctx.beginPath();
  ctx.ellipse(8, 0, 4.5, 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#7fdcff';
  ctx.fill();

  // Wingtip nav lights
  ctx.fillStyle = '#ff3b3b';
  ctx.fillRect(-7.5, -17.5, 2, 2);
  ctx.fillStyle = '#3bff6e';
  ctx.fillRect(-7.5, 15.5, 2, 2);

  ctx.restore();
  ctx.globalAlpha = 1;

  // Small HP bar under the plane
  const w = 30;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(-w / 2, ship.radius + 12, w, 3);
  ctx.fillStyle = ship.hp > 30 ? NEON : '#ff4d4d';
  ctx.fillRect(-w / 2, ship.radius + 12, (w * ship.hp) / ship.maxHp, 3);
}

function drawBullet(ctx, bullet, angle) {
  ctx.rotate(angle);
  // Fast bullets ('bullets' pickup) get a longer, brighter streak.
  ctx.strokeStyle = bullet.fast ? '#fff6a0' : '#ffe14d';
  ctx.lineWidth = bullet.fast ? 2.5 : 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bullet.fast ? -16 : -8, 0);
  ctx.lineTo(3, 0);
  ctx.stroke();
}

function drawAsteroid(ctx, a, angle, time) {
  ctx.rotate(angle);
  const n = a.shape.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = a.radius * a.shape[i];
    if (i === 0) ctx.moveTo(Math.cos(t) * r, Math.sin(t) * r);
    else ctx.lineTo(Math.cos(t) * r, Math.sin(t) * r);
  }
  ctx.closePath();
  ctx.fillStyle = a.hitFlash > 0 ? '#5a4a3a' : '#221d19';
  ctx.fill();
  ctx.lineWidth = 2;
  if (a.homing) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 8);
    ctx.strokeStyle = `rgba(255, 77, 77, ${pulse})`;
    ctx.shadowColor = '#ff4d4d';
    ctx.shadowBlur = 10;
  } else {
    ctx.strokeStyle = '#c8b49a';
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawPickup(ctx, p, angle, time) {
  const type = PICKUP_TYPES[p.pickup.effect];
  const timeLeft = p.lifetime - p.age;
  if (timeLeft < 3 && Math.floor(time * 8) % 2 === 0) ctx.globalAlpha = 0.3;

  const scale = 1 + 0.1 * Math.sin(time * 4);
  ctx.save();
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2;
    ctx.lineTo(Math.cos(t) * p.radius, Math.sin(t) * p.radius);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.strokeStyle = type.color;
  ctx.lineWidth = 2;
  ctx.shadowColor = type.color;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = type.color;
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(type.label, 0, 1);
  ctx.globalAlpha = 1;
}

function drawExplosion(ctx, ex) {
  const life = Math.max(0, ex.ttl / ex.maxTtl);
  ctx.globalAlpha = life;
  ctx.fillStyle = ex.color;
  for (const p of ex.particles) {
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  // Initial flash
  if (life > 0.8) {
    ctx.beginPath();
    ctx.arc(0, 0, 20 * (1 - life) * 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 240, 200, 0.5)';
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const EFFECT_NAMES = { speed: 'SPEED x2', bullets: 'BULLETS x2' };

export function drawHud(ctx, { stats, world, player, width, height }) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = NEON;
  ctx.font = '14px monospace';
  ctx.fillText(`frames/s: ${stats.fps}`, 16, 24);
  ctx.fillText(`steps/s:  ${stats.ups}`, 16, 44);
  ctx.fillText(`frame ms: ${stats.frameTime.toFixed(2)}`, 16, 64);
  ctx.fillText(`entities: ${world.size}`, 16, 84);

  // Score (top right)
  ctx.textAlign = 'right';
  ctx.font = 'bold 22px monospace';
  ctx.fillText(`SCORE ${String(player.score).padStart(6, '0')}`, width - 16, 32);
  ctx.font = '14px monospace';
  ctx.fillText(`deaths: ${player.deaths}`, width - 16, 54);

  // HP bar + effects (bottom left)
  ctx.textAlign = 'left';
  const barW = 200;
  const y = height - 40;
  ctx.fillText('HP', 16, y + 11);
  ctx.strokeStyle = NEON;
  ctx.strokeRect(44, y, barW, 14);
  ctx.fillStyle = player.hp > 30 ? NEON : '#ff4d4d';
  ctx.fillRect(46, y + 2, ((barW - 4) * player.hp) / player.maxHp, 10);

  let ex = 260;
  for (const [name, left] of player.effects) {
    ctx.fillStyle = PICKUP_TYPES[name].color;
    const label = `${EFFECT_NAMES[name]} ${left.toFixed(1)}s`;
    ctx.fillText(label, ex, y + 11);
    ex += ctx.measureText(label).width + 20;
  }

  ctx.fillStyle = '#555';
  ctx.textAlign = 'right';
  ctx.font = '12px monospace';
  ctx.fillText('W/↑ thrust · A D/← → turn · SPACE fire', width - 16, height - 16);

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
}
