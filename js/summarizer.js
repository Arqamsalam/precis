// Précis offline summarizer. Pure functions, no DOM, no network: runs in a Web Worker or the page.
//
// How it works, in four stages:
//  1. analyze(): split the text into sections, paragraphs and sentences, and measure each sentence
//     (how central it is via TextRank, how many key terms it carries, where it sits, cue phrases…).
//  2. select: walk through the document in windows and spend each window's word budget on its best
//     sentences, skipping near-duplicates and bringing along a sentence's lead-in when it needs one.
//  3. smooth: drop dangling connectives ("Moreover, …") and, optionally, side remarks and citations.
//  4. format: rebuild paragraphs / bullets / sections, plus optional extra sections.

import { countWords, looksLikeHeading } from './textutil.js';

// ------------------------------------------------------------------ languages

const STOP_RAW = {
  en: `a about above after again against all almost also am an and any are aren't as at be because been before being below between both
    but by can cannot could couldn't did didn't do does doesn't doing don't down during each either else even ever every few for from
    further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how however i i'd
    i'll i'm i've if in into is isn't it it's its itself just let's like many may me might more most much must my myself neither never
    no nor not now of off often on once one only or other ought our ours ourselves out over own perhaps quite rather really same say
    said says shall she she'd she'll she's should shouldn't since so some such than that that's the their theirs them themselves then
    there there's therefore these they they'd they'll they're they've this those though through thus till to too toward towards under
    until unto up upon us very was wasn't we we'd we'll we're we've well were weren't what what's whatever when where where's whether
    which while who who's whom whose why will with within without won't would wouldn't yet you you'd you'll you're you've your yours
    yourself yourselves thee thou thy thine ye hath doth also get got go went come came make made know see seem seemed things thing`,
  es: `de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy
    sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes
    algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros
    mi mis tú te ti tu tus ellas es son fue era ser ha han había`,
  fr: `le la les de des du un une et en à au aux ce ces cette cet il elle ils elles on nous vous je tu me te se lui leur leurs son sa ses
    mon ma mes ton ta tes notre nos votre vos qui que quoi dont où ne pas plus par pour sur dans avec sans sous entre est sont était été
    être avoir a ont avait mais ou donc ni car si comme aussi bien très tout tous toute toutes y`,
  de: `der die das den dem des ein eine einer eines einem einen und oder aber in im zu zum zur von vom mit auf an am aus bei für über
    unter nach vor durch um ist sind war waren sein hat haben hatte wird werden wurde nicht kein keine ich du er sie es wir ihr mich mir
    dich dir sich uns euch ihm ihn ihnen seine ihre auch als wie wenn dass so noch nur schon doch dann denn da hier dort was wer wo`,
  pt: `de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito
    há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha
    foram essa num nem suas meu às minha numa pelos elas havia seja qual será nós tenho lhe deles essas esses pelas este fosse dele`,
  it: `di a da in con su per tra fra il lo la i gli le un uno una e è ed o ma non che chi cui come dove quando se anche più del della
    dei delle degli al alla ai alle nel nella nei nelle sul sulla questo questa quello quella sono era erano essere ha hanno aveva io tu
    lui lei noi voi loro mi ti si ci vi suo sua suoi sue`,
  nl: `de het een en van in is dat op te zijn met voor niet aan er om ook als bij of maar door naar dan wordt nog zo uit worden was werd
    hij zij ze we wij ik je u hun haar dit die deze tot heeft hebben had al wel geen kan meer`,
  id: `yang dan di ke dari ini itu dengan untuk pada adalah dalam tidak akan juga atau oleh karena sebagai bisa ada mereka kami kita
    saya anda ia dia sudah telah lebih harus tersebut seperti saat jika namun`,
  tr: `ve bir bu da de için ile ama gibi çok daha en ne o şu her mi mu mı mü ki ise veya hem kadar sonra önce olan olarak değil var yok
    ben sen biz siz onlar bunu şey diye`,
  ru: `и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему
    теперь когда даже ну ли если уже или ни быть был него до вас опять уж вам ведь там потом себя ничего ей может они тут где есть надо
    ней для мы тебя их чем была сам без будто чего раз тоже себе под будет тогда кто этот того потому этого какой совсем ним здесь этом
    один почти мой тем чтобы нее сейчас были куда можно при два об другой после над больше тот через эти нас про всего них много три эту
    моя перед иногда лучше чуть том такой им более всегда конечно всю между`,
  ur: `کے کی کا کو میں سے پر اور یہ وہ ہے ہیں تھا تھی تھے نے کہ بھی تو ہی ایک اس ان جو کر کیا کیے گیا گئی ہو ہوا ہوئی لیے ساتھ بعد
    پہلے یا نہیں تک جب اپنے اپنی اپنا رہا رہی رہے سکتا سکتی کچھ`,
  ar: `في من على إلى عن أن إن كان كانت هذا هذه ذلك التي الذي الذين ما لا لم لن قد مع هو هي هم نحن أنا كل بين بعد قبل ثم أو أي حتى
    عند كما لكن إذا وقد وفي ومن وأن وهو وهي فيه منه به له لها`,
  hi: `का की के को में से पर और यह वह है हैं था थी थे ने कि भी तो ही एक इस उस जो कर किया गया गई हो लिए साथ बाद पहले या नहीं तक जब
    अपने अपनी कुछ`,
};
const STOP = Object.fromEntries(Object.entries(STOP_RAW).map(([k, v]) => [k, new Set(v.split(/\s+/).filter(Boolean))]));
const LATIN_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'id', 'tr'];
const NO_SPACE_LANGS = new Set(['zh', 'ja', 'th']);

