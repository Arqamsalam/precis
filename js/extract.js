// Turns uploaded files into plain text, entirely in the browser.
import { htmlToText, normalizeWhitespace } from './textutil.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

export const ACCEPT = [
  '.pdf', '.docx', '.txt', '.md', '.markdown', '.rtf', '.html', '.htm', '.xhtml', '.xml', '.epub', '.odt',
  '.pptx', '.csv', '.tsv', '.json', '.log', '.srt', '.vtt', '.tex', '.rst', '.org', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff',
].join(',');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

const scriptCache = new Map();
export function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        scriptCache.delete(src);
        reject(new Error(`Could not load ${src.split('/').pop()}. Check your internet connection.`));
      };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import(VENDOR + 'pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.mjs';
    return pdfjs;
  });
  return pdfjsPromise;
}

let jszipPromise;
function loadJSZip() {
  jszipPromise ??= import(VENDOR + 'jszip.mjs').then((m) => m.JSZip);
  return jszipPromise;
}

export function extension(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Extract text from a File.
 * @param {File} file
 * @param {{onProgress?: (msg: string, frac?: number) => void, pageFrom?: number, pageTo?: number,
 *          ocrLang?: string, forceOcr?: boolean}} opts
 * @returns {Promise<{text: string, meta: object}>}
 */
export async function extractFile(file, opts = {}) {
  const ext = extension(file.name);
  const onProgress = opts.onProgress || (() => {});
  onProgress(`Reading ${file.name}…`);

  if (ext === 'pdf' || file.type === 'application/pdf') return extractPdf(file, opts);
  if (ext === 'docx') return extractDocx(file);
  if (ext === 'epub') return extractEpub(file, onProgress);
  if (ext === 'odt') return extractOdt(file);
  if (ext === 'pptx') return extractPptx(file);
  if (IMAGE_EXT.has(ext) || file.type.startsWith('image/')) {
    const text = await ocrImages([file], opts.ocrLang || 'eng', onProgress);
    return { text, meta: { kind: 'image', ocr: true } };
  }
  if (ext === 'doc') {
    throw new Error('Old .doc files are not supported. Open it in Word or LibreOffice and save as .docx or PDF.');
  }

  const raw = await decodeText(await file.arrayBuffer());
  if (ext === 'rtf' || raw.startsWith('{\\rtf')) return { text: rtfToText(raw), meta: { kind: 'rtf' } };
  if (['html', 'htm', 'xhtml'].includes(ext) || /^\s*<(!doctype html|html)/i.test(raw)) {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    return { text: htmlToText(doc.body || doc.documentElement), meta: { kind: 'html', title: doc.title || '' } };
  }
  if (ext === 'srt' || ext === 'vtt') return { text: subtitlesToText(raw), meta: { kind: 'subtitles' } };
  if (ext === 'xml') {
    const doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (!doc.querySelector('parsererror')) {
      return { text: normalizeWhitespace(doc.documentElement.textContent.replace(/[ \t]+/g, ' ')), meta: { kind: 'xml' } };
    }
  }
  return { text: normalizeWhitespace(raw), meta: { kind: 'text' } };
}

async function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------- PDF ----------

async function openPdf(file, password) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  for (;;) {
    try {
      const doc = await pdfjs.getDocument({ data: data.slice(), password, isEvalSupported: false }).promise;
      return { doc, password };
    } catch (err) {
      if (err?.name === 'PasswordException') {
        password = window.prompt(err.code === 2 ? 'Wrong password. Try again:' : `"${file.name}" is password-protected. Enter the password:`);
        if (password == null) throw new Error('A password is needed to open this PDF.');
        continue;
      }
      throw new Error(`Could not open the PDF: ${err?.message || err}`);
    }
  }
}

/**
 * Read a PDF's text layer page by page. Pages without text (scanned images) can be recognised with OCR:
 * opts.ocr = 'empty' recognises only those pages, 'all' recognises every page (for a garbled text layer).
 */
