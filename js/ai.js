// AI summarization engine: talks to Claude (official SDK) or any OpenAI-compatible endpoint,
// and splits long documents into parts so any length can be summarized at any percentage.
import { Anthropic } from '../vendor/anthropic.mjs';
import { countWords, estimateTokens, splitParagraphs, splitSentences, looksLikeHeading } from './textutil.js';
import {
  SYSTEM_PROMPT, singlePassPrompt, chunkPrompt, notesPrompt, reducePrompt, extrasPrompt,
  extrasFollowupPrompt, lengthFixPrompt,
} from './prompts.js';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'best quality', input: 4, output: 20, fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'fast, half price', input: 2, output: 10, fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fastest, cheapest', input: 0.1, output: 0.5, inputLong: 0.5, outputLong: 2.5, fallback: false },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable, premium', input: 10, output: 50, fallback: true },
];

export const OPENAI_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.1', context: 400000, needsKey: true },
  openrouter: { label: 'OpenRouter (hundreds of models)', baseUrl: 'https://openrouter.ai/api/v1', model: '', context: 128000, needsKey: true },
  ollama: { label: 'Ollama (local, private)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', context: 8192, needsKey: false },
  lmstudio: { label: 'LM Studio (local, private)', baseUrl: 'http://localhost:1234/v1', model: '', context: 8192, needsKey: false },
  custom: { label: 'Custom endpoint', baseUrl: '', model: '', context: 32000, needsKey: false },
};

export class SummaryError extends Error {
  constructor(message, { kind = 'error', partial = '' } = {}) {
    super(message);
    this.kind = kind;
    this.partial = partial;
  }
}

// ---------------------------------------------------------------- providers

async function streamClaude({ conf, system, messages, maxTokens, signal, onText, onPhase }) {
  const client = new Anthropic({ apiKey: conf.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3, timeout: 20 * 60 * 1000 });
  const info = CLAUDE_MODELS.find((m) => m.id === conf.model);
  const params = { model: conf.model, max_tokens: maxTokens, system, messages };
  if (info) params.output_config = { effort: conf.effort || 'high' };

  let text = '';
  let final;
  try {
    // Server-side fallback: if a safety classifier declines, the API retries on Anthropic's recommended model.
    const stream = info?.fallback
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const t = event.content_block.type;
        if (t === 'thinking' || t === 'redacted_thinking') onPhase?.('thinking');
        else if (t === 'text') onPhase?.('writing');
        else if (t === 'fallback') onPhase?.('fallback', event.content_block);
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText?.(text);
      }
    }
    final = await stream.finalMessage();
  } catch (err) {
    throw claudeError(err, text);
  }

  if (final.stop_reason === 'refusal') {
    const cat = final.stop_details?.category;
    throw new SummaryError(
      `Claude declined to continue with this text${cat ? ` (safety category: ${cat})` : ''}. ` +
      'You can try another Claude model, use an OpenAI-compatible or local model (Settings), or the offline mode.',
      { kind: 'refusal', partial: text },
    );
  }
  let content = final.content;
  // After a mid-answer model switch, earlier thinking blocks can't be replayed; keep text only.
  if (content.some((b) => b.type === 'fallback')) content = content.filter((b) => b.type === 'text');
  const u = final.usage || {};
  return {
    text,
    assistantContent: content,
    stopReason: final.stop_reason,
    model: final.model,
    usage: {
      input: u.input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    },
  };
}

function claudeError(err, partial) {
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') {
    return new SummaryError('Stopped.', { kind: 'abort', partial });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new SummaryError('Your Anthropic API key was rejected. Check it in Settings.', { kind: 'auth' });
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new SummaryError(`This API key can't use that model: ${err.message}`, { kind: 'auth' });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new SummaryError(`Model not found. Check the model name in Settings. (${err.message})`, { kind: 'config' });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new SummaryError('Rate limit reached on your Anthropic account. Wait a minute and try again, or pick a smaller model.', { kind: 'rate', partial });
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message;
    if (/credit balance/i.test(msg)) return new SummaryError('Your Anthropic account is out of credit. Add credit at console.anthropic.com → Billing.', { kind: 'billing' });
    return new SummaryError(`The request was rejected: ${msg}`, { kind: 'bad_request', partial });
  }
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && err.status >= 500)) {
    return new SummaryError('Anthropic is temporarily overloaded or unavailable. Please try again shortly.', { kind: 'server', partial });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new SummaryError('Could not reach the Anthropic API. Check your internet connection (or a browser extension that blocks requests).', { kind: 'network', partial });
  }
  if (err instanceof Anthropic.APIError) return new SummaryError(`API error ${err.status}: ${err.message}`, { partial });
  return new SummaryError(err?.message || String(err), { partial });
}

