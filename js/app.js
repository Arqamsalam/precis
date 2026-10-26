// UI controller for Précis.
import { ACCEPT, extractFile, extension, ocrPdfDocument, destroyPdf } from './extract.js';
import { countWords, estimateTokens, readingMinutes, formatNumber, baseName, normalizeWhitespace } from './textutil.js';
import { extractiveSummary } from './extractive.js';
import { runSummary, planSummary, estimateCost, costOf, CLAUDE_MODELS, OPENAI_PRESETS, SummaryError } from './ai.js';
import { FORMATS, TONES, EXTRAS, LANGUAGES } from './prompts.js';
import {
  renderMarkdown, markdownToPlain, fileStem, downloadMarkdown, downloadText, downloadHtml,
  downloadPdf, downloadDocx, printAsPdf, pdfNeedsPrint,
} from './export.js';
import {
  loadSettings, saveSettings, loadOptions, saveOptions, loadHistory, addHistory, updateHistory,
  deleteHistory, clearHistory, getTheme, setTheme,
} from './storage.js';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './sample.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const OCR_LANGS = [
  ['eng', 'English'], ['urd', 'Urdu'], ['ara', 'Arabic'], ['hin', 'Hindi'], ['ben', 'Bengali'], ['fas', 'Persian'],
  ['tur', 'Turkish'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'],
  ['nld', 'Dutch'], ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['pol', 'Polish'], ['ind', 'Indonesian'], ['msa', 'Malay'],
  ['chi_sim', 'Chinese (Simplified)'], ['chi_tra', 'Chinese (Traditional)'], ['jpn', 'Japanese'], ['kor', 'Korean'],
  ['vie', 'Vietnamese'], ['tha', 'Thai'],
];
const SPEECH_LANG = {
  English: 'en', Urdu: 'ur', Arabic: 'ar', Hindi: 'hi', Bengali: 'bn', Persian: 'fa', Turkish: 'tr', Spanish: 'es',
  French: 'fr', German: 'de', Portuguese: 'pt', Italian: 'it', Dutch: 'nl', Russian: 'ru', Ukrainian: 'uk', Polish: 'pl',
  Indonesian: 'id', Malay: 'ms', Swahili: 'sw', 'Chinese (Simplified)': 'zh-CN', 'Chinese (Traditional)': 'zh-TW',
  Japanese: 'ja', Korean: 'ko', Vietnamese: 'vi', Thai: 'th',
};

const state = {
  settings: loadSettings(),
  options: loadOptions(),
  files: [], // {id, file, name, ext, size, status, text, meta, error, pdfDoc}
  manualText: false,
  running: false,
  controller: null,
  result: null, // {id, markdown, title, pct, words, srcWords, model, engine, usage, cost, seconds, warnings}
  editing: false,
  speaking: false,
};

const el = {
  fileInput: $('#file-input'), dropzone: $('#dropzone'), fileList: $('#file-list'),
  title: $('#doc-title'), source: $('#source-text'), sourceStats: $('#source-stats'),
  pdfRange: $('#pdf-range'), pageFrom: $('#page-from'), pageTo: $('#page-to'), pageTotal: $('#page-total'),
  ocrNotice: $('#ocr-notice'), ocrLangPdf: $('#ocr-lang-pdf'),
  extractProgress: $('#extract-progress'),
  ratio: $('#ratio'), ratioOut: $('#ratio-out'), targetWords: $('#target-words'), lengthDetail: $('#length-detail'),
  format: $('#format'), formatHint: $('#format-hint'), tone: $('#tone'), language: $('#language'), mature: $('#mature'),
  extras: $('#extras'), quotes: $('#quotes'), custom: $('#custom'),
  engine: $('#engine'), engineMeta: $('#engine-meta'), run: $('#btn-run'),
  output: $('#output'), outputScroll: $('#output-scroll'), editor: $('#output-editor'), stats: $('#output-stats'),
  status: $('#status'), statusMsg: $('#status-msg'), statusBar: $('#status-bar'), notice: $('#notice'),
  toast: $('#toast'),
};

// ------------------------------------------------------------------ setup

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

