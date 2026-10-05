'use strict';

/* Pure image processing: shared by the page (sync fallback + tests) and
   by enhance-worker.js (importScripts), so there is exactly one copy of
   the pipeline. No DOM access allowed in here. */

/* ---------- filters ---------- */

let _pool = null;
let _strip = null;
let _rowTmp = null;
const STRIP_H = 160;

function poolFor(w, h) {
  const n = w * h * 4;
  if (!_pool || _pool.length < n) _pool = new Float32Array(n);
  return _pool;
}

/* Separable box blur. Rows are processed in horizontal strips so the
   vertical pass streams sequentially (a full-image vertical pass jumps
   between distant cache lines) and the result stays in float, so nothing
   gets converted to bytes between filter stages. Intermediate iteration
   results live in a strip-sized buffer, which keeps the final output
   buffer untouched for rows the neighbouring strips already finished. */
let _mid = null;

function blurRGB(src, w, h, r, iterations, dst) {
  const rs = w * 4;
  if (r < 1) {
    for (let i = 0; i < w * h; i++) {
      dst[i * 4] = src[i * 4];
      dst[i * 4 + 1] = src[i * 4 + 1];
      dst[i * 4 + 2] = src[i * 4 + 2];
    }
    return dst;
  }
  const inv = 1 / (r * 2 + 1);
  const halo = r * iterations;
  const growMax = r * (iterations - 1);
  const need = (STRIP_H + 2 * halo + 2) * rs;
  if (!_strip || _strip.length < need) _strip = new Float32Array(need);
  if (!_rowTmp || _rowTmp.length < rs) _rowTmp = new Float32Array(rs);
  const midRows = STRIP_H + 2 * growMax + 2;
  if (iterations > 1 && (!_mid || _mid.length < midRows * rs)) {
    _mid = new Float32Array(midRows * rs);
  }
  const strip = _strip;
  const rowTmp = _rowTmp;
  const mid = _mid;
  const hA = r + 1;
  const hB = w - r - 1;
  const leftEnd = Math.min(hA, w);
  const rightStart = Math.max(hA, w - r);

  for (let y0 = 0; y0 < h; y0 += STRIP_H) {
    const y1 = Math.min(h, y0 + STRIP_H);
    const stripLo = Math.max(0, y0 - halo);
    const midLo = Math.max(0, y0 - growMax);

    for (let it = 0; it < iterations; it++) {
      const last = it === iterations - 1;
      const grow = growMax - r * it;
      const lo = Math.max(0, y0 - grow);
      const hi = Math.min(h, y1 + grow);
      const hLo = Math.max(0, lo - r);
      const hHi = Math.min(h, hi + r);

      /* horizontal: input rows [hLo,hHi) -> strip */
      for (let y = hLo; y < hHi; y++) {
        const row = y * rs;
        for (let i = 0; i < rs; i += 4) {
          if (it === 0) {
            rowTmp[i] = src[row + i];
            rowTmp[i + 1] = src[row + i + 1];
            rowTmp[i + 2] = src[row + i + 2];
          } else {
            const m = (y - midLo) * rs + i;
            rowTmp[i] = mid[m];
            rowTmp[i + 1] = mid[m + 1];
            rowTmp[i + 2] = mid[m + 2];
          }
        }
        const o = (y - stripLo) * rs;

        for (let x = 0; x < leftEnd; x++) {
          const oi = o + x * 4;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) {
              const idx = x + k;
              const xx = idx < 0 ? 0 : (idx >= w ? w - 1 : idx);
              sum += rowTmp[xx * 4 + c];
            }
            strip[oi + c] = sum * inv;
          }
        }

        let s0 = 0, s1 = 0, s2 = 0;
        for (let k = -r; k <= r; k++) {
          const idx = hA + k;
          const xx = idx < 0 ? 0 : (idx >= w ? w - 1 : idx);
          const j = xx * 4;
          s0 += rowTmp[j]; s1 += rowTmp[j + 1]; s2 += rowTmp[j + 2];
        }
        for (let x = hA; x <= hB; x++) {
          const oi = o + x * 4;
          strip[oi] = s0 * inv;
          strip[oi + 1] = s1 * inv;
          strip[oi + 2] = s2 * inv;
          if (x === hB) break;
          const ai = (x + r + 1) * 4;
          const ri = (x - r) * 4;
          s0 += rowTmp[ai] - rowTmp[ri];
          s1 += rowTmp[ai + 1] - rowTmp[ri + 1];
          s2 += rowTmp[ai + 2] - rowTmp[ri + 2];
        }

        for (let x = rightStart; x < w; x++) {
          const oi = o + x * 4;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) {
              const idx = x + k;
              const xx = idx < 0 ? 0 : (idx >= w ? w - 1 : idx);
              sum += rowTmp[xx * 4 + c];
            }
            strip[oi + c] = sum * inv;
          }
        }
      }

      /* vertical: strip -> dst (final pass) or mid (intermediate pass) */
      const out = last ? dst : mid;
      const off = last ? 0 : -midLo;
      const up = r * rs;
      const down = (r + 1) * rs;
      for (let y = lo; y < hi; y++) {
        const row = y * rs;
        const o = (y - stripLo) * rs;
        const oi = (y + off) * rs;
        const pRow = (y - 1 + off) * rs;
        if (y > lo && y - r - 1 >= 0 && y + r <= h - 1) {
          for (let x = 0; x < w; x++) {
            const i = row + x * 4;
            const j = o + x * 4;
            const q = oi + x * 4;
            out[q] = out[pRow + x * 4] + (strip[j + up] - strip[j - down]) * inv;
            out[q + 1] = out[pRow + x * 4 + 1] + (strip[j + 1 + up] - strip[j + 1 - down]) * inv;
            out[q + 2] = out[pRow + x * 4 + 2] + (strip[j + 2 + up] - strip[j + 2 - down]) * inv;
          }
        } else {
          for (let x = 0; x < w; x++) {
            const i = row + x * 4;
            const o2 = o + x * 4;
            let a0 = 0, a1 = 0, a2 = 0;
            for (let k = -r; k <= r; k++) {
              const idx = y + k;
              const yy = idx < 0 ? 0 : (idx >= h ? h - 1 : idx);
              const jj = (yy - stripLo) * rs + x * 4;
              a0 += strip[jj]; a1 += strip[jj + 1]; a2 += strip[jj + 2];
            }
            const q = oi + x * 4;
            out[q] = a0 * inv;
            out[q + 1] = a1 * inv;
            out[q + 2] = a2 * inv;
          }
        }
      }
    }
  }
  return dst;
}

