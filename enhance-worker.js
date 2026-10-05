'use strict';

/* Enhancement runs here so the UI thread stays responsive: progress
   messages stream to the page and a new request can cancel this worker
   outright (terminate) instead of queueing behind a long render. */

importScripts('filters.js');

let src = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'source') {
    src = { width: m.width, height: m.height, data: m.data };
    return;
  }
  if (m.type !== 'render') return;
  try {
    if (!src) throw new Error('sumber gambar belum dikirim');
    const full = m.mode === 'full';
    let base = src;
    if (m.targetW !== src.width || m.targetH !== src.height) {
      base = {
        width: m.targetW,
        height: m.targetH,
        data: resample(src.data, src.width, src.height, m.targetW, m.targetH, full ? 0 : 4, full),
      };
      if (full) postMessage({ type: 'progress', id: m.id, pct: 10 });
    }
    const out = enhance(base, m.params, full
      ? (p) => postMessage({ type: 'progress', id: m.id, pct: Math.min(99, 10 + Math.round(p * 0.9)) })
      : null);
    postMessage(
      { type: 'result', id: m.id, mode: m.mode, width: out.width, height: out.height, data: out.data },
      [out.data.buffer]
    );
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.stack) || err) });
  }
};
