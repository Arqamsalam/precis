// Read-aloud player with two kinds of voices:
//  - Natural voices: the Kokoro neural model running inside the page (English, downloaded once, ~90 MB).
//  - Browser voices: whatever the browser provides (Microsoft's natural voices in Edge, Google's in Chrome…).

const PREF_KEY = 'precis.voice.v2';
const NATURAL = /natural|neural|online|premium|enhanced|wavenet|studio/i;
const PREFERRED_NAMES = /\b(ava|andrew|emma|brian|jenny|guy|aria|christopher|sonia|ryan|libby|natasha|william|uzma|asad|salman|gul)\b/i;

// Kokoro voices with the quality grades published by the model's authors.
export const NEURAL_VOICES = [
  ['af_heart', 'Heart', 'American', 'Female', 'A'], ['af_bella', 'Bella', 'American', 'Female', 'A-'],
  ['af_nicole', 'Nicole', 'American', 'Female', 'B-'], ['bf_emma', 'Emma', 'British', 'Female', 'B-'],
  ['am_fenrir', 'Fenrir', 'American', 'Male', 'C+'], ['am_michael', 'Michael', 'American', 'Male', 'C+'],
  ['am_puck', 'Puck', 'American', 'Male', 'C+'], ['af_aoede', 'Aoede', 'American', 'Female', 'C+'],
  ['af_kore', 'Kore', 'American', 'Female', 'C+'], ['af_sarah', 'Sarah', 'American', 'Female', 'C+'],
  ['bm_george', 'George', 'British', 'Male', 'C'], ['bm_fable', 'Fable', 'British', 'Male', 'C'],
  ['bf_isabella', 'Isabella', 'British', 'Female', 'C'], ['af_alloy', 'Alloy', 'American', 'Female', 'C'],
  ['af_nova', 'Nova', 'American', 'Female', 'C'], ['af_sky', 'Sky', 'American', 'Female', 'C-'],
  ['bm_lewis', 'Lewis', 'British', 'Male', 'D+'], ['am_echo', 'Echo', 'American', 'Male', 'D'],
  ['am_eric', 'Eric', 'American', 'Male', 'D'], ['am_liam', 'Liam', 'American', 'Male', 'D'],
  ['am_onyx', 'Onyx', 'American', 'Male', 'D'], ['bm_daniel', 'Daniel', 'British', 'Male', 'D'],
  ['bf_alice', 'Alice', 'British', 'Female', 'D'], ['bf_lily', 'Lily', 'British', 'Female', 'D'],
].map(([id, name, accent, gender, grade]) => ({ id, name, accent, gender, grade }));
export const DEFAULT_NEURAL = 'af_heart';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}
export function neuralSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function' &&
    typeof (window.AudioContext || window.webkitAudioContext) === 'function';
}
export function isEdge() {
  return /\bEdg\//.test(navigator.userAgent);
}

let voicesPromise = null;
export function getBrowserVoices() {
  if (!speechSupported()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  voicesPromise ??= new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2500); // some browsers never fire the event
  }).finally(() => { voicesPromise = null; });
  return voicesPromise;
}

/** "Microsoft AvaMultilingual Online (Natural) - English (United States)" -> {name:"Ava Multilingual", region:"United States"} */
export function describeVoice(v) {
  let name = v.name;
  let region = '';
  const ms = /^Microsoft\s+(.+?)(?:\s+Online)?\s*(?:\((?:Natural|Neural)\))?\s*-\s*([^()]+?)(?:\s*\(([^)]+)\))?$/.exec(name);
  if (ms) {
    name = ms[1].replace(/([a-z])([A-Z])/g, '$1 $2');
    region = ms[3] || '';
  } else {
    name = name.replace(/^(Google|Apple|Microsoft)\s+/, '').replace(/\s*\((Natural|Neural|Online)\)/i, '');
  }
  const natural = NATURAL.test(v.name) || (/^Google/.test(v.name) && !v.localService);
  return { name: name.trim(), region, natural, online: !v.localService };
}

