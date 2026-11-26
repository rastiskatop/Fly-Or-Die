// Sprite sheet = one image + an atlas of named frames (source rectangles).
// drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) copies one frame onto the canvas.
export function createSprites(image, atlas) {
  const scale = atlas.scale ?? 1; // the sheet is authored at 2x for HiDPI

  return {
    has(name) {
      return name in atlas.frames;
    },
    frame(name) {
      return atlas.frames[name];
    },
    /** Draws a frame centred on its anchor at the current origin; k = extra uniform scale. */
    draw(ctx, name, k = 1) {
      const f = atlas.frames[name];
      if (!f) return;
      const s = k / scale;
      ctx.drawImage(image, f.x, f.y, f.w, f.h, -f.ax * s, -f.ay * s, f.w * s, f.h * s);
    },
    /** Logical (1x) radius a frame was drawn with, for scaling rocks/pickups to entity.radius. */
    radiusOf(name) {
      const f = atlas.frames[name];
      return f?.radius ? f.radius / scale : null;
    },
  };
}
