export function setupCanvas(id, bounds) {
  const canvas = document.getElementById(id);
  const ctx = canvas.getContext('2d');
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = bounds.width * dpr;
  canvas.height = bounds.height * dpr;
  canvas.style.width = `${bounds.width}px`;
  canvas.style.height = `${bounds.height}px`;
  
  ctx.scale(dpr, dpr);
  
  return { canvas, ctx };
}