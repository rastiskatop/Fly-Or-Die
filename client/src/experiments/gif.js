// Minimal GIF89a encoder: fixed 6×7×6 colour palette, LZW, infinite loop.
// Used by duel.html to record the README GIF (no dependencies).
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function encodeGif(frames, w, h, delayCs) {
  const out = [];
  const byte = (b) => out.push(b & 0xff);
  const word = (v) => {
    byte(v);
    byte(v >> 8);
  };
  const str = (s) => [...s].forEach((c) => byte(c.charCodeAt(0)));
  str('GIF89a');
  word(w);
  word(h);
  byte(0xf7); // global color table, 8 bits, 256 entries
  byte(0);
  byte(0);
  for (let i = 0; i < 256; i++) {
    if (i < 252) {
      const r = Math.floor(i / 42);
      const gg = Math.floor((i % 42) / 6);
      const b = i % 6;
      byte(Math.round((r * 255) / 5));
      byte(Math.round((gg * 255) / 6));
      byte(Math.round((b * 255) / 5));
    } else str('\0\0\0');
  }
  byte(0x21); // loop forever
  byte(0xff);
  byte(11);
  str('NETSCAPE2.0');
  byte(3);
  byte(1);
  word(0);
  byte(0);
  const indices = new Uint8Array(w * h);
  for (const frame of frames) {
    const d = frame.data;
    for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
      // ordered (Bayer 4×4) dithering: trades banding for a fine, even pattern
      const t = BAYER[((p / w) & 3) * 4 + ((p % w) & 3)] / 16 - 0.5;
      const r = Math.min(5, Math.max(0, Math.round((d[i] + t * 51) / 51)));
      const g = Math.min(6, Math.max(0, Math.round((d[i + 1] + t * 42.5) / 42.5)));
      const b = Math.min(5, Math.max(0, Math.round((d[i + 2] + t * 51) / 51)));
      indices[p] = r * 42 + g * 6 + b;
    }
    byte(0x21);
    byte(0xf9);
    byte(4);
    byte(0);
    word(delayCs);
    byte(0);
    byte(0);
    byte(0x2c);
    word(0);
    word(0);
    word(w);
    word(h);
    byte(0);
    byte(8); // LZW minimum code size
    const data = lzw(indices, 8);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      byte(n);
      for (let k = 0; k < n; k++) out.push(data[i + k]);
    }
    byte(0);
  }
  byte(0x3b);
  return new Uint8Array(out);
}

function lzw(pixels, minSize) {
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let size = minSize + 1;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  };
  let dict = new Map();
  let next = eoi + 1;
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) bytes.push(acc & 0xff);
  return bytes;
}
