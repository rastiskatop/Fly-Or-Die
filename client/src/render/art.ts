// Shared military silhouettes (original art, drawn with Path2D). Origin = centre, facing +x.

/** Side-view fighter plane, ~64 units long. */
export const FIGHTER_SIDE = (() => {
  const body = new Path2D(
    'M32 0 Q26 -5 12 -5.5 L-20 -4.5 L-28 -15 L-33 -15 L-30 -3 L-31 2 L-24 4.5 L12 5.5 Q26 5 32 0 Z',
  );
  const wing = new Path2D('M4 2 L-10 10 L-17 10 L-8 2 Z');
  const canopy = new Path2D('M16 -5.5 Q9 -12 0 -6 Z');
  const prop = new Path2D('M32 -9 L34 -9 L34 9 L32 9 Z');
  return { body, wing, canopy, prop };
})();

export function drawFighterSide(
  ctx: CanvasRenderingContext2D,
  color = '#1d2226',
  canopy = 'rgba(160,200,220,0.5)',
) {
  ctx.fillStyle = color;
  ctx.fill(FIGHTER_SIDE.body);
  ctx.fill(FIGHTER_SIDE.wing);
  ctx.fill(FIGHTER_SIDE.prop);
  ctx.fillStyle = canopy;
  ctx.fill(FIGHTER_SIDE.canopy);
}

/** Top-down plane silhouette (for shadows on the ground), ~40 units. */
export const PLANE_TOP = new Path2D(
  'M20 0 L12 -2.5 L4 -2.5 L-2 -18 L-7 -18 L-5 -2.5 L-14 -2 L-18 -7 L-21 -7 L-19 0 L-21 7 L-18 7 L-14 2 L-5 2.5 L-7 18 L-2 18 L4 2.5 L12 2.5 Z',
);

/** Assault rifle (AK-style silhouette), ~104 units long. Wooden stock and handguard. */
export function drawRifle(ctx: CanvasRenderingContext2D, alpha = 1) {
  const metal = `rgba(36, 36, 34, ${alpha})`;
  const wood = `rgba(112, 66, 34, ${alpha})`;
  const woodDark = `rgba(74, 42, 22, ${alpha})`;
  ctx.fillStyle = wood;
  ctx.beginPath(); // stock
  ctx.moveTo(-52, -3);
  ctx.lineTo(-31, -4.5);
  ctx.lineTo(-31, 2.5);
  ctx.lineTo(-47, 10);
  ctx.lineTo(-53, 9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = metal;
  ctx.fillRect(-31, -5.5, 36, 9); // receiver
  ctx.beginPath(); // pistol grip
  ctx.moveTo(-21, 3);
  ctx.lineTo(-15, 3);
  ctx.lineTo(-18, 15);
  ctx.lineTo(-24, 14);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath(); // curved magazine
  ctx.moveTo(-9, 3);
  ctx.quadraticCurveTo(-7, 16, -14, 25);
  ctx.lineTo(-6, 28);
  ctx.quadraticCurveTo(2, 16, 0, 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = wood;
  ctx.fillRect(5, -4.5, 19, 8); // handguard
  ctx.fillStyle = woodDark;
  ctx.fillRect(5, -1, 19, 1.2);
  ctx.fillStyle = metal;
  ctx.fillRect(5, -8, 24, 2.6); // gas tube
  ctx.fillRect(24, -3, 28, 3); // barrel
  ctx.fillRect(45, -8, 2.2, 5); // front sight
  ctx.fillRect(51, -3.6, 5, 4.2); // muzzle
}

/** "Pineapple" hand grenade, ~30 units tall. */
export function drawGrenade(ctx: CanvasRenderingContext2D, alpha = 1) {
  ctx.fillStyle = `rgba(74, 90, 42, ${alpha})`;
  ctx.beginPath();
  ctx.ellipse(0, 3, 9.5, 12.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(40, 50, 22, ${alpha})`;
  ctx.lineWidth = 1.2;
  for (let y = -6; y <= 12; y += 4.5) {
    ctx.beginPath();
    ctx.moveTo(-9, y);
    ctx.lineTo(9, y);
    ctx.stroke();
  }
  for (const x of [-4.5, 0, 4.5]) {
    ctx.beginPath();
    ctx.moveTo(x, -9);
    ctx.lineTo(x, 15);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(60, 60, 58, ${alpha})`;
  ctx.fillRect(-3.5, -14, 7, 5); // fuse
  ctx.beginPath(); // lever
  ctx.moveTo(3, -13);
  ctx.quadraticCurveTo(12, -12, 10, 4);
  ctx.lineTo(8, 4);
  ctx.quadraticCurveTo(9, -9, 3, -10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(150, 150, 140, ${alpha})`;
  ctx.lineWidth = 1.4;
  ctx.beginPath(); // pin ring
  ctx.arc(-6, -14, 3.5, 0, Math.PI * 2);
  ctx.stroke();
}

/** Rifle cartridge, ~26 units long. */
export function drawCartridge(ctx: CanvasRenderingContext2D, alpha = 1) {
  ctx.fillStyle = `rgba(201, 160, 58, ${alpha})`; // brass case
  ctx.fillRect(-13, -3.5, 17, 7);
  ctx.fillRect(-14, -4, 2, 8); // rim
  ctx.fillStyle = `rgba(176, 102, 58, ${alpha})`; // copper bullet
  ctx.beginPath();
  ctx.moveTo(4, -3);
  ctx.quadraticCurveTo(13, -2.5, 14, 0);
  ctx.quadraticCurveTo(13, 2.5, 4, 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(255, 240, 190, ${alpha * 0.5})`;
  ctx.fillRect(-12, -2.5, 15, 1.2);
}

/** Aerial bomb with tail fins, ~44 units long. */
export function drawBomb(ctx: CanvasRenderingContext2D, alpha = 1) {
  ctx.fillStyle = `rgba(68, 76, 60, ${alpha})`;
  ctx.beginPath();
  ctx.ellipse(4, 0, 18, 7.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath(); // fins
  ctx.moveTo(-12, -3);
  ctx.lineTo(-22, -10);
  ctx.lineTo(-24, -10);
  ctx.lineTo(-20, 0);
  ctx.lineTo(-24, 10);
  ctx.lineTo(-22, 10);
  ctx.lineTo(-12, 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(214, 170, 40, ${alpha})`; // yellow band
  ctx.fillRect(12, -6.5, 3, 13);
}
