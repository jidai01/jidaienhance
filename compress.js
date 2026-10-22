'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('cDropzone'),
  fileInput: $('cFileInput'),
  btnPick: $('cPick'),
  btnDownload: $('cDownload'),
  view: $('cView'),
  frame: $('cFrame'),
  orig: $('cOrig'),
  canvas: $('cCanvas'),
  meta: $('cMeta'),
  busy: $('cBusy'),
  label: $('cLabel'),
  toast: $('cToast'),
  format: $('cFormat'),
  quality: $('cQuality'),
  vQuality: $('cVQuality'),
  qualityField: $('cQualityField'),
  maxSize: $('cMaxSize'),
};

const outCtx = els.canvas.getContext('2d', { willReadFrequently: true });

let sourceImage = null;
let fileName = 'photo';
let fileSize = 0;
let lastUrl = null;
let lastBlob = null;
let compressSeq = 0;
let compressTimer = null;
let busyTimer = null;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function setBusy(on) {
  clearTimeout(busyTimer);
  if (on) {
    busyTimer = setTimeout(() => els.busy.classList.remove('hidden'), 60);
  } else {
    els.busy.classList.add('hidden');
  }
}

function setPos(pct) {
  pct = Math.round(Math.max(0, Math.min(100, pct)));
  els.frame.style.setProperty('--pos', pct + '%');
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function loadFile(file) {
  if (!file) return;
  const isHeic = /\.(heic|heif)$/i.test(file.name || '');
  if (!file.type.startsWith('image/') && !(isHeic && !file.type)) {
    toast('File bukan gambar yang valid');
    return;
  }
  fileName = (file.name || 'photo').replace(/\.[^.]+$/, '');
  fileSize = file.size || 0;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    els.orig.src = url;
    els.dropzone.classList.add('hidden');
    els.view.classList.remove('hidden');
    els.btnDownload.disabled = true;
    lastBlob = null;
    if (els.frame.style.getPropertyValue('--pos') === '') setPos(50);
    runCompress();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isHeic ? 'HEIC tidak didukung browser ini — ekspor ke JPG dulu' : 'Gagal memuat gambar');
  };
  img.src = url;
}

function targetDims() {
  const natW = sourceImage.naturalWidth;
  const natH = sourceImage.naturalHeight;
  const max = +els.maxSize.value;
  let w = natW;
  let h = natH;
  if (max > 0 && Math.max(natW, natH) > max) {
    const s = max / Math.max(natW, natH);
    w = Math.max(1, Math.round(natW * s));
    h = Math.max(1, Math.round(natH * s));
  }
  return clampDims(w, h);
}

function updateMeta(blob, w, h) {
  const origDims = `${sourceImage.naturalWidth}×${sourceImage.naturalHeight}`;
  const outDims = `${w}×${h}`;
  if (!blob) {
    els.meta.innerHTML =
      `Asli <b>${fmtSize(fileSize)}</b> · ${origDims} → <b>mengompres…</b>`;
    return;
  }
  const smaller = blob.size <= fileSize;
  const pct = fileSize
    ? Math.round((1 - blob.size / fileSize) * 100)
    : 0;
  const sign = smaller ? '−' : '+';
  const cls = smaller ? 'stat-ok' : 'stat-warn';
  const pctTxt = `${sign}${Math.abs(pct)}%`;
  els.meta.innerHTML =
    `Asli <b>${fmtSize(fileSize)}</b> · ${origDims} → ` +
    `Hasil <b>${fmtSize(blob.size)}</b> · ${outDims} · ` +
    `<b class="${cls}">${pctTxt}</b> · dikompres lokal di browser`;
}

async function runCompress() {
  if (!sourceImage) return;
  const mySeq = ++compressSeq;
  const fmt = els.format.value;
  const q = +els.quality.value;
  const [w, h] = targetDims();
  setBusy(true);
  updateMeta(null, w, h);
  try {
    els.canvas.width = w;
    els.canvas.height = h;
    outCtx.drawImage(sourceImage, 0, 0, w, h);
    const mime = fmt === 'png' ? 'image/png' : fmt === 'jpeg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise((res) => els.canvas.toBlob(res, mime, q / 100));
    if (mySeq !== compressSeq) return;
    if (!blob) {
      setBusy(false);
      toast('Gagal mengompres gambar');
      updateMeta(null, w, h);
      return;
    }
    lastBlob = blob;
    updateMeta(blob, w, h);
    els.btnDownload.disabled = false;
    setBusy(false);
  } catch (err) {
    console.error(err);
    if (mySeq === compressSeq) {
      setBusy(false);
      toast('Gagal mengompres gambar');
    }
  }
}

function scheduleCompress() {
  if (!sourceImage) return;
  clearTimeout(compressTimer);
  compressTimer = setTimeout(runCompress, 250);
}

/* ---------- compare slider ---------- */

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

els.format.addEventListener('change', () => {
  const isPng = els.format.value === 'png';
  els.quality.disabled = isPng;
  els.qualityField.classList.toggle('disabled', isPng);
  runCompress();
});
els.quality.addEventListener('input', () => {
  els.vQuality.textContent = els.quality.value;
  scheduleCompress();
});
els.maxSize.addEventListener('change', runCompress);

els.btnDownload.addEventListener('click', () => {
  if (!lastBlob) return;
  const fmt = els.format.value;
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(lastBlob);
  const a = document.createElement('a');
  a.href = lastUrl;
  a.download = `${fileName}-compressed.${ext}`;
  a.click();
  toast('Hasil diunduh');
});

window.addEventListener('beforeunload', () => {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
});

/* ---------- init ---------- */

setPos(50);
els.vQuality.textContent = els.quality.value;