function initOptionsUI() {
  const o = state.options;
  fillSelect(el.format, Object.entries(FORMATS).map(([k, f]) => [k, f.label]), o.format);
  fillSelect(el.tone, Object.entries(TONES).map(([k, t]) => [k, t.label]), o.tone);
  fillSelect(el.language, [['same', 'Same as original'], ...LANGUAGES.map((l) => [l, l])], o.language);
  el.mature.value = o.mature;
  el.quotes.checked = o.quotes !== false;
  el.custom.value = o.custom || '';
  if (o.custom) $('details.custom').open = true;
  el.extras.innerHTML = '';
  for (const [k, x] of Object.entries(EXTRAS)) {
    const lab = document.createElement('label');
    lab.className = 'chip';
    lab.innerHTML = `<input type="checkbox" value="${k}"><span>${x.label}</span>`;
    lab.querySelector('input').checked = o.extras.includes(k);
    el.extras.appendChild(lab);
  }
  el.ratio.value = Math.round(o.ratio * 100);
  el.formatHint.textContent = FORMATS[el.format.value]?.hint || '';
  el.engine.value = state.settings.provider;
  fillSelect(el.ocrLangPdf, OCR_LANGS, state.settings.ocrLang);
}

function readOptions() {
  state.options = {
    ratio: Number(el.ratio.value) / 100,
    format: el.format.value,
    tone: el.tone.value,
    language: el.language.value,
    mature: el.mature.value,
    quotes: el.quotes.checked,
    extras: $$('input', el.extras).filter((i) => i.checked).map((i) => i.value),
    custom: el.custom.value,
  };
  saveOptions(state.options);
  return state.options;
}

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

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMoney(x) {
  if (x == null || !isFinite(x)) return '';
  if (x < 0.01) return '< $0.01';
  return `$${x < 1 ? x.toFixed(2) : x.toFixed(2)}`;
}

function modelLabel(id) {
  return CLAUDE_MODELS.find((m) => id && id.startsWith(m.id))?.label || id;
}

// ------------------------------------------------------------------ source text

function sourceText() {
  return el.source.value;
}

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
  if (ready.length === 1) {
    el.source.value = ready[0].text;
  } else {
    el.source.value = ready.map((f) => `# ${baseName(f.name)}\n\n${f.text}`).join('\n\n');
  }
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
    else if (f.status === 'error') info = `<span class="state-err">${escape(f.error)}</span>`;
    else if (f.status === 'ready') {
      const bits = [`${formatNumber(countWords(f.text))} words`];
      if (f.meta?.pages) bits.unshift(f.meta.from > 1 || f.meta.to < f.meta.pages ? `pages ${f.meta.from}–${f.meta.to} of ${f.meta.pages}` : `${f.meta.pages} pages`);
      if (f.meta?.ocr) bits.push('OCR');
      info = bits.join(' · ');
    }
    li.innerHTML = `<span class="badge">${escape(f.ext || 'file')}</span><span class="name" title="${escape(f.name)}">${escape(f.name)}</span><span class="info">${info}</span><button type="button" aria-label="Remove ${escape(f.name)}">✕</button>`;
    li.querySelector('button').addEventListener('click', () => removeFile(f.id));
    el.fileList.appendChild(li);
  }
  updatePdfPanels();
}

function updatePdfPanels() {
  const pdfs = state.files.filter((f) => f.ext === 'pdf' && f.status === 'ready' && f.meta?.pages > 1);
  const single = pdfs.length === 1 && state.files.length === 1 ? pdfs[0] : null;
  el.pdfRange.hidden = !single;
  if (single) {
    el.pageFrom.max = el.pageTo.max = single.meta.pages;
    el.pageFrom.value = single.meta.from;
    el.pageTo.value = single.meta.to;
    el.pageTotal.textContent = `of ${single.meta.pages}`;
  }
  const scanned = state.files.find((f) => f.meta?.needsOcr && f.pdfDoc);
  el.ocrNotice.hidden = !scanned;
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  if (!files.length) return;
  if (state.manualText && el.source.value.trim() && !state.files.length) {
    if (!confirm('Replace the text in the box with the uploaded file(s)?')) return;
  }
  const entries = files.map((file) => ({
    id: crypto.randomUUID(), file, name: file.name, ext: extension(file.name), size: file.size, status: 'reading', text: '', meta: null,
  }));
  state.files.push(...entries);
  renderFileList();
  for (const entry of entries) {
    await extractEntry(entry, {});
  }
  setExtractProgress(null);
}

