import { html, mount } from '../lib/html.js';

export function toast(message, { error = false } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3500);
}

/**
 * Modal confirmation. With `noteLabel`, asks for text and resolves with it.
 * Resolves null when cancelled.
 */
export function confirmDialog({ title, body, confirmLabel, noteLabel }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    mount(
      dialog,
      html`<form method="dialog" class="grid">
        <h2>${title}</h2>
        ${body ? html`<p class="muted m0">${body}</p>` : ''}
        ${noteLabel ? html`<label class="field">${noteLabel}<textarea name="note" required maxlength="4000"></textarea></label>` : ''}
        <div class="btn-row justify-end">
          <button class="btn" value="cancel" formnovalidate>Cancel</button>
          <button class="btn btn-primary" value="ok">${confirmLabel}</button>
        </div>
      </form>`,
    );
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      const ok = dialog.returnValue === 'ok';
      const note = dialog.querySelector('textarea')?.value.trim() ?? '';
      dialog.remove();
      resolve(ok ? { note } : null);
    });
    dialog.showModal();
  });
}

/** Run an action with the button disabled; report errors as toasts. */
export async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, { error: true });
    return undefined;
  } finally {
    button.disabled = false;
  }
}
