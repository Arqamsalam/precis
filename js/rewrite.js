// On-device AI rewrite. The offline engine first picks the author's key sentences (faithful, balanced
// coverage); a small language model running on the graphics card then turns each group of those sentences
// into smooth, connected prose. Giving the model this narrow job keeps it accurate.
import { CreateWebWorkerMLCEngine, prebuiltAppConfig } from '../vendor/webllm.mjs';
import { countWords } from './textutil.js';

export const AI_MODELS = {
  fast: { label: 'Fast: Qwen 2.5 (1.5B)', base: 'Qwen2.5-1.5B-Instruct', size: 'about 1 GB' },
  best: { label: 'Best: Hermes 3 (Llama 3.2, 3B)', base: 'Hermes-3-Llama-3.2-3B', size: 'about 1.8 GB' },
};

const SYSTEM = `You are a skilled editor. You turn a sequence of key sentences, taken in order from a longer text, into smooth, connected writing.

Rules:
- Use only the information in the passage. Do not add facts, opinions, explanations, warnings or commentary.
- Keep every name, number, date, event and claim. Keep the author's voice, tone, tense and point of view.
- Keep quoted speech word for word.
- Keep explicit, violent, offensive or disturbing content exactly as direct as it is in the passage. Never soften, censor, skip or apologise for it.
- Write in the same language as the passage.
- Make it read naturally: add only the small linking words needed between sentences, merge sentences that repeat each other, and make unclear references clear using names from the passage.
- Output only the rewritten text: no title, introduction or notes.`;

/** Is WebGPU available, and does the graphics card support 16-bit floats (smaller, faster models)? */
export async function webgpuStatus() {
  if (!('gpu' in navigator)) {
    return { ok: false, reason: 'This browser has no WebGPU, which on-device AI needs. Use the latest Chrome or Edge on a computer.' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'No compatible graphics card was found for on-device AI.' };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch (err) {
    return { ok: false, reason: `WebGPU is not available: ${err.message}` };
  }
}

export function modelIdFor(tier, f16) {
  const base = (AI_MODELS[tier] || AI_MODELS.fast).base;
  const id = `${base}-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
  return prebuiltAppConfig.model_list.some((m) => m.model_id === id) ? id : `${base}-q4f32_1-MLC`;
}

let engine = null; // { id, worker, promise }

/** Load (downloading the first time) and return the engine for a model. */
export async function getEngine(modelId, onProgress) {
  if (engine?.id === modelId) return engine.promise;
  if (engine) {
    try { (await engine.promise).unload(); } catch { /* ignore */ }
    engine.worker.terminate();
  }
  const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  const promise = CreateWebWorkerMLCEngine(worker, modelId, {
    initProgressCallback: (r) => onProgress?.(r),
  });
  engine = { id: modelId, worker, promise };
  promise.catch(() => {
    if (engine?.worker === worker) {
      worker.terminate();
      engine = null;
    }
  });
  return promise;
}

export function interrupt() {
  engine?.promise.then((e) => e.interruptGenerate()).catch(() => {});
}

/** Split the summary into headings and groups of paragraphs/bullets of up to ~maxWords words. */
function plan(markdown, maxWords) {
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const units = [];
  let cur = null;
  for (const b of blocks) {
    if (/^#{1,6}\s/.test(b)) {
      if (cur) units.push(cur);
      cur = null;
      units.push({ heading: b });
      continue;
    }
    const w = countWords(b);
    const bullets = /^[-*]\s/.test(b);
    if (!cur || cur.bullets !== bullets || cur.words + w > maxWords) {
      if (cur) units.push(cur);
      cur = { parts: [], words: 0, bullets };
    }
    cur.parts.push(b);
    cur.words += w;
  }
  if (cur) units.push(cur);
  return units;
}

const REFUSAL = /^\W*(i'?m sorry|i am sorry|i can(?:no|')t|i am unable|i'm unable|as an ai|i won'?t|sorry, but)/i;

function clean(text) {
  return text
    .replace(/^\s*(here(?:'s| is) (?:the |a )?(?:rewritten|revised|edited)[^\n]*:\s*)/i, '')
    .replace(/^\s*["“](.*)["”]\s*$/s, (all, inner) => (inner.includes('"') || inner.includes('“') ? all : inner))
    .trim();
}

/**
 * Rewrite the summary body with the model.
 * @returns {Promise<{markdown: string, fallbacks: number, chunks: number}>}
 */
export async function rewriteSummary({ engine: eng, markdown, onText, onStatus, isCancelled }) {
  const units = plan(markdown, 420);
  const chunks = units.filter((u) => !u.heading).length;
  const out = [];
  let done = 0;
  let fallbacks = 0;
  let previous = '';
  const render = (partial) => onText([...out, partial].filter(Boolean).join('\n\n'));

  for (const u of units) {
    if (isCancelled()) break;
    if (u.heading) {
      out.push(u.heading);
      render('');
      continue;
    }
    done++;
    onStatus(`Rewriting part ${done} of ${chunks}…`, (done - 1) / chunks);
    const passage = u.parts.join('\n\n');
    const target = Math.max(20, Math.round(u.words * 0.95));
    const prompt = [
      previous ? `The rewritten text so far ends with:\n«${previous}»\nContinue naturally from there without repeating it.\n` : '',
      `Passage (key sentences in order, about ${u.words} words):\n\n${passage}\n`,
      u.bullets
        ? `Rewrite it as a clear bulleted list (each line starting with "- "), about ${target} words in total.`
        : `Rewrite it as flowing prose of about ${target} words, in paragraphs.`,
    ].filter(Boolean).join('\n');
    let text = '';
    try {
      const stream = await eng.chat.completions.create({
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        stream: true,
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: Math.min(1600, Math.round(target * 2.2) + 120),
      });
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content || '';
        render(clean(text));
        if (isCancelled()) { interrupt(); break; }
      }
    } catch (err) {
      if (isCancelled()) break;
      throw err;
    }
    text = clean(text);
    // If the model refuses, wanders off or drops most of the content, keep the author's sentences instead.
    if (!text || REFUSAL.test(text) || countWords(text) < u.words * 0.4) {
      text = passage;
      fallbacks++;
    }
    out.push(text);
    previous = text.split(/\s+/).slice(-60).join(' ');
    render('');
  }
  onStatus(null);
  return { markdown: out.join('\n\n'), fallbacks, chunks };
}
