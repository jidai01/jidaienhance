'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  btnPick: $('btnPick'),
  btnDownload: $('btnDownload'),
  btnAuto: $('btnAuto'),
  btnReset: $('btnReset'),
  btnCopy: $('btnCopy'),
  compare: $('compare'),
  frame: $('frame'),
  handle: $('handle'),
  origImg: $('origImg'),
  outCanvas: $('outCanvas'),
  busy: $('busy'),
  fileMeta: $('fileMeta'),
  toast: $('toast'),
  scale: $('scale'),
  format: $('format'),
  denoise: $('denoise'),
  clarity: $('clarity'),
  sharpen: $('sharpen'),
  contrast: $('contrast'),
  saturation: $('saturation'),
};

const DEFAULTS = { denoise: 60, clarity: 65, sharpen: 85, contrast: 15, saturation: 12 };
const PROMPT_PRESET = { denoise: 80, clarity: 80, sharpen: 95, contrast: 20, saturation: 14 };

const outCtx = els.outCanvas.getContext('2d', { willReadFrequently: true });

let sourceImage = null;
let fileName = 'photo';
let baseCanvas = document.createElement('canvas');
let baseData = null;
let baseKey = '';
let renderTimer = null;
let busyTimer = null;
let busyOn = false;
let lastUrl = null;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function setBusy(on) {
  busyOn = on;
  clearTimeout(busyTimer);
  if (on) {
    busyTimer = setTimeout(() => els.busy.classList.remove('hidden'), 60);
  } else {
    els.busy.classList.add('hidden');
  }
}

function params() {
  return {
    denoise: +els.denoise.value,
    clarity: +els.clarity.value,
    sharpen: +els.sharpen.value,
    contrast: +els.contrast.value,
    saturation: +els.saturation.value,
    scale: +els.scale.value,
  };
}

function updateLabels() {
  $('vDenoise').textContent = els.denoise.value;
  $('vClarity').textContent = els.clarity.value;
  $('vSharpen').textContent = els.sharpen.value;
  $('vContrast').textContent = els.contrast.value;
  $('vSaturation').textContent = els.saturation.value;
}

/* ---------- image loading ---------- */

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('File bukan gambar yang valid');
    return;
  }
  fileName = (file.name || 'photo').replace(/\.[^.]+$/, '');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    els.origImg.src = url;
    els.dropzone.classList.add('hidden');
    els.compare.classList.remove('hidden');
    els.btnDownload.disabled = true;
    els.btnAuto.disabled = false;
    baseKey = '';
    updateMeta(file.size);
    renderNow(true);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('Gagal memuat gambar');
  };
  img.src = url;
}

function updateMeta(size) {
  if (!sourceImage) return;
  const w0 = sourceImage.naturalWidth;
  const h0 = sourceImage.naturalHeight;
  const w1 = baseData ? baseData.width : w0 * +els.scale.value;
  const h1 = baseData ? baseData.height : h0 * +els.scale.value;
  const kb = size ? ` · ${(size / 1024).toFixed(0)} KB` : '';
  els.fileMeta.innerHTML =
    `Asli <b>${w0}×${h0}</b> → Hasil <b>${Math.round(w1)}×${Math.round(h1)}</b> · ` +
    `Enhance dijalankan lokal di browser${kb}`;
}

/* ---------- drawing (progressive upscale) ---------- */

function buildBase() {
  const s = +els.scale.value;
  let w = Math.round(sourceImage.naturalWidth * s);
  let h = Math.round(sourceImage.naturalHeight * s);

  const MAX_DIM = 6000;
  const MAX_PX = 12e6;
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
  if (clamped) toast('Ukuran output dibatasi demi performa');

  const key = w + 'x' + h;
  if (key === baseKey && baseData) return;

  let cw = sourceImage.naturalWidth;
  let ch = sourceImage.naturalHeight;
  baseCanvas.width = cw <= w && ch <= h ? cw : w;
  baseCanvas.height = cw <= w && ch <= h ? ch : h;
  let ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (cw <= w && ch <= h) {
    // progressive 2x steps give much better upscaling quality than a single draw
    ctx.drawImage(sourceImage, 0, 0);
    while (cw * 2 <= w && ch * 2 <= h) {
      const tmp = document.createElement('canvas');
      tmp.width = cw * 2;
      tmp.height = ch * 2;
      const tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(baseCanvas, 0, 0, cw, ch, 0, 0, cw * 2, ch * 2);
      cw *= 2;
      ch *= 2;
      baseCanvas = tmp;
      ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
    }
  } else {
    // size clamp turned this into a downscale: draw straight to the target
    ctx.drawImage(sourceImage, 0, 0, w, h);
    cw = w;
    ch = h;
  }
  if (cw !== w || ch !== h) {
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(baseCanvas, 0, 0, cw, ch, 0, 0, w, h);
    baseCanvas = tmp;
    cw = w;
    ch = h;
  }

  ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  baseData = ctx.getImageData(0, 0, w, h);
  baseKey = key;
}

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