function applyDenoise(data, w, h, amount) {
  const r = Math.max(1, 1 + Math.round(amount / 25));
  const k = Math.min(1, amount / 55);
  const sigma = 26;
  const inv = 1 / (2 * sigma * sigma);
  const passes = amount >= 45 ? 2 : 1;
  const mean = poolFor(w, h);
  if (k <= 0) {
    blurRGB(data, w, h, 1, 1, mean);
    return mean;
  }
  for (let p = 0; p < passes; p++) {
    blurRGB(data, w, h, r, 2, mean);
    for (let i = 0; i < data.length; i += 4) {
      const d0 = data[i] - mean[i];
      const d1 = data[i + 1] - mean[i + 1];
      const d2 = data[i + 2] - mean[i + 2];
      const g = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) * inv) * k;
      data[i] += g * (mean[i] - data[i]);
      data[i + 1] += g * (mean[i + 1] - data[i + 1]);
      data[i + 2] += g * (mean[i + 2] - data[i + 2]);
    }
  }
  return mean;
}

/* Clamps isolated pixels that deviate too far from their neighbourhood,
   removing the speckles the bilateral pass leaves behind. The limit
   tightens as the neighbourhood gets flatter: in flat areas a big
   deviation is always noise, so it is replaced outright; near texture
   the clamp loosens to protect real detail. */