async function extractPdf(file, opts) {
  const onProgress = opts.onProgress || (() => {});
  const { doc, password } = await openPdf(file, opts.password);
  try {
    const total = doc.numPages;
    const from = Math.min(Math.max(1, opts.pageFrom || 1), total);
    const to = Math.max(from, Math.min(total, opts.pageTo || total));
    const pages = [];
    for (let i = from; i <= to; i++) {
      onProgress(`Reading page ${i} of ${to}…`, (i - from) / (to - from + 1));
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = pageToLines(content.items);
      pages.push({ n: i, lines, chars: lines.reduce((a, l) => a + l.text.replace(/\s/g, '').length, 0) });
      page.cleanup();
    }
    const emptyPages = pages.filter((p) => p.chars < 25).map((p) => p.n);
    const targets = opts.ocr === 'all' ? pages.map((p) => p.n) : opts.ocr === 'empty' ? emptyPages : [];
    const recognised = targets.length ? await ocrPdfPages(doc, targets, opts.ocrLang || 'eng', onProgress) : new Map();
    const text = assemblePdfText(pages.map((p) => (recognised.has(p.n) ? { ocr: recognised.get(p.n) } : { lines: p.lines })));
    const meta = {
      kind: 'pdf', pages: total, from, to, password,
      emptyPages: emptyPages.length, scanned: emptyPages.length === pages.length,
      ocr: recognised.size ? opts.ocr : null, ocrPages: recognised.size,
    };
    return { text, meta };
  } finally {
    destroyPdf(doc);
  }
}

export function destroyPdf(doc) {
  try {
    (doc?.loadingTask ?? doc)?.destroy?.();
  } catch { /* already closed */ }
}

// Rebuild lines from positioned text runs. Returns [{text, y, h}] in reading order.
function pageToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.height || it.transform[3]) || 10;
    if (cur && Math.abs(y - cur.y) > Math.max(2, h * 0.45)) {
      lines.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { text: '', y, h, xEnd: x };
    } else if (it.str && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && x - cur.xEnd > h * 0.12) {
      cur.text += ' ';
    }
    cur.text += it.str;
    cur.xEnd = x + (it.width || 0);
    cur.h = Math.max(cur.h, h);
    if (it.hasEOL) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

/** @param {Array<{lines?: object[], ocr?: string}>} pages text-layer lines, or recognised text for OCR'd pages */
function assemblePdfText(pages) {
  // Drop running headers/footers: short lines that repeat on many pages, and bare page numbers.
  const freq = new Map();
  const linePages = pages.filter((p) => p.lines).map((p) => p.lines);
  for (const lines of linePages) {
    const edge = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const l of new Set(edge.map((l) => l.text.replace(/\d+/g, '#')))) freq.set(l, (freq.get(l) || 0) + 1);
  }
  const repeated = linePages.length >= 4
    ? new Set([...freq].filter(([t, n]) => n >= linePages.length * 0.5 && t.length < 90).map(([t]) => t))
    : new Set();

  const paragraphs = [];
  for (const page of pages) {
    if (page.ocr != null) {
      paragraphs.push(...page.ocr.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean));
      continue;
    }
    const lines = page.lines;
    const kept = lines.filter((l, idx) => {
      if (/^[-–—\s]*(page\s*)?\d{1,4}([-–—\s]*|\s*(of|\/)\s*\d+)$/i.test(l.text)) return false;
      const edge = idx < 2 || idx >= lines.length - 2;
      return !(edge && repeated.has(l.text.replace(/\d+/g, '#')));
    });
    // Typical line spacing on this page decides where paragraphs break.
    const gaps = [];
    for (let i = 1; i < kept.length; i++) {
      const g = kept[i - 1].y - kept[i].y;
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;

    let para = '';
    for (let i = 0; i < kept.length; i++) {
      const l = kept[i];
      const prev = kept[i - 1];
      const gap = prev ? prev.y - l.y : 0;
      const breakHere = prev && (gap > typical * 1.45 || gap < -typical || Math.abs(l.h - prev.h) > prev.h * 0.3);
      if (breakHere && para) {
        paragraphs.push(para);
        para = '';
      }
      if (!para) para = l.text;
      else if (/[A-Za-zÀ-ɏ]-$/.test(para) && /^[a-zß-ÿ]/.test(l.text)) para = para.slice(0, -1) + l.text;
      else para += ' ' + l.text;
    }
    if (para) paragraphs.push(para);
  }

  // Join paragraphs that were split only by a page break (previous ends mid-sentence, next starts lowercase).
  const merged = [];
  for (const p of paragraphs) {
    const last = merged[merged.length - 1];
    if (last && !/[.!?:;"”’)\]…]$/.test(last) && /^[a-z]/.test(p)) {
      merged[merged.length - 1] = /-$/.test(last) ? last.slice(0, -1) + p : last + ' ' + p;
    } else merged.push(p);
  }
  return normalizeWhitespace(merged.join('\n\n'));
}

