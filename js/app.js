// UI controller for Précis (offline edition).
import { ACCEPT, extractFile, extension } from './extract.js';
import { countWords, readingMinutes, formatNumber, baseName, normalizeWhitespace, escapeHtml } from './textutil.js';
import { runEngine } from './engine.js';
import {
  renderMarkdown, markdownToPlain, fileStem, downloadMarkdown, downloadText, downloadHtml,
  downloadPdf, downloadDocx, printAsPdf, pdfNeedsPrint,
} from './export.js';
import {
  loadSettings, saveSettings, loadOptions, saveOptions, loadHistory, addHistory, updateHistory,
  deleteHistory, clearHistory, getTheme, setTheme,
} from './storage.js';
import { ReadAloud, speechSupported, neuralSupported, describeVoice, isEdge, NEURAL_VOICES } from './speech.js';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './sample.js';
import { initPwa } from './pwa.js';

// Must match PRECIS_BUILD in index.html (see the update safety net there).
window.PRECIS_BUILD_LOADED = '2026-10-27d';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const OCR_LANGS = [
  ['eng', 'English'], ['urd', 'Urdu'], ['ara', 'Arabic'], ['hin', 'Hindi'], ['ben', 'Bengali'], ['fas', 'Persian'],
  ['tur', 'Turkish'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'],
  ['nld', 'Dutch'], ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['pol', 'Polish'], ['ind', 'Indonesian'], ['msa', 'Malay'],
  ['chi_sim', 'Chinese (Simplified)'], ['chi_tra', 'Chinese (Traditional)'], ['jpn', 'Japanese'], ['kor', 'Korean'],
  ['vie', 'Vietnamese'], ['tha', 'Thai'],
];
const EXTRAS = [
  ['takeaways', 'Key takeaways'], ['keywords', 'Keywords'], ['names', 'Names mentioned'],
  ['quotes', 'Notable quotes'], ['figures', 'Key figures'], ['timeline', 'Timeline'],
];
const FORMAT_HINTS = {
  paragraphs: 'Reads like a shorter version of the original',
  bullets: 'One chosen sentence per bullet, grouped by section',
  sections: 'A heading for each chapter or part',
};
const PREVIEW_TEXT = {
  en: 'Hello! This is how your summary will sound with this voice.',
  ur: 'السلام علیکم! آپ کا خلاصہ اس آواز میں ایسا سنائی دے گا۔',
  ar: 'مرحبًا! هكذا سيبدو ملخصك بهذا الصوت.',
  hi: 'नमस्ते! आपका सारांश इस आवाज़ में ऐसा सुनाई देगा।',
  es: '¡Hola! Así sonará tu resumen con esta voz.',
  fr: 'Bonjour ! Voici comment votre résumé sonnera avec cette voix.',
  de: 'Hallo! So klingt Ihre Zusammenfassung mit dieser Stimme.',
};

// Remove data the earlier online version may have stored (including any API key).
for (const k of ['precis.settings.v1', 'precis.options.v1']) {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}
try { sessionStorage.removeItem('precis.keys.session'); } catch { /* ignore */ }

const state = {
  settings: loadSettings(),
  options: loadOptions(),
  files: [], // {id, file, name, ext, size, status, text, meta, error, pdfOpts}
  manualText: false,
  busy: false,
  result: null, // {id, markdown, title, pct, srcWords, stats, options, selected, lang, sourceKey}
  editing: false,
  contextOn: false,
};

const el = {
  fileInput: $('#file-input'), dropzone: $('#dropzone'), fileList: $('#file-list'), ocrLang: $('#ocr-lang'),
  title: $('#doc-title'), source: $('#source-text'), sourceStats: $('#source-stats'),
  pdfTools: $('#pdf-tools'), pageFrom: $('#page-from'), pageTo: $('#page-to'), pageTotal: $('#page-total'),
  autoOcr: $('#auto-ocr'), extractProgress: $('#extract-progress'),
  ratio: $('#ratio'), ratioOut: $('#ratio-out'), targetWords: $('#target-words'), lengthDetail: $('#length-detail'),
  format: $('#format'), formatHint: $('#format-hint'), focus: $('#focus'),
  smooth: $('#opt-smooth'), dedupe: $('#opt-dedupe'), trim: $('#opt-trim'), gaps: $('#opt-gaps'),
  extras: $('#extras'), run: $('#btn-run'),
  output: $('#output'), outputScroll: $('#output-scroll'), editor: $('#output-editor'), context: $('#context-view'),
  stats: $('#output-stats'), statsLine: $('#stats-line'), coverage: $('#coverage'), notice: $('#notice'),
  toast: $('#toast'), player: $('#player'),
};
const EMPTY_HTML = el.output.innerHTML;

// ------------------------------------------------------------------ helpers

let toastTimer;
function toast(msg, ms = 3200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function showNotice(html, kind = 'warn') {
  if (!html) { el.notice.hidden = true; el.notice.innerHTML = ''; return; }
  el.notice.className = `notice ${kind === 'error' ? 'error' : ''}`;
  el.notice.innerHTML = html;
  el.notice.hidden = false;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fillSelect(select, entries, value) {
  select.innerHTML = '';
  for (const [v, label] of entries) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }
  if (value != null) select.value = value;
}

function sourceKey() {
  const t = el.source.value;
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return `${t.length}|${h >>> 0}`;
}

// ------------------------------------------------------------------ options

function initOptionsUI() {
  const o = state.options;
  el.ratio.value = Math.round(o.ratio * 100);
  el.format.value = FORMAT_HINTS[o.format] ? o.format : 'paragraphs';
  el.formatHint.textContent = FORMAT_HINTS[el.format.value];
  el.focus.value = o.focus || '';
  el.smooth.checked = o.smooth !== false;
  el.dedupe.checked = o.dedupe !== false;
  el.trim.checked = !!o.trim;
  el.gaps.checked = !!o.markGaps;
  el.extras.innerHTML = '';
  for (const [k, label] of EXTRAS) {
    const lab = document.createElement('label');
    lab.className = 'chip';
    lab.innerHTML = `<input type="checkbox" value="${k}"><span>${label}</span>`;
    lab.querySelector('input').checked = o.extras.includes(k);
    el.extras.appendChild(lab);
  }
  fillSelect(el.ocrLang, OCR_LANGS, state.settings.ocrLang);
  el.autoOcr.checked = state.settings.autoOcr !== false;
  fillSelect($('#ai-model'), AI_CHOICES, o.aiModel || 'fast');
  const writer = o.writer === 'ai' ? 'ai' : 'extract';
  $(`input[name=writer][value=${writer}]`).checked = true;
  syncWriterUI();
}

const AI_CHOICES = [
  ['fast', 'Fast: Qwen 2.5, 1.5B (about 1 GB download)'],
  ['best', 'Best writing: Hermes 3, Llama 3.2 3B (about 1.8 GB download)'],
];

/** WebGPU check without loading the AI library. */
async function gpuCheck() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'This browser has no WebGPU, which on-device AI needs. Use the latest Chrome or Edge on a computer.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { ok: true } : { ok: false, reason: 'No compatible graphics card was found for on-device AI.' };
  } catch (err) {
    return { ok: false, reason: `WebGPU is not available: ${err.message}` };
  }
}