export function langName(code) {
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

function rankVoice(v, lang) {
  const d = describeVoice(v);
  let r = 0;
  if (lang && v.lang?.toLowerCase().startsWith(lang)) r += 100;
  if (d.natural) r += 40;
  if (PREFERRED_NAMES.test(d.name)) r += 10;
  if (/multilingual/i.test(v.name)) r += 5;
  if (v.default) r += 2;
  return r;
}

// ------------------------------------------------------------------ natural voice engine (Kokoro)

class NeuralVoice {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
    this.cache = new Map(); // key -> Promise<{data, rate}>
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { this.onStatus({ kind: 'download', loaded: m.loaded, total: m.total }); return; }
      if (m.type === 'device') { this.device = m.device; return; }
      const job = this.pending.get(m.id);
      if (!job) return;
      this.pending.delete(m.id);
      if (m.type === 'error') job.reject(new Error(m.message));
      else job.resolve(m);
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      for (const job of this.pending.values()) job.reject(new Error('The voice engine could not start in this browser.'));
      this.pending.clear();
      this.worker = null;
      this.ready = null;
    };
  }

  call(msg) {
    this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg });
    });
  }

  load() {
    this.ready ??= this.call({ type: 'load' }).then(() => this.onStatus({ kind: 'ready' })).catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  audio(text, voice, speed) {
    const key = `${voice}|${speed}|${text}`;
    if (!this.cache.has(key)) {
      const p = this.load().then(() => this.call({ type: 'generate', text, voice, speed }));
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(key);
  }
}

// ------------------------------------------------------------------ player

/**
 * Reads the output's block elements one sentence at a time and highlights the paragraph being read.
 * prefs.voice is "k:<kokoro id>" for a natural voice or "b:<voiceURI>" for a browser voice.
 */
export class ReadAloud {
  constructor({ onState, onStatus } = {}) {
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    const saved = loadPrefs();
    this.prefs = { voice: '', rate: 1, pitch: 1, ...saved };
    this.blocks = [];
    this.bi = 0;
    this.si = 0;
    this.playing = false;
    this.run = 0;
    this.voices = [];
    this.neural = new NeuralVoice((s) => this.onStatus(s));
    this.ctx = null;
    this.source = null;
    this.lang = 'en';
  }

  async refreshVoices() {
    this.voices = await getBrowserVoices();
    return this.voices;
  }

  /** Browser voices grouped by language, best first. */
  browserVoiceGroups(lang) {
    const sorted = [...this.voices].sort((a, b) => rankVoice(b, lang) - rankVoice(a, lang) || a.name.localeCompare(b.name));
    const groups = new Map();
    for (const v of sorted) {
      const label = langName((v.lang || 'und').replace('_', '-').split('-')[0]);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(v);
    }
    return groups;
  }

  /** Natural voices only speak English; other languages fall back to the best browser voice. */
  pickDefaultVoice(lang) {
    this.lang = lang || 'en';
    const v = this.prefs.voice;
    const english = this.lang === 'en';
    if (v.startsWith('k:') && english && neuralSupported()) return v;
    if (v.startsWith('b:') && this.voices.some((x) => `b:${x.voiceURI}` === v) &&
      (english || this.voices.find((x) => `b:${x.voiceURI}` === v)?.lang?.toLowerCase().startsWith(this.lang))) return v;
    if (english && neuralSupported()) return `k:${DEFAULT_NEURAL}`;
    const best = [...this.voices].sort((a, b) => rankVoice(b, this.lang) - rankVoice(a, this.lang))[0];
    return best ? `b:${best.voiceURI}` : '';
  }

  get isNeural() {
    return this.prefs.voice.startsWith('k:');
  }

  get browserVoice() {
    return this.voices.find((v) => `b:${v.voiceURI}` === this.prefs.voice) || null;
  }

  setPrefs(p, { save = true } = {}) {
    this.prefs = { ...this.prefs, ...p };
    if (save) savePrefs(this.prefs);
    if (this.playing) this.restartSentence();
  }

  load(container) {
    this.stop();
    const els = [...container.querySelectorAll('h1, h2, h3, h4, p, li, blockquote > p')]
      .filter((el) => !el.closest('li p') && el.textContent.trim());
    this.blocks = els.map((el) => ({ el, parts: splitForSpeech(el.textContent) }));
    this.bi = 0;
    this.si = 0;
    this.emit();
  }

  /** Must be called from a click so browsers allow audio. */
  unlockAudio() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume();
  }

  play() {
    if (!this.blocks.length) return;
    if (this.bi >= this.blocks.length) { this.bi = 0; this.si = 0; }
    this.unlockAudio();
    this.playing = true;
    if (this.paused && this.source && this.isNeural) {
      // Natural voices pause mid-sentence and resume exactly where they stopped.
      this.paused = false;
      this.ctx.resume();
      this.emit();
      return;
    }
    this.paused = false;
    this.speakCurrent();
  }

  pause() {
    this.playing = false;
    if (this.isNeural && this.source) {
      this.paused = true;
      this.ctx?.suspend();
    } else {
      this.run++;
      if (speechSupported()) speechSynthesis.cancel();
    }
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this.run++;
    this.stopAudio();
    if (speechSupported()) speechSynthesis.cancel();
    this.highlight(null);
    this.bi = 0;
    this.si = 0;
    this.onStatus({ kind: 'idle' });
    this.emit();
  }

  stopAudio() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source = null;
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  jump(delta) {
    this.bi = Math.max(0, Math.min(this.blocks.length - 1, this.bi + delta));
    this.si = 0;
    if (this.playing) this.restartSentence();
    else {
      this.paused = false;
      this.stopAudio();
      this.highlight(this.blocks[this.bi]?.el);
      this.emit();
    }
  }

  restartSentence() {
    this.run++;
    this.paused = false;
    this.stopAudio();
    if (speechSupported()) speechSynthesis.cancel();
    // Chrome needs a tick between cancel() and speak().
    setTimeout(() => { if (this.playing) this.speakCurrent(); }, 60);
  }

  speakCurrent() {
    const block = this.blocks[this.bi];
    if (!block) { this.stop(); return; }
    const text = block.parts[this.si];
    if (!text) { this.advance(); return; }
    this.highlight(block.el);
    this.emit();
    if (this.isNeural) this.speakNeural(text);
    else this.speakBrowser(text);
  }

  speakBrowser(text) {
    const run = ++this.run;
    const u = new SpeechSynthesisUtterance(text);
    const v = this.browserVoice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.prefs.rate;
    u.pitch = this.prefs.pitch;
    u.onend = () => { if (run === this.run && this.playing) this.advance(); };
    u.onerror = (e) => {
      if (run !== this.run || e.error === 'interrupted' || e.error === 'canceled') return;
      this.advance();
    };
    speechSynthesis.speak(u);
  }

  async speakNeural(text) {
    const run = ++this.run;
    const voice = this.prefs.voice.slice(2);
    const speed = this.prefs.rate;
    let clip;
    const slow = setTimeout(() => { if (run === this.run && this.neural.ready) this.onStatus({ kind: 'buffering' }); }, 700);
    try {
      if (!this.neural.ready) this.onStatus({ kind: 'loading' });
      clip = await this.neural.audio(text, voice, speed);
    } catch (err) {
      clearTimeout(slow);
      if (run !== this.run) return;
      this.playing = false;
      this.onStatus({ kind: 'error', message: err.message });
      this.emit();
      return;
    }
    clearTimeout(slow);
    if (run !== this.run || !this.playing) return;
    this.onStatus({ kind: 'playing' });
    this.prefetch(voice, speed);
    const buffer = this.ctx.createBuffer(1, clip.data.length, clip.rate);
    buffer.copyToChannel(clip.data, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      if (run === this.run && this.playing) this.advance();
    };
    this.source = src;
    src.start();
  }

  /** Generate the next sentences while the current one plays, so speech flows without gaps. */
  prefetch(voice, speed) {
    let bi = this.bi;
    let si = this.si;
    for (let k = 0; k < 4; k++) {
      si++;
      if (si >= (this.blocks[bi]?.parts.length || 0)) { bi++; si = 0; }
      const t = this.blocks[bi]?.parts[si];
      if (!t) return;
      this.neural.audio(t, voice, speed).catch(() => {});
    }
  }

  advance() {
    const block = this.blocks[this.bi];
    if (block && this.si < block.parts.length - 1) this.si++;
    else { this.bi++; this.si = 0; }
    if (this.bi >= this.blocks.length) { this.stop(); return; }
    this.speakCurrent();
  }

  async preview(text) {
    this.pause();
    this.unlockAudio();
    if (this.isNeural) {
      try {
        if (!this.neural.ready) this.onStatus({ kind: 'loading' });
        const clip = await this.neural.audio(text, this.prefs.voice.slice(2), this.prefs.rate);
        this.stopAudio();
        this.paused = false;
        const buffer = this.ctx.createBuffer(1, clip.data.length, clip.rate);
        buffer.copyToChannel(clip.data, 0);
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);
        src.start();
      } catch (err) {
        this.onStatus({ kind: 'error', message: err.message });
      }
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = this.browserVoice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.prefs.rate;
    u.pitch = this.prefs.pitch;
    speechSynthesis.speak(u);
  }

  /**
   * Render the whole text with the natural voice into a WAV file (an audiobook of the summary).
   * @returns {Promise<Blob|null>} null if cancelled
   */
  async exportWav(onProgress, isCancelled) {
    const voice = this.prefs.voice.slice(2);
    const speed = this.prefs.rate;
    const parts = this.blocks.flatMap((b) => b.parts);
    const chunks = [];
    let rate = 24000;
    const pause = (secs) => new Float32Array(Math.round(rate * secs));
    for (let i = 0; i < parts.length; i++) {
      if (isCancelled()) return null;
      onProgress(i, parts.length);
      const clip = await this.neural.audio(parts[i], voice, speed);
      rate = clip.rate;
      chunks.push(clip.data, pause(0.25));
    }
    onProgress(parts.length, parts.length);
    return encodeWav(chunks, rate);
  }

  highlight(el) {
    for (const b of this.blocks) b.el.classList.remove('speaking');
    if (el) {
      el.classList.add('speaking');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  emit() {
    this.onState({ playing: this.playing, index: Math.min(this.bi, this.blocks.length - 1), total: this.blocks.length });
  }
}

/** Sentences, with very long ones split at commas so each piece stays within the voice model's limit. */
function splitForSpeech(text) {
  const sentences = (text.trim().match(/[^.!?。！？؟]+[.!?。！？؟]+["'”’)\]]*\s*|[^.!?。！？؟]+$/g) || [text])
    .map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    const words = s.split(/\s+/);
    if (words.length <= 60) { out.push(s); continue; }
    let cur = [];
    for (const w of words) {
      cur.push(w);
      if ((cur.length >= 25 && /[,;:—–]$/.test(w)) || cur.length >= 50) { out.push(cur.join(' ')); cur = []; }
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out;
}

function encodeWav(chunks, rate) {
  const length = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
  v.setUint32(40, length * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
