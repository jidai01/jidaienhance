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
  btnCancel: $('btnCancel'),
  compare: $('compare'),
  frame: $('frame'),
  handle: $('handle'),
  origImg: $('origImg'),
  outCanvas: $('outCanvas'),
  busy: $('busy'),
  busyLabel: $('busyLabel'),
  busyBar: $('busyBar'),
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
const SETTINGS_KEY = 'jidaienhance-settings';

const outCtx = els.outCanvas.getContext('2d', { willReadFrequently: true });

let sourceImage = null;
let fileName = 'photo';
let sourceData = null;   // {width, height, data} at capped natural size
let baseData = null;     // alias kept for tools/tests
let baseKey = '';
let worker = null;
let sourceSent = false;
let workerBusy = false;
let renderSeq = 0;
let lastRequest = null;
let lastResultMode = null;
let downloadPending = false;
let previewTimer = null;
let fullTimer = null;
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

function updateProgress(pct) {
  els.busyBar.style.width = pct + '%';
  els.busyLabel.textContent = 'Memproses ' + pct + '%';
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

/* ---------- settings persistence ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      denoise: +els.denoise.value,
      clarity: +els.clarity.value,
      sharpen: +els.sharpen.value,
      contrast: +els.contrast.value,
      saturation: +els.saturation.value,
      scale: els.scale.value,
      format: els.format.value,
    }));
  } catch { /* storage may be unavailable */ }
}

function applySettings(s) {
  ['denoise', 'clarity', 'sharpen', 'contrast', 'saturation'].forEach((k) => {
    if (s[k] != null) els[k].value = s[k];
  });
  if (s.scale) els.scale.value = s.scale;
  if (s.format) els.format.value = s.format;
}

/* Noise-adaptive starting values for a fresh session (no saved settings).
   Applied programmatically only — never persisted, so the next image can
   re-adapt until the user touches a control. */
function applySmartDefaults() {
  const noise = estimateNoise(sourceData.data, sourceData.width, sourceData.height);
  els.denoise.value = Math.min(90, Math.max(10, Math.round(noise * 7)));
  els.clarity.value = noise > 15 ? 55 : 75;
  els.sharpen.value = noise > 15 ? 70 : 90;
  updateLabels();
}

/* ---------- image loading ---------- */

function buildSource() {
  const img = sourceImage;
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  const [w, h, wasClamped] = clampDims(natW, natH);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  sourceData = { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  baseData = sourceData;
  baseKey = w + 'x' + h;
  sourceSent = false;
  if (wasClamped) toast('Ukuran dipetakan ke maksimal ' + w + '×' + h);
  return true;
}

function loadFile(file) {
  if (!file) return;
  const isHeic = /\.(heic|heif)$/i.test(file.name || '');
  if (!file.type.startsWith('image/') && !(isHeic && !file.type)) {
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
    downloadPending = false;
    if (!buildSource()) { toast('Gagal memuat gambar'); return; }
    updateMeta(file.size);
    if (!loadSettings()) applySmartDefaults();
    renderNow();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isHeic ? 'HEIC tidak didukung browser ini — ekspor ke JPG dulu' : 'Gagal memuat gambar');
  };
  img.src = url;
}

function updateMeta(size) {
  if (!sourceImage) return;
  const w0 = sourceImage.naturalWidth;
  const h0 = sourceImage.naturalHeight;
  const sw = sourceData ? sourceData.width : w0;
  const sh = sourceData ? sourceData.height : h0;
  const [w1, h1] = clampDims(sw * +els.scale.value, sh * +els.scale.value);
  const kb = size ? ` · ${(size / 1024).toFixed(0)} KB` : '';
  els.fileMeta.innerHTML =
    `Asli <b>${w0}×${h0}</b> → Hasil <b>${w1}×${h1}</b> · ` +
    `Enhance dijalankan lokal di browser${kb}`;
}

/* ---------- render (worker with sync fallback) ---------- */

function makeWorker() {
  try {
    const w = new Worker('enhance-worker.js');
    w.onmessage = onWorkerMessage;
    w.onerror = (err) => {
      console.error('worker error', err);
      killWorker();
      if (lastRequest) syncRender(lastRequest);
    };
    worker = w;
    sourceSent = false;
    return w;
  } catch (e) {
    worker = null;
    return null;
  }
}

function killWorker() {
  if (worker) worker.terminate();
  worker = null;
  workerBusy = false;
  sourceSent = false;
}

