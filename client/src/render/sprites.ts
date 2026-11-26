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

export function createSprites(image: CanvasImageSource, atlas: Atlas): Sprites {
  const scale = atlas.scale ?? 1; // the sheet is authored at 2x for HiDPI

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
