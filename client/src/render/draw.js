import { PICKUP_TYPES } from '../sim/pickup.js';

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

/**
 * Draws every entity. With a sprite sheet loaded, entities are drawn from it; without one
 * (404 / failed load) the Lab 2 vector drawings are the fallback — the game still runs.
 */
export function drawWorld(ctx, world, alpha, time, sprites = null) {
  const { width, height } = world;
  // Draw order by kind: effects under everything, ships on top.
  for (const kind of ['explosion', 'pickup', 'asteroid', 'bullet', 'ship']) {
    for (const e of world.ofKind(kind)) {
      if (!e.alive && kind !== 'explosion') continue;
      const p = renderPos(e, alpha, width, height);
      ctx.save();
      ctx.translate(p.x, p.y);
      const draw = (sprites && SPRITE[kind]) || DRAW[kind];
      draw(ctx, e, p.angle, time, sprites);
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
  ctx.strokeStyle = hit ? '#ffffff' : '#1b2023';
  ctx.fillStyle = hit ? '#ff4d4d' : '#b9c2c6';

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

  drawHpBar(ctx, ship);
}

function drawHpBar(ctx, ship) {
  const w = 30;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(-w / 2 - 1, ship.radius + 11, w + 2, 5);
  ctx.fillStyle = ship.hp > 30 ? '#9fd14a' : '#ff4d4d';
  ctx.fillRect(-w / 2, ship.radius + 12, (w * ship.hp) / ship.maxHp, 3);
}

function drawBullet(ctx, bullet, angle) {
  ctx.rotate(angle);
  // Glowing tracer: wide coloured halo + white core. Fast bullets ('bullets' pickup) are longer and cyan.
  const tail = bullet.fast ? -28 : -14;
  ctx.lineCap = 'round';
  ctx.shadowColor = bullet.fast ? '#4fe3ff' : '#ffc21a';
  ctx.shadowBlur = 8;
  ctx.strokeStyle = bullet.fast ? '#4fe3ff' : '#ffc21a';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(tail, 0);
  ctx.lineTo(3, 0);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tail * 0.6, 0);
  ctx.lineTo(2, 0);
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

// ---------- sprite versions ----------

function spriteShip(ctx, ship, angle, time, sprites) {
  if (ship.destroyed) return;
  if (ship.invulnerableFor > 0 && Math.floor(time * 12) % 2 === 0) ctx.globalAlpha = 0.35;
  const anim = Math.floor(time * 15) % 2 === 0 ? 'a' : 'b'; // 2-frame engine flame animation
  let frame = 'ship';
  if (ship.hitFlash > 0) frame = 'ship_hit';
  else if (ship.thrusting)
    frame = ship.effects.has('speed') ? `ship_boost_${anim}` : `ship_thrust_${anim}`;
  ctx.save();
  ctx.rotate(angle);
  sprites.draw(ctx, frame);
  ctx.restore();
  ctx.globalAlpha = 1;
  drawHpBar(ctx, ship);
}

function spriteBullet(ctx, bullet, angle, time, sprites) {
  ctx.rotate(angle);
  sprites.draw(ctx, bullet.fast ? 'bullet_fast' : 'bullet');
}

const ROCKS = ['asteroid_a', 'asteroid_b', 'asteroid_c'];

function spriteAsteroid(ctx, a, angle, time, sprites) {
  const frame = ROCKS[a.id % ROCKS.length];
  const k = a.radius / sprites.radiusOf(frame);
  if (a.homing) {
    // Seeker: pulsing red halo drawn under the rock.
    const pulse = 0.35 + 0.25 * Math.sin(time * 8);
    ctx.beginPath();
    ctx.arc(0, 0, a.radius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 77, 77, ${pulse + 0.2})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ff4d4d';
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.rotate(angle);
  sprites.draw(ctx, frame, k);
  if (a.hitFlash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    sprites.draw(ctx, frame, k);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

function spritePickup(ctx, p, angle, time, sprites) {
  const timeLeft = p.lifetime - p.age;
  if (timeLeft < 3 && Math.floor(time * 8) % 2 === 0) ctx.globalAlpha = 0.3;
  const frame = `pickup_${p.pickup.effect}`;
  const k = (p.radius / sprites.radiusOf(frame)) * (1 + 0.1 * Math.sin(time * 4));
  sprites.draw(ctx, frame, k);
  ctx.globalAlpha = 1;
}

const SPRITE = {
  ship: spriteShip,
  bullet: spriteBullet,
  asteroid: spriteAsteroid,
  pickup: spritePickup,
  // explosions stay procedural particles
};
