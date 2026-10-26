// Settings and history live only in this browser (localStorage). Nothing is sent anywhere.

const SETTINGS_KEY = 'precis.settings.v2';
const HISTORY_KEY = 'precis.history.v1';
const OPTIONS_KEY = 'precis.options.v2';
const HISTORY_MAX_ITEMS = 40;
const HISTORY_MAX_CHARS = 3_000_000;

export const DEFAULT_SETTINGS = {
  ocrLang: 'eng',
};

export const DEFAULT_OPTIONS = {
  ratio: 0.25, format: 'paragraphs', focus: '', smooth: true, dedupe: true, trim: false, markGaps: false, extras: [],
};

function read(store, key) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function merge(base, extra) {
  const out = structuredClone(base);
  if (!extra || typeof extra !== 'object') return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], v);
    else if (k in out) out[k] = v;
  }
  return out;
}

export function loadSettings() {
  return merge(DEFAULT_SETTINGS, read(localStorage, SETTINGS_KEY));
}

export function saveSettings(s) {
  write(localStorage, SETTINGS_KEY, s);
}

export function loadOptions() {
  return merge(DEFAULT_OPTIONS, read(localStorage, OPTIONS_KEY));
}

export function saveOptions(o) {
  write(localStorage, OPTIONS_KEY, o);
}

export function loadHistory() {
  const h = read(localStorage, HISTORY_KEY);
  return Array.isArray(h) ? h : [];
}

export function addHistory(entry) {
  let h = [{ id: crypto.randomUUID(), date: Date.now(), ...entry }, ...loadHistory()].slice(0, HISTORY_MAX_ITEMS);
  while (h.length > 1 && JSON.stringify(h).length > HISTORY_MAX_CHARS) h = h.slice(0, -1);
  while (h.length && !write(localStorage, HISTORY_KEY, h)) h = h.slice(0, -1);
  return h;
}

export function updateHistory(id, patch) {
  const h = loadHistory().map((e) => (e.id === id ? { ...e, ...patch } : e));
  write(localStorage, HISTORY_KEY, h);
  return h;
}

export function deleteHistory(id) {
  const h = loadHistory().filter((e) => e.id !== id);
  write(localStorage, HISTORY_KEY, h);
  return h;
}

export function clearHistory() {
  write(localStorage, HISTORY_KEY, []);
  return [];
}

export function getTheme() {
  try { return localStorage.getItem('precis.theme'); } catch { return null; }
}

export function setTheme(t) {
  try {
    if (t) localStorage.setItem('precis.theme', t);
    else localStorage.removeItem('precis.theme');
  } catch { /* ignore */ }
}