function applyOutlierClamp(data, w, h, sigma, mean) {
  sigma = Math.max(1, sigma);
  const limTight = 1.5 * sigma;
  const limLoose = 2.6 * sigma;
  const skip2 = (3.4 * sigma) * (3.4 * sigma);
  const rs = w * 4;
  for (let y = 1; y < h - 1; y++) {
    const row = y * rs;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x * 4;
      const g0 = mean[i + 4] - mean[i - 4];
      const g1 = mean[i + 4 + 1] - mean[i - 4 + 1];
      const g2 = mean[i + 4 + 2] - mean[i - 4 + 2];
      const g3 = mean[i + rs] - mean[i - rs];
      const g4 = mean[i + rs + 1] - mean[i - rs + 1];
      const g5 = mean[i + rs + 2] - mean[i - rs + 2];
      const mag2 = g0 * g0 + g1 * g1 + g2 * g2 + g3 * g3 + g4 * g4 + g5 * g5;
      if (mag2 > skip2) continue;
      const flat = 1 - mag2 / skip2;
      const lim = limLoose - (limLoose - limTight) * flat;
      const hard = flat > 0.6;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        const m = mean[i + c];
        const dev = v - m;
        if (dev < -limLoose) data[i + c] = hard ? m : m - lim;
        else if (dev > limLoose) data[i + c] = hard ? m : m + lim;
        else if (dev < -lim) data[i + c] = m - lim;
        else if (dev > lim) data[i + c] = m + lim;
      }
    }
  }
}

/* Edge-aware unsharp mask: flat/noisy areas are barely sharpened,
   real edges and details get the full amount. */
function applyUnsharp(data, w, h, radius, amount, iterations, gate) {
  if (amount <= 0) return;
  const blurred = poolFor(w, h);
  blurRGB(data, w, h, radius, iterations, blurred);
  for (let i = 0; i < data.length; i += 4) {
    const d0 = data[i] - blurred[i];
    const d1 = data[i + 1] - blurred[i + 1];
    const d2 = data[i + 2] - blurred[i + 2];
    const mag = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
    const t = mag / (mag + gate);
    const a = amount * t * t;
    data[i] += a * d0;
    data[i + 1] += a * d1;
    data[i + 2] += a * d2;
  }
}

/* Robust noise level estimate: median absolute deviation of the
   high-frequency response. The 3x3 mean is evaluated only at sampled
   points, so big images don't pay for a full blur pass. */
function estimateNoise(data, w, h) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 15000)));
  const rs = w * 4;
  const mags = [];
  for (let y = 1; y < h - 1; y += step) {
    const row = y * rs;
    for (let x = 1; x < w - 1; x += step) {
      const i = row + x * 4;
      let s0 = 0, s1 = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const rr = i + dy * rs;
        s0 += data[rr - 4] + data[rr] + data[rr + 4];
        s1 += data[rr - 3] + data[rr + 1] + data[rr + 5];
        s2 += data[rr - 2] + data[rr + 2] + data[rr + 6];
      }
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const lb = (0.2126 * s0 + 0.7152 * s1 + 0.0722 * s2) / 9;
      mags.push(Math.abs(l - lb));
    }
  }
  mags.sort((a, b) => a - b);
  return (mags[Math.floor(mags.length / 2)] || 0) / 0.6745;
}

