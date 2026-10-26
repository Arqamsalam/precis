// Small text helpers shared by extraction, the offline summarizer and the AI engine.

const WORD_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*/gu;

export function countWords(text) {
  if (!text) return 0;
  let n = 0;
  WORD_RE.lastIndex = 0;
  while (WORD_RE.exec(text)) n++;
  return n;
}

// Rough token estimate (Claude/GPT tokenizers average ~1.35 tokens per English word;
// scripts without spaces are closer to 1 token per character).
export function estimateTokens(text) {
  if (!text) return 0;
  const words = countWords(text);
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  return Math.ceil((words - cjk) * 1.4 + cjk * 1.1 + text.length * 0.02);
}

export function readingMinutes(words) {
  return Math.max(1, Math.round(words / 230));
}

export function formatNumber(n) {
  return new Intl.NumberFormat().format(Math.round(n));
}

export function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitParagraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

const segmenterCache = new Map();
function sentenceSegmenter(lang) {
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
  const key = lang || 'default';
  if (!segmenterCache.has(key)) {
    segmenterCache.set(key, new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }));
  }
  return segmenterCache.get(key);
}

export function splitSentences(paragraph, lang) {
  const seg = sentenceSegmenter(lang);
  if (seg) {
    return Array.from(seg.segment(paragraph), (s) => s.segment.trim()).filter(Boolean);
  }
  return paragraph.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) || [paragraph];
}

// Lines that look like chapter / section headings make good places to split long texts.
export function looksLikeHeading(paragraph) {
  const p = paragraph.trim();
  if (p.length > 120 || p.includes('\n')) return false;
  if (/^#{1,6}\s/.test(p)) return true;
  if (/^(chapter|part|book|section|act|scene|prologue|epilogue|introduction|conclusion|appendix)\b/i.test(p)) return true;
  if (/^(\d+|[IVXLC]+)[.)]?\s+\S/.test(p) && p.split(/\s+/).length <= 12 && !/[.!?]$/.test(p)) return true;
  const letters = p.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase() && p.split(/\s+/).length <= 10;
}

// Convert an HTML document/element into readable text, keeping headings, lists and paragraphs.
export function htmlToText(root) {
  const out = [];
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'BLOCKQUOTE', 'PRE',
    'FIGURE', 'FIGCAPTION', 'TABLE', 'TR', 'UL', 'OL', 'DL', 'DT', 'DD', 'ADDRESS', 'CENTER', 'BODY', 'HTML', 'NAV']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME', 'OBJECT', 'BUTTON', 'SELECT']);
  let line = '';
  const flush = (blank = true) => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
    if (blank && out.length && out[out.length - 1] !== '') out.push('');
    line = '';
  };
  const walk = (node, listDepth = 0) => {
    if (node.nodeType === 3) { line += node.nodeValue.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (/^H[1-6]$/.test(tag)) {
      flush();
      const level = Number(tag[1]);
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) out.push('#'.repeat(level) + ' ' + text, '');
      return;
    }
    if (tag === 'BR') { line += '\n'; return; }
    if (tag === 'HR') { flush(); return; }
    if (tag === 'LI') {
      flush(false);
      line = '  '.repeat(Math.max(0, listDepth - 1)) + '- ';
      for (const c of node.childNodes) walk(c, listDepth);
      flush(false);
      return;
    }
    if (tag === 'TD' || tag === 'TH') {
      for (const c of node.childNodes) walk(c, listDepth);
      line += ' | ';
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock) flush(tag !== 'TR');
    const depth = tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth;
    for (const c of node.childNodes) walk(c, depth);
    if (isBlock) flush(tag !== 'TR' && tag !== 'LI');
  };
  walk(root);
  flush();
  return normalizeWhitespace(out.join('\n').replace(/ \| \n/g, '\n').replace(/ \|$/gm, ''));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function baseName(filename) {
  return (filename || 'document').replace(/\.[^.]+$/, '');
}

export function slugify(s) {
  return (s || 'summary')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase() || 'summary';
}

// True when the text uses scripts the bundled PDF font (Roboto) can't draw,
// or right-to-left scripts that need shaping.
export function needsComplexScript(text) {
  return /[֐-ࣿऀ-෿฀-࿿က-႟ᄀ-ᇿ぀-ヿ㐀-鿿가-힯יִ-﷿ﹰ-﻿]/.test(text);
}

export function isRtl(text) {
  const sample = text.slice(0, 2000);
  const rtl = (sample.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) || []).length;
  const ltr = (sample.match(/[A-Za-zÀ-ɏЀ-ӿ]/g) || []).length;
  return rtl > ltr;
}