async function ocrPdfPages(doc, pageNumbers, lang, onProgress) {
  const worker = await createOcrWorker(lang, onProgress);
  const out = new Map();
  try {
    for (let k = 0; k < pageNumbers.length; k++) {
      const n = pageNumbers[k];
      onProgress(`Recognising text: page ${n} (${k + 1} of ${pageNumbers.length})…`, k / pageNumbers.length);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const { data } = await worker.recognize(canvas);
      out.set(n, cleanOcr(data.text));
      page.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  return out;
}

// ---------- OCR (images) ----------

async function createOcrWorker(lang, onProgress) {
  onProgress('Loading the text-recognition engine (first time can take a moment)…');
  await loadScript(TESSERACT_URL);
  return window.Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress(`OCR: ${Math.round(m.progress * 100)}%`, m.progress);
      else if (m.status) onProgress(`OCR: ${m.status}…`);
    },
  });
}

export async function ocrImages(files, lang, onProgress) {
  const worker = await createOcrWorker(lang, onProgress);
  const parts = [];
  try {
    for (const f of files) {
      const { data } = await worker.recognize(f);
      parts.push(cleanOcr(data.text));
    }
  } finally {
    await worker.terminate();
  }
  return normalizeWhitespace(parts.join('\n\n'));
}

function cleanOcr(text) {
  // OCR returns one line per printed line; rejoin them into paragraphs.
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/-\n(?=[a-z])/g, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------- Word (.docx) ----------

async function extractDocx(file) {
  await loadScript(VENDOR + 'mammoth.browser.min.js');
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return { text: htmlToText(doc.body), meta: { kind: 'docx' } };
}

// ---------- EPUB ----------

async function extractEpub(file, onProgress) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('This EPUB is missing its table of contents (container.xml).');
  const opfPath = xml(container).querySelector('rootfile')?.getAttribute('full-path');
  const opf = xml(await zip.file(opfPath).async('string'));
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map();
  for (const item of opf.getElementsByTagName('item')) manifest.set(item.getAttribute('id'), item.getAttribute('href'));
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent || '';
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest.get(r.getAttribute('idref'))).filter(Boolean);

  const parts = [];
  for (let i = 0; i < spine.length; i++) {
    onProgress(`Reading chapter ${i + 1} of ${spine.length}…`, i / spine.length);
    const path = resolvePath(baseDir, decodeURIComponent(spine[i].split('#')[0]));
    const entry = zip.file(path);
    if (!entry) continue;
    const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/html');
    const t = htmlToText(doc.body || doc.documentElement);
    if (t) parts.push(t);
  }
  return { text: normalizeWhitespace(parts.join('\n\n')), meta: { kind: 'epub', title, chapters: spine.length } };
}

function resolvePath(base, rel) {
  const stack = (base + rel).split('/');
  const out = [];
  for (const seg of stack) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

// ---------- OpenDocument text (.odt) ----------

async function extractOdt(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const content = await zip.file('content.xml')?.async('string');
  if (!content) throw new Error('This ODT file has no content.xml.');
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const out = [];
  const inline = (node) => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.localName === 's') s += ' '.repeat(Number(c.getAttribute('text:c') || 1));
      else if (c.localName === 'tab') s += '\t';
      else if (c.localName === 'line-break') s += '\n';
      else if (c.localName !== 'note' && c.localName !== 'annotation') s += inline(c);
    }
    return s;
  };
  const walk = (node, depth) => {
    for (const c of node.children) {
      if (c.localName === 'h') {
        const lvl = Math.min(6, Number(c.getAttribute('text:outline-level') || 1));
        out.push('#'.repeat(lvl) + ' ' + inline(c).trim(), '');
      } else if (c.localName === 'p') {
        const t = inline(c).trim();
        if (t) out.push(depth ? '  '.repeat(depth - 1) + '- ' + t : t, depth ? '' : '');
      } else if (c.localName === 'list') walk(c, depth + 1);
      else walk(c, depth);
    }
  };
  walk(doc.documentElement, 0);
  return { text: normalizeWhitespace(out.join('\n')), meta: { kind: 'odt' } };
}

