export const createShip = (x, y) => ({
  x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrusting: false
});

export function integrate(ship, input, dt) {
  if (input.isDown('KeyA') || input.isDown('ArrowLeft')) ship.angle -= 3.5 * dt;
  if (input.isDown('KeyD') || input.isDown('ArrowRight')) ship.angle += 3.5 * dt;

  ship.thrusting = input.isDown('KeyW') || input.isDown('ArrowUp');
  
  if (ship.thrusting) {
    ship.vx += Math.cos(ship.angle) * 400 * dt;
    ship.vy += Math.sin(ship.angle) * 400 * dt;
  }

  const drag = Math.pow(0.98, dt * 60);
  ship.vx *= drag;
  ship.vy *= drag;

  const speedSq = ship.vx * ship.vx + ship.vy * ship.vy;
  const maxSpeed = 600;
  if (speedSq > maxSpeed * maxSpeed) {
    const speed = Math.sqrt(speedSq);
    ship.vx = (ship.vx / speed) * maxSpeed;
    ship.vy = (ship.vy / speed) * maxSpeed;
  }

  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
}