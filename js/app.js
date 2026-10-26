// UI controller for Précis (offline edition).
import { ACCEPT, extractFile, extension, ocrPdfDocument, destroyPdf } from './extract.js';
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
import { ReadAloud, speechSupported, describeVoice, isEdge } from './speech.js';
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
  files: [], // {id, file, name, ext, size, status, text, meta, error, pdfDoc}
  manualText: false,
  busy: false,
  result: null, // {id, markdown, title, pct, srcWords, stats, options, selected, lang, sourceKey}
  editing: false,
  contextOn: false,
};

const el = {
  fileInput: $('#file-input'), dropzone: $('#dropzone'), fileList: $('#file-list'), ocrLang: $('#ocr-lang'),
  title: $('#doc-title'), source: $('#source-text'), sourceStats: $('#source-stats'),
  pdfRange: $('#pdf-range'), pageFrom: $('#page-from'), pageTo: $('#page-to'), pageTotal: $('#page-total'),
  ocrNotice: $('#ocr-notice'), extractProgress: $('#extract-progress'),
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
  const pdfs = state.files.filter((f) => f.ext === 'pdf' && f.status === 'ready' && f.meta?.pages > 1);
  const single = pdfs.length === 1 && state.files.length === 1 ? pdfs[0] : null;
  el.pdfRange.hidden = !single;
  if (single) {
    el.pageFrom.max = el.pageTo.max = single.meta.pages;
    el.pageFrom.value = single.meta.from;
    el.pageTo.value = single.meta.to;
    el.pageTotal.textContent = `of ${single.meta.pages}`;
  }
  el.ocrNotice.hidden = !state.files.some((f) => f.meta?.needsOcr && f.pdfDoc);
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

async function extractEntry(entry, opts) {
  entry.status = 'reading';
  renderFileList();
  try {
    const { text, meta, doc } = await extractFile(entry.file, {
      ...opts, ocrLang: state.settings.ocrLang, onProgress: (msg, frac) => setExtractProgress(msg, frac),
    });
    entry.text = normalizeWhitespace(text || '');
    entry.meta = meta;
    entry.pdfDoc = doc || null;
    entry.status = 'ready';
    if (!entry.text && !meta?.needsOcr) { entry.status = 'error'; entry.error = 'no text found'; }
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
  if (state.manualText && !confirm('Removing a file rebuilds the text box and discards your edits. Continue?')) return;
  const f = state.files.find((x) => x.id === id);
  destroyPdf(f?.pdfDoc);
  state.files = state.files.filter((x) => x.id !== id);
  renderFileList();
  rebuildSourceFromFiles();
}

function clearSource() {
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
      markdown: res.markdown, title: docTitle, pct: Math.round(options.ratio * 100), srcWords: res.stats.words,
      stats: res.stats, options, selected: res.selected, lang: res.lang, sourceKey: key,
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
    srcWords: r.srcWords, engine: 'offline', options: r.options,
  };
}

let liveTimer;
function scheduleLive() {
  if (!state.result || state.result.sourceKey !== sourceKey() || state.editing) return;
  if (state.result.edited) {
    showNotice('You edited this summary by hand, so it no longer updates automatically. Press <b>Summarize</b> for a fresh one.');
    return;
  }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => summarize({ live: true }), 180);
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
  return state.result?.markdown || '';
}