async function extractEntry(entry, opts) {
  entry.status = 'reading';
  renderFileList();
  try {
    const { text, meta, doc } = await extractFile(entry.file, {
      ...opts,
      ocrLang: state.settings.ocrLang,
      onProgress: (msg, frac) => setExtractProgress(msg, frac),
    });
    entry.text = normalizeWhitespace(text || '');
    entry.meta = meta;
    entry.pdfDoc = doc || null;
    entry.status = 'ready';
    if (!entry.text && !meta?.needsOcr) {
      entry.status = 'error';
      entry.error = 'no text found';
    }
    if (meta?.needsOcr) toast('This PDF has no selectable text. Use "Recognise text (OCR)" to read it.', 5000);
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
  const f = state.files.find((x) => x.id === id);
  if (state.manualText && !confirm('Removing a file rebuilds the text box and discards your edits. Continue?')) return;
  destroyPdf(f?.pdfDoc);
  state.files = state.files.filter((x) => x.id !== id);
  renderFileList();
  rebuildSourceFromFiles();
}

function clearSource() {
  if (state.running) return;
  for (const f of state.files) destroyPdf(f.pdfDoc);
  state.files = [];
  el.source.value = '';
  el.title.value = '';
  delete el.title.dataset.userSet;
  state.manualText = false;
  renderFileList();
  updateSourceStats();
}

function updateSourceStats() {
  const text = sourceText();
  const words = countWords(text);
  if (!words) {
    el.sourceStats.textContent = 'No text yet';
  } else {
    const tokens = estimateTokens(text);
    el.sourceStats.innerHTML = `<b>${formatNumber(words)}</b> words · ${formatNumber(text.length)} characters · ~${readingMinutes(words)} min read · ~${formatNumber(tokens)} tokens`;
  }
  updateLength();
}

// ------------------------------------------------------------------ length + engine info

function updateLength() {
  const pct = Number(el.ratio.value);
  el.ratioOut.textContent = `${pct}%`;
  $$('.presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ratio) === pct));
  const words = countWords(sourceText());
  const target = Math.max(words ? 25 : 0, Math.round(words * pct / 100));
  if (document.activeElement !== el.targetWords) el.targetWords.value = words ? target : '';
  el.targetWords.disabled = !words;
  el.lengthDetail.textContent = words
    ? `· ~${readingMinutes(target)} min read instead of ~${readingMinutes(words)} (${(100 / pct).toFixed(pct >= 50 ? 1 : 0)}× shorter)`
    : '· add some text to see the estimate';
  updateEngineMeta();
}

function updateEngineMeta() {
  const s = state.settings;
  const text = sourceText();
  if (s.provider === 'offline') {
    el.engineMeta.innerHTML = '<b>Free</b> · runs in your browser';
    return;
  }
  if (s.provider === 'openai') {
    const p = OPENAI_PRESETS[s.openai.preset];
    el.engineMeta.innerHTML = `<b>${escape(s.openai.model || 'no model set')}</b> via ${escape(p?.label.split(' (')[0] || 'custom')}`;
    return;
  }
  const model = s.anthropic.model;
  let html = `<b>${escape(modelLabel(model))}</b>`;
  if (!s.anthropic.apiKey) html += ' · <a href="#" data-open-settings>add API key</a>';
  if (text.trim()) {
    const plan = planSummary(text, Number(el.ratio.value) / 100, s);
    const cost = estimateCost(plan, model);
    if (cost != null) html += ` · est. ${fmtMoney(cost)}`;
    if (plan.mode !== 'single') html += ` · ${plan.parts} parts`;
  }
  el.engineMeta.innerHTML = html;
}

// ------------------------------------------------------------------ output rendering

let renderPending = null;
let renderScheduled = false;
function renderOutput(md, { streaming = false } = {}) {
  renderPending = { md, streaming };
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!renderPending) return; // cleared by renderEmpty()
    const { md: text, streaming: live } = renderPending;
    const scroller = el.outputScroll;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    el.output.innerHTML = text ? renderMarkdown(text) : '';
    el.output.classList.toggle('streaming', live);
    if (live && atBottom) scroller.scrollTop = scroller.scrollHeight;
  });
}

function setToolsEnabled(on) {
  for (const id of ['#btn-copy', '#btn-download', '#btn-print', '#btn-speak', '#btn-edit', '#btn-regen']) $(id).disabled = !on;
}

