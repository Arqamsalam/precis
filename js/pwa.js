// Installable app + offline support: registers the service worker and handles the "Install app" button.

// COEP "credentialless" lets the page keep loading fonts and the OCR engine from CDNs while becoming
// cross-origin isolated. Chromium browsers and Firefox 119+ support it; Safari doesn't, so it is skipped there.
function credentiallessSupported() {
  const ua = navigator.userAgent;
  const ff = /Firefox\/(\d+)/.exec(ua);
  const chromium = /Chrome\/(\d+)/.exec(ua);
  return (chromium && Number(chromium[1]) >= 96) || (ff && Number(ff[1]) >= 119);
}

/** True when nothing has been typed or loaded yet, so a reload loses nothing. */
function pristine() {
  return !document.querySelector('#source-text')?.value.trim() && !document.querySelector('.file-item');
}

export function initPwa({ onInstallable } = {}) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const coep = credentiallessSupported() ? 'credentialless' : '';
  navigator.serviceWorker.register(`sw.js${coep ? `?coep=${coep}` : ''}`).catch((err) => console.warn('Service worker not registered:', err));

  // The very first visit isn't isolated yet (the headers arrive with the next page load). Reload once, but
  // only if the user hasn't started working; otherwise the speed-up simply applies from the next visit.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!coep || self.crossOriginIsolated || !pristine()) return;
    try {
      if (sessionStorage.getItem('precis.isolationReload')) return;
      sessionStorage.setItem('precis.isolationReload', '1');
    } catch { return; }
    location.reload();
  });

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    onInstallable?.(true, async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      onInstallable?.(false);
    });
  });
  window.addEventListener('appinstalled', () => onInstallable?.(false));
}
