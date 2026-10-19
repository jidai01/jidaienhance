'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('rbDropzone'),
  fileInput: $('rbFileInput'),
  btnPick: $('rbPick'),
  btnDownload: $('rbDownload'),
  view: $('rbView'),
  frame: $('rbFrame'),
  orig: $('rbOrig'),
  canvas: $('rbCanvas'),
  meta: $('rbMeta'),
  busy: $('rbBusy'),
  label: $('rbLabel'),
  bar: $('rbBar'),
  btnCancel: $('rbCancel'),
  toast: $('rbToast'),
};

const outCtx = els.canvas.getContext('2d', { willReadFrequently: true });

let sourceImage = null;
let fileName = 'photo';
let fileSize = 0;
let bgModule = null;
let bgToken = 0;
let bgBusy = false;
let lastUrl = null;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function setBusy(on) {
  clearTimeout(setBusy._t);
  if (on) {
    setBusy._t = setTimeout(() => els.busy.classList.remove('hidden'), 60);
  } else {
    els.busy.classList.add('hidden');
  }
}

function setPos(pct) {
  pct = Math.round(Math.max(0, Math.min(100, pct)));
  els.frame.style.setProperty('--pos', pct + '%');
}

function updateMeta(done) {
  if (!sourceImage) return;
  const w = sourceImage.naturalWidth;
  const h = sourceImage.naturalHeight;
  const kb = fileSize ? ` · ${(fileSize / 1024).toFixed(0)} KB` : '';
  const result = done
    ? `Hasil <b>PNG transparan</b>`
    : `menunggu proses`;
  els.meta.innerHTML = `Asli <b>${w}×${h}</b>${kb} → ${result} · diproses lokal di browser`;
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
    if (els.frame.style.getPropertyValue('--pos') === '') setPos(50);
    updateMeta(false);
    runRemove();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast(isHeic ? 'HEIC tidak didukung browser ini — ekspor ke JPG dulu' : 'Gagal memuat gambar');
  };
  img.src = url;
}

async function runRemove() {
  if (!sourceImage || bgBusy) return;
  const myToken = ++bgToken;
  bgBusy = true;
  setBusy(true);
  els.bar.style.width = '0%';
  els.label.textContent = 'Menghapus latar…';
  try {
    if (!bgModule) {
      bgModule = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
    }
    if (myToken !== bgToken) return;
    const resp = await fetch(els.orig.src);
    const blob = await resp.blob();
    if (myToken !== bgToken) return;
    const out = await bgModule.removeBackground(blob, {
      model: 'isnet_fp16',
      progress: (key, current, total) => {
        if (myToken !== bgToken || !total) return;
        const frac = Math.min(1, current / total);
        const fetching = String(key).startsWith('fetch');
        const pct = Math.round(fetching ? 4 + 46 * frac : 55 + 40 * frac);
        els.bar.style.width = pct + '%';
        els.label.textContent = (fetching ? 'Mengunduh model ' : 'Menghapus latar ') + pct + '%';
      },
    });
    if (myToken !== bgToken) return;
    const url = URL.createObjectURL(out);
    const cutout = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('cutout decode'));
      im.src = url;
    });
    if (myToken !== bgToken) return;
    const [w, h] = clampDims(cutout.naturalWidth, cutout.naturalHeight);
    els.canvas.width = w;
    els.canvas.height = h;
    outCtx.drawImage(cutout, 0, 0, w, h);
    bgBusy = false;
    setBusy(false);
    els.btnDownload.disabled = false;
    updateMeta(true);
    toast('Latar dihapus — hasil PNG transparan');
  } catch (err) {
    console.error(err);
    if (myToken === bgToken) {
      bgBusy = false;
      setBusy(false);
      toast('Gagal menghapus latar — unduhan model pertama butuh koneksi');
    }
  }
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

els.btnCancel.addEventListener('click', () => {
  bgToken++;
  if (bgBusy) {
    bgBusy = false;
    setBusy(false);
    toast('Proses dibatalkan');
  }
});

els.btnDownload.addEventListener('click', () => {
  if (!els.canvas.width) return;
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

setPos(50);
