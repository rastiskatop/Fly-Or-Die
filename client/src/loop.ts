export interface LoopStats {
  fps: number;
  ups: number;
  frameTime: number;
}

export interface Loop {
  start(): void;
  stop(): void;
  getStats(): Readonly<LoopStats>;
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
}: {
  step?: number;
  simulate: (dt: number) => void;
  render: (alpha: number) => void;
}): Loop {
  let last = performance.now();
  let accumulator = 0;
  let rafId = 0;

  let frames = 0;
  let steps = 0;
  let lastFpsTime = last;

  const stats: LoopStats = { fps: 0, ups: 0, frameTime: 0 };

  function frame(now: number): void {
    stats.frameTime = now - last;
    const dt = (now - last) / 1000;
    last = now;

    accumulator += Math.min(dt, 0.25);

    while (accumulator >= step) {
      simulate(step);
      accumulator -= step;
      steps++;
    }

    render(accumulator / step);
    frames++;

    if (now - lastFpsTime >= 1000) {
      stats.fps = frames;
      stats.ups = steps;
      frames = 0;
      steps = 0;
      lastFpsTime = now;
    }

    rafId = requestAnimationFrame(frame);
  }

  return {
    start: () => {
      last = performance.now();
      lastFpsTime = last;
      rafId = requestAnimationFrame(frame);
    },
    stop: () => cancelAnimationFrame(rafId),
    getStats: () => stats,
  };
}
