import { z } from 'zod';

// Sprite sheet = one image + an atlas of named frames (source rectangles).
// drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) copies one frame onto the canvas.
export const AtlasSchema = z.object({
  scale: z.number().positive().default(1),
  frames: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      ax: z.number(),
      ay: z.number(),
      radius: z.number().optional(),
    }),
  ),
});
export type Atlas = z.infer<typeof AtlasSchema>;

export interface Sprites {
  has(name: string): boolean;
  draw(ctx: CanvasRenderingContext2D, name: string, k?: number): void;
  radiusOf(name: string): number | null;
}

/**
 * Lab 7: rasterize the SVG sheet ONCE into a canvas. drawImage() from an SVG <img> makes the browser
 * re-rasterize (sub-)images on draw — the profile's #1 self-time function, and memory outside the
 * JS heap that scales with the number of sprites drawn. From a canvas, drawImage is a plain blit.
 */
function rasterize(image: CanvasImageSource): CanvasImageSource {
  if (!(image instanceof HTMLImageElement) || !image.naturalWidth) return image;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d');
  if (!g) return image;
  g.drawImage(image, 0, 0);
  return canvas;
}

export function createSprites(source: CanvasImageSource, atlas: Atlas): Sprites {
  const scale = atlas.scale ?? 1; // the sheet is authored at 2x for HiDPI
  const image = rasterize(source);

  return {
    has(name) {
      return name in atlas.frames;
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