function showStats() {
  const r = state.result;
  if (!r) { el.stats.hidden = true; return; }
  const words = countWords(r.markdown);
  const pct = r.srcWords ? (words / r.srcWords) * 100 : 0;
  const saved = Math.max(0, readingMinutes(r.srcWords) - readingMinutes(words));
  const bits = [
    `<span><b>${formatNumber(words)}</b> words</span>`,
    r.srcWords ? `<span><b>${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</b> of ${formatNumber(r.srcWords)} (target ${r.pct}%)</span>` : '',
    saved ? `<span>saves ~<b>${saved} min</b> of reading</span>` : '',
    `<span>${escape(r.engine === 'offline' ? 'Offline (extractive)' : modelLabel(r.model))}</span>`,
    r.seconds ? `<span>${r.seconds < 60 ? `${Math.round(r.seconds)} s` : `${Math.floor(r.seconds / 60)} min ${Math.round(r.seconds % 60)} s`}</span>` : '',
    r.cost != null ? `<span>cost ≈ <b>${fmtMoney(r.cost)}</b></span>` : '',
  ];
  el.stats.innerHTML = bits.filter(Boolean).join('');
  el.stats.hidden = false;
}

function showResult(result, { save = true } = {}) {
  state.result = result;
  if (state.editing) toggleEdit(false);
  renderOutput(result.markdown);
  setToolsEnabled(!!result.markdown);
  showStats();
  if (save && result.markdown) {
    const h = addHistory({
      title: result.title, markdown: result.markdown, pct: result.pct, words: countWords(result.markdown), srcWords: result.srcWords,
      model: result.model, engine: result.engine, cost: result.cost, options: result.options,
    });
    result.id = h[0]?.id;
  }
}

function setStatus(msg, progress) {
  if (msg == null) { el.status.hidden = true; return; }
  el.status.hidden = false;
  el.statusMsg.textContent = msg;
  el.statusBar.classList.toggle('indeterminate', progress == null);
  $('span', el.statusBar).style.width = progress == null ? '' : `${Math.max(3, Math.round(progress * 100))}%`;
}

function setRunning(on) {
  state.running = on;
  el.run.disabled = false;
  el.run.classList.toggle('running', on);
  $('.label', el.run).textContent = on ? 'Stop' : 'Summarize';
  $('#btn-regen').disabled = on || !state.result;
  if (on) setToolsEnabled(false);
}

// ------------------------------------------------------------------ summarizing