async function syncWriterUI() {
  const ai = $('input[name=writer]:checked').value === 'ai';
  $('#ai-options').hidden = !ai;
  $('#faithful-note').textContent = ai
    ? 'The AI only rewrites the key sentences chosen from your text, is told to keep every detail (including mature content) and to add nothing. Where it fails, the author\'s sentences are kept.'
    : 'Only the author\'s own sentences are used, so nothing is reworded, softened or censored.';
  if (!ai) return;
  const hint = $('#ai-hint');
  const gpu = await gpuCheck();
  hint.classList.toggle('bad', !gpu.ok);
  hint.textContent = gpu.ok
    ? 'Runs on your graphics card. The first rewrite downloads the model once; after that it works offline. Rewriting takes longer than the instant mode.'
    : gpu.reason;
}

function readOptions() {
  state.options = {
    ratio: Number(el.ratio.value) / 100,
    format: el.format.value,
    focus: el.focus.value.trim(),
    smooth: el.smooth.checked,
    dedupe: el.dedupe.checked,
    trim: el.trim.checked,
    markGaps: el.gaps.checked,
    extras: $$('input', el.extras).filter((i) => i.checked).map((i) => i.value),
    writer: $('input[name=writer]:checked')?.value === 'ai' ? 'ai' : 'extract',
    aiModel: $('#ai-model').value || 'fast',
  };
  saveOptions(state.options);
  return state.options;
}

// ------------------------------------------------------------------ source text

function setExtractProgress(msg, frac) {
  if (msg == null) { el.extractProgress.hidden = true; return; }
  el.extractProgress.hidden = false;
  $('.msg', el.extractProgress).textContent = msg;
  const bar = $('.bar', el.extractProgress);
  bar.classList.toggle('indeterminate', frac == null);
  $('span', bar).style.width = frac == null ? '' : `${Math.round(frac * 100)}%`;
}

function rebuildSourceFromFiles() {
  const ready = state.files.filter((f) => f.status === 'ready' && f.text);
  el.source.value = ready.length === 1 ? ready[0].text : ready.map((f) => `# ${baseName(f.name)}\n\n${f.text}`).join('\n\n');
  state.manualText = false;
  if (!el.title.dataset.userSet) {
    el.title.value = ready.length === 1 ? (ready[0].meta?.title || baseName(ready[0].name)) : ready.length ? `${ready.length} documents` : '';
  }
  updateSourceStats();
}

function renderFileList() {
  el.fileList.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    let info = fmtSize(f.size);
    if (f.status === 'reading') info = 'reading…';
    else if (f.status === 'error') info = `<span class="state-err">${escapeHtml(f.error)}</span>`;
    else if (f.status === 'ready') {
      const bits = [`${formatNumber(countWords(f.text))} words`];
      if (f.meta?.pages) bits.unshift(f.meta.from > 1 || f.meta.to < f.meta.pages ? `pages ${f.meta.from}–${f.meta.to} of ${f.meta.pages}` : `${f.meta.pages} pages`);
      if (f.meta?.ocr) bits.push('OCR');
      info = bits.join(' · ');
    }
    li.innerHTML = `<span class="badge">${escapeHtml(f.ext || 'file')}</span><span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><span class="info">${info}</span><button type="button" aria-label="Remove ${escapeHtml(f.name)}">✕</button>`;
    li.querySelector('button').addEventListener('click', () => removeFile(f.id));
    el.fileList.appendChild(li);
  }
  renderPdfTools();
}

// Page range and OCR controls, shown when a single PDF is loaded.
function renderPdfTools() {
  const f = state.files.length === 1 && state.files[0].ext === 'pdf' && state.files[0].status === 'ready' ? state.files[0] : null;
  el.pdfTools.hidden = !f;
  if (!f) return;
  const m = f.meta;
  $('#pdf-range-row').hidden = m.pages < 2;
  el.pageFrom.max = el.pageTo.max = m.pages;
  el.pageFrom.value = m.from;
  el.pageTo.value = m.to;
  el.pageTotal.textContent = `of ${m.pages}`;
  const range = m.to - m.from + 1;
  let status;
  if (m.ocr === 'all') status = `All ${range} page${range > 1 ? 's' : ''} read with OCR.`;
  else if (m.ocrPages) status = `${m.ocrPages} scanned page${m.ocrPages > 1 ? 's' : ''} recognised with OCR.`;
  else if (m.emptyPages) status = `${m.emptyPages} of ${range} page${range > 1 ? 's have' : ' has'} no selectable text (scanned).`;
  else status = 'Text read from the PDF.';
  $('#pdf-ocr-status').textContent = status;
  $('#btn-ocr-empty').hidden = !(m.emptyPages && !m.ocr);
  $('#btn-ocr-all').hidden = m.ocr === 'all';
  $('#btn-ocr-off').hidden = !m.ocr;
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  if (!files.length) return;
  if (state.manualText && el.source.value.trim() && !state.files.length && !confirm('Replace the text in the box with the uploaded file(s)?')) return;
  const entries = files.map((file) => ({
    id: crypto.randomUUID(), file, name: file.name, ext: extension(file.name), size: file.size, status: 'reading', text: '', meta: null,
  }));
  state.files.push(...entries);
  renderFileList();
  for (const entry of entries) await extractEntry(entry, {});
  setExtractProgress(null);
}