function requestRender(mode) {
  if (!sourceData) return;
  const p = params();
  const [tw, th] = mode === 'preview'
    ? previewDims(sourceData.width, sourceData.height)
    : clampDims(sourceData.width * p.scale, sourceData.height * p.scale);
  const id = ++renderSeq;
  lastRequest = { id, mode, tw, th, p };
  setBusy(true);
  updateProgress(mode === 'preview' ? 6 : 0);

  if (!worker) makeWorker();
  if (workerBusy) { killWorker(); makeWorker(); }
  if (!worker) { syncRender(lastRequest); return; }

  if (!sourceSent) {
    worker.postMessage({
      type: 'source',
      width: sourceData.width,
      height: sourceData.height,
      data: sourceData.data,
    });
    sourceSent = true;
  }
  workerBusy = true;
  worker.postMessage({ type: 'render', id, mode, targetW: tw, targetH: th, params: p });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'progress') {
    if (m.id === renderSeq) updateProgress(m.pct);
    return;
  }
  if (m.id !== renderSeq) return;
  if (m.type === 'result') {
    workerBusy = false;
    paint(m);
    setBusy(false);
  } else if (m.type === 'error') {
    workerBusy = false;
    console.error(m.message);
    killWorker();
    if (lastRequest) syncRender(lastRequest);
  }
}

function syncRender(req) {
  try {
    const { tw, th, p, mode } = req;
    const base = (tw === sourceData.width && th === sourceData.height)
      ? sourceData
      : {
        width: tw,
        height: th,
        data: resample(sourceData.data, sourceData.width, sourceData.height, tw, th, mode === 'preview' ? 4 : 0, mode === 'full'),
      };
    const out = enhance(base, p);
    paint({ id: req.id, mode, width: out.width, height: out.height, data: out.data });
  } catch (err) {
    console.error(err);
    toast('Gagal memproses gambar');
  } finally {
    setBusy(false);
  }
}

function paint(m) {
  els.outCanvas.width = m.width;
  els.outCanvas.height = m.height;
  outCtx.putImageData(new ImageData(m.data, m.width, m.height), 0, 0);
  lastResultMode = m.mode;
  updateMeta();
  els.btnDownload.disabled = false;
  if (els.frame.style.getPropertyValue('--pos') === '') setPos(50);
  if (downloadPending) { downloadPending = false; doDownload(); }
}

function renderNow() {
  if (!sourceData) return;
  clearTimeout(previewTimer);
  clearTimeout(fullTimer);
  requestRender('full');
}

/* Preview first while sliders move, full quality shortly after they stop. */
function schedulePreview() {
  if (!sourceData) return;
  clearTimeout(previewTimer);
  clearTimeout(fullTimer);
  previewTimer = setTimeout(() => requestRender('preview'), 90);
  fullTimer = setTimeout(() => requestRender('full'), 550);
}

/* ---------- compare slider ---------- */

function setPos(pct) {
  pct = Math.round(Math.max(0, Math.min(100, pct)));
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
  setPos(posFromEvent(e));
  try { els.frame.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
});
els.frame.addEventListener('pointermove', (e) => {
  if (dragging) setPos(posFromEvent(e));
});
/* Fallback if pointer capture is lost (release happened outside the frame). */
document.addEventListener('pointermove', (e) => {
  if (dragging) setPos(posFromEvent(e));
});
document.addEventListener('pointerup', () => { dragging = false; });
document.addEventListener('pointercancel', () => { dragging = false; });

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
    saveSettings();
    schedulePreview();
  });
});
els.scale.addEventListener('change', () => {
  saveSettings();
  updateMeta();
  renderNow();
});
els.format.addEventListener('change', saveSettings);

els.btnAuto.addEventListener('click', () => {
  Object.entries(PROMPT_PRESET).forEach(([k, v]) => { els[k].value = v; });
  els.scale.value = '2';
  updateLabels();
  saveSettings();
  renderNow();
  toast('Preset prompt diterapkan');
});

els.btnReset.addEventListener('click', () => {
  Object.entries(DEFAULTS).forEach(([k, v]) => { els[k].value = v; });
  els.scale.value = '2';
  updateLabels();
  saveSettings();
  renderNow();
});

els.btnCancel.addEventListener('click', () => {
  clearTimeout(previewTimer);
  clearTimeout(fullTimer);
  renderSeq++;
  killWorker();
  setBusy(false);
  toast('Proses dibatalkan');
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

function doDownload() {
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
}

els.btnDownload.addEventListener('click', () => {
  if (!els.outCanvas.width) return;
  if (lastResultMode === 'preview') {
    downloadPending = true;
    toast('Menyiapkan hasil penuh…');
    renderNow();
    return;
  }
  doDownload();
});

window.addEventListener('beforeunload', () => {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
});

/* ---------- init ---------- */

const savedSettings = loadSettings();
if (savedSettings) applySettings(savedSettings);
updateLabels();
setPos(50);