async function copy(kind) {
  const md = currentMarkdown();
  if (!md) return;
  try {
    if (kind === 'rich' && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([renderMarkdown(md)], { type: 'text/html' }),
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

const reader = new ReadAloud({
  onState: ({ playing, index, total }) => {
    const play = $('#tts-play');
    play.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8L7 4Z" fill="currentColor"/></svg>';
    play.title = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    $('#tts-pos').textContent = total ? `Paragraph ${Math.max(1, index + 1)} of ${total}` : '';
    $('#btn-speak').classList.toggle('on', playing || !el.player.hidden);
  },
});

async function openPlayer() {
  if (!speechSupported()) { toast('Your browser does not support reading aloud.'); return; }
  if (!el.player.hidden) { closePlayer(); return; }
  if (state.editing) toggleEdit(false);
  if (state.contextOn) toggleContext(false);
  el.player.hidden = false;
  $('#btn-speak').setAttribute('aria-expanded', 'true');
  await fillVoices();
  reader.load(el.output);
  reader.play();
}

function closePlayer() {
  reader.stop();
  el.player.hidden = true;
  $('#btn-speak').setAttribute('aria-expanded', 'false');
  $('#btn-speak').classList.remove('on');
}

async function fillVoices() {
  const select = $('#tts-voice');
  const voices = await reader.refreshVoices();
  const lang = state.result?.lang || 'en';
  select.innerHTML = '';
  if (!voices.length) {
    select.innerHTML = '<option value="">Default voice</option>';
  } else {
    for (const [label, list] of reader.voiceOptions(lang)) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const v of list) {
        const d = describeVoice(v);
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = `${d.natural ? '★ ' : ''}${d.name}${d.region ? ` · ${d.region}` : ''}${d.online ? '' : ' · on this device'}`;
        group.appendChild(o);
      }
      select.appendChild(group);
    }
  }
  const chosen = reader.pickDefaultVoice(lang);
  if (chosen) select.value = chosen;
  reader.prefs.voice = select.value;
  $('#tts-rate').value = reader.prefs.rate;
  $('#tts-pitch').value = reader.prefs.pitch;
  $('#tts-rate-out').textContent = `${Number(reader.prefs.rate).toFixed(2).replace(/0$/, '')}×`;
  $('#tts-pitch-out').textContent = Number(reader.prefs.pitch).toFixed(2).replace(/0$/, '');
  updateVoiceHint();
}

function updateVoiceHint() {
  const v = reader.voice;
  const hasNatural = reader.voices.some((x) => describeVoice(x).natural);
  const hint = [];
  if (!hasNatural && !isEdge()) {
    hint.push('Tip: open this page in <b>Microsoft Edge</b> to get Microsoft\'s free natural voices (Andrew, Ava, Emma, Brian and many more, including Urdu).');
  }
  if (v && !v.localService) {
    hint.push('This voice is online: your browser sends the text being read to its voice service. Voices marked “on this device” stay private.');
  }
  $('#tts-hint').innerHTML = hint.join(' ');
  $('#tts-hint').hidden = !hint.length;
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
      const text = await ocrPdfDocument(f.pdfDoc, f.meta.from, f.meta.to, el.ocrLang.value, (m, p) => setExtractProgress(m, p));
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

  // Options: once a summary exists for this text, every change updates it live.
  el.ratio.addEventListener('input', () => { updateLength(); scheduleLive(); });
  $$('.presets button').forEach((b) => b.addEventListener('click', () => { el.ratio.value = b.dataset.ratio; updateLength(); scheduleLive(); readOptions(); }));
  el.targetWords.addEventListener('change', () => {
    const words = countWords(el.source.value);
    const target = Number(el.targetWords.value);
    if (!words || !target) return;
    el.ratio.value = Math.min(90, Math.max(1, Math.round((target / words) * 100)));
    updateLength();
    scheduleLive();
  });
  el.format.addEventListener('change', () => { el.formatHint.textContent = FORMAT_HINTS[el.format.value]; scheduleLive(); });
  el.focus.addEventListener('input', scheduleLive);
  for (const x of [el.smooth, el.dedupe, el.trim, el.gaps]) x.addEventListener('change', scheduleLive);
  el.extras.addEventListener('change', scheduleLive);
  $('#options-card').addEventListener('change', readOptions);

  el.run.addEventListener('click', () => summarize());
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
    const v = reader.voice;
    const code = (v?.lang || 'en').slice(0, 2);
    reader.preview(PREVIEW_TEXT[code] || PREVIEW_TEXT.en);
  });
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
initTheme();
bind();
updateSourceStats();
renderEmpty();
const repo = $('#repo-link');
if (location.hostname.endsWith('github.io')) {
  const user = location.hostname.split('.')[0];
  const path = location.pathname.split('/').filter(Boolean)[0];
  repo.href = `https://github.com/${user}/${path || `${user}.github.io`}`;
} else repo.hidden = true;
