export function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;
  return a + diff * t;
}

export function drawGrid(ctx, width, height) {
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 50) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 50) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

export function drawShip(ctx, ship) {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, 8);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-12, -8);
  ctx.closePath();
  ctx.strokeStyle = '#00ff66';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (ship.thrusting) {
    ctx.beginPath();
    ctx.moveTo(-10, 0); ctx.lineTo(-20, 5); ctx.lineTo(-25, 0); ctx.lineTo(-20, -5);
    ctx.closePath();
    ctx.strokeStyle = '#ff5500';
    ctx.stroke();
  }
  ctx.restore();
}

export function drawHud(ctx, stats) {
  ctx.fillStyle = '#00ff66';
  ctx.font = '14px monospace';
  ctx.fillText(`frames/s: ${stats.fps}`, 16, 24);
  ctx.fillText(`steps/s:  ${stats.ups}`, 16, 44);
  ctx.fillText(`frame ms: ${stats.frameTime.toFixed(2)}`, 16, 64);
}