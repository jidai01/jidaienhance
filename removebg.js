'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('rbDropzone'),
  fileInput: $('rbFileInput'),
  btnPick: $('rbPick'),
  btnDownload: $('rbDownload'),
  view: $('rbView'),
  canvas: $('rbCanvas'),
  meta: $('rbMeta'),
  toast: $('rbToast'),
  modeErase: $('rbModeErase'),
  modeRestore: $('rbModeRestore'),
  tol: $('rbTol'),
  tolVal: $('rbTolVal'),
  contig: $('rbContig'),
  undo: $('rbUndo'),
  reset: $('rbReset'),
};

const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

const UNDO_MAX = 10;

let sourceImage = null;
let fileName = 'photo';
let fileSize = 0;
let origData = null;      // ImageData at load — source of truth for reset/restore
let curData = null;       // ImageData currently reflected on canvas
let undoStack = [];       // [{idx: Int32Array, prev: Uint8Array}]
let mode = 'erase';
let changed = false;
let lastUrl = null;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function updateButtons() {
  els.undo.disabled = undoStack.length === 0;
  els.reset.disabled = !changed;
  els.btnDownload.disabled = !sourceImage;
}

function updateMeta() {
  if (!sourceImage || !curData) return;
  let removed = 0;
  const d = curData.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] === 0) removed++;
  const pct = Math.round((removed / (els.canvas.width * els.canvas.height)) * 100);
  const kb = fileSize ? ` · ${fmtSize(fileSize)}` : '';
  els.meta.innerHTML =
    `Asli <b>${sourceImage.naturalWidth}×${sourceImage.naturalHeight}</b>${kb} → ` +
    `<b>PNG transparan</b> · dihapus <b>${pct}%</b> piksel · diproses lokal di browser`;
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
    URL.revokeObjectURL(url);
    sourceImage = img;
    const [w, h, wasClamped] = clampDims(img.naturalWidth, img.naturalHeight);
    els.canvas.width = w;
    els.canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    origData = ctx.getImageData(0, 0, w, h);
    curData = origData;
    undoStack = [];
    changed = false;
    els.dropzone.classList.add('hidden');
    els.view.classList.remove('hidden');
    updateButtons();
    updateMeta();
    if (wasClamped) toast('Ukuran dipetakan ke maksimal ' + w + '×' + h);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isHeic ? 'HEIC tidak didukung browser ini — ekspor ke JPG dulu' : 'Gagal memuat gambar');
  };
  img.src = url;
}

/* Magic wand: colour-distance flood fill (contiguous) or whole-image match. */
function collectSelection(data, w, h, sx, sy, thresh) {
  const si = (sy * w + sx) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2];
  const dist = (i) => {
    const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const picked = [];
  if (els.contig.checked) {
    const visited = new Uint8Array(w * h);
    const stack = [sy * w + sx];
    while (stack.length) {
      const p = stack.pop();
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      if (dist(i) > thresh) continue;
      picked.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
  } else {
    const total = w * h;
    for (let p = 0; p < total; p++) {
      if (dist(p * 4) <= thresh) picked.push(p);
    }
  }
  return picked;
}

function applyWand(px, py) {
  if (!origData) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  if (px < 0 || py < 0 || px >= w || py >= h) return;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const thresh = +els.tol.value * 3;
  const picked = collectSelection(data, w, h, px, py, thresh);
  const idx = [];
  const prev = [];
  for (const p of picked) {
    const i = p * 4;
    const target = mode === 'erase' ? 0 : origData.data[i + 3];
    if (data[i + 3] !== target) {
      idx.push(p);
      prev.push(data[i + 3]);
      data[i + 3] = target;
    }
  }
  if (!idx.length) {
    toast(mode === 'erase'
      ? 'Tidak ada yang berubah — coba naikkan toleransi'
      : 'Tidak ada yang dipulihkan di area ini');
    return;
  }
  undoStack.push({ idx: Int32Array.from(idx), prev: Uint8Array.from(prev) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  ctx.putImageData(img, 0, 0);
  curData = img;
  changed = true;
  updateButtons();
  updateMeta();
}

function undo() {
  const action = undoStack.pop();
  if (!action || !origData) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  for (let k = 0; k < action.idx.length; k++) {
    img.data[action.idx[k] * 4 + 3] = action.prev[k];
  }
  ctx.putImageData(img, 0, 0);
  curData = img;
  updateButtons();
  updateMeta();
}

function resetAll() {
  if (!origData) return;
  ctx.putImageData(origData, 0, 0);
  curData = origData;
  undoStack = [];
  changed = false;
  updateButtons();
  updateMeta();
  toast('Foto dikembalikan ke kondisi awal');
}

/* ---------- events ---------- */

function setMode(next) {
  mode = next;
  els.modeErase.classList.toggle('active', mode === 'erase');
  els.modeRestore.classList.toggle('active', mode === 'restore');
}

els.modeErase.addEventListener('click', () => setMode('erase'));
els.modeRestore.addEventListener('click', () => setMode('restore'));

els.tol.addEventListener('input', () => { els.tolVal.textContent = els.tol.value; });
els.undo.addEventListener('click', undo);
els.reset.addEventListener('click', resetAll);

els.canvas.addEventListener('pointerdown', (e) => {
  if (!origData) return;
  const rect = els.canvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) * (els.canvas.width / rect.width));
  const py = Math.floor((e.clientY - rect.top) * (els.canvas.height / rect.height));
  applyWand(px, py);
});

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

els.btnDownload.addEventListener('click', () => {
  if (!sourceImage) return;
  els.canvas.toBlob(
    (blob) => {
      if (!blob) { toast('Gagal membuat file'); return; }
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = lastUrl;
      a.download = `${fileName}-nobg.png`;
      a.click();
      toast('Hasil diunduh');
    },
    'image/png'
  );
});

window.addEventListener('beforeunload', () => {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
});

/* ---------- init ---------- */

setMode('erase');
els.tolVal.textContent = els.tol.value;
updateButtons();