function enhance(base, p) {
  const w = base.width;
  const h = base.height;
  const data = new Uint8ClampedArray(base.data);
  const noise = estimateNoise(base.data, w, h);
  // scale denoise with how noisy the image actually is, so clean photos stay crisp
  const denoise = p.denoise * Math.min(1, noise / 5);

  if (denoise > 0) {
    const mean = applyDenoise(data, w, h, denoise);
    applyOutlierClamp(data, w, h, noise, mean);
  }
  if (p.clarity > 0) {
    const r = Math.max(2, Math.round(3 + p.clarity / 100 * 9));
    applyUnsharp(data, w, h, r, (p.clarity / 100) * 0.75, 1, 6 + noise * 3);
  }
  if (p.sharpen > 0) applyUnsharp(data, w, h, 1, (p.sharpen / 100) * 1.8, 2, 4 + noise * 3.2);
  applyColor(data, p.contrast, p.saturation);

  return new ImageData(data, w, h);
}

/* ---------- render ---------- */

function scheduleRender(delay) {
  if (!sourceImage) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderNow(false), delay === undefined ? 140 : delay);
}

function renderNow(force) {
  if (!sourceImage) return;
  const p = params();
  clearTimeout(renderTimer);
  setBusy(true);

  setTimeout(() => {
    try {
      buildBase();
      const out = enhance(baseData, p);
      els.outCanvas.width = out.width;
      els.outCanvas.height = out.height;
      outCtx.putImageData(out, 0, 0);
      updateMeta();
      els.btnDownload.disabled = false;
      if (force && els.frame.style.getPropertyValue('--pos') === '') {
        setPos(50);
      }
    } catch (err) {
      console.error(err);
      toast('Gagal memproses gambar');
    } finally {
      setBusy(false);
    }
  }, 30);
}

/* ---------- compare slider ---------- */

function setPos(pct) {
  pct = Math.max(0, Math.min(100, pct));
  els.frame.style.setProperty('--pos', pct + '%');
}

function posFromEvent(e) {
  const rect = els.frame.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  return (x / rect.width) * 100;
}

let dragging = false;
els.frame.addEventListener('pointerdown', (e) => {
  dragging = true;
  els.frame.setPointerCapture(e.pointerId);
  setPos(posFromEvent(e));
});
els.frame.addEventListener('pointermove', (e) => {
  if (dragging) setPos(posFromEvent(e));
});
els.frame.addEventListener('pointerup', () => { dragging = false; });
els.frame.addEventListener('pointercancel', () => { dragging = false; });

/* ---------- events ---------- */

els.btnPick.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});
els.fileInput.addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
  })
);
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

['denoise', 'clarity', 'sharpen', 'contrast', 'saturation'].forEach((k) => {
  els[k].addEventListener('input', () => {
    updateLabels();
    scheduleRender();
  });
});
els.scale.addEventListener('change', () => {
  updateMeta();
  renderNow(true);
});

els.btnAuto.addEventListener('click', () => {
  Object.entries(PROMPT_PRESET).forEach(([k, v]) => { els[k].value = v; });
  els.scale.value = '2';
  updateLabels();
  renderNow(true);
  toast('Preset prompt diterapkan');
});

els.btnReset.addEventListener('click', () => {
  Object.entries(DEFAULTS).forEach(([k, v]) => { els[k].value = v; });
  els.scale.value = '2';
  updateLabels();
  renderNow(true);
});

els.btnCopy.addEventListener('click', async () => {
  const text = $('promptText').textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    toast('Prompt disalin');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Prompt disalin');
  }
});

els.btnDownload.addEventListener('click', () => {
  if (!els.outCanvas.width) return;
  const fmt = els.format.value;
  const mime = fmt === 'png' ? 'image/png' : fmt === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  els.outCanvas.toBlob(
    (blob) => {
      if (!blob) { toast('Gagal membuat file'); return; }
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = lastUrl;
      a.download = `${fileName}-enhanced.${ext}`;
      a.click();
      toast('Hasil diunduh');
    },
    mime,
    0.92
  );
});

window.addEventListener('beforeunload', () => {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
});

updateLabels();
setPos(50);
