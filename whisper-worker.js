/* Speech-to-text worker: runs OpenAI's Whisper model in the browser with transformers.js.
   The model downloads once from Hugging Face and is cached by the browser; audio never leaves the PC. */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
let asr = null, loadedKey = '', device = 'wasm';

async function load(model, preferGpu) {
  const key = model + (preferGpu ? ':gpu' : ':cpu');
  if (asr && loadedKey === key) return;
  const progress_callback = p => { if (p.status === 'progress') postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total }); };
  asr = null;
  if (preferGpu && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no adapter');
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback });
      device = 'webgpu';
    } catch (e) { asr = null; postMessage({ type: 'note', message: 'Graphics acceleration unavailable, using the processor instead.' }); }
  }
  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', progress_callback });
    device = 'wasm';
  }
  loadedKey = key;
}

const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|♪+|\.+)\s*$/;
const rms = a => { let s = 0; for (let i = 0; i < a.length; i += 8) s += a[i] * a[i]; return Math.sqrt(s / Math.ceil(a.length / 8)); };

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'transcribe') return;
  try {
    await load(m.model, m.preferGpu);
    postMessage({ type: 'ready', device });
    const SR = 16000, audio = m.audio, win = (m.windowSec || 120) * SR;
    for (let i = (m.startAt || 0) * SR; i < audio.length; i += win) {
      const slice = audio.subarray(i, Math.min(audio.length, i + win));
      const offset = i / SR, segs = [];
      if (slice.length > SR / 2 && rms(slice) > 0.002) {
        const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };
        if (m.language) Object.assign(opts, { language: m.language, task: 'transcribe' });
        const out = await asr(slice, opts);
        const chunks = out.chunks && out.chunks.length ? out.chunks : [{ timestamp: [0, slice.length / SR], text: out.text || '' }];
        for (const c of chunks) {
          const text = (c.text || '').trim();
          if (!text || NOISE.test(text)) continue;
          const s = c.timestamp?.[0] ?? 0, en = c.timestamp?.[1] ?? (slice.length / SR);
          segs.push({ start: +(offset + s).toFixed(2), end: +(offset + en).toFixed(2), text });
        }
      }
      postMessage({ type: 'progress', done: Math.min(1, (i + win) / audio.length), upTo: Math.min(audio.length, i + win) / SR, segments: segs });
    }
    postMessage({ type: 'done' });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
