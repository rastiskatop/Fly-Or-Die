import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { createShip, integrate } from './sim/ship.js';
import { bounds, wrap } from './sim/arena.js';
import { setupCanvas } from './render/canvas.js';
import { drawGrid, drawShip, drawHud, lerpAngle } from './render/draw.js';

const { ctx } = setupCanvas('gameCanvas', bounds);
const input = createInput(window);

let previousState = createShip(bounds.width / 2, bounds.height / 2);
let currentState = { ...previousState };

function simulate(dt) {
  previousState = { ...currentState };
  
  integrate(currentState, input, dt);
  wrap(currentState);
  
  input.consume(); 
}

function render(alpha) {
  ctx.clearRect(0, 0, bounds.width, bounds.height);
  drawGrid(ctx, bounds.width, bounds.height);

  let lerpX = previousState.x + (currentState.x - previousState.x) * alpha;
  let lerpY = previousState.y + (currentState.y - previousState.y) * alpha;

  if (Math.abs(currentState.x - previousState.x) > bounds.width / 2) lerpX = currentState.x;
  if (Math.abs(currentState.y - previousState.y) > bounds.height / 2) lerpY = currentState.y;

  const lerpedAngle = lerpAngle(previousState.angle, currentState.angle, alpha);

  const renderState = {
    x: lerpX,
    y: lerpY,
    angle: lerpedAngle,
    thrusting: currentState.thrusting
  };

  drawShip(ctx, renderState);
  drawHud(ctx, loop.getStats());
}

const loop = createLoop({ step: 1 / 60, simulate, render });
loop.start();