async function streamOpenAICompatible({ conf, system, messages, maxTokens, signal, onText, onPhase }) {
  const base = (conf.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new SummaryError('Set the endpoint URL in Settings first.', { kind: 'config' });
  const url = base + '/chat/completions';
  const flat = [{ role: 'system', content: system }, ...messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n'),
  }))];
  const headers = { 'Content-Type': 'application/json' };
  if (conf.apiKey) headers.Authorization = `Bearer ${conf.apiKey}`;
  if (/openrouter\.ai/.test(base)) {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Precis Summarizer';
  }
  const body = { model: conf.model, messages: flat, stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } };

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw new SummaryError('Stopped.', { kind: 'abort' });
      const local = /localhost|127\.0\.0\.1/.test(base);
      throw new SummaryError(local
        ? `Could not reach ${base}. Make sure the local server is running and allows this site (for Ollama, start it with OLLAMA_ORIGINS="*").`
        : `Could not reach ${base}. Check the URL, your connection, and that the service allows browser (CORS) requests.`, { kind: 'network' });
    }
    if (res.status !== 400) break;
    const errText = await res.text();
    // Some APIs want different optional parameters; adapt once and retry.
    if (/max_completion_tokens/.test(errText) && body.max_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    } else if (/stream_options/.test(errText) && body.stream_options) delete body.stream_options;
    else throw new SummaryError(`The endpoint rejected the request: ${errorDetail(errText)}`, { kind: 'bad_request' });
  }
  if (!res.ok) {
    const detail = errorDetail(await res.text());
    if (res.status === 401 || res.status === 403) throw new SummaryError(`The API key was rejected (${res.status}): ${detail}`, { kind: 'auth' });
    if (res.status === 404) throw new SummaryError(`Not found (404). Check the endpoint URL and model name: ${detail}`, { kind: 'config' });
    if (res.status === 429) throw new SummaryError(`Rate limited (429): ${detail}`, { kind: 'rate' });
    throw new SummaryError(`Error ${res.status}: ${detail}`);
  }

  onPhase?.('writing');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let finish = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.error) throw new SummaryError(`Error from the model: ${json.error.message || JSON.stringify(json.error)}`, { partial: text });
        const choice = json.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onText?.(text);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (json.usage) usage = json.usage;
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw new SummaryError('Stopped.', { kind: 'abort', partial: text });
    throw err instanceof SummaryError ? err : new SummaryError(err?.message || String(err), { partial: text });
  }
  if (finish === 'content_filter') {
    throw new SummaryError('The model stopped because of its content filter. Try another model.', { kind: 'refusal', partial: text });
  }
  // Some local models wrap their reasoning in <think> tags; never show it as part of the summary.
  const clean = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return {
    text: clean,
    assistantContent: clean,
    stopReason: finish === 'length' ? 'max_tokens' : 'end_turn',
    model: conf.model,
    usage: { input: usage?.prompt_tokens || 0, output: usage?.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function errorDetail(text) {
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || j.detail || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

// ---------------------------------------------------------------- planning

export function providerLimits(settings) {
  if (settings.provider === 'anthropic') {
    return {
      inputTokens: Number(settings.advanced.chunkTokens) || 150000,
      partWords: Number(settings.advanced.partWords) || 3500,
      contextTokens: 1000000,
    };
  }
  const ctx = Math.max(2048, Number(settings.openai.contextTokens) || 8192);
  const partWords = Math.max(200, Math.min(Number(settings.advanced.partWords) || 3500, Math.floor((ctx * 0.3) / 1.5)));
  return {
    inputTokens: Math.max(800, Math.min(Number(settings.advanced.chunkTokens) || 150000, ctx - Math.ceil(partWords * 1.6) - 1600)),
    partWords,
    contextTokens: ctx,
  };
}

export function planSummary(text, ratio, settings) {
  const words = countWords(text);
  const target = Math.max(25, Math.round(words * ratio));
  const tokens = estimateTokens(text);
  const limits = providerLimits(settings);
  const byInput = Math.ceil(tokens / limits.inputTokens);
  const byOutput = Math.ceil(target / limits.partWords);
  let mode = 'single';
  let parts = 1;
  if (byInput > 1 || byOutput > 1) {
    if (target <= limits.partWords) {
      mode = 'mapreduce';
      parts = byInput;
    } else {
      mode = 'sequential';
      parts = Math.max(byInput, byOutput);
    }
  }
  return { words, target, tokens, limits, mode, parts };
}

export function estimateCost(plan, modelId) {
  const m = CLAUDE_MODELS.find((x) => x.id === modelId);
  if (!m) return null;
  const outWords = plan.target + (plan.mode === 'mapreduce' ? plan.words * 0.25 : 0);
  const inputTokens = plan.tokens + (plan.mode === 'sequential' ? plan.parts * 3500 : 0) + (plan.mode === 'mapreduce' ? outWords * 1.4 : 0) + 1200;
  const outputTokens = outWords * 1.4 * 1.8; // includes an allowance for the model's thinking
  const long = m.inputLong && inputTokens > 100000;
  return (inputTokens * (long ? m.inputLong : m.input) + outputTokens * (long ? m.outputLong : m.output)) / 1e6;
}

/** Split text into n parts of similar length, preferring chapter/section boundaries. */
export function splitIntoParts(text, n, maxTokens) {
  for (let count = Math.max(1, n); count < n + 50; count++) {
    const parts = splitBalanced(text, count);
    if (parts.every((p) => estimateTokens(p) <= maxTokens)) return parts;
  }
  return splitBalanced(text, n + 50);
}

function splitBalanced(text, n) {
  const total = countWords(text);
  const size = total / n;
  const units = [];
  for (const p of splitParagraphs(text)) {
    const w = countWords(p);
    if (w > size * 0.5) {
      // A giant paragraph (common in PDFs without line breaks): split it by sentences.
      let buf = [];
      let bw = 0;
      for (const s of splitSentences(p)) {
        buf.push(s);
        bw += countWords(s);
        if (bw >= size * 0.25) { units.push({ text: buf.join(' '), w: bw, heading: false }); buf = []; bw = 0; }
      }
      if (buf.length) units.push({ text: buf.join(' '), w: bw, heading: false });
    } else units.push({ text: p, w, heading: looksLikeHeading(p) });
  }
  const parts = [];
  let cur = [];
  let cw = 0;
  for (const u of units) {
    const remaining = n - parts.length;
    if (cur.length && remaining > 1 && ((cw >= size * 0.8 && u.heading) || cw + u.w > size * 1.12)) {
      parts.push(cur.join('\n\n'));
      cur = [];
      cw = 0;
    }
    cur.push(u.text);
    cw += u.w;
  }
  if (cur.length) parts.push(cur.join('\n\n'));
  return parts;
}

function tailWords(text, n) {
  const words = text.split(/(\s+)/);
  let count = 0;
  let i = words.length - 1;
  for (; i >= 0; i--) {
    if (/\S/.test(words[i]) && ++count >= n) break;
  }
  return i <= 0 ? text : '[…]\n' + words.slice(i).join('');
}

function maxTokensFor(words, settings, inputTokens) {
  if (settings.provider === 'anthropic') {
    return Math.min(128000, Math.max(16000, Math.round(words * 1.6) + 24000));
  }
  const ctx = Number(settings.openai.contextTokens) || 8192;
  const room = ctx - inputTokens - 300;
  return Math.max(256, Math.min(Number(settings.openai.maxOutputTokens) || 16000, Math.round(words * 1.8) + 600, room));
}

// ---------------------------------------------------------------- orchestration

/**
 * @param {{text: string, title: string, ratio: number, options: object, settings: object,
 *          signal: AbortSignal, onUpdate: (u: object) => void}} job
 */
export async function runSummary({ text, title, ratio, options, settings, signal, onUpdate }) {
  const provider = settings.provider;
  const conf = provider === 'anthropic' ? settings.anthropic : settings.openai;
  if (provider === 'anthropic' && !conf.apiKey) throw new SummaryError('Add your Anthropic API key in Settings first.', { kind: 'nokey' });
  if (provider === 'openai' && !conf.model) throw new SummaryError('Set the model name in Settings first.', { kind: 'config' });

  const streamFn = provider === 'anthropic' ? streamClaude : streamOpenAICompatible;
  const plan = planSummary(text, ratio, settings);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  let servedBy = conf.model;
  const warnings = [];

  const call = async (messages, targetWords, onText) => {
    const inputTokens = estimateTokens(JSON.stringify(messages)) + 900;
    const r = await streamFn({
      conf, system: SYSTEM_PROMPT, messages, signal, onText,
      maxTokens: maxTokensFor(targetWords, settings, inputTokens),
      onPhase: (phase, info) => {
        if (phase === 'fallback') warnings.push(`Part of this response was continued by ${info?.to?.model || 'a fallback model'} after the first model declined.`);
        onUpdate({ type: 'phase', phase });
      },
    });
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) usage[k] += r.usage[k];
    usage.calls++;
    servedBy = r.model || servedBy;
    if (r.stopReason === 'max_tokens') warnings.push('A response hit the output limit and may be cut short. Try a smaller percentage or a larger "max output" setting.');
    return r;
  };
  const docContent = (docBlock, instr) => (provider === 'anthropic'
    ? [{ type: 'text', text: docBlock, cache_control: { type: 'ephemeral' } }, { type: 'text', text: instr }]
    : `${docBlock}\n\n${instr}`);
  const emit = (t) => onUpdate({ type: 'text', text: t });

  // Length correction and extras happen as follow-up turns, so the original stays in (cached) context.
  const finish = async (messages, first, sourceIsNotes) => {
    let r = first;
    let summary = r.text.trim();
    const actual = countWords(summary);
    if (settings.advanced.autoLength && plan.target >= 120 && (actual < plan.target * 0.75 || actual > plan.target * 1.3) && !signal.aborted) {
      onUpdate({ type: 'status', message: `Fine-tuning length (${actual.toLocaleString()} → about ${plan.target.toLocaleString()} words)…` });
      messages.push({ role: 'assistant', content: r.assistantContent }, { role: 'user', content: lengthFixPrompt({ actual, target: plan.target }) });
      const r2 = await call(messages, plan.target, emit);
      if (countWords(r2.text) > 20) {
        r = r2;
        summary = r2.text.trim();
      } else messages.splice(-2, 2);
    }
    if (options.extras?.length && !signal.aborted) {
      onUpdate({ type: 'status', message: 'Adding extra sections…' });
      messages.push({ role: 'assistant', content: r.assistantContent }, {
        role: 'user',
        content: sourceIsNotes ? extrasFollowupPrompt(options).replace('Base them on the full original, with quotes taken verbatim from it.', 'Base them on the notes, with quotes taken verbatim from the quoted lines in them.') : extrasFollowupPrompt(options),
      });
      const r3 = await call(messages, 900, (t) => emit(`${summary}\n\n${t}`));
      summary = `${summary}\n\n${r3.text.trim()}`;
    }
    return summary;
  };

  let summary;
  if (plan.mode === 'single') {
    onUpdate({ type: 'status', message: 'Reading the whole document and writing the summary…', progress: null });
    const [docBlock, instr] = singlePassPrompt({ title, text, words: plan.words, target: plan.target, ratio, options });
    const messages = [{ role: 'user', content: docContent(docBlock, instr) }];
    const r = await call(messages, plan.target, emit);
    emit(r.text);
    summary = await finish(messages, r, false);
  } else if (plan.mode === 'sequential') {
    const parts = splitIntoParts(text, plan.parts, plan.limits.inputTokens);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      if (signal.aborted) throw new SummaryError('Stopped.', { kind: 'abort', partial: acc });
      const pw = countWords(parts[i]);
      const pt = Math.max(20, Math.round(pw * ratio));
      onUpdate({ type: 'status', message: `Condensing part ${i + 1} of ${parts.length}…`, progress: i / parts.length });
      const prompt = chunkPrompt({
        title, text: parts[i], words: pw, target: pt, ratio, options, index: i, total: parts.length,
        previous: acc ? tailWords(acc, 2500) : '',
      });
      let r;
      try {
        r = await call([{ role: 'user', content: prompt }], pt, (t) => emit(acc ? `${acc}\n\n${t}` : t));
      } catch (err) {
        if (err instanceof SummaryError) err.partial = acc + (err.partial ? `\n\n${err.partial}` : '');
        throw err;
      }
      acc = acc ? `${acc}\n\n${r.text.trim()}` : r.text.trim();
      emit(acc);
    }
    summary = acc;
    if (options.extras?.length && !signal.aborted) {
      onUpdate({ type: 'status', message: 'Adding extra sections…', progress: 0.98 });
      const source = estimateTokens(summary) > plan.limits.inputTokens ? tailWords(summary, Math.floor(plan.limits.inputTokens / 1.6)) : summary;
      const r = await call([{ role: 'user', content: extrasPrompt({ title, summary: source, extras: options.extras, options }) }], 900, (t) => emit(`${summary}\n\n${t}`));
      summary = `${summary}\n\n${r.text.trim()}`;
    }
  } else {
    // Map-reduce: dense notes per part, then one final summary written from all the notes.
    let source = text;
    let round = 0;
    let parts = splitIntoParts(source, plan.parts, plan.limits.inputTokens);
    // Each round shrinks the material to at most half, so a few rounds always suffice.
    while (parts.length > 1 && round < 6) {
      round++;
      const notes = [];
      for (let i = 0; i < parts.length; i++) {
        if (signal.aborted) throw new SummaryError('Stopped.', { kind: 'abort' });
        const pw = countWords(parts[i]);
        const nt = Math.max(60, Math.min(plan.limits.partWords, Math.max(250, Math.round(pw * 0.25)), Math.round(pw * 0.5)));
        onUpdate({
          type: 'status',
          message: `${round > 1 ? 'Consolidating notes' : 'Reading'} part ${i + 1} of ${parts.length}…`,
          progress: (i / parts.length) * 0.85,
        });
        const r = await call([{ role: 'user', content: notesPrompt({ title, text: parts[i], words: pw, target: nt, index: i, total: parts.length }) }], nt, null);
        notes.push(r.text.trim());
      }
      source = notes.join('\n\n');
      parts = estimateTokens(source) > plan.limits.inputTokens ? splitIntoParts(source, Math.ceil(estimateTokens(source) / plan.limits.inputTokens), plan.limits.inputTokens) : [source];
    }
    onUpdate({ type: 'status', message: 'Writing the final summary from the notes…', progress: 0.88 });
    const prompt = reducePrompt({ title, notes: source, originalWords: plan.words, target: plan.target, ratio, options });
    const messages = [{ role: 'user', content: provider === 'anthropic' ? [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] : prompt }];
    const r = await call(messages, plan.target, emit);
    summary = await finish(messages, r, true);
  }

  summary = summary.replace(/^\s*(here(?:'s| is) (?:a|the|your) [^\n]{0,80}summary[^\n]*:\s*\n)/i, '').trim();
  emit(summary);
  return { markdown: summary, usage, model: servedBy, plan, warnings: [...new Set(warnings)] };
}

export function costOf(usage, modelId) {
  const m = CLAUDE_MODELS.find((x) => modelId && modelId.startsWith(x.id));
  if (!m) return null;
  const long = m.inputLong && usage.input + usage.cacheRead + usage.cacheWrite > 100000 * Math.max(1, usage.calls);
  const inP = long ? m.inputLong : m.input;
  const outP = long ? m.outputLong : m.output;
  return (usage.input * inP + usage.cacheWrite * inP * 1.25 + usage.cacheRead * inP * 0.1 + usage.output * outP) / 1e6;
}