/** @param {{pageFrom?: number, pageTo?: number, ocr?: 'empty'|'all'|null}} opts for PDFs */
async function extractEntry(entry, opts = {}) {
  entry.status = 'reading';
  renderFileList();
  entry.pdfOpts = { ocr: state.settings.autoOcr ? 'empty' : null, ...entry.pdfOpts, ...opts };
  try {
    const { text, meta } = await extractFile(entry.file, {
      ...entry.pdfOpts, password: entry.meta?.password, ocrLang: state.settings.ocrLang,
      onProgress: (msg, frac) => setExtractProgress(msg, frac),
    });
    entry.text = normalizeWhitespace(text || '');
    entry.meta = meta;
    entry.status = 'ready';
    if (!entry.text) {
      entry.status = meta?.emptyPages && !meta.ocr ? 'ready' : 'error';
      entry.error = 'no text found';
      if (entry.status === 'ready') toast('This PDF is scanned. Press "Recognise scanned pages" to read it.', 6000);
    } else if (meta?.ocrPages) toast(`Recognised ${meta.ocrPages} scanned page${meta.ocrPages > 1 ? 's' : ''} with OCR.`);
  } catch (err) {
    console.error(err);
    entry.status = 'error';
    entry.error = err?.message || 'could not read this file';
    toast(`${entry.name}: ${entry.error}`, 6000);
  }
  renderFileList();
  rebuildSourceFromFiles();
}

function removeFile(id) {
  if (state.manualText && !confirm('Removing a file rebuilds the text box and discards your edits. Continue?')) return;
  state.files = state.files.filter((x) => x.id !== id);
  renderFileList();
  rebuildSourceFromFiles();
}

function clearSource() {
  state.files = [];
  el.source.value = '';
  el.title.value = '';
  delete el.title.dataset.userSet;
  state.manualText = false;
  renderFileList();
  updateSourceStats();
}

function updateSourceStats() {
  const text = el.source.value;
  const words = countWords(text);
  el.sourceStats.innerHTML = words
    ? `<b>${formatNumber(words)}</b> words · ${formatNumber(text.length)} characters · ~${readingMinutes(words)} min read`
    : 'No text yet';
  updateLength();
}

function updateLength() {
  const pct = Number(el.ratio.value);
  el.ratioOut.textContent = `${pct}%`;
  $$('.presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ratio) === pct));
  const words = countWords(el.source.value);
  const target = Math.round((words * pct) / 100);
  if (document.activeElement !== el.targetWords) el.targetWords.value = words ? target : '';
  el.targetWords.disabled = !words;
  el.lengthDetail.textContent = words
    ? `· ~${readingMinutes(target)} min read instead of ~${readingMinutes(words)} (${(100 / pct).toFixed(pct >= 50 ? 1 : 0)}× shorter)`
    : '· add some text to see the estimate';
}

// ------------------------------------------------------------------ summarizing

function setToolsEnabled(on) {
  for (const id of ['#btn-copy', '#btn-download', '#btn-print', '#btn-speak', '#btn-edit', '#btn-context']) $(id).disabled = !on;
}

// Render streaming text at most once per animation frame, following the end of the text while it grows.
let renderPending = null;
function renderOutput(md, { streaming = false } = {}) {
  const first = !renderPending;
  renderPending = { md, streaming };
  if (!first) return;
  requestAnimationFrame(() => {
    const { md: text, streaming: live } = renderPending;
    renderPending = null;
    const scroller = el.outputScroll;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    el.output.innerHTML = renderMarkdown(text);
    el.output.classList.toggle('streaming', live);
    if (live && atBottom) scroller.scrollTop = scroller.scrollHeight;
  });
}

function renderEmpty() {
  el.output.innerHTML = EMPTY_HTML;
  setToolsEnabled(false);
  el.stats.hidden = true;
}

let runSeq = 0;
/** @param {{live?: boolean}} opts live = an automatic refresh after an option change */
async function summarize({ live = false } = {}) {
  const text = el.source.value.trim();
  if (!text) {
    if (!live) { toast('Add a file, paste some text, or try the sample first.'); el.source.focus(); }
    return;
  }
  const options = readOptions();
  const title = el.title.value.trim();
  const seq = ++runSeq;
  const key = sourceKey();
  const big = text.length > 300000;
  state.busy = true;
  el.run.classList.add('running');
  if (!live || big) $('.label', el.run).textContent = 'Summarizing…';
  showNotice(null);
  try {
    const res = await runEngine('summarize', { text, title, options }, (p) => {
      if (seq === runSeq && big) $('.label', el.run).textContent = `Reading… ${Math.round(p * 100)}%`;
    });
    if (seq !== runSeq) return; // a newer run superseded this one
    if (!res.markdown) {
      showNotice('Not enough complete sentences to summarize. Try a longer text.');
      return;
    }
    // A title found in the text itself beats one made from the file name.
    if (res.title && !el.title.dataset.userSet && el.title.value !== res.title) el.title.value = res.title;
    const docTitle = el.title.value.trim() || 'Untitled';
    const result = {
      markdown: res.markdown, body: res.body, extras: res.extras, title: docTitle, pct: Math.round(options.ratio * 100),
      srcWords: res.stats.words, stats: res.stats, options, selected: res.selected, lang: res.lang, sourceKey: key,
    };
    const sameDoc = state.result && state.result.sourceKey === key && state.result.id;
    if (sameDoc) {
      result.id = state.result.id;
      updateHistory(result.id, historyEntry(result));
    } else {
      result.id = addHistory(historyEntry(result))[0]?.id;
    }
    showResult(result);
    if (!live && matchMedia('(max-width: 1060px)').matches) $('.output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (options.writer === 'ai') {
      if (live) showNotice('Showing the author\'s sentences for the new settings. Press <b>Summarize</b> to rewrite them with AI.');
      else aiRewrite(result);
    }
  } catch (err) {
    console.error(err);
    showNotice(`Something went wrong while summarizing: ${escapeHtml(err.message || String(err))}`, 'error');
  } finally {
    if (seq === runSeq) {
      state.busy = false;
      el.run.classList.remove('running');
      $('.label', el.run).textContent = 'Summarize';
    }
  }
}

function historyEntry(r) {
  return {
    title: r.title, markdown: r.markdown, pct: r.pct, words: r.stats?.summaryWords ?? countWords(r.markdown),
    srcWords: r.srcWords, engine: r.ai ? 'ai' : 'offline', model: r.ai?.model, options: r.options,
  };
}

let liveTimer;
function scheduleLive() {
  if (!state.result || state.result.sourceKey !== sourceKey() || state.editing) return;
  if (state.result.edited) {
    showNotice('You edited this summary by hand, so it no longer updates automatically. Press <b>Summarize</b> for a fresh one.');
    return;
  }
  if (aiJob) aiJob.cancelled = true;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => summarize({ live: true }), 180);
}

