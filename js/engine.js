// Talks to the summarizer worker; falls back to running on the page if workers are unavailable.

let worker = null;
let workerFailed = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./summarizer-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, type } = e.data;
      const job = pending.get(id);
      if (!job) return;
      if (type === 'progress') job.onProgress?.(e.data.p);
      else {
        pending.delete(id);
        if (type === 'error') job.reject(new Error(e.data.message));
        else job.resolve(e.data.result);
      }
    };
    worker.onerror = (e) => {
      // A module-worker load failure (old browser) lands here: switch to the in-page engine.
      e.preventDefault?.();
      workerFailed = true;
      worker = null;
      for (const [, job] of pending) job.retry();
      pending.clear();
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

let local = null;
async function runLocally(type, payload) {
  local ??= { mod: await import('./summarizer.js'), key: null, analysis: null };
  const { mod } = local;
  if (type === 'summarize') {
    let h = 2166136261;
    for (let i = 0; i < payload.text.length; i++) h = Math.imul(h ^ payload.text.charCodeAt(i), 16777619);
    const key = `${payload.title}\u0000${payload.text.length}:${h >>> 0}`;
    if (local.key !== key) {
      local.analysis = mod.analyze(payload.text, { title: payload.title });
      local.key = key;
    }
    return mod.summarize(local.analysis, payload.options);
  }
  return mod.contextView(local.analysis, payload.selected);
}

/**
 * @param {'summarize'|'context'} type
 * @param {object} payload {text, title, options} or {selected}
 * @param {(p:number)=>void} [onProgress]
 */
export function runEngine(type, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      runLocally(type, payload).then(resolve, reject);
      return;
    }
    const id = ++seq;
    pending.set(id, {
      resolve, reject, onProgress,
      retry: () => runLocally(type, payload).then(resolve, reject),
    });
    w.postMessage({ id, type, ...payload });
  });
}
