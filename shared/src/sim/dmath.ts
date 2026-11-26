// Deterministic trigonometry for the shared simulation.
//
// WHY: ECMAScript does not specify the exact bits of Math.sin/cos/atan2/exp — engines may differ.
// Measured in Lab 5: Chrome 156 and Node 24 (V8 13.6) return DIFFERENT bits for sin, cos, atan2
// and exp on the same inputs (pow, sqrt, hypot, round matched). The server runs Node, the client's
// prediction runs Chrome: same inputs → slightly different ships → constant small corrections,
// and a determinism hash that doesn't match across runtimes.
//
// HOW: these functions use only +, −, ×, ÷, Math.round and Math.abs, which IEEE-754 / ECMAScript
// define exactly. Polynomials and constants are fdlibm's (the classic Sun libm), so accuracy is
// within ~1 ulp — but, more importantly, the result is bit-identical in every engine.

const PIO2_HI = 1.57079632673412561417; // π/2 split in two for an accurate reduction
const PIO2_LO = 6.07710050650619224932e-11;
const INV_PIO2 = 6.36619772367581382433e-1;

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function kSin(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function kCos(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** x = q·(π/2) + r, |r| ≤ π/4 (for the angles a game uses; not for |x| ≫ 1e6). */
/** x = q·(π/2) + r — returns [q mod 4, r]. */
function reduce(x: number): readonly [quadrant: number, rest: number] {
  const q = Math.round(x * INV_PIO2);
  const r = x - q * PIO2_HI - q * PIO2_LO;
  return [((q % 4) + 4) % 4, r];
}

export function dsin(x: number): number {
  const [q, r] = reduce(x);
  switch (q) {
    case 0:
      return kSin(r);
    case 1:
      return kCos(r);
    case 2:
      return -kSin(r);
    default:
      return -kCos(r);
  }
}

export function dcos(x: number): number {
  const [q, r] = reduce(x);
  switch (q) {
    case 0:
      return kCos(r);
    case 1:
      return -kSin(r);
    case 2:
      return -kCos(r);
    default:
      return kSin(r);
  }
}

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
] as const;
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
] as const;
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1,
  -1.1111110405462355788e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2,
  -3.6531572744216915527e-2, 1.62858201153657823623e-2,
] as const;

export function datan(x: number): number {
  const neg = x < 0;
  let a = Math.abs(x);
  if (a >= 7.3786976294838206464e19) return neg ? -ATAN_HI[3] : ATAN_HI[3];
  let id: number;
  if (a < 0.4375) {
    if (a < 1.862645149230957e-9) return x;
    id = -1;
  } else if (a < 1.1875) {
    if (a < 0.6875) {
      id = 0;
      a = (2 * a - 1) / (2 + a);
    } else {
      id = 1;
      a = (a - 1) / (a + 1);
    }
  } else if (a < 2.4375) {
    id = 2;
    a = (a - 1.5) / (1 + 1.5 * a);
  } else {
    id = 3;
    a = -1 / a;
  }
  const z = a * a;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = (ATAN_HI[id] ?? 0) - (a * (s1 + s2) - (ATAN_LO[id] ?? 0) - a);
  return neg ? -r : r;
}

const PI = 3.141592653589793116;

export function datan2(y: number, x: number): number {
  if (x === 0) return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : 0;
  if (y === 0) return x > 0 ? 0 : y === 0 && Object.is(y, -0) ? -PI : PI;
  const a = datan(Math.abs(y / x));
  if (x > 0) return y > 0 ? a : -a;
  return y > 0 ? PI - a : -(PI - a);
}