// ------------------------------------------------------------------ AI rewrite

let aiJob = null;

function setStatus(msg, progress) {
  const box = $('#status');
  if (msg == null) { box.hidden = true; return; }
  box.hidden = false;
  $('#status-msg').textContent = msg;
  const bar = $('#status-bar');
  bar.classList.toggle('indeterminate', progress == null);
  $('span', bar).style.width = progress == null ? '' : `${Math.max(2, Math.round(progress * 100))}%`;
}

async function aiRewrite(result) {
  if (aiJob) aiJob.cancelled = true;
  const job = { cancelled: false };
  aiJob = job;
  reader.stop();
  setStatus('Starting the on-device AI…', null);
  try {
    const gpu = await gpuCheck();
    if (!gpu.ok) {
      showNotice(`${escapeHtml(gpu.reason)} Showing the author's own sentences instead.`);
      return;
    }
    const ai = await import('./rewrite.js');
    const gpuInfo = await ai.webgpuStatus();
    const modelId = ai.modelIdFor(result.options.aiModel, gpuInfo.f16);
    const engine = await ai.getEngine(modelId, (r) => {
      if (job.cancelled) return;
      const pct = Math.round((r.progress || 0) * 100);
      const msg = /fetch/i.test(r.text || '') ? `Downloading the AI model (one time only): ${pct}%`
        : /load|shader|cache/i.test(r.text || '') ? `Loading the AI model into your graphics card: ${pct}%` : 'Preparing the AI model…';
      setStatus(msg, r.progress || null);
    });
    if (job.cancelled) return;
    el.output.classList.add('streaming');
    const res = await ai.rewriteSummary({
      engine,
      markdown: result.body,
      onText: (md) => { if (!job.cancelled) renderOutput(md + result.extras, { streaming: true }); },
      onStatus: (msg, p) => { if (!job.cancelled) setStatus(msg, p ?? null); },
      isCancelled: () => job.cancelled,
    });
    if (job.cancelled || state.result !== result) return;
    result.extractMarkdown = result.markdown;
    result.markdown = res.markdown + result.extras;
    result.ai = { model: modelId, fallbacks: res.fallbacks, chunks: res.chunks };
    result.stats = { ...result.stats, summaryWords: countWords(res.markdown) };
    if (result.id) updateHistory(result.id, historyEntry(result));
    showResult(result);
    showAiNotice(result);
  } catch (err) {
    console.error(err);
    if (!job.cancelled) {
      showNotice(`The on-device AI could not run: ${escapeHtml(err.message || String(err))}. Showing the author's own sentences instead.`, 'error');
      if (state.result === result) showResult(result);
    }
  } finally {
    if (aiJob === job) aiJob = null;
    setStatus(null);
    el.output.classList.remove('streaming');
  }
}

function showAiNotice(result) {
  const r = result.ai;
  if (!r) return;
  const name = escapeHtml(r.model.split('-q4')[0]);
  const bits = r.fallbacks && r.fallbacks === r.chunks
    ? [`${name} declined or couldn't rewrite this text, so the author's own sentences are shown. You can try the other AI model.`]
    : [`Rewritten on your device by ${name}.`];
  if (r.fallbacks && r.fallbacks < r.chunks) bits.push(`In ${r.fallbacks} of ${r.chunks} parts the AI's text wasn't usable, so the author's sentences were kept there.`);
  showNotice(`${bits.join(' ')} <button class="small" type="button" id="btn-toggle-ai">Show the author's original sentences</button>`);
  $('#btn-toggle-ai').addEventListener('click', (e) => {
    const showingAi = state.result.markdown !== state.result.extractMarkdown && !state.result.viewingOriginal;
    state.result.viewingOriginal = showingAi;
    el.output.innerHTML = renderMarkdown(showingAi ? state.result.extractMarkdown : state.result.markdown);
    e.target.textContent = showingAi ? 'Show the AI version' : 'Show the author\'s original sentences';
    if (!el.player.hidden) reader.load(el.output);
  });
}

function stopAi() {
  if (!aiJob) return;
  aiJob.cancelled = true;
  import('./rewrite.js').then((ai) => ai.interrupt()).catch(() => {});
  setStatus(null);
  if (state.result) showResult(state.result);
  toast('AI rewrite stopped. Showing the author\'s sentences.');
}

function showResult(result) {
  if (state.editing) toggleEdit(false);
  reader.stop();
  state.result = result;
  const scroller = el.outputScroll;
  const keep = scroller.scrollTop;
  el.output.innerHTML = renderMarkdown(result.markdown);
  scroller.scrollTop = keep;
  setToolsEnabled(true);
  $('#btn-context').disabled = !result.selected; // history items have no source to show
  if (state.contextOn) {
    if (result.selected) renderContext();
    else toggleContext(false);
  }
  if (!el.player.hidden) reader.load(el.output);
  showStats();
}

