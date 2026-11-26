// Backing store = logical size * devicePixelRatio (crisp on HiDPI);
// CSS size = largest box with the arena's aspect ratio that fits the window.
export function setupCanvas(
  id: string,
  bounds: { readonly width: number; readonly height: number },
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.getElementById(id);
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`#${id} is not a <canvas>`);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');

  const dpr = window.devicePixelRatio || 1;
  canvas.width = bounds.width * dpr;
  canvas.height = bounds.height * dpr;
  ctx.scale(dpr, dpr);

  const el = canvas; // narrowed to HTMLCanvasElement; closures below don't re-narrow `canvas`
  function fit(): void {
    const scale = Math.min(window.innerWidth / bounds.width, window.innerHeight / bounds.height);
    const s = scale > 0 ? scale : 1;
    el.style.width = `${Math.floor(bounds.width * s)}px`;
    el.style.height = `${Math.floor(bounds.height * s)}px`;
  }
  fit();
  window.addEventListener('resize', fit);

  return { canvas, ctx };
}