async function summarize() {
  if (state.running) { stop(); return; }
  stopSpeaking();
  const text = sourceText().trim();
  if (!text) {
    toast('Add a file, paste some text, or try the sample first.');
    el.source.focus();
    return;
  }
  const words = countWords(text);
  const options = readOptions();
  const title = el.title.value.trim() || 'Untitled';
  const pct = Math.round(options.ratio * 100);
  showNotice(null);

  if (state.settings.provider === 'offline') {
    const t0 = performance.now();
    const md = extractiveSummary(text, options.ratio);
    showResult({
      markdown: md, title, pct, srcWords: words, engine: 'offline', model: 'offline', seconds: (performance.now() - t0) / 1000, options,
    });
    if (options.format !== 'preserve' || options.tone !== 'match' || options.language !== 'same' || options.extras.length || options.custom.trim()) {
      showNotice('Offline mode keeps the author\'s own sentences, so format, tone, language, extra sections and custom instructions only apply with an AI engine. <button class="small" data-open-settings type="button">Choose an AI engine</button>');
    }
    return;
  }

  if (state.settings.provider === 'anthropic' && !state.settings.anthropic.apiKey) {
    openSettings('anthropic-key');
    toast('Add your Anthropic API key to use Claude, or choose the free offline engine.', 5000);
    return;
  }

  state.controller = new AbortController();
  setRunning(true);
  if (state.editing) toggleEdit(false);
  state.result = null;
  el.stats.hidden = true;
  renderOutput('', { streaming: true });
  setStatus('Starting…', null);
  if (matchMedia('(max-width: 1060px)').matches) $('.output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const t0 = performance.now();
  let latest = '';
  try {
    const res = await runSummary({
      text, title, ratio: options.ratio, options, settings: state.settings, signal: state.controller.signal,
      onUpdate: (u) => {
        if (u.type === 'text') {
          latest = u.text;
          renderOutput(u.text, { streaming: true });
        } else if (u.type === 'status') setStatus(u.message, u.progress);
        else if (u.type === 'phase') {
          if (u.phase === 'thinking' && !latest) setStatus('Reading closely and planning the summary…', null);
          if (u.phase === 'writing' && /planning|Starting|Reading the whole/.test(el.statusMsg.textContent)) setStatus('Writing…', null);
        }
      },
    });
    const cost = state.settings.provider === 'anthropic' ? costOf(res.usage, res.model) : null;
    setStatus(null);
    el.outputScroll.scrollTo({ top: 0, behavior: 'smooth' });
    showResult({
      markdown: res.markdown, title, pct, srcWords: words, engine: state.settings.provider, model: res.model,
      usage: res.usage, cost, seconds: (performance.now() - t0) / 1000, options,
    });
    if (res.warnings.length) showNotice(res.warnings.map(escape).join('<br>'));
    if (res.plan.mode !== 'single') toast(`Long document: summarized in ${res.plan.parts} parts.`);
  } catch (err) {
    setStatus(null);
    const e = err instanceof SummaryError ? err : new SummaryError(err?.message || String(err));
    if (!(err instanceof SummaryError)) console.error(err);
    if (e.kind === 'abort') {
      if (e.partial || latest) {
        showResult({ markdown: (e.partial || latest).trim(), title, pct, srcWords: words, engine: state.settings.provider, model: state.settings.provider === 'anthropic' ? state.settings.anthropic.model : state.settings.openai.model, options, seconds: (performance.now() - t0) / 1000 }, { save: false });
        showNotice('Stopped. The partial summary is shown; it was not saved to History.');
      } else {
        renderEmpty();
        toast('Stopped.');
      }
    } else {
      // Partial output from a failed or declined request is incomplete, so don't present it as a summary.
      renderEmpty();
      const action = ['auth', 'nokey', 'config', 'billing'].includes(e.kind)
        ? ' <button class="small" data-open-settings type="button">Open settings</button>'
        : e.kind === 'refusal' ? ' <button class="small" data-open-settings type="button">Change engine</button>' : '';
      showNotice(escape(e.message) + action, 'error');
    }
  } finally {
    state.controller = null;
    setRunning(false);
    el.output.classList.remove('streaming');
  }
}

function stop() {
  state.controller?.abort();
}

function renderEmpty() {
  renderPending = null;
  el.output.innerHTML = EMPTY_HTML;
  el.output.classList.remove('streaming');
  setToolsEnabled(false);
  el.stats.hidden = true;
}
const EMPTY_HTML = el.output.innerHTML;

// ------------------------------------------------------------------ output tools

function exportMeta() {
  const r = state.result;
  return {
    title: r.title || 'Untitled', source: r.title, pct: r.pct, words: countWords(r.markdown), date: Date.now(),
    stem: fileStem(r.title, r.pct),
  };
}

function currentMarkdown() {
  if (state.editing) return el.editor.value;
  return state.result?.markdown || '';
}

async function copy(kind) {
  const md = currentMarkdown();
  if (!md) return;
  try {
    if (kind === 'rich' && window.ClipboardItem) {
      const html = renderMarkdown(md);
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([markdownToPlain(md)], { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(kind === 'md' ? md : markdownToPlain(md));
    }
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed. Your browser blocked clipboard access.');
  }
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
  state.editing = on;
  $('#btn-edit').classList.toggle('on', on);
  $('#btn-edit span').textContent = on ? 'Done' : 'Edit';
  if (on) {
    el.editor.value = state.result.markdown;
    el.editor.hidden = false;
    el.output.hidden = true;
    el.editor.focus();
  } else {
    if (state.result && el.editor.value !== state.result.markdown) {
      state.result.markdown = el.editor.value;
      if (state.result.id) updateHistory(state.result.id, { markdown: state.result.markdown, words: countWords(state.result.markdown) });
      showStats();
    }
    el.editor.hidden = true;
    el.output.hidden = false;
    if (state.result) renderOutput(state.result.markdown);
  }
}

function speak() {
  if (!('speechSynthesis' in window)) { toast('Your browser does not support reading aloud.'); return; }
  if (state.speaking) { stopSpeaking(); return; }
  const md = currentMarkdown();
  if (!md) return;
  const paras = markdownToPlain(md).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lang = SPEECH_LANG[state.result?.options?.language];
  speechSynthesis.cancel();
  state.speaking = true;
  $('#btn-speak').classList.add('on');
  $('#btn-speak span').textContent = 'Stop';
  paras.forEach((p, i) => {
    // Short utterances avoid the Chrome bug that cuts off long speech after ~15 seconds.
    const chunks = p.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [p];
    chunks.forEach((c, j) => {
      const u = new SpeechSynthesisUtterance(c.trim());
      if (lang) u.lang = lang;
      if (i === paras.length - 1 && j === chunks.length - 1) u.onend = stopSpeaking;
      speechSynthesis.speak(u);
    });
  });
}

function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  state.speaking = false;
  $('#btn-speak')?.classList.remove('on');
  const s = $('#btn-speak span');
  if (s) s.textContent = 'Listen';
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
      if (open) $('button', list)?.focus();
    });
    list.addEventListener('keydown', (e) => {
      const items = $$('button', list);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === 'Escape') { closeMenus(); btn.focus(); }
    });
  }
  document.addEventListener('click', closeMenus);
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => { closeMenus(); copy(b.dataset.copy); }));
  $$('[data-dl]').forEach((b) => b.addEventListener('click', () => { closeMenus(); download(b.dataset.dl); }));
}