function showStats() {
  const r = state.result;
  if (!r) { el.stats.hidden = true; return; }
  const words = r.stats?.summaryWords ?? countWords(r.markdown);
  const pct = r.srcWords ? (words / r.srcWords) * 100 : 0;
  const saved = Math.max(0, readingMinutes(r.srcWords) - readingMinutes(words));
  const ease = r.stats?.readingEase;
  const easeLabel = ease == null ? '' : ease >= 80 ? 'very easy' : ease >= 65 ? 'easy' : ease >= 50 ? 'moderate' : ease >= 30 ? 'difficult' : 'very difficult';
  const bits = [
    `<span><b>${formatNumber(words)}</b> words</span>`,
    r.srcWords ? `<span><b>${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</b> of ${formatNumber(r.srcWords)}</span>` : '',
    r.stats ? `<span>${formatNumber(r.stats.chosen)} of ${formatNumber(r.stats.sentences)} sentences</span>` : '',
    saved ? `<span>saves ~<b>${saved} min</b> of reading</span>` : '',
    easeLabel ? `<span title="Flesch reading ease of the original: ${ease}">original reads <b>${easeLabel}</b></span>` : '',
    r.stats?.ms != null ? `<span>${r.stats.ms < 1000 ? `${r.stats.ms} ms` : `${(r.stats.ms / 1000).toFixed(1)} s`}</span>` : '',
  ];
  el.statsLine.innerHTML = bits.filter(Boolean).join('');
  el.coverage.innerHTML = '';
  if (r.stats?.coverage?.length) {
    const frag = document.createDocumentFragment();
    for (const x of r.stats.coverage) {
      const t = document.createElement('i');
      t.style.left = `${(x * 100).toFixed(2)}%`;
      frag.appendChild(t);
    }
    el.coverage.appendChild(frag);
    el.coverage.hidden = false;
  } else el.coverage.hidden = true;
  el.stats.hidden = false;
}

// ------------------------------------------------------------------ context view

async function renderContext() {
  const r = state.result;
  if (!r?.selected) return;
  const paras = await runEngine('context', { selected: r.selected });
  if (state.result !== r || !state.contextOn) return;
  const html = [];
  for (const p of paras) {
    if (p.h) { html.push(`<h3>${escapeHtml(p.h)}</h3>`); continue; }
    const inner = p.s.map((x) => (x.s ? `<mark>${escapeHtml(x.t)}</mark>` : `<span class="dim">${escapeHtml(x.t)}</span>`)).join(' ');
    html.push(p.list ? `<p class="li">${inner}</p>` : `<p>${inner}</p>`);
  }
  el.context.innerHTML = `<p class="context-note">Highlighted sentences are the ones in the summary. Dimmed text was left out.</p>${html.join('')}`;
  el.context.querySelector('mark')?.scrollIntoView({ block: 'center' });
}

function toggleContext(force) {
  const on = force ?? !state.contextOn;
  if (on && !state.result?.selected) return;
  if (on && state.editing) toggleEdit(false);
  state.contextOn = on;
  const btn = $('#btn-context');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  el.context.hidden = !on;
  el.output.hidden = on;
  if (on) {
    reader.stop();
    renderContext();
  } else el.context.innerHTML = '';
}

// ------------------------------------------------------------------ output tools

function exportMeta() {
  const r = state.result;
  return {
    title: r.title || 'Untitled', source: r.title, pct: r.pct, words: countWords(currentMarkdown()), date: Date.now(),
    stem: fileStem(r.title, r.pct),
  };
}

function currentMarkdown() {
  if (state.editing) return el.editor.value;
  if (state.result?.viewingOriginal) return state.result.extractMarkdown;
  return state.result?.markdown || '';
}

/** Copy the whole summary: formatted for Word/Docs/email, with plain text for everything else. */
async function copy() {
  const md = currentMarkdown();
  if (!md) return;
  const plain = markdownToPlain(md);
  const html = renderMarkdown(md);
  if (await copyModern(html, plain) || copyBySelection(html, plain)) toast('Summary copied');
  else toast('Copy failed. Select the summary text and press Ctrl+C instead.', 6000);
}

async function copyModern(html, plain) {
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('no rich clipboard');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    })]);
    return true;
  } catch {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(plain);
      return true;
    } catch {
      return false;
    }
  }
}

// Older method that still works where the clipboard API is blocked: select a hidden copy and "copy" it.
function copyBySelection(html, plain) {
  const box = document.createElement('div');
  box.innerHTML = html;
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap;';
  document.body.appendChild(box);
  const sel = window.getSelection();
  const saved = sel.rangeCount ? sel.getRangeAt(0) : null;
  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(range);
    ok = document.execCommand('copy');
  } catch { ok = false; }
  sel.removeAllRanges();
  if (saved) sel.addRange(saved);
  box.remove();
  if (ok) return true;
  const ta = document.createElement('textarea');
  ta.value = plain;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.appendChild(ta);
  ta.select();
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function download(kind) {
  const md = currentMarkdown();
  if (!md) return;
  const meta = exportMeta();
  try {
    if (kind === 'pdf') {
      if (pdfNeedsPrint(md, meta)) {
        toast('Choose "Save as PDF" in the print window (this keeps every script and right-to-left text correct).', 6000);
        printAsPdf(md, meta);
        return;
      }
      toast('Creating PDF…');
      await downloadPdf(md, meta);
    } else if (kind === 'docx') {
      toast('Creating Word document…');
      await downloadDocx(md, meta);
    } else if (kind === 'md') downloadMarkdown(md, meta);
    else if (kind === 'html') downloadHtml(md, meta);
    else if (kind === 'txt') downloadText(md, meta);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`, 6000);
  }
}

function toggleEdit(force) {
  const on = force ?? !state.editing;
  if (!state.result && on) return;
  if (on && state.contextOn) toggleContext(false);
  state.editing = on;
  $('#btn-edit').classList.toggle('on', on);
  $('#btn-edit span').textContent = on ? 'Done' : 'Edit';
  if (on) {
    reader.stop();
    el.editor.value = state.result.markdown;
    el.editor.hidden = false;
    el.output.hidden = true;
    el.editor.focus();
  } else {
    if (state.result && el.editor.value !== state.result.markdown) {
      state.result.markdown = el.editor.value;
      state.result.stats = state.result.stats && { ...state.result.stats, summaryWords: countWords(el.editor.value) };
      state.result.edited = true;
      if (state.result.id) updateHistory(state.result.id, { markdown: state.result.markdown, words: countWords(state.result.markdown) });
      showStats();
    }
    el.editor.hidden = true;
    el.output.hidden = false;
    if (state.result) el.output.innerHTML = renderMarkdown(state.result.markdown);
  }
}

// ------------------------------------------------------------------ read aloud

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8L7 4Z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';

function setVoiceStatus(msg, frac) {
  const box = $('#tts-status');
  if (msg == null) { box.hidden = true; return; }
  box.hidden = false;
  $('.msg', box).textContent = msg;
  const bar = $('.bar', box);
  bar.hidden = frac === false;
  bar.classList.toggle('indeterminate', frac == null);
  $('span', bar).style.width = frac == null || frac === false ? '' : `${Math.round(frac * 100)}%`;
}

const reader = new ReadAloud({
  onState: ({ playing, index, total }) => {
    const play = $('#tts-play');
    play.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    play.title = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    $('#tts-pos').textContent = total ? `Paragraph ${Math.max(1, index + 1)} of ${total}` : '';
    $('#btn-speak').classList.toggle('on', playing || !el.player.hidden);
  },
  onStatus: (s) => {
    if (saving) return;
    if (s.kind === 'download') {
      const mb = (n) => Math.round(n / 1048576);
      setVoiceStatus(`Downloading the natural voice (one time only): ${mb(s.loaded)} of ${mb(s.total)} MB`, s.loaded / s.total);
    } else if (s.kind === 'loading') setVoiceStatus('Preparing the natural voice…', null);
    else if (s.kind === 'buffering') setVoiceStatus('Generating speech… (tip: "Save as audio" makes a gap-free recording on slower computers)', null);
    else if (s.kind === 'error') setVoiceStatus(`The natural voice could not start: ${s.message}. Choose one of your browser's voices instead.`, false);
    else setVoiceStatus(null);
  },
});

