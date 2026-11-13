/*
 * detmath.js — engine-independent replacements for the transcendental Math functions the game's logic uses.
 *
 * Why: Math.sin, cos, atan2, exp, pow, ... are implementation-defined in JavaScript. Node 22 (V8 12.4) and current
 * Chromium return results that differ in the last bit, so the same seed and inputs drift apart between the
 * headless run and a browser. +, -, *, / and Math.sqrt are exactly specified (IEEE 754, no fused multiply-add
 * in JS), so functions built only from those give bit-identical results on every engine.
 *
 * The kernels follow the classic fdlibm algorithms (argument reduction plus polynomial). They are accurate to
 * about one unit in the last place for the ranges a game uses; correct rounding is not the goal, identical
 * results everywhere is.
 *
 * No Node dependencies: CommonJS module in Node, global `BotaDetMath` in a browser page.
 * Installed by default since 2026-11-13 (loader option `detMath`, see docs/phase0-results.md §2).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotaDetMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);   // little-endian: u32[0] = low word, u32[1] = high word
  const sqrt = Math.sqrt, abs = Math.abs, round = Math.round;   // exactly specified, safe to use

  // ---- sin / cos -----------------------------------------------------------
  const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
    S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
    C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  const PIO4 = 7.85398163397448278999e-01, INV_PIO2 = 6.36619772367581382433e-01;
  // pi/2 split into three parts; the first two have 33 significant bits, so k * part is exact for |k| < 2^20
  const PIO2_1 = 1.57079632673412561417e+00, PIO2_2 = 6.07710050630396597660e-11, PIO2_3 = 2.02226624879595063154e-21;
  const TWO_PI = 6.283185307179586, REDUCE_MAX = 1.0e6;

  function kSin(x) { const z = x * x, v = z * x; return x + v * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))); }
  function kCos(x) { const z = x * x; return 1 - (0.5 * z - z * (z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))))); }

  let quadrant = 0;
  /** Reduce x to y in [-pi/4, pi/4] with x = y + quadrant * pi/2 */
  function reduce(x) {
    if (abs(x) > REDUCE_MAX) x %= TWO_PI;   // far outside any game angle: deterministic, reduced accuracy
    const k = round(x * INV_PIO2);
    quadrant = k & 3;
    return ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  }

  function sin(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    if (abs(x) <= PIO4) return abs(x) < 7.450580596923828e-9 ? x : kSin(x);   // below 2^-27 sin(x) = x; keeps -0
    const y = reduce(x);
    switch (quadrant) { case 0: return kSin(y); case 1: return kCos(y); case 2: return -kSin(y); default: return -kCos(y); }
  }

  function cos(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    if (abs(x) <= PIO4) return kCos(x);
    const y = reduce(x);
    switch (quadrant) { case 0: return kCos(y); case 1: return -kSin(y); case 2: return -kCos(y); default: return kSin(y); }
  }

  function tan(x) { return sin(x) / cos(x); }

  // ---- atan / atan2 / acos / asin -----------------------------------------
  const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
  const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
  const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
    9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
    4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
  const PI = 3.14159265358979311600e+00, PI_LO = 1.2246467991473531772e-16, PIO2 = 1.57079632679489655800e+00;

  function atan(x) {
    x = +x;
    if (x !== x) return NaN;
    const neg = x < 0 || (x === 0 && 1 / x < 0);
    let a = abs(x), id;
    if (a >= 7.378697629483821e19) return neg ? -PIO2 : PIO2;   // 2^66 and beyond, infinities included
    if (a < 0.4375) {
      if (a < 3.725290298461914e-9) return x;                    // 2^-28: atan(x) = x to double precision
      id = -1;
    } else if (a < 1.1875) {
      if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); }
    } else if (a < 2.4375) { id = 2; a = (a - 1.5) / (1 + 1.5 * a); } else { id = 3; a = -1 / a; }
    const z = a * a, w = z * z;
    const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    const r = id < 0 ? a - a * (s1 + s2) : ATAN_HI[id] - ((a * (s1 + s2) - ATAN_LO[id]) - a);
    return neg ? -r : r;
  }

  function atan2(y, x) {
    y = +y; x = +x;
    if (x !== x || y !== y) return NaN;
    const xNeg = x < 0 || (x === 0 && 1 / x < 0), yNeg = y < 0 || (y === 0 && 1 / y < 0);
    if (y === 0) return xNeg ? (yNeg ? -PI : PI) : y;
    if (x === 0) return yNeg ? -PIO2 : PIO2;
    const xInf = x === Infinity || x === -Infinity, yInf = y === Infinity || y === -Infinity;
    if (xInf) {
      if (yInf) { const v = xNeg ? 3 * PIO4 : PIO4; return yNeg ? -v : v; }
      return xNeg ? (yNeg ? -PI : PI) : (yNeg ? -0 : 0);
    }
    if (yInf) return yNeg ? -PIO2 : PIO2;
    const z = atan(abs(y / x));
    if (!xNeg) return yNeg ? -z : z;
    return yNeg ? (z - PI_LO) - PI : PI - (z - PI_LO);
  }

  function acos(x) { x = +x; return x !== x || x > 1 || x < -1 ? NaN : atan2(sqrt((1 - x) * (1 + x)), x); }
  function asin(x) { x = +x; return x !== x || x > 1 || x < -1 ? NaN : atan2(x, sqrt((1 - x) * (1 + x))); }

  // ---- exp / log / pow -----------------------------------------------------
  const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
  const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
    P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
  const EXP_MAX = 7.09782712893383973096e+02, EXP_MIN = -7.45133219101941108420e+02;
  const TWO_M54 = 5.55111512312578270212e-17, TWO_54 = 1.80143985094819840000e+16;

  /** 2^k for -1022 <= k <= 1023, built from the bit pattern (exact) */
  function pow2(k) { u32[0] = 0; u32[1] = (k + 1023) << 20; return f64[0]; }
  function scale(y, k) {
    if (k > 1023) return y * 2 * pow2(k - 1);
    if (k < -1022) return y * pow2(k + 54) * TWO_M54;
    return y * pow2(k);
  }

  function exp(x) {
    x = +x;
    if (x !== x) return NaN;
    if (x > EXP_MAX) return Infinity;
    if (x < EXP_MIN) return 0;
    const a = abs(x);
    let k = 0, hi = x, lo = 0, r = x;
    if (a > 0.34657359027997264) {           // 0.5 * ln2
      if (a < 1.0397207708399179) k = x > 0 ? 1 : -1;   // 1.5 * ln2
      else k = (INV_LN2 * x + (x > 0 ? 0.5 : -0.5)) | 0;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
      r = hi - lo;
    } else if (a < 3.725290298461914e-9) {
      return 1 + x;
    }
    const t = r * r;
    const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k === 0) return 1 - ((r * c) / (c - 2) - r);
    return scale(1 - ((lo - (r * c) / (2 - c)) - hi), k);
  }

  const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01,
    LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;

  function log(x) {
    x = +x;
    if (x !== x || x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    let k = 0;
    f64[0] = x;
    let hx = u32[1];
    if (hx < 0x00100000) { f64[0] = x * TWO_54; hx = u32[1]; k = -54; }   // subnormal
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    const i = (hx + 0x95f64) & 0x100000;
    u32[1] = hx | (i ^ 0x3ff00000);          // normalise to [sqrt(2)/2, sqrt(2))
    k += i >> 20;
    const f = f64[0] - 1;
    const s = f / (2 + f), z = s * s, w = z * z;
    const t1 = w * (LG2 + w * (LG4 + w * LG6));
    const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    const R = t2 + t1;
    if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
      const hfsq = 0.5 * f * f;
      return k === 0 ? f - (hfsq - s * (hfsq + R)) : k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
    }
    return k === 0 ? f - s * (f - R) : k * LN2_HI - ((s * (f - R) - k * LN2_LO) - f);
  }

  function pow(x, y) {
    x = +x; y = +y;
    if (y === 0) return 1;
    if (x !== x || y !== y) return NaN;
    if (y === 1) return x;
    const yInt = y === Math.floor(y) && abs(y) < 9007199254740992;
    if (yInt && abs(y) <= 64) {              // small integer powers: repeated multiplication
      let n = abs(y), base = x, acc = 1;
      while (n > 0) { if (n & 1) acc *= base; base *= base; n >>>= 1; }
      return y < 0 ? 1 / acc : acc;
    }
    if (y === 0.5 && x >= 0) return sqrt(x) + 0;
    if (y === Infinity || y === -Infinity) {
      const a = abs(x);
      if (a === 1) return NaN;
      return (a > 1) === (y > 0) ? Infinity : 0;
    }
    if (x === 0) return y > 0 ? 0 : Infinity;
    if (x < 0) {
      if (!yInt) return NaN;
      const v = exp(y * log(-x));
      return (y / 2) !== Math.floor(y / 2) ? -v : v;
    }
    return exp(y * log(x));
  }

  // ---- hypot ---------------------------------------------------------------
  // Math.hypot is implementation-defined too. sqrt(sum of squares) is exact arithmetic plus an exact sqrt.
  function hypot(x, y) {
    const n = arguments.length;
    if (n === 2) {
      x = +x; y = +y;
      if (x === Infinity || x === -Infinity || y === Infinity || y === -Infinity) return Infinity;
      return sqrt(x * x + y * y);
    }
    let sum = 0, inf = false;
    for (let i = 0; i < n; i++) {
      const v = +arguments[i];
      if (v === Infinity || v === -Infinity) inf = true;
      sum += v * v;
    }
    return inf ? Infinity : sqrt(sum);
  }

  const functions = { sin, cos, tan, atan, atan2, acos, asin, exp, log, pow, hypot };

  /** Replace the functions on a Math object. Returns a function that restores the originals. */
  function install(mathObject) {
    const target = mathObject || Math;
    const saved = {};
    for (const name of Object.keys(functions)) { saved[name] = target[name]; target[name] = functions[name]; }
    target.botaDetMath = true;
    return function uninstall() {
      for (const name of Object.keys(saved)) target[name] = saved[name];
      delete target.botaDetMath;
    };
  }

  return Object.assign({ install }, functions);
});
