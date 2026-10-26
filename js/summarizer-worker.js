// Runs the summarizer off the main thread so the page stays responsive on long books.
import { analyze, summarize, contextView } from './summarizer.js';

let cached = { key: null, analysis: null };

function keyOf(text, title) {
  // Fingerprint of the whole text (FNV-1a), so any edit, however small, triggers a fresh analysis.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${title}\u0000${text.length}:${h >>> 0}`;
}

self.onmessage = (e) => {
  const { id, type, text, title, options, selected } = e.data;
  try {
    if (type === 'summarize') {
      const key = keyOf(text, title || '');
      if (cached.key !== key) {
        cached = { key, analysis: null };
        cached.analysis = analyze(text, { title, onProgress: (p) => self.postMessage({ id, type: 'progress', p }) });
      }
      self.postMessage({ id, type: 'result', result: summarize(cached.analysis, options) });
    } else if (type === 'context') {
      if (!cached.analysis) throw new Error('Summarize the text first.');
      self.postMessage({ id, type: 'result', result: contextView(cached.analysis, selected) });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
