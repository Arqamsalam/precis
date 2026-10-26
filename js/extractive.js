// Offline summarizer: no AI, no network. Picks the most central sentences of each section
// (TextRank over TF-IDF similarity) and keeps them in their original order and paragraphs,
// so the result is made entirely of the author's own words.
import { countWords, splitParagraphs, splitSentences, looksLikeHeading } from './textutil.js';

const STOP = new Set(('a an and are as at be been but by for from had has have he her hers him his i if in into is it its ' +
  'me my of on or our she so than that the their them then there these they this those to was we were what when which who ' +
  'will with would you your not no do does did can could should may might must shall just also very more most such only ' +
  'own same too up down out over under again further once here why how all any both each few other some nor').split(' '));

const SECTION_SENTENCES = 600;

function tokenize(sentence) {
  return (sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * @param {string} text
 * @param {number} ratio 0..1 share of words to keep
 * @returns {string} markdown
 */
export function extractiveSummary(text, ratio) {
  const paragraphs = splitParagraphs(text);
  const sentences = []; // {text, para, words, heading}
  paragraphs.forEach((p, pi) => {
    if (looksLikeHeading(p)) {
      sentences.push({ text: p.replace(/^#+\s*/, ''), para: pi, words: countWords(p), heading: true });
      return;
    }
    for (const s of splitSentences(p.replace(/\s*\n\s*/g, ' '))) {
      sentences.push({ text: s, para: pi, words: countWords(s), heading: false });
    }
  });
  const totalWords = sentences.reduce((a, s) => a + s.words, 0);
  if (!totalWords) return '';

  // Work section by section so every part of the document is represented in proportion.
  const sections = [];
  let cur = [];
  sentences.forEach((s, i) => {
    if ((s.heading && cur.length > 40) || cur.length >= SECTION_SENTENCES) {
      sections.push(cur);
      cur = [];
    }
    cur.push(i);
  });
  if (cur.length) sections.push(cur);

  const chosen = new Set();
  for (const idxs of sections) {
    const body = idxs.filter((i) => !sentences[i].heading);
    const sectionWords = body.reduce((a, i) => a + sentences[i].words, 0);
    const budget = sectionWords * ratio;
    const scores = rankSentences(body.map((i) => sentences[i].text));
    const order = body.map((i, k) => ({ i, score: scores[k] })).sort((a, b) => b.score - a.score);
    let used = 0;
    for (const { i } of order) {
      if (used >= budget) break;
      const w = sentences[i].words;
      if (used + w > budget * 1.15 && used > 0 && w > 8) continue;
      chosen.add(i);
      used += w;
    }
    // Keep headings of sections that contributed anything.
    for (const i of idxs) if (sentences[i].heading && body.some((b) => chosen.has(b))) chosen.add(i);
  }

  const out = [];
  let lastPara = -1;
  let buf = [];
  const flush = () => {
    if (buf.length) out.push(buf.join(' '));
    buf = [];
  };
  [...chosen].sort((a, b) => a - b).forEach((i) => {
    const s = sentences[i];
    if (s.heading) {
      flush();
      out.push('## ' + s.text);
      lastPara = s.para;
      return;
    }
    if (s.para !== lastPara) flush();
    buf.push(s.text);
    lastPara = s.para;
  });
  flush();
  return out.join('\n\n');
}

function rankSentences(texts) {
  const n = texts.length;
  if (n === 0) return [];
  const tokens = texts.map(tokenize);
  const df = new Map();
  tokens.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const vecs = tokens.map((t) => {
    const tf = new Map();
    t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const x = (1 + Math.log(c)) * Math.log(1 + n / df.get(w));
      v.set(w, x);
      norm += x * x;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  });

  // Similarity graph (sparse via inverted index).
  const index = new Map();
  vecs.forEach(({ v }, i) => v.forEach((_, w) => { if (!index.has(w)) index.set(w, []); index.get(w).push(i); }));
  const edges = Array.from({ length: n }, () => new Map());
  vecs.forEach(({ v, norm }, i) => {
    const acc = new Map();
    v.forEach((x, w) => {
      const posting = index.get(w);
      if (posting.length > n * 0.5) return; // too common to be informative
      for (const j of posting) if (j > i) acc.set(j, (acc.get(j) || 0) + x * vecs[j].v.get(w));
    });
    acc.forEach((dot, j) => {
      const sim = dot / (norm * vecs[j].norm);
      if (sim > 0.05) { edges[i].set(j, sim); edges[j].set(i, sim); }
    });
  });

  // PageRank.
  const outSum = edges.map((e) => [...e.values()].reduce((a, b) => a + b, 0));
  let score = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 30; iter++) {
    const next = new Array(n).fill(0.15 / n);
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) continue;
      edges[i].forEach((w, j) => { next[j] += 0.85 * score[i] * (w / outSum[i]); });
    }
    score = next;
  }
  // Mild preferences: opening sentences and sentences of informative length.
  return score.map((s, i) => {
    const len = tokens[i].length;
    const lenFactor = len < 4 ? 0.5 : len > 60 ? 0.8 : 1;
    const posFactor = i === 0 ? 1.25 : i < 3 ? 1.1 : 1;
    return s * lenFactor * posFactor;
  });
}