async function openPlayer() {
  if (!speechSupported() && !neuralSupported()) { toast('Your browser does not support reading aloud.'); return; }
  if (!el.player.hidden) { closePlayer(); return; }
  if (state.editing) toggleEdit(false);
  if (state.contextOn) toggleContext(false);
  el.player.hidden = false;
  $('#btn-speak').setAttribute('aria-expanded', 'true');
  reader.unlockAudio();
  await fillVoices();
  reader.load(el.output);
  reader.play();
}

function closePlayer() {
  reader.stop();
  el.player.hidden = true;
  setVoiceStatus(null);
  $('#btn-speak').setAttribute('aria-expanded', 'false');
  $('#btn-speak').classList.remove('on');
}

const GRADE_STARS = { A: '★★★', B: '★★', C: '★' };

async function fillVoices() {
  const select = $('#tts-voice');
  const voices = await reader.refreshVoices();
  const lang = state.result?.lang || 'en';
  select.innerHTML = '';
  if (neuralSupported()) {
    const group = document.createElement('optgroup');
    group.label = lang === 'en' ? 'Natural voices (built in, English)' : 'Natural voices (English only)';
    for (const v of NEURAL_VOICES) {
      const o = document.createElement('option');
      o.value = `k:${v.id}`;
      const stars = GRADE_STARS[v.grade[0]] || '';
      o.textContent = `${v.name} · ${v.accent} ${v.gender.toLowerCase()}${stars ? ` ${stars}` : ''}`;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  for (const [label, list] of reader.browserVoiceGroups(lang)) {
    const group = document.createElement('optgroup');
    group.label = `Browser voices: ${label}`;
    for (const v of list) {
      const d = describeVoice(v);
      const o = document.createElement('option');
      o.value = `b:${v.voiceURI}`;
      o.textContent = `${d.natural ? '★ ' : ''}${d.name}${d.region ? ` · ${d.region}` : ''}${d.online ? '' : ' · on this device'}`;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  if (!select.options.length) select.innerHTML = '<option value="">Default voice</option>';
  const chosen = reader.pickDefaultVoice(lang);
  if (chosen) select.value = chosen;
  reader.setPrefs({ voice: select.value }, { save: false });
  $('#tts-rate').value = reader.prefs.rate;
  $('#tts-pitch').value = reader.prefs.pitch;
  $('#tts-rate-out').textContent = `${Number(reader.prefs.rate).toFixed(2).replace(/0$/, '')}×`;
  $('#tts-pitch-out').textContent = Number(reader.prefs.pitch).toFixed(2).replace(/0$/, '');
  updateVoiceHint();
}

function updateVoiceHint() {
  const hint = [];
  const neural = reader.isNeural;
  $('#tts-pitch').disabled = neural;
  $('#tts-pitch').closest('.field').title = neural ? 'Pitch can only be changed for browser voices.' : '';
  $('#tts-save').hidden = !neural;
  if (neural) {
    if (state.result?.lang && state.result.lang !== 'en') hint.push('Natural voices speak English only; for this text choose a browser voice.');
    else hint.push('Natural voices run on your device. The first time, the voice model downloads once (about 90 MB, or 330 MB for the faster graphics-card version); after that it works offline.');
  } else {
    const v = reader.browserVoice;
    if (!reader.voices.some((x) => describeVoice(x).natural) && !isEdge()) {
      hint.push('Tip: for Microsoft\'s natural voices in other languages (including Urdu), open this page in <b>Microsoft Edge</b>.');
    }
    if (v && !v.localService) hint.push('This voice is online: your browser sends the text being read to its voice service.');
  }
  $('#tts-hint').innerHTML = hint.join(' ');
  $('#tts-hint').hidden = !hint.length;
}

let saving = null;
async function saveAudio() {
  const btn = $('#tts-save');
  if (saving) { saving.cancelled = true; return; }
  reader.pause();
  if (!reader.blocks.length) reader.load(el.output);
  saving = { cancelled: false };
  const job = saving;
  btn.textContent = 'Cancel saving';
  try {
    const blob = await reader.exportWav(
      (done, total) => setVoiceStatus(`Creating audio: sentence ${Math.min(done + 1, total)} of ${total}…`, done / total),
      () => job.cancelled,
    );
    if (blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${exportMeta().stem}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Audio saved.');
    }
  } catch (err) {
    toast(`Could not create the audio: ${err.message}`, 6000);
  } finally {
    saving = null;
    btn.textContent = 'Save as audio (.wav)';
    setVoiceStatus(null);
  }
}

// ------------------------------------------------------------------ reading settings

const READ_KEY = 'precis.reading.v1';
const READ_FONTS = [
  ['serif', 'Source Serif (book)', '"Source Serif 4", Georgia, serif', null],
  ['georgia', 'Georgia (classic)', 'Georgia, "Times New Roman", serif', null],
  ['sans', 'Inter (clean)', 'Inter, system-ui, sans-serif', null],
  ['atkinson', 'Atkinson Hyperlegible (easy to read)', '"Atkinson Hyperlegible", system-ui, sans-serif', 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400'],
  ['lexend', 'Lexend (relaxed reading)', 'Lexend, system-ui, sans-serif', 'Lexend:wght@400;600'],
  ['literata', 'Literata (e-book)', 'Literata, Georgia, serif', 'Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400'],
  ['nastaliq', 'Noto Nastaliq (Urdu)', '"Noto Nastaliq Urdu", "Source Serif 4", serif', 'Noto+Nastaliq+Urdu:wght@400;700'],
  ['naskh', 'Noto Naskh (Arabic)', '"Noto Naskh Arabic", "Source Serif 4", serif', 'Noto+Naskh+Arabic:wght@400;700'],
  ['system', 'System default', 'system-ui, sans-serif', null],
  ['mono', 'Monospace', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', null],
];
const READ_DEFAULTS = { font: 'serif', size: 17.5, leading: 1.72, width: '72ch' };

function loadReading() {
  try { return { ...READ_DEFAULTS, ...JSON.parse(localStorage.getItem(READ_KEY)) }; } catch { return { ...READ_DEFAULTS }; }
}

function applyReading(r) {
  const font = READ_FONTS.find((f) => f[0] === r.font) || READ_FONTS[0];
  if (font[3] && !document.querySelector(`link[data-font="${font[0]}"]`)) {
    // Extra fonts are fetched only when chosen.
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font[3]}&display=swap`;
    link.dataset.font = font[0];
    document.head.appendChild(link);
  }
  const root = document.documentElement.style;
  root.setProperty('--read-font', font[2]);
  root.setProperty('--read-size', `${r.size}px`);
  root.setProperty('--read-leading', String(r.leading));
  root.setProperty('--read-width', r.width);
  $('#read-font').value = font[0];
  $('#read-size').value = r.size;
  $('#read-size-out').textContent = `${Math.round(r.size)} px`;
  $('#read-leading').value = r.leading;
  $('#read-leading-out').textContent = Number(r.leading).toFixed(2);
  $('#read-width').value = r.width;
}

function initReading() {
  fillSelect($('#read-font'), READ_FONTS.map(([k, label]) => [k, label]));
  let r = loadReading();
  applyReading(r);
  const update = (patch) => {
    r = { ...r, ...patch };
    applyReading(r);
    try { localStorage.setItem(READ_KEY, JSON.stringify(r)); } catch { /* private mode */ }
  };
  $('#read-font').addEventListener('change', (e) => update({ font: e.target.value }));
  $('#read-size').addEventListener('input', (e) => update({ size: Number(e.target.value) }));
  $('#read-leading').addEventListener('input', (e) => update({ leading: Number(e.target.value) }));
  $('#read-width').addEventListener('change', (e) => update({ width: e.target.value }));
  $('#read-reset').addEventListener('click', () => update({ ...READ_DEFAULTS }));
  // Clicks inside the panel shouldn't close it.
  $('#reading-menu').addEventListener('click', (e) => e.stopPropagation());
}

// ------------------------------------------------------------------ menus

function setupMenus() {
  for (const menu of $$('.menu')) {
    const btn = $('button', menu);
    const list = $('.menu-list', menu);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = list.hidden;
      closeMenus();
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) $('select, input, button', list)?.focus();
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenus(); btn.focus(); return; }
      if (list.classList.contains('reading-menu')) return;
      const items = $$('button', list);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
  }
  document.addEventListener('click', closeMenus);
  $$('[data-dl]').forEach((b) => b.addEventListener('click', () => { closeMenus(); download(b.dataset.dl); }));
}

function closeMenus() {
  $$('.menu-list').forEach((l) => { l.hidden = true; });
  $$('.menu > button').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

// ------------------------------------------------------------------ history

function openHistory() {
  renderHistory();
  $('#history-drawer').hidden = false;
  $('#scrim').hidden = false;
  $('#btn-close-history').focus();
}

function closeHistory() {
  $('#history-drawer').hidden = true;
  $('#scrim').hidden = true;
}

function renderHistory() {
  const list = $('#history-list');
  const items = loadHistory();
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="history-empty">No summaries yet.<br>They will be kept here automatically.</li>';
    return;
  }
  for (const h of items) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const date = new Date(h.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const snippet = markdownToPlain(h.markdown.slice(0, 600)).replace(/\s+/g, ' ').slice(0, 180);
    li.innerHTML = `<button class="open" type="button"><span class="h-title">${escapeHtml(h.title)}</span><span class="h-meta">${date} · ${h.pct}% · ${formatNumber(h.words)} words</span><span class="h-snippet">${escapeHtml(snippet)}</span></button><button class="del" type="button" aria-label="Delete">✕</button>`;
    $('.open', li).addEventListener('click', () => {
      // A saved summary has no source text attached, so it can't be live-updated or shown in context.
      showResult({ id: h.id, markdown: h.markdown, title: h.title, pct: h.pct, srcWords: h.srcWords, options: h.options, selected: null, sourceKey: null, lang: null });
      showNotice(null);
      closeHistory();
    });
    $('.del', li).addEventListener('click', () => { deleteHistory(h.id); renderHistory(); });
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ theme

function initTheme() {
  const btn = $('#btn-theme');
  const icon = () => {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    btn.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
    return dark;
  };
  icon();
  btn.addEventListener('click', () => {
    const next = icon() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    icon();
  });
  if (!getTheme()) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', icon);
}

// ------------------------------------------------------------------ events

function bind() {
  el.fileInput.accept = ACCEPT;
  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });

  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; el.dropzone.classList.add('over'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; el.dropzone.classList.remove('over'); } });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    el.dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  el.source.addEventListener('input', () => { state.manualText = true; updateSourceStats(); });
  el.title.addEventListener('input', () => {
    if (el.title.value) el.title.dataset.userSet = '1';
    else delete el.title.dataset.userSet;
  });
  el.ocrLang.addEventListener('change', () => {
    state.settings.ocrLang = el.ocrLang.value;
    saveSettings(state.settings);
  });

  $('#btn-sample').addEventListener('click', () => {
    if (el.source.value.trim() && !confirm('Replace the current text with the sample story?')) return;
    clearSource();
    el.source.value = SAMPLE_TEXT;
    el.title.value = SAMPLE_TITLE;
    updateSourceStats();
    toast('Sample loaded: a 650-word short story. Press Summarize.');
  });
  $('#btn-clear').addEventListener('click', () => {
    if (el.source.value.trim() && !confirm('Clear the text and files?')) return;
    clearSource();
  });

  const pdfEntry = () => (state.files.length === 1 && state.files[0].ext === 'pdf' ? state.files[0] : null);
  const reread = async (opts) => {
    const f = pdfEntry();
    if (!f) return;
    for (const b of $$('button', el.pdfTools)) b.disabled = true;
    try {
      await extractEntry(f, opts);
    } finally {
      for (const b of $$('button', el.pdfTools)) b.disabled = false;
      setExtractProgress(null);
    }
  };
  $('#btn-apply-range').addEventListener('click', () => {
    const f = pdfEntry();
    const from = Number(el.pageFrom.value) || 1;
    const to = Number(el.pageTo.value) || f?.meta.pages;
    if (from > to) { toast('The first page must come before the last page.'); return; }
    reread({ pageFrom: from, pageTo: to });
  });
  $('#btn-ocr-empty').addEventListener('click', () => reread({ ocr: 'empty' }));
  $('#btn-ocr-all').addEventListener('click', () => reread({ ocr: 'all' }));
  $('#btn-ocr-off').addEventListener('click', () => reread({ ocr: null }));
  el.autoOcr.addEventListener('change', () => {
    state.settings.autoOcr = el.autoOcr.checked;
    saveSettings(state.settings);
  });

  // Options: once a summary exists for this text, every change updates it live.
  el.ratio.addEventListener('input', () => { updateLength(); scheduleLive(); });
  $$('.presets button').forEach((b) => b.addEventListener('click', () => { el.ratio.value = b.dataset.ratio; updateLength(); scheduleLive(); readOptions(); }));
  el.targetWords.addEventListener('change', () => {
    const words = countWords(el.source.value);
    const target = Number(el.targetWords.value);
    if (!words || !target) return;
    el.ratio.value = Math.min(95, Math.max(1, Math.round((target / words) * 100)));
    updateLength();
    scheduleLive();
  });
  el.format.addEventListener('change', () => { el.formatHint.textContent = FORMAT_HINTS[el.format.value]; scheduleLive(); });
  el.focus.addEventListener('input', scheduleLive);
  for (const x of [el.smooth, el.dedupe, el.trim, el.gaps]) x.addEventListener('change', scheduleLive);
  el.extras.addEventListener('change', scheduleLive);
  $('#options-card').addEventListener('change', readOptions);

  el.run.addEventListener('click', () => summarize());
  $('#btn-stop').addEventListener('click', stopAi);
  $$('input[name=writer]').forEach((r) => r.addEventListener('change', () => { syncWriterUI(); readOptions(); }));
  $('#ai-model').addEventListener('change', readOptions);
  $('#btn-copy').addEventListener('click', copy);
  $('#btn-print').addEventListener('click', () => { const md = currentMarkdown(); if (md) printAsPdf(md, exportMeta()); });
  $('#btn-edit').addEventListener('click', () => toggleEdit());
  $('#btn-context').addEventListener('click', () => toggleContext());
  setupMenus();

  // Read aloud
  $('#btn-speak').addEventListener('click', openPlayer);
  $('#tts-close').addEventListener('click', closePlayer);
  $('#tts-play').addEventListener('click', () => reader.toggle());
  $('#tts-stop').addEventListener('click', () => reader.stop());
  $('#tts-prev').addEventListener('click', () => reader.jump(-1));
  $('#tts-next').addEventListener('click', () => reader.jump(1));
  $('#tts-voice').addEventListener('change', (e) => { reader.setPrefs({ voice: e.target.value }); updateVoiceHint(); });
  $('#tts-rate').addEventListener('input', (e) => {
    $('#tts-rate-out').textContent = `${Number(e.target.value).toFixed(2).replace(/0$/, '')}×`;
  });
  $('#tts-rate').addEventListener('change', (e) => reader.setPrefs({ rate: Number(e.target.value) }));
  $('#tts-pitch').addEventListener('input', (e) => {
    $('#tts-pitch-out').textContent = Number(e.target.value).toFixed(2).replace(/0$/, '');
  });
  $('#tts-pitch').addEventListener('change', (e) => reader.setPrefs({ pitch: Number(e.target.value) }));
  $('#tts-preview').addEventListener('click', () => {
    const code = reader.isNeural ? 'en' : (reader.browserVoice?.lang || 'en').slice(0, 2);
    reader.preview(PREVIEW_TEXT[code] || PREVIEW_TEXT.en);
  });
  $('#tts-save').addEventListener('click', saveAudio);
  if (speechSupported()) speechSynthesis.addEventListener?.('voiceschanged', () => { if (!el.player.hidden) fillVoices(); });

  // History & help
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-close-history').addEventListener('click', closeHistory);
  $('#scrim').addEventListener('click', closeHistory);
  $('#btn-clear-history').addEventListener('click', () => {
    if (confirm('Delete all saved summaries from this browser?')) { clearHistory(); renderHistory(); }
  });
  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); summarize(); }
    if (e.key === 'Escape' && !$('#history-drawer').hidden) closeHistory();
  });
  window.addEventListener('beforeunload', () => reader.stop());
}

// ------------------------------------------------------------------ start

initOptionsUI();
initReading();
initTheme();
bind();
updateSourceStats();
renderEmpty();
initPwa({
  onInstallable: (yes, install) => {
    const btn = $('#btn-install');
    btn.hidden = !yes;
    btn.onclick = install || null;
  },
});
// Files opened with the installed app ("Open with Précis") arrive here.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    addFiles(await Promise.all(params.files.map((h) => h.getFile())));
  });
}
const repo = $('#repo-link');
if (location.hostname.endsWith('github.io')) {
  const user = location.hostname.split('.')[0];
  const path = location.pathname.split('/').filter(Boolean)[0];
  repo.href = `https://github.com/${user}/${path || `${user}.github.io`}`;
} else repo.hidden = true;