function applyColor(data, contrast, saturation) {
  if (contrast === 0 && saturation === 0) return;
  const ck = 1 + contrast * 0.006;
  const sk = 1 + saturation * 0.011;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (ck !== 1) {
      r = (r - 128) * ck + 128;
      g = (g - 128) * ck + 128;
      b = (b - 128) * ck + 128;
    }
    if (sk !== 1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * sk;
      g = lum + (g - lum) * sk;
      b = lum + (b - lum) * sk;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

function enhance(base, p, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : null;
  const w = base.width;
  const h = base.height;
  const data = new Uint8ClampedArray(base.data);
  if (report) report(2);
  const noise = estimateNoise(base.data, w, h);
  if (report) report(10);
  // scale denoise with how noisy the image actually is, so clean photos stay crisp
  const denoise = p.denoise * Math.min(1, noise / 5);

  if (denoise > 0) {
    const mean = applyDenoise(data, w, h, denoise);
    if (report) report(46);
    applyOutlierClamp(data, w, h, noise, mean);
    if (report) report(56);
  } else if (report) {
    report(56);
  }
  if (p.clarity > 0) {
    const r = Math.max(2, Math.round(3 + p.clarity / 100 * 9));
    applyUnsharp(data, w, h, r, (p.clarity / 100) * 0.75, 1, 6 + noise * 3);
  }
  if (report) report(76);
  if (p.sharpen > 0) applyUnsharp(data, w, h, 1, (p.sharpen / 100) * 1.3, 1, 4 + noise * 3.2);
  if (report) report(94);
  applyColor(data, p.contrast, p.saturation);
  if (report) report(100);

  return new ImageData(data, w, h);
}


/* ---------- size helpers ---------- */

const MAX_DIM = 6000;
const MAX_PX = 12e6;
const PREVIEW_MAX = 1280;

function clampDims(w, h) {
  w = Math.round(w);
  h = Math.round(h);
  let clamped = false;
  if (w > MAX_DIM || h > MAX_DIM) {
    const f = MAX_DIM / Math.max(w, h);
    w = Math.round(w * f);
    h = Math.round(h * f);
    clamped = true;
  }
  if (w * h > MAX_PX) {
    const f = Math.sqrt(MAX_PX / (w * h));
    w = Math.round(w * f);
    h = Math.round(h * f);
    clamped = true;
  }
  return [w, h, clamped];
}

function previewDims(w, h) {
  const m = Math.max(w, h);
  if (m <= PREVIEW_MAX) return [w, h];
  const f = PREVIEW_MAX / m;
  return [Math.round(w * f), Math.round(h * f)];
}

/* ---------- resample ---------- */

/* Downscales with an area box (sampleCap > 0 limits samples per axis to
   keep previews cheap). Full-quality upscales use Lanczos3, clamped to a
   bilinear reference within +/-8 levels so kernel ringing cannot be
   amplified into visible white halos by the unsharp passes. Preview
   upscales stay plain bilinear for speed. */
function resample(src, sw, sh, dw, dh, sampleCap, useLanczos) {
  if (sw === dw && sh === dh) return src;
  if (dw <= sw && dh <= sh) return boxDown(src, sw, sh, dw, dh, sampleCap);
  if (!useLanczos) return bilinearUp(src, sw, sh, dw, dh);
  const out = lanczosResample(src, sw, sh, dw, dh);
  const ref = bilinearUp(src, sw, sh, dw, dh);
  const E = 8;
  for (let i = 0; i < out.length; i++) {
    const r = ref[i];
    const lo = r - E;
    const hi = r + E;
    if (out[i] < lo) out[i] = lo;
    else if (out[i] > hi) out[i] = hi;
  }
  return out;
}

function boxDown(src, sw, sh, dw, dh, sampleCap) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yr)));
    const yStep = sampleCap ? Math.max(1, Math.floor((y1 - y0) / sampleCap)) : 1;
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xr)));
      const xStep = sampleCap ? Math.max(1, Math.floor((x1 - x0) / sampleCap)) : 1;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
      for (let yy = y0; yy < y1; yy += yStep) {
        const row = yy * sw * 4;
        for (let xx = x0; xx < x1; xx += xStep) {
          const i = row + xx * 4;
          s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; s3 += src[i + 3];
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n; out[o + 3] = s3 / n;
    }
  }
  return out;
}

