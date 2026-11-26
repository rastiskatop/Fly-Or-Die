// Backing store = logical size * devicePixelRatio (crisp on HiDPI);
// CSS size = largest box with the arena's aspect ratio that fits the window.
export function setupCanvas(id, bounds) {
  const canvas = document.getElementById(id);
  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  canvas.width = bounds.width * dpr;
  canvas.height = bounds.height * dpr;
  ctx.scale(dpr, dpr);

  function fit() {
    const scale = Math.min(window.innerWidth / bounds.width, window.innerHeight / bounds.height);
    const s = scale > 0 ? scale : 1;
    canvas.style.width = `${Math.floor(bounds.width * s)}px`;
    canvas.style.height = `${Math.floor(bounds.height * s)}px`;
  }
  fit();
  window.addEventListener('resize', fit);

  return { canvas, ctx };
}