export function detectLanguage(text) {
  const s = text.slice(0, 30000);
  const count = (re) => (s.match(re) || []).length;
  const scripts = {
    arabic: count(/[؀-ۿݐ-ݿ]/g),
    devanagari: count(/[ऀ-ॿ]/g),
    han: count(/\p{Script=Han}/gu),
    kana: count(/[぀-ヿ]/g),
    hangul: count(/[가-힯]/g),
    thai: count(/[฀-๿]/g),
    cyrillic: count(/[Ѐ-ӿ]/g),
    latin: count(/[A-Za-zÀ-ɏ]/g),
  };
  const [top, topCount] = Object.entries(scripts).sort((a, b) => b[1] - a[1])[0];
  if (!topCount) return 'en';
  if (top === 'arabic') return count(/[ٹڈڑںےۓ]/g) > scripts.arabic * 0.01 ? 'ur' : 'ar';
  if (top === 'devanagari') return 'hi';
  if (top === 'han' || top === 'kana') return scripts.kana > scripts.han * 0.05 ? 'ja' : 'zh';
  if (top === 'hangul') return 'ko';
  if (top === 'thai') return 'th';
  if (top === 'cyrillic') return 'ru';
  const words = (s.toLowerCase().match(/[\p{L}']+/gu) || []).slice(0, 4000);
  let best = 'en';
  let bestHits = 0;
  for (const lang of LATIN_LANGS) {
    const set = STOP[lang];
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    if (hits > bestHits * 1.15) { best = lang; bestHits = hits; }
  }
  return best;
}

function stemEn(w) {
  if (w.length < 4) return w;
  w = w.replace(/['’]s$/, '');
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ness') && w.length > 6) w = w.slice(0, -4);
  const undouble = (x) => (/([^aeiouls])\1$/.test(x) ? x.slice(0, -1) : x);
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2);
  if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function makeTokenizer(lang) {
  const stop = STOP[lang] || new Set();
  const stem = lang === 'en' ? stemEn : (w) => w;
  if (NO_SPACE_LANGS.has(lang) && typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(lang, { granularity: 'word' });
    return (s) => Array.from(seg.segment(s)).filter((x) => x.isWordLike).map((x) => x.segment.toLowerCase()).filter((w) => !stop.has(w));
  }
  return (s) => {
    const out = [];
    for (const m of s.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu)) {
      const w = m[0].replace(/['’-]+$/, '');
      if (w.length < 2 || stop.has(w) || /^\d+$/.test(w) && w.length < 3) continue;
      out.push(stem(w));
    }
    return out;
  };
}

// ------------------------------------------------------------------ structure

const ABBREV = /(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Gen|Col|Lt|Sgt|Capt|Cmdr|Rev|Hon|Mt|Ft|vs|etc|e\.g|i\.e|cf|al|approx|Inc|Ltd|Co|Corp|No|Nos|Fig|Figs|Vol|Ch|pp?|Sept?|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Aug|U\.S|U\.K|Gov|Sen|Rep|Ave|Blvd|Dept|Univ)\.|\b[A-Z]\.)$/;

function sentenceSplitter(lang) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(lang, { granularity: 'sentence' }) : null;
  const raw = (p) => (seg
    ? Array.from(seg.segment(p), (x) => x.segment.trim()).filter(Boolean)
    : (p.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g) || [p]).map((x) => x.trim()).filter(Boolean));
  return (p) => {
    const parts = raw(p);
    const out = [];
    for (const s of parts) {
      const prev = out[out.length - 1];
      if (prev && (
        ABBREV.test(prev) || // "Mr." / "Harry S." / "e.g."
        /^[a-zß-ÿ]/.test(s) || // "…?" she asked.
        /^[,;:)\]]/.test(s) ||
        (openQuote(prev) && prev.split(/\s+/).length < 120) // keep a quoted speech together
      )) {
        out[out.length - 1] = `${prev} ${s}`;
      } else out.push(s);
    }
    return out.flatMap(splitLong);
  };
}

// Text without punctuation (raw transcripts, lists of words) would become one giant "sentence" that no
// budget can fit; break such runs at commas/dashes, or every ~40 words.
function splitLong(s) {
  const words = s.split(/\s+/);
  if (words.length <= 90) return [s];
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if ((cur.length >= 30 && /[,;:—–]$/.test(w)) || cur.length >= 45) {
      out.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

function openQuote(s) {
  const curlyOpen = (s.match(/“/g) || []).length;
  const curlyClose = (s.match(/”/g) || []).length;
  if (curlyOpen !== curlyClose) return curlyOpen > curlyClose;
  if ((s.match(/"/g) || []).length % 2 === 1) return true;
  // Single-quoted dialogue ('Oh dear!' said Alice): an opening quote follows a space, a closing one precedes
  // a space or the end. Apostrophes inside words (don't) match neither.
  const opens = (s.match(/(?:^|[\s([—–-])['‘](?=[\p{L}\p{N}"“])/gu) || []).length;
  const closes = (s.match(/[\p{L}\p{N}.,!?;:—–-]['’](?=[\s)\]—–-]|$)/gu) || []).length;
  return opens > closes;
}

// Split text into blocks: headings and paragraphs. Hard-wrapped lines (as in many .txt books) are
// rejoined; one-paragraph-per-line text keeps its lines as paragraphs.
function parseBlocks(text) {
  const blocks = [];
  const chunks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  // A short first line without sentence punctuation is the document's title, not a sentence.
  const firstLines = chunks[0]?.split('\n').map((l) => l.trim()).filter(Boolean) || [];
  const first = firstLines[0] || '';
  const allCaps = /\p{Lu}/u.test(first) && first === first.toUpperCase();
  if (first && first.length <= 160 && first.split(/\s+/).length <= (allCaps ? 30 : 15) &&
    !/[.!?:;,。！？；：，、۔؟।॥]["”’'»]?$/.test(first.replace(/[\])]$/, ''))) {
    blocks.push({ type: 'title', text: firstLines[0].replace(/^[[(]|[\])]$/g, '').trim() });
    chunks[0] = firstLines.slice(1).join('\n');
  }
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const listy = lines.filter((l) => /^([-*•]|\d+[.)])\s/.test(l)).length >= Math.max(2, lines.length * 0.6);
    const wrapped = lines.length > 1 && lines.filter((l) => !/[.!?:;"”’)]$/.test(l)).length >= lines.length * 0.4 &&
      lines.reduce((a, l) => a + l.length, 0) / lines.length < 100;
    let buf = [];
    const flush = () => {
      if (buf.length) blocks.push({ type: 'p', text: buf.join(' ') });
      buf = [];
    };
    for (const l of lines) {
      const md = /^(#{1,6})\s+(.+)$/.exec(l);
      const chapterLike = /^(chapter|part|book|section|act|scene|prologue|epilogue)\b/i.test(l);
      // In hard-wrapped prose only a chapter line at the start of a block is a heading; when every line is its
      // own paragraph, any heading-looking line counts.
      const capsLine = /\p{Lu}{3}/u.test(l) && l === l.toUpperCase() && l.split(/\s+/).length <= 20 && !/[.!?,;:]$/.test(l);
      const headingHere = md || capsLine || (lines.length <= 2 && looksLikeHeading(l)) ||
        (!wrapped && looksLikeHeading(l)) || (buf.length === 0 && chapterLike && looksLikeHeading(l));
      if (headingHere) {
        flush();
        blocks.push({ type: 'h', text: (md ? md[2] : l).replace(/[_*]+/g, '').trim() });
      } else if (listy || !wrapped) {
        if (listy || lines.length > 1) { flush(); blocks.push({ type: 'p', text: l, list: listy }); } else buf.push(l);
      } else buf.push(l);
    }
    flush();
  }
  return blocks;
}

// ------------------------------------------------------------------ analysis

const CUE_POS = /\b(in (conclusion|summary|short|sum|essence)|to (sum up|summarize|summarise|conclude)|overall|above all|most important(ly)?|the (main|key|central|chief|primary) (point|idea|issue|reason|goal|finding|problem|question)|importantly|significant(ly)?|crucial(ly)?|essential(ly)?|we (found|find|show|conclude|propose|argue|recommend)|(this|the) (paper|report|study|article|book|chapter) (shows|argues|finds|presents|describes|examines)|(the )?(results?|findings?|evidence) (show|shows|suggest|suggests|indicate|indicates)|as a result|in other words|the purpose of)\b/i;
const CUE_NEG = /\b(for (example|instance)|e\.g\.|such as|incidentally|by the way|for one thing|in parentheses)\b/i;
const DEPENDENT = /^[\s"“'‘(«]*(he|she|it|they|them|him|her|his|its|their|this|these|those|that|such|then|however|but|yet|also|moreover|furthermore|additionally|besides|therefore|thus|hence|so|still|nevertheless|nonetheless|instead|meanwhile|afterwards|consequently|similarly|likewise|and|or|nor|another|both|neither|either|in addition|as a result|on the other hand|in contrast|by contrast|for this reason|even so)\b/i;

/**
 * Measure every sentence of a text. The result is cached by the worker, so changing the length
 * or other options only re-runs the cheap selection step.
 */
export function analyze(text, { title = '', onProgress } = {}) {
  const t0 = Date.now();
  const lang = detectLanguage(text);
  const tokenize = makeTokenizer(lang);
  const split = sentenceSplitter(lang);
  const blocks = parseBlocks(text);

  const sentences = [];
  const paragraphs = []; // {sentences:[idx], section, list}
  const sections = [{ title: '', heading: null, start: 0 }];
  let wordPos = 0;
  let docTitle = '';
  for (const b of blocks) {
    if (b.type === 'title') {
      docTitle = b.text;
      continue;
    }
    if (b.type === 'h') {
      sections.push({ title: b.text, heading: b.text, start: sentences.length });
      paragraphs.push({ heading: b.text, section: sections.length - 1, sentences: [] });
      continue;
    }
    const pIdx = paragraphs.length;
    const para = { section: sections.length - 1, sentences: [], list: !!b.list };
    paragraphs.push(para);
    // Decorative separators ("* * * *") and other lines without letters are not sentences.
    const parts = (b.list ? [b.text] : split(b.text)).filter((x) => /\p{L}/u.test(x));
    if (!parts.length) { paragraphs.pop(); continue; }
    parts.forEach((s, k) => {
      const words = countWords(s);
      sentences.push({
        i: sentences.length, text: s, para: pIdx, inPara: k, section: para.section, words, pos: wordPos,
        tokens: tokenize(s), list: !!b.list,
      });
      para.sentences.push(sentences.length - 1);
      wordPos += words;
    });
  }
  // Drop empty leading section.
  const totalWords = wordPos || 1;
  onProgress?.(0.25);

  // TF-IDF vectors (sentences are the "documents").
  const N = sentences.length || 1;
  const df = new Map();
  const docTf = new Map();
  for (const s of sentences) {
    for (const w of new Set(s.tokens)) df.set(w, (df.get(w) || 0) + 1);
    for (const w of s.tokens) docTf.set(w, (docTf.get(w) || 0) + 1);
  }
  const idf = (w) => Math.log(1 + N / (df.get(w) || 1));
  for (const s of sentences) {
    const tf = new Map();
    for (const w of s.tokens) tf.set(w, (tf.get(w) || 0) + 1);
    const vec = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const x = (1 + Math.log(c)) * idf(w);
      vec.set(w, x);
      norm += x * x;
    }
    s.vec = vec;
    s.norm = Math.sqrt(norm) || 1;
  }

  // Centrality: TextRank over windows of up to 800 consecutive sentences.
  const CH = 800;
  for (let start = 0; start < sentences.length; start += CH) {
    const slice = sentences.slice(start, start + CH);
    const ranks = textRank(slice, N);
    const max = Math.max(...ranks, 1e-9);
    slice.forEach((s, k) => { s.central = ranks[k] / max; });
    onProgress?.(0.25 + 0.55 * Math.min(1, (start + CH) / sentences.length));
  }

  // Global key terms, and per-section key terms (so each part's own topic counts too).
  const globalKw = topTerms(docTf, idf, 40, df, N);
  const sectionKw = sections.map((sec, si) => {
    const tf = new Map();
    for (const s of sentences) if (s.section === si) for (const w of s.tokens) tf.set(w, (tf.get(w) || 0) + 1);
    return topTerms(tf, idf, 15, df, N);
  });
  const titleStems = new Set(tokenize(title || docTitle));

  let maxKg = 1e-9;
  let maxKl = 1e-9;
  for (const s of sentences) {
    const uniq = new Set(s.tokens);
    let kg = 0;
    let kl = 0;
    const local = sectionKw[s.section];
    for (const w of uniq) {
      kg += globalKw.get(w) || 0;
      kl += local.get(w) || 0;
    }
    const damp = 1 + Math.log(1 + uniq.size);
    s.kg = kg / damp;
    s.kl = kl / damp;
    maxKg = Math.max(maxKg, s.kg);
    maxKl = Math.max(maxKl, s.kl);
    const heading = sections[s.section].heading;
    const hStems = heading ? tokenize(heading) : [];
    const ref = new Set([...titleStems, ...hStems]);
    s.titleHit = ref.size ? [...uniq].filter((w) => ref.has(w)).length / Math.min(ref.size, 6) : 0;
    s.cue = CUE_POS.test(s.text) ? 1 : CUE_NEG.test(s.text) ? -0.5 : 0;
    const proper = (s.text.slice(1).match(/(?<![.!?]\s)\b\p{Lu}\p{Ll}+/gu) || []).length;
    s.info = Math.min(1, proper / 3) * 0.6 + (/\d/.test(s.text) ? 0.4 : 0);
    const bare = s.text.replace(/^["“'‘(«\s—–-]+/, '');
    const tail = s.text.replace(/["”’')\]»\s]+$/, '');
    // A list item or a broken-off piece of a sentence (lowercase start, or a ")" closing a bracket opened earlier).
    s.lowerStart = /^\p{Ll}/u.test(bare) || (s.text.match(/\)/g) || []).length > (s.text.match(/\(/g) || []).length;
    s.fragment = s.lowerStart || /(?:[;,]|\b(?:and|or|but))$/i.test(tail);
    s.intro = /:$/.test(tail);
    s.ordinal = lang === 'en' && /^(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|lastly|finally)\b/i.test(bare);
    s.quote = /^["“'‘«]/.test(s.text);
  }
  // Sentences that only make sense after the one before them ("He refused.", "Second, …", "…; and").
  for (const s of sentences) {
    const prev = sentences[s.i - 1];
    const sameSection = prev && prev.section === s.section;
    s.needsPrev = !!sameSection && (
      (lang === 'en' && s.inPara > 0 && DEPENDENT.test(s.text)) || s.ordinal || s.lowerStart || prev.intro
    );
  }

  // Base score; focus terms are added at selection time.
  for (const s of sentences) {
    const para = paragraphs[s.para];
    const firstParaOfSection = paragraphs.findIndex((p) => p.section === s.section && p.sentences?.length) === s.para;
    const pos = (s.inPara === 0 ? 0.65 : s.inPara === 1 ? 0.15 : 0) + (firstParaOfSection ? 0.35 : 0);
    const w = s.words;
    const lenFactor = w < 4 ? 0.35 : w < 7 ? 0.7 : w > 75 ? 0.6 : w > 45 ? 0.85 : 1;
    const shape = s.lowerStart ? 0.5 : s.fragment ? 0.65 : s.intro ? 0.7 : 1;
    s.base = lenFactor * shape * (
      0.38 * (s.central || 0) + 0.2 * (s.kg / maxKg) + 0.17 * (s.kl / maxKl) + 0.08 * Math.min(1, s.titleHit) +
      0.1 * pos + 0.04 * s.cue + 0.03 * s.info
    ) + (para.list ? 0.02 : 0);
  }
  onProgress?.(1);

  const keyPhrases = extractKeyPhrases(text, lang);
  return {
    lang, title: title || docTitle, docTitle, sentences, paragraphs, sections, totalWords, tokenize,
    keyPhrases, globalKw,
    hasHeadings: sections.length > 1,
    readingEase: lang === 'en' ? fleschEase(sentences) : null,
    ms: Date.now() - t0,
  };
}

function topTerms(tf, idf, k, df, N) {
  const arr = [];
  for (const [w, c] of tf) {
    if ((df.get(w) || 0) > N * 0.25 && N > 20) continue; // too common to be a topic
    arr.push([w, c * idf(w)]);
  }
  arr.sort((a, b) => b[1] - a[1]);
  const top = arr.slice(0, k);
  const max = top[0]?.[1] || 1;
  return new Map(top.map(([w, v]) => [w, v / max]));
}

function cosine(a, b) {
  const [small, big] = a.vec.size < b.vec.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [w, x] of small.vec) {
    const y = big.vec.get(w);
    if (y) dot += x * y;
  }
  return dot / (a.norm * b.norm);
}

function textRank(sents, N) {
  const n = sents.length;
  if (!n) return [];
  const index = new Map();
  sents.forEach((s, i) => s.vec.forEach((_, w) => { if (!index.has(w)) index.set(w, []); index.get(w).push(i); }));
  const edges = Array.from({ length: n }, () => new Map());
  sents.forEach((s, i) => {
    const acc = new Map();
    s.vec.forEach((x, w) => {
      const posting = index.get(w);
      if (posting.length > Math.max(12, n * 0.3)) return;
      for (const j of posting) if (j > i) acc.set(j, (acc.get(j) || 0) + x * sents[j].vec.get(w));
    });
    acc.forEach((dot, j) => {
      const sim = dot / (s.norm * sents[j].norm);
      if (sim > 0.04) { edges[i].set(j, sim); edges[j].set(i, sim); }
    });
  });
  const outSum = edges.map((e) => { let t = 0; e.forEach((v) => { t += v; }); return t; });
  let score = new Array(n).fill(1 / n);
  for (let it = 0; it < 30; it++) {
    const next = new Array(n).fill(0.15 / n);
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) continue;
      const share = 0.85 * score[i] / outSum[i];
      edges[i].forEach((w, j) => { next[j] += share * w; });
    }
    score = next;
  }
  void N;
  return score;
}

// ------------------------------------------------------------------ selection

/**
 * @param {object} A analysis from analyze()
 * @param {{ratio:number, format?:string, focus?:string, smooth?:boolean, trim?:boolean, dedupe?:boolean,
 *          markGaps?:boolean, extras?:string[]}} o
 */
export function summarize(A, o) {
  const t0 = Date.now();
  const ratio = Math.min(0.95, Math.max(0.005, o.ratio || 0.25));
  const S = A.sentences;
  if (!S.length) return { markdown: '', selected: [], stats: { sentences: 0, chosen: 0 } };

  // Focus terms: stems + raw phrases.
  const focusTerms = (o.focus || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  const focusStems = new Set(focusTerms.flatMap((f) => A.tokenize(f)));
  const focusPhrases = focusTerms.filter((f) => f.includes(' ')).map((f) => f.toLowerCase());
  const score = S.map((s) => {
    let sc = s.base;
    if (focusStems.size || focusPhrases.length) {
      let hits = 0;
      for (const w of new Set(s.tokens)) if (focusStems.has(w)) hits++;
      for (const p of focusPhrases) if (s.text.toLowerCase().includes(p)) hits++;
      sc += Math.min(hits, 3) * 0.25;
    }
    return sc;
  });

  // Windows: consecutive stretches of the text, each spending its share of the word budget.
  const avg = A.totalWords / S.length;
  const W = Math.max(320, (2.6 * avg) / ratio);
  const windows = [];
  let cur = [];
  let cw = 0;
  for (const s of S) {
    const newSection = cur.length && S[cur[cur.length - 1]].section !== s.section;
    if (cur.length && (cw >= W || (newSection && cw >= W * 0.45))) {
      windows.push(cur);
      cur = [];
      cw = 0;
    }
    cur.push(s.i);
    cw += s.words;
  }
  if (cur.length) windows.push(cur);

  const chosen = new Set();
  const recent = [];
  const lambda = o.dedupe === false ? 0 : 0.55;
  let carry = 0;
  for (const win of windows) {
    const winWords = win.reduce((a, i) => a + S[i].words, 0);
    const budget = winWords * ratio + carry;
    let used = 0;
    const pool = new Set(win);
    for (;;) {
      const remaining = budget - used;
      const tolerance = Math.max(6, budget * 0.15);
      let best = null;
      for (const i of pool) {
        if (chosen.has(i)) continue;
        const s = S[i];
        let cost = s.words;
        let value = score[i];
        let withPrev = false;
        const prev = S[i - 1];
        if (o.smooth !== false && s.needsPrev && !chosen.has(i - 1)) {
          if (prev.words + s.words <= remaining + tolerance) {
            cost += prev.words;
            value = (score[i] + score[i - 1]) / 2 + 0.02;
            withPrev = true;
          } else value *= 0.75;
        }
        if (cost > remaining + tolerance) continue;
        if (lambda && recent.length) {
          let maxSim = 0;
          for (const r of recent) maxSim = Math.max(maxSim, cosine(s, S[r]));
          value -= lambda * maxSim * 0.5;
        }
        if (!best || value > best.value) best = { i, value, cost, withPrev };
      }
      if (!best) break;
      chosen.add(best.i);
      if (best.withPrev) chosen.add(best.i - 1);
      used += best.cost;
      recent.push(best.i);
      if (recent.length > 40) recent.shift();
      if (used >= budget) break;
    }
    carry = Math.max(-budget, budget - used);
  }

  const selected = [...chosen].sort((a, b) => a - b);
  const body = format(A, selected, o);
  const extras = extrasMarkdown(A, score, o);
  return {
    markdown: body + extras,
    body,
    extras,
    selected,
    lang: A.lang,
    title: A.docTitle,
    stats: {
      sentences: S.length,
      chosen: selected.length,
      words: A.totalWords,
      summaryWords: selected.reduce((a, i) => a + S[i].words, 0),
      coverage: selected.map((i) => S[i].pos / A.totalWords),
      readingEase: A.readingEase,
      ms: Date.now() - t0 + A.ms,
    },
  };
}

// ------------------------------------------------------------------ smoothing

const DROP_LEAD = /^(\s*["“'‘(«]*\s*)(also|moreover|furthermore|in addition|additionally|besides|what's more|likewise|similarly|and|plus|indeed|in fact|of course|however|but|yet|still|nevertheless|nonetheless|on the other hand|in contrast|by contrast|instead|even so|then|so|now|well|anyway|again|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|lastly|finally)\s*,?\s+/i;

/**
 * Make a sentence read well on its own: drop a connective whose partner sentence was left out, finish
 * a list item with a full stop when the next item isn't included, and optionally trim side remarks.
 */
function smoothSentence(text, { isolated, nextIncluded = false, smooth, trim, lang }) {
  let t = text;
  if (smooth && isolated && lang === 'en') {
    const m = DROP_LEAD.exec(t);
    if (m && t.length - m[0].length > 12) {
      t = m[1] + t.slice(m[0].length);
    }
  }
  if (smooth && !nextIncluded) {
    t = t.replace(/\s*[;,:]\s*(?:(?:and|or|but)\s*)?$/i, '.').replace(/[;,]\s+(?:and|or|but)$/i, '.');
  }
  if (smooth) t = t.replace(/^(\s*["“'‘(«]*\s*)(\p{Ll})/u, (all, pre, ch) => pre + ch.toUpperCase());
  if (trim) t = trimAsides(t);
  return t;
}

export function trimAsides(t) {
  return t
    .replace(/\s*\[(?:\d+(?:\s*[-–,]\s*\d+)*|[a-z]|citation needed|note \d+|sic)\]/gi, '')
    .replace(/\s*\((?:[A-Z][\p{L}'’-]+(?:\s+et al\.)?(?:,?\s+(?:and|&)\s+[A-Z][\p{L}'’-]+)?),?\s+\d{4}[a-z]?(?:[;,][^)]{0,80})?\)/gu, '')
    .replace(/\s*\((?:see|e\.g\.|i\.e\.|cf\.|for example|for instance|viz\.)[^()]{0,160}\)/gi, '')
    .replace(/\s*\((?:fig(?:ure)?s?\.?|table|tab\.|chapter|ch\.|section|sec\.|p\.|pp\.|page|appendix)\s*[^()]{0,30}\)/gi, '')
    .replace(/\s*\(([^()\d]{1,140})\)/g, (all, inner) => (inner.trim().split(/\s+/).length <= 14 ? '' : all))
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ formatting

function format(A, selected, o) {
  const S = A.sentences;
  const sel = new Set(selected);
  const fmt = o.format || 'paragraphs';
  const textOf = (i) => smoothSentence(S[i].text, {
    isolated: !sel.has(i - 1) || S[i - 1].section !== S[i].section,
    nextIncluded: sel.has(i + 1) && fmt !== 'bullets',
    smooth: o.smooth !== false, trim: !!o.trim, lang: A.lang,
  });
  const lines = [];
  let lastSection = -1;
  const heading = (secIdx, level) => {
    const h = A.sections[secIdx].heading;
    if (h) lines.push(`${'#'.repeat(level)} ${escapeMd(h)}`);
  };

  if (fmt === 'bullets') {
    for (const i of selected) {
      if (S[i].section !== lastSection) {
        lastSection = S[i].section;
        if (A.hasHeadings) heading(lastSection, 3);
      }
      lines.push(`- ${escapeInline(textOf(i))}`);
    }
    return joinBlocks(lines, true);
  }

  // Paragraph groups (consecutive picks from one source paragraph).
  const groups = [];
  for (const i of selected) {
    const g = groups[groups.length - 1];
    if (g && S[g.items[g.items.length - 1]].para === S[i].para) g.items.push(i);
    else groups.push({ para: S[i].para, section: S[i].section, items: [i], list: S[i].list });
  }

  // Artificial parts for the "sections" format when the text has no headings of its own.
  let partOf = null;
  if (fmt === 'sections' && !A.hasHeadings) {
    const parts = Math.max(2, Math.min(12, Math.round(A.totalWords / 1500)));
    partOf = (i) => Math.min(parts - 1, Math.floor((S[i].pos / A.totalWords) * parts));
    partOf.total = parts;
  }

  let paraBuf = [];
  let paraCount = 0;
  const flushPara = () => {
    if (paraBuf.length) lines.push(paraBuf.join(''));
    paraBuf = [];
    paraCount = 0;
  };
  let lastPart = -1;
  let prevGroup = null;
  for (const g of groups) {
    if (partOf) {
      const p = partOf(g.items[0]);
      if (p !== lastPart) {
        flushPara();
        lastPart = p;
        lines.push(`## Part ${p + 1} of ${partOf.total}`);
        prevGroup = null;
      }
    } else if (g.section !== lastSection) {
      flushPara();
      lastSection = g.section;
      heading(g.section, 2);
      prevGroup = null;
    }
    if (g.list) {
      flushPara();
      g.items.forEach((i) => lines.push(`- ${escapeInline(textOf(i).replace(/^([-*•]|\d+[.)])\s+/, ''))}`));
      prevGroup = null;
      continue;
    }
    // Merge small neighbouring groups into one paragraph so the summary doesn't read as a list of one-liners.
    const small = g.items.length <= 2;
    const mergeable = prevGroup && small && paraCount <= 3 && paraCount + g.items.length <= 5 && g.para - prevGroup.para <= 6;
    if (!mergeable) flushPara();
    g.items.forEach((i, k) => {
      let t = textOf(i);
      const gap = k > 0 ? i - g.items[k - 1] > 1 : paraBuf.length > 0;
      const sep = NO_SPACE_LANGS.has(A.lang) ? '' : ' ';
      if (paraBuf.length) paraBuf.push(o.markGaps && gap ? `${sep}[…]${sep}` : sep);
      if (k === 0 && paraBuf.length === 0) t = escapeLead(t);
      paraBuf.push(escapeInline(t));
      paraCount++;
    });
    prevGroup = g;
  }
  flushPara();
  return joinBlocks(lines);
}

function joinBlocks(lines, tight = false) {
  // Bullets under the same heading stay together; everything else is separated by blank lines.
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (tight && prev !== undefined && l.startsWith('- ') && prev.startsWith('- ')) out.push(l);
    else {
      if (out.length) out.push('');
      out.push(l);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function escapeMd(s) {
  return s.replace(/[*_`[\]]/g, (c) => `\\${c}`);
}
// Sentences are the author's text, not Markdown: neutralise characters that would change the layout.
function escapeInline(s) {
  return s.replace(/<(?=[a-zA-Z/!])/g, '&lt;').replace(/(^|\s)([*_]{2,})(?=\s|$)/g, '$1\\$2');
}
function escapeLead(s) {
  return s.replace(/^(\s*)(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|={3,}|-{3,})/, (m, sp, mark) => `${sp}\\${mark}`);
}

// ------------------------------------------------------------------ extras

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const SPEECH_VERBS = 'said|asked|replied|cried|answered|shouted|whispered|exclaimed|continued|added|thought|muttered|remarked|called|began|went on|repeated|declared|insisted|wrote|told|says|asks|explained|admitted|observed|screamed|yelled|murmured|sighed|laughed';

function extrasMarkdown(A, score, o) {
  const want = new Set(o.extras || []);
  if (!want.size) return '';
  const S = A.sentences;
  const out = [];
  const clean = (t) => escapeInline(escapeLead(smoothSentence(t, { isolated: true, smooth: true, trim: true, lang: A.lang })));
  const byScore = S.map((s) => s.i).sort((a, b) => score[b] - score[a]);

  if (want.has('takeaways')) {
    const n = Math.max(4, Math.min(10, Math.round(Math.sqrt(S.length) / 1.6)));
    const picks = [];
    for (const i of byScore) {
      if (picks.length >= n) break;
      if (S[i].words < 6 || S[i].words > 60 || S[i].quote || S[i].fragment || S[i].intro) continue;
      if (!/[.!?]["”’')\]]*$/.test(S[i].text)) continue;
      if (picks.some((j) => cosine(S[i], S[j]) > 0.35)) continue;
      picks.push(i);
    }
    picks.sort((a, b) => a - b);
    if (picks.length) out.push('## Key takeaways', picks.map((i) => `- ${clean(smoothSentence(S[i].text, { isolated: true, smooth: true, trim: false, lang: A.lang }))}`).join('\n'));
  }

  if (want.has('keywords')) {
    const k = A.keyPhrases.slice(0, 14);
    if (k.length) out.push('## Keywords', k.map((p) => `\`${p.replace(/`/g, '')}\``).join(' · '));
  }

  if (want.has('names')) {
    const names = extractNames(A);
    out.push('## Names mentioned', names.length
      ? names.slice(0, 18).map(([n, c]) => `**${escapeMd(n)}** (${c})`).join(' · ')
      : '_No recurring names found._');
  }

  if (want.has('quotes')) {
    const quotes = extractQuotes(A, score).slice(0, 6);
    out.push('## Notable quotes', quotes.length
      ? quotes.map((q) => `> “${escapeInline(q.text)}”${q.speaker ? ` — ${escapeMd(q.speaker)}` : ''}`).join('\n\n')
      : '_No quotations found._');
  }

  if (want.has('figures')) {
    const picks = byScore
      .filter((i) => /\d/.test(S[i].text) && !/^\s*\d+\s*$/.test(S[i].text) && S[i].words >= 6 && S[i].words <= 70 &&
        /(\d[\d,.]*\s*(%|percent|per cent|million|billion|thousand|trillion|hundred|km|kg|miles|tons|years?|days?|hours?|people|dollars|pounds|euros)|[$€£¥₹]\s?\d|\d[\d,]*\.\d|\d{1,3}(,\d{3})+)/i.test(S[i].text))
      .slice(0, 8)
      .sort((a, b) => a - b);
    out.push('## Key figures', picks.length ? picks.map((i) => `- ${clean(S[i].text)}`).join('\n') : '_No figures found._');
  }

  if (want.has('timeline')) {
    const dated = [];
    for (const i of byScore) {
      const s = S[i];
      const y = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(s.text);
      const md = new RegExp(`\\b(${MONTHS})\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(${MONTHS})\\b`).exec(s.text);
      if (!y && !md) continue;
      if (s.words > 70) continue;
      dated.push({ i, year: y ? Number(y[1]) : null, label: y ? y[1] : md[0] });
      if (dated.length >= 12) break;
    }
    dated.sort((a, b) => (a.year ?? 1e9) - (b.year ?? 1e9) || a.i - b.i);
    out.push('## Timeline', dated.length >= 2
      ? dated.map((d) => `- **${d.label}**: ${clean(S[d.i].text)}`).join('\n')
      : '_Not enough dates in the text for a timeline._');
  }
  return out.length ? `\n\n${out.join('\n\n')}` : '';
}

function extractNames(A) {
  if (!['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'id', 'tr', 'ru'].includes(A.lang)) return [];
  const stop = STOP[A.lang] || new Set();
  const counts = new Map();
  const midForms = new Set();
  const connectors = new Set(['of', 'de', 'van', 'von', 'da', 'del', 'la', 'le', 'al', 'bin', 'ibn', 'the', 'and']);
  const skip = new Set(['I', 'Chapter', 'Part', 'Book', 'The', 'A', 'An', 'Mr', 'Mrs', 'Ms', 'Dr', 'Sir', 'Madam', 'Miss', 'God', 'Lord', 'Oh', 'Yes', 'No', ...MONTHS.split('|'), 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  for (const s of A.sentences) {
    const words = s.text.split(/\s+/);
    let run = [];
    let runStart = false;
    const flush = () => {
      while (run.length && connectors.has(run[run.length - 1].toLowerCase())) run.pop();
      if (run.length) {
        const name = run.join(' ');
        const alone = run.length === 1;
        if (!(alone && (skip.has(name) || stop.has(name.toLowerCase()))) && name.length > 2 && !/^[\p{Lu}\s]+$/u.test(name) || (name.length > 2 && run.length > 1 && !/^[\p{Lu}\s]+$/u.test(name))) {
          counts.set(name, (counts.get(name) || 0) + 1);
          if (!runStart) midForms.add(name);
        }
      }
      run = [];
    };
    words.forEach((raw, k) => {
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}'’.-]+$/gu, '').replace(/['’]s$/, '').replace(/\.$/, '');
      const cap = /^\p{Lu}\p{Ll}/u.test(w);
      const startsSentence = k === 0 || /[.!?:"“”]$/.test(words[k - 1] || '');
      if (cap && !(run.length === 0 && skip.has(w))) {
        if (!run.length) runStart = startsSentence;
        run.push(w);
        if (/[,;:.!?)"”’]$/.test(raw)) flush();
      } else if (run.length && connectors.has(w) && w === w.toLowerCase()) run.push(w);
      else flush();
    });
    flush();
  }
  // A capitalised word that also appears in lowercase is usually an ordinary word ("Nation", "Progress").
  const lower = new Map();
  for (const s of A.sentences) {
    for (const m of s.text.matchAll(/(?<![\p{L}'’])\p{Ll}[\p{L}'’-]*/gu)) lower.set(m[0], (lower.get(m[0]) || 0) + 1);
  }
  const list = [...counts].filter(([n, c]) => midForms.has(n) && c >= 2 && !stop.has(n.toLowerCase()) &&
    (n.includes(' ') || (lower.get(n.toLowerCase()) || 0) < c * 0.5));
  list.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return list;
}

function extractQuotes(A, score) {
  const res = [];
  const re = /“([^”]{12,400})”|"([^"]{12,400})"|(?:^|[\s(—–-])'([^']{12,400}?)'(?=[\s,.;:!?)—–-]|$)|(?:^|[\s(—–-])‘([^’]{12,400}?)’(?=[\s,.;:!?)—–-]|$)/g;
  for (const s of A.sentences) {
    for (const m of s.text.matchAll(re)) {
      const q = (m[1] || m[2] || m[3] || m[4]).trim();
      const words = q.split(/\s+/).length;
      if (words < 5 || words > 60) continue;
      const after = s.text.slice(m.index + m[0].length);
      const before = s.text.slice(0, m.index);
      const sp = new RegExp(`^\\s*[,.!?—–-]?\\s*(?:(?:${SPEECH_VERBS})\\s+(?:the\\s+)?(\\p{Lu}[\\p{L}’'-]+(?:\\s\\p{Lu}[\\p{L}’'-]+)?)|(?:the\\s+)?(\\p{Lu}[\\p{L}’'-]+(?:\\s\\p{Lu}[\\p{L}’'-]+)?)\\s+(?:${SPEECH_VERBS}))`, 'u').exec(after) ||
        new RegExp(`(\\p{Lu}[\\p{L}’'-]+(?:\\s\\p{Lu}[\\p{L}’'-]+)?)\\s+(?:${SPEECH_VERBS})[,:]?\\s*$`, 'u').exec(before);
      const speaker = sp ? (sp[1] || sp[2] || '').trim() : '';
      const value = score[s.i] + (words >= 8 && words <= 35 ? 0.1 : 0) + (speaker ? 0.05 : 0);
      res.push({ text: q.replace(/[,]$/, '').trim(), speaker: /^(He|She|They|It|I|We|You)$/.test(speaker) ? '' : speaker, value, i: s.i });
    }
  }
  res.sort((a, b) => b.value - a.value);
  const picked = [];
  for (const q of res) {
    if (picked.some((p) => p.text === q.text || p.i === q.i)) continue;
    picked.push(q);
  }
  return picked;
}

// RAKE-style key phrases: runs of content words between stop words and punctuation.
export function extractKeyPhrases(text, lang) {
  const stop = STOP[lang];
  if (!stop || NO_SPACE_LANGS.has(lang)) return [];
  const sample = text.length > 800000 ? text.slice(0, 800000) : text;
  const phrases = new Map(); // lower -> {count, forms:Map}
  const wordFreq = new Map();
  const wordDeg = new Map();
  for (const piece of sample.split(/[.,;:!?()[\]{}"“”‘’'—–\n\t/\\|]+|\s-\s/)) {
    let run = [];
    const flush = () => {
      if (run.length && run.length <= 4) {
        const lower = run.map((w) => w.toLowerCase());
        if (!lower.every((w) => /^\d+$/.test(w))) {
          const key = lower.join(' ');
          const e = phrases.get(key) || { count: 0, forms: new Map(), words: lower };
          e.count++;
          const form = run.join(' ');
          e.forms.set(form, (e.forms.get(form) || 0) + 1);
          phrases.set(key, e);
          for (const w of lower) {
            wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
            wordDeg.set(w, (wordDeg.get(w) || 0) + lower.length);
          }
        }
      }
      run = [];
    };
    for (const raw of piece.split(/\s+/)) {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!w || stop.has(w.toLowerCase()) || w.length < 2) flush();
      else run.push(w);
    }
    flush();
  }
  const minCount = sample.length > 6000 ? 2 : 1;
  const scored = [];
  for (const [key, e] of phrases) {
    if (e.count < minCount) continue;
    if (e.words.length === 1 && e.words[0].length < 4) continue;
    const s = e.words.reduce((a, w) => a + (wordDeg.get(w) / wordFreq.get(w)), 0) * Math.log(1 + e.count);
    const form = [...e.forms].sort((a, b) => b[1] - a[1])[0][0];
    scored.push([form, s, key]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [form, , key] of scored) {
    if (out.some((o) => o.toLowerCase().includes(key) || key.includes(o.toLowerCase()))) continue;
    out.push(form);
    if (out.length >= 20) break;
  }
  return out;
}

function fleschEase(sentences) {
  let words = 0;
  let syll = 0;
  const sample = sentences.slice(0, 3000);
  for (const s of sample) {
    for (const w of s.text.toLowerCase().match(/[a-z]+/g) || []) {
      words++;
      const v = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
      syll += Math.max(1, v ? v.length : 1);
    }
  }
  if (!words || !sample.length) return null;
  return Math.round(206.835 - 1.015 * (words / sample.length) - 84.6 * (syll / words));
}

// ------------------------------------------------------------------ context view

/** The original text as paragraphs of {t, s} (sentence text, selected?) for the "In context" view. */
export function contextView(A, selected) {
  const sel = new Set(selected);
  return A.paragraphs.map((p) => (p.heading
    ? { h: p.heading }
    : { list: p.list, s: p.sentences.map((i) => ({ t: A.sentences[i].text, s: sel.has(i) })) }));
}