function bilinearUp(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
    const ay = Math.floor(sy);
    const by = Math.min(sh - 1, ay + 1);
    const fy = sy - ay;
    const rowA = ay * sw * 4;
    const rowB = by * sw * 4;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
      const ax = Math.floor(sx);
      const bx = Math.min(sw - 1, ax + 1);
      const fx = sx - ax;
      const ia = rowA + ax * 4, ib = rowA + bx * 4;
      const ic = rowB + ax * 4, id = rowB + bx * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[ia + c] * (1 - fx) + src[ib + c] * fx;
        const bot = src[ic + c] * (1 - fx) + src[id + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return out;
}

function lanczos3(t) {
  t = Math.abs(t);
  if (t < 1e-9) return 1;
  if (t >= 3) return 0;
  const pt = Math.PI * t;
  return (3 * Math.sin(pt) * Math.sin(pt / 3)) / (pt * pt);
}

/* Lanczos-3 upscale: separable, with per-output-coordinate weights
   precomputed once (kernel widened to max(1, scale) on each axis) and
   horizontally-filtered source rows kept in a small sliding window so
   the horizontal pass runs exactly once per source row. */
function lanczosResample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  const kx = Math.max(1, xr);
  const ky = Math.max(1, yr);
  const rx = Math.ceil(3 * kx);
  const ry = Math.ceil(3 * ky);

  const buildWeights = (n, srcN, scale, r) => {
    const start = new Int32Array(n);
    const count = new Int32Array(n);
    const norm = new Float32Array(n);
    const ws = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) * scale - 0.5;
      const a = Math.max(0, Math.ceil(c - r));
      const b = Math.min(srcN - 1, Math.floor(c + r));
      const w = new Float32Array(b - a + 1);
      let sum = 0;
      for (let j = a; j <= b; j++) {
        const v = lanczos3((j - c) / scale);
        w[j - a] = v;
        sum += v;
      }
      start[i] = a;
      count[i] = b - a + 1;
      norm[i] = sum || 1;
      ws[i] = w;
    }
    return { start, count, norm, ws };
  };

  const hx = buildWeights(dw, sw, xr, rx);
  const hy = buildWeights(dh, sh, yr, ry);

  const winH = 2 * ry + 2;
  const win = new Float32Array(winH * dw * 4);
  const winRow = new Int32Array(winH).fill(-1);
  const hRow = (s) => {
    const slot = s % winH;
    if (winRow[slot] === s) return slot;
    winRow[slot] = s;
    const base = s * sw * 4;
    const o = slot * dw * 4;
    for (let x = 0; x < dw; x++) {
      const a = hx.start[x];
      const w = hx.ws[x];
      const cnt = hx.count[x];
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = 0; j < cnt; j++) {
        const i = base + (a + j) * 4;
        const v = w[j];
        s0 += src[i] * v; s1 += src[i + 1] * v;
        s2 += src[i + 2] * v; s3 += src[i + 3] * v;
      }
      const invN = 1 / hx.norm[x];
      win[o + x * 4] = s0 * invN;
      win[o + x * 4 + 1] = s1 * invN;
      win[o + x * 4 + 2] = s2 * invN;
      win[o + x * 4 + 3] = s3 * invN;
    }
    return slot;
  };

  for (let y = 0; y < dh; y++) {
    const w = hy.ws[y];
    const a0 = hy.start[y];
    const cnt = hy.count[y];
    const invN = 1 / hy.norm[y];
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = 0; j < cnt; j++) {
        const slot = hRow(a0 + j);
        const v = w[j];
        const i = slot * dw * 4 + x * 4;
        s0 += win[i] * v; s1 += win[i + 1] * v;
        s2 += win[i + 2] * v; s3 += win[i + 3] * v;
      }
      out[o] = s0 * invN; out[o + 1] = s1 * invN;
      out[o + 2] = s2 * invN; out[o + 3] = s3 * invN;
    }
  }
  return out;
}