// ---------- PowerPoint (.pptx) ----------

async function extractPptx(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const doc = new DOMParser().parseFromString(await zip.file(slides[i]).async('string'), 'application/xml');
    const paras = [...doc.getElementsByTagName('a:p')]
      .map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join('').trim())
      .filter(Boolean);
    const notesPath = slides[i].replace('slides/slide', 'notesSlides/notesSlide');
    let notes = '';
    if (zip.file(notesPath)) {
      const nd = new DOMParser().parseFromString(await zip.file(notesPath).async('string'), 'application/xml');
      notes = [...nd.getElementsByTagName('a:t')].map((t) => t.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (/^\d+$/.test(notes)) notes = '';
    }
    if (paras.length || notes) {
      parts.push(`## Slide ${i + 1}${paras[0] ? ': ' + paras[0] : ''}\n\n${paras.slice(1).join('\n')}${notes ? `\n\nSpeaker notes: ${notes}` : ''}`);
    }
  }
  return { text: normalizeWhitespace(parts.join('\n\n')), meta: { kind: 'pptx', slides: slides.length } };
}

// ---------- RTF ----------

export function rtfToText(rtf) {
  const out = [];
  const stack = [];
  let skip = false;
  let ucSkip = 1;
  let pendingSkip = 0;
  const destinations = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|generator|themedata|colorschememapping|datastore|latentstyles|xmlnstbl|fldinst|bkmkstart|bkmkend)$/;
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push(skip); i++; if (rtf.startsWith('\\*', i)) skip = true; continue; }
    if (ch === '}') { skip = stack.pop() ?? false; i++; continue; }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!skip) out.push(next); i += 2; continue; }
      if (next === "'") {
        const hex = rtf.substr(i + 2, 2);
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip) out.push(new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hex, 16)])));
        i += 4;
        continue;
      }
      if (next === '~') { if (!skip) out.push(' '); i += 2; continue; }
      if (next === '-' || next === '_') { i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      const [all, word, arg] = m;
      i += all.length;
      if (destinations.test(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out.push('\n');
      else if (word === 'tab' || word === 'cell') out.push('\t');
      else if (word === 'row') out.push('\n');
      else if (word === 'uc') ucSkip = Number(arg || 1);
      else if (word === 'u') {
        let code = Number(arg);
        if (code < 0) code += 65536;
        out.push(String.fromCharCode(code));
        pendingSkip = ucSkip;
      } else if (word === 'emdash') out.push('—');
      else if (word === 'endash') out.push('–');
      else if (word === 'lquote') out.push('‘');
      else if (word === 'rquote') out.push('’');
      else if (word === 'ldblquote') out.push('“');
      else if (word === 'rdblquote') out.push('”');
      else if (word === 'bullet') out.push('•');
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    if (!skip) out.push(ch);
    i++;
  }
  return normalizeWhitespace(out.join('').replace(/\n[ \t]+/g, '\n').replace(/\n(?!\n)/g, '\n\n'));
}

// ---------- Subtitles ----------

function subtitlesToText(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const kept = [];
  let inNote = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l) { inNote = false; kept.push(''); continue; }
    if (inNote || /^WEBVTT/.test(l) || /^(NOTE|STYLE|REGION)\b/.test(l)) { inNote = /^(NOTE|STYLE|REGION)\b/.test(l) || inNote; continue; }
    if (/^\d+$/.test(l) || /-->/.test(l)) continue;
    kept.push(l.replace(/<[^>]+>/g, '').replace(/\{\\[^}]+\}/g, ''));
  }
  // Merge consecutive caption lines into flowing paragraphs, breaking on long silences (blank runs).
  const text = kept.join('\n').replace(/\n{2,}/g, '\n').split('\n');
  const paras = [];
  let cur = [];
  for (const t of text) {
    if (!t) continue;
    if (cur[cur.length - 1] === t) continue;
    cur.push(t);
    if (cur.length >= 8 && /[.!?]$/.test(t)) { paras.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) paras.push(cur.join(' '));
  return normalizeWhitespace(paras.join('\n\n'));
}