function closeMenus() {
  $$('.menu-list').forEach((l) => { l.hidden = true; });
  $$('.menu > button').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

// ------------------------------------------------------------------ history drawer

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
    li.innerHTML = `<button class="open" type="button"><span class="h-title">${escape(h.title)}</span><span class="h-meta">${date} · ${h.pct}% · ${formatNumber(h.words)} words · ${escape(h.engine === 'offline' ? 'Offline' : modelLabel(h.model))}</span><span class="h-snippet">${escape(snippet)}</span></button><button class="del" type="button" aria-label="Delete">✕</button>`;
    $('.open', li).addEventListener('click', () => {
      showResult({ ...h, engine: h.engine, model: h.model, seconds: null }, { save: false });
      state.result.id = h.id;
      showNotice(null);
      closeHistory();
    });
    $('.del', li).addEventListener('click', () => { deleteHistory(h.id); renderHistory(); });
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ settings dialog

const dlg = $('#settings-dialog');

function initSettingsUI() {
  fillSelect($('#anthropic-model'), [...CLAUDE_MODELS.map((m) => [m.id, `${m.label} · ${m.note}`]), ['__custom', 'Other model ID…']]);
  fillSelect($('#openai-preset'), Object.entries(OPENAI_PRESETS).map(([k, p]) => [k, p.label]));
  fillSelect($('#ocr-lang'), OCR_LANGS);
}

function openSettings(focusId) {
  const s = state.settings;
  $$('input[name=provider]').forEach((r) => { r.checked = r.value === s.provider; });
  const known = CLAUDE_MODELS.some((m) => m.id === s.anthropic.model);
  $('#anthropic-key').value = s.anthropic.apiKey;
  $('#anthropic-model').value = known ? s.anthropic.model : '__custom';
  $('#anthropic-model-custom').value = known ? '' : s.anthropic.model;
  $('#anthropic-model-custom').hidden = known;
  $('#anthropic-effort').value = s.anthropic.effort;
  $('#openai-preset').value = s.openai.preset;
  $('#openai-base').value = s.openai.baseUrl;
  $('#openai-key').value = s.openai.apiKey;
  $('#openai-model').value = s.openai.model;
  $('#openai-context').value = s.openai.contextTokens;
  $('#openai-maxout').value = s.openai.maxOutputTokens;
  $('#remember-key').checked = s.rememberKey;
  $('#adv-chunk').value = s.advanced.chunkTokens;
  $('#adv-partwords').value = s.advanced.partWords;
  $('#adv-autolength').checked = s.advanced.autoLength;
  $('#ocr-lang').value = s.ocrLang;
  $('#test-anthropic-result').textContent = '';
  updateModelPrice();
  syncSettingsSections();
  updateOpenAINote();
  dlg.showModal();
  if (focusId) setTimeout(() => $(`#${focusId}`)?.focus(), 30);
}

function updateModelPrice() {
  const m = CLAUDE_MODELS.find((x) => x.id === $('#anthropic-model').value);
  $('#model-price').textContent = m
    ? `$${m.input} per million tokens read, $${m.output} per million written (a million tokens ≈ 750,000 words).`
    : 'Any Claude model ID your key can use.';
}

function syncSettingsSections() {
  const p = $('input[name=provider]:checked')?.value || 'anthropic';
  $$('.settings-section').forEach((s) => { s.hidden = s.dataset.provider !== p; });
}

function updateOpenAINote() {
  const preset = $('#openai-preset').value;
  const notes = {
    openai: 'Uses your OpenAI API key. Pick any chat model, e.g. gpt-5.1.',
    openrouter: 'One key for hundreds of models, including open-weight ones. Copy the model ID from openrouter.ai/models.',
    ollama: 'Runs on your own computer, fully private. Start Ollama so it accepts requests from this page: set the environment variable OLLAMA_ORIGINS="*" before running "ollama serve". Set the context window to what your model supports.',
    lmstudio: 'Runs on your own computer. In LM Studio, open the Developer tab, start the server and enable CORS. Use the model identifier shown there.',
    custom: 'Any server that implements the OpenAI chat-completions API with streaming and allows browser (CORS) requests.',
  };
  $('#openai-note').textContent = notes[preset] || '';
}

function readSettingsForm() {
  const s = structuredClone(state.settings);
  s.provider = $('input[name=provider]:checked')?.value || 'anthropic';
  s.anthropic.apiKey = $('#anthropic-key').value.trim();
  const m = $('#anthropic-model').value;
  s.anthropic.model = m === '__custom' ? ($('#anthropic-model-custom').value.trim() || 'claude-opus-5-5') : m;
  s.anthropic.effort = $('#anthropic-effort').value;
  s.openai.preset = $('#openai-preset').value;
  s.openai.baseUrl = $('#openai-base').value.trim();
  s.openai.apiKey = $('#openai-key').value.trim();
  s.openai.model = $('#openai-model').value.trim();
  s.openai.contextTokens = Number($('#openai-context').value) || 8192;
  s.openai.maxOutputTokens = Number($('#openai-maxout').value) || 4096;
  s.rememberKey = $('#remember-key').checked;
  s.advanced.chunkTokens = Math.max(1000, Number($('#adv-chunk').value) || 150000);
  s.advanced.partWords = Math.max(200, Number($('#adv-partwords').value) || 3500);
  s.advanced.autoLength = $('#adv-autolength').checked;
  s.ocrLang = $('#ocr-lang').value;
  return s;
}

function applySettings(s) {
  state.settings = s;
  saveSettings(s);
  el.engine.value = s.provider;
  el.ocrLangPdf.value = s.ocrLang;
  updateEngineMeta();
}

async function testAnthropicKey() {
  const out = $('#test-anthropic-result');
  const s = readSettingsForm();
  if (!s.anthropic.apiKey) { out.textContent = 'Enter a key first.'; out.className = 'test-result bad'; return; }
  out.textContent = 'Testing…';
  out.className = 'test-result';
  try {
    const { Anthropic } = await import('../vendor/anthropic.mjs');
    const client = new Anthropic({ apiKey: s.anthropic.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    const model = await client.models.retrieve(s.anthropic.model);
    out.textContent = `✓ Key works. ${model.display_name || model.id} is available.`;
    out.className = 'test-result ok';
  } catch (err) {
    out.textContent = err?.status === 401 ? '✗ This key was rejected.' : err?.status === 404 ? '✗ Key works, but that model ID was not found.' : `✗ ${err?.message || err}`;
    out.className = 'test-result bad';
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
    const dark = icon();
    const next = dark ? 'light' : 'dark';
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

  // Drag and drop anywhere on the page.
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
  // Pasting an image or file (e.g. a screenshot) adds it like an upload.
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  el.source.addEventListener('input', () => { state.manualText = true; updateSourceStats(); });
  el.title.addEventListener('input', () => { el.title.dataset.userSet = el.title.value ? '1' : ''; if (!el.title.value) delete el.title.dataset.userSet; });

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

  $('#btn-apply-range').addEventListener('click', async () => {
    const f = state.files.find((x) => x.ext === 'pdf');
    if (!f) return;
    const from = Number(el.pageFrom.value) || 1;
    const to = Number(el.pageTo.value) || f.meta.pages;
    if (from > to) { toast('The first page must come before the last page.'); return; }
    await extractEntry(f, { pageFrom: from, pageTo: to });
    setExtractProgress(null);
  });
  $('#btn-run-ocr').addEventListener('click', async () => {
    const f = state.files.find((x) => x.meta?.needsOcr && x.pdfDoc);
    if (!f) return;
    $('#btn-run-ocr').disabled = true;
    try {
      const text = await ocrPdfDocument(f.pdfDoc, f.meta.from, f.meta.to, el.ocrLangPdf.value, (m, p) => setExtractProgress(m, p));
      f.text = normalizeWhitespace(text);
      f.meta = { ...f.meta, needsOcr: false, ocr: true };
      f.pdfDoc = null;
      if (!f.text) toast('No text could be recognised on these pages.');
    } catch (err) {
      toast(`OCR failed: ${err.message || err}`, 6000);
    } finally {
      $('#btn-run-ocr').disabled = false;
      setExtractProgress(null);
      renderFileList();
      rebuildSourceFromFiles();
    }
  });

  el.ratio.addEventListener('input', () => { updateLength(); });
  el.ratio.addEventListener('change', readOptions);
  $$('.presets button').forEach((b) => b.addEventListener('click', () => { el.ratio.value = b.dataset.ratio; updateLength(); readOptions(); }));
  el.targetWords.addEventListener('change', () => {
    const words = countWords(sourceText());
    const target = Number(el.targetWords.value);
    if (!words || !target) return;
    el.ratio.value = Math.min(90, Math.max(1, Math.round((target / words) * 100)));
    updateLength();
    readOptions();
  });
  el.format.addEventListener('change', () => { el.formatHint.textContent = FORMATS[el.format.value]?.hint || ''; readOptions(); });
  for (const x of [el.tone, el.language, el.mature, el.quotes, el.custom]) x.addEventListener('change', readOptions);
  el.extras.addEventListener('change', readOptions);
  el.engine.addEventListener('change', () => {
    const s = structuredClone(state.settings);
    s.provider = el.engine.value;
    applySettings(s);
    if (s.provider === 'openai' && !s.openai.model) openSettings('openai-model');
  });

  el.run.addEventListener('click', summarize);
  $('#btn-stop').addEventListener('click', stop);
  $('#btn-regen').addEventListener('click', summarize);
  $('#btn-print').addEventListener('click', () => { const md = currentMarkdown(); if (md) printAsPdf(md, exportMeta()); });
  $('#btn-speak').addEventListener('click', speak);
  $('#btn-edit').addEventListener('click', () => toggleEdit());
  setupMenus();

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open-settings]');
    if (t) { e.preventDefault(); openSettings(state.settings.provider === 'anthropic' ? 'anthropic-key' : null); }
  });

  // History
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-close-history').addEventListener('click', closeHistory);
  $('#scrim').addEventListener('click', closeHistory);
  $('#btn-clear-history').addEventListener('click', () => {
    if (confirm('Delete all saved summaries from this browser?')) { clearHistory(); renderHistory(); }
  });

  // Settings
  $('#btn-settings').addEventListener('click', () => openSettings());
  $$('input[name=provider]').forEach((r) => r.addEventListener('change', syncSettingsSections));
  $('#anthropic-model').addEventListener('change', (e) => {
    $('#anthropic-model-custom').hidden = e.target.value !== '__custom';
    updateModelPrice();
  });
  $('#openai-preset').addEventListener('change', (e) => {
    const p = OPENAI_PRESETS[e.target.value];
    if (p.baseUrl) $('#openai-base').value = p.baseUrl;
    if (p.model) $('#openai-model').value = p.model;
    $('#openai-context').value = p.context;
    updateOpenAINote();
  });
  $$('[data-toggle-key]').forEach((b) => b.addEventListener('click', () => {
    const input = $(`#${b.dataset.toggleKey}`);
    input.type = input.type === 'password' ? 'text' : 'password';
    b.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }));
  $('#btn-test-anthropic').addEventListener('click', testAnthropicKey);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save') {
      applySettings(readSettingsForm());
      toast('Settings saved');
    }
  });

  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); summarize(); }
    if (e.key === 'Escape' && !$('#history-drawer').hidden) closeHistory();
  });
  window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
}

// ------------------------------------------------------------------ start

initOptionsUI();
initSettingsUI();
initTheme();
bind();
updateSourceStats();
setToolsEnabled(false);
const repo = document.querySelector('#repo-link');
if (location.hostname.endsWith('github.io')) {
  const user = location.hostname.split('.')[0];
  const path = location.pathname.split('/').filter(Boolean)[0];
  repo.href = `https://github.com/${user}/${path || `${user}.github.io`}`;
} else repo.hidden = true;
