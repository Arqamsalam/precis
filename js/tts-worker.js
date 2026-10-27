// Generates natural speech with the Kokoro model, off the main thread. The model (~90 MB) is downloaded
// once from Hugging Face and kept in the browser's cache, so later sessions work offline.
import { KokoroTTS, env } from '../vendor/kokoro.mjs';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
// Multi-threading only works when the page is cross-origin isolated (our service worker arranges that).
if (self.crossOriginIsolated) env.backends.onnx.wasm.numThreads = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4)));

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let ttsPromise = null;
let queue = Promise.resolve();
let mode = 'auto';

// The graphics card (WebGPU) is many times faster; the model authors recommend full precision there
// (~330 MB). Everywhere else the compact 8-bit model (~90 MB) runs on the processor.
async function useGpu() {
  if (mode === 'cpu' || !self.navigator?.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

function load() {
  if (!ttsPromise) {
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'progress', loaded, total });
      }
    };
    ttsPromise = (async () => {
      if (await useGpu()) {
        try {
          const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback });
          await tts.generate('Ready.', { voice: 'af_heart' }); // make sure the graphics card path really works
          self.postMessage({ type: 'device', device: 'webgpu' });
          return tts;
        } catch (err) {
          console.warn('WebGPU voice failed, using the processor instead:', err);
          files.clear();
        }
      }
      const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback });
      self.postMessage({ type: 'device', device: 'wasm' });
      return tts;
    })().catch((err) => {
      ttsPromise = null;
      throw err;
    });
  }
  return ttsPromise;
}

self.onmessage = (e) => {
  const { id, type, text, voice, speed } = e.data;
  if (type === 'mode') { mode = e.data.mode; return; }
  // One generation at a time: the model can't run two requests at once.
  queue = queue.then(async () => {
    try {
      const tts = await load();
      if (type === 'load') {
        self.postMessage({ id, type: 'ready' });
        return;
      }
      const audio = await tts.generate(text, { voice, speed });
      const data = audio.audio;
      self.postMessage({ id, type: 'audio', data, rate: audio.sampling_rate }, [data.buffer]);
    } catch (err) {
      self.postMessage({ id, type: 'error', message: err?.message || String(err) });
    }
  });
};
