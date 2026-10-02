import { html, mount } from '../lib/html.js';

/**
 * Watch an open detail view for changes made by the backend (poller, other users).
 * Reads OUR API only — never a PSP — and never redraws under the user: it shows a
 * "refresh" prompt instead. Stops itself when the view is replaced or the item is settled.
 */
export function watchForUpdates(el, { load, signature, settled, onRefresh, intervalMs = 15_000 }) {
  let current = null;
  const banner = document.createElement('div');
  el.prepend(banner);

  const tick = async () => {
    if (!banner.isConnected) return clearInterval(timer);
    if (document.hidden) return;
    try {
      const data = await load();
      const sig = signature(data);
      if (current === null) current = sig;
      else if (sig !== current) {
        mount(banner, html`<div class="callout info update-banner"><strong>This page has new information</strong>
          <button class="btn btn-primary" type="button">Refresh</button></div>`);
        banner.querySelector('button').addEventListener('click', onRefresh);
        clearInterval(timer);
      }
      if (settled(data)) clearInterval(timer);
    } catch {
      // Transient errors are fine: the next tick tries again; a 401 is handled globally.
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
}
