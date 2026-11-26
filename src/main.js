import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { bounds } from './sim/arena.js';
import { createGame } from './sim/game.js';
import { setupCanvas } from './render/canvas.js';
import { drawGrid, drawWorld, drawHud } from './render/draw.js';
import { demonstrateThisBug } from './experiments/this-bug.js';

const { ctx } = setupCanvas('gameCanvas', bounds);
const input = createInput(window);
const { world, player } = createGame({ width: bounds.width, height: bounds.height });

// Inputs are plain data keyed by ship id — the same shape the server will receive in Lab 5.
function readControls() {
  return {
    left: input.isDown('KeyA') || input.isDown('ArrowLeft'),
    right: input.isDown('KeyD') || input.isDown('ArrowRight'),
    thrust: input.isDown('KeyW') || input.isDown('ArrowUp'),
    fire: input.isDown('Space'),
  };
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});

function simulate(dt) {
  world.step(dt, new Map([[player.id, readControls()]]));
  input.consume();
}

let renderTime = 0;
function render(alpha) {
  renderTime = performance.now() / 1000;
  ctx.clearRect(0, 0, bounds.width, bounds.height);
  drawGrid(ctx, bounds.width, bounds.height);
  drawWorld(ctx, world, alpha, renderTime);
  drawHud(ctx, { stats: loop.getStats(), world, player, ...bounds });
}

const loop = createLoop({ step: 1 / 60, simulate, render });
loop.start();

// Dev-only handles for console experiments at the defense (prototype chain, `this`, Map).
if (import.meta.env.DEV) {
  window.game = { world, player };
  if (new URLSearchParams(location.search).get('demo') === 'this')
    demonstrateThisBug(player, world);
}
