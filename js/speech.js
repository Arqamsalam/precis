// Read-aloud player built on the browser's speech engine. In Microsoft Edge this includes Microsoft's free
// natural voices (Andrew, Ava, Emma, Brian, …); other browsers offer their own (Google, Apple, system voices).

const PREF_KEY = 'precis.voice.v1';
const NATURAL = /natural|neural|online|premium|enhanced|wavenet|studio/i;
const PREFERRED_NAMES = /\b(ava|andrew|emma|brian|jenny|guy|aria|christopher|sonia|ryan|libby|natasha|william|uzma|asad|salman|gul)\b/i;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function isEdge() {
  return /\bEdg\//.test(navigator.userAgent);
}

let voicesPromise = null;
export function getVoices() {
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

function langName(code) {
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

/**
 * The read-aloud controller. Reads the output's block elements one sentence at a time (which avoids the
 * browser bug that cuts long utterances off) and highlights the paragraph being read.
 */
export class ReadAloud {
  constructor({ onState } = {}) {
    this.onState = onState || (() => {});
    this.prefs = { voice: '', rate: 1, pitch: 1, ...loadPrefs() };
    this.blocks = [];
    this.bi = 0;
    this.si = 0;
    this.playing = false;
    this.run = 0;
    this.voices = [];
  }

  async refreshVoices() {
    this.voices = await getVoices();
    return this.voices;
  }

  /** Voices grouped and sorted for a <select>, best first for the given language code. */
  voiceOptions(lang) {
    const sorted = [...this.voices].sort((a, b) => rankVoice(b, lang) - rankVoice(a, lang) || a.name.localeCompare(b.name));
    const groups = new Map();
    for (const v of sorted) {
      const code = (v.lang || 'und').replace('_', '-');
      const base = code.split('-')[0];
      const label = langName(base);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(v);
    }
    return groups;
  }

  pickDefaultVoice(lang) {
    if (this.prefs.voice && this.voices.some((v) => v.voiceURI === this.prefs.voice)) return this.prefs.voice;
    const best = [...this.voices].sort((a, b) => rankVoice(b, lang) - rankVoice(a, lang))[0];
    return best?.voiceURI || '';
  }

  setPrefs(p) {
    this.prefs = { ...this.prefs, ...p };
    savePrefs(this.prefs);
    if (this.playing) this.restartSentence();
  }

  load(container) {
    this.stop();
    const els = [...container.querySelectorAll('h1, h2, h3, h4, p, li, blockquote > p')]
      .filter((el) => !el.closest('li p') && el.textContent.trim());
    this.blocks = els.map((el) => ({
      el,
      parts: (el.textContent.trim().match(/[^.!?。！？؟]+[.!?。！？؟]+["'”’)\]]*\s*|[^.!?。！？؟]+$/g) || [el.textContent])
        .map((s) => s.trim()).filter(Boolean),
    }));
    this.bi = 0;
    this.si = 0;
    this.emit();
  }

  get voice() {
    return this.voices.find((v) => v.voiceURI === this.prefs.voice) || null;
  }

  play() {
    if (!this.blocks.length) return;
    if (this.bi >= this.blocks.length) { this.bi = 0; this.si = 0; }
    this.playing = true;
    this.speakCurrent();
  }

  pause() {
    this.playing = false;
    this.run++;
    speechSynthesis.cancel();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this.playing = false;
    this.run++;
    if (speechSupported()) speechSynthesis.cancel();
    this.highlight(null);
    this.bi = 0;
    this.si = 0;
    this.emit();
  }

  jump(delta) {
    this.bi = Math.max(0, Math.min(this.blocks.length - 1, this.bi + delta));
    this.si = 0;
    if (this.playing) this.restartSentence();
    else { this.highlight(this.blocks[this.bi]?.el); this.emit(); }
  }

  restartSentence() {
    this.run++;
    speechSynthesis.cancel();
    // Chrome needs a tick between cancel() and speak().
    setTimeout(() => { if (this.playing) this.speakCurrent(); }, 60);
  }

  speakCurrent() {
    const block = this.blocks[this.bi];
    if (!block) { this.stop(); return; }
    const text = block.parts[this.si];
    if (!text) { this.advance(); return; }
    const run = ++this.run;
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.prefs.rate;
    u.pitch = this.prefs.pitch;
    u.onend = () => { if (run === this.run && this.playing) this.advance(); };
    u.onerror = (e) => {
      if (run !== this.run || e.error === 'interrupted' || e.error === 'canceled') return;
      this.advance();
    };
    this.highlight(block.el);
    this.emit();
    speechSynthesis.speak(u);
  }

  advance() {
    const block = this.blocks[this.bi];
    if (block && this.si < block.parts.length - 1) this.si++;
    else { this.bi++; this.si = 0; }
    if (this.bi >= this.blocks.length) { this.stop(); return; }
    this.speakCurrent();
  }

  preview(text) {
    this.pause();
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.prefs.rate;
    u.pitch = this.prefs.pitch;
    speechSynthesis.speak(u);
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
