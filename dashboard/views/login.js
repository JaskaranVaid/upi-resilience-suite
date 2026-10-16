import { api } from '../api/client.js';
import { html, mount } from '../lib/html.js';

export function renderLogin(el, onSignedIn) {
  mount(
    el,
    html`<main class="login">
      <form class="card" id="login-form">
        <div>
          <h1>Merchantflo</h1>
          <p class="muted mt4">Payment Resolution Console — sign in to investigate payments and disputes.</p>
        </div>
        <label class="field">Email<input name="email" type="email" autocomplete="username" required /></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <label class="field" id="code-field" hidden>Code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" /></label>
        <p id="login-error" class="error-text" role="alert"></p>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </main>`,
  );
  const form = el.querySelector('#login-form');
  const codeField = el.querySelector('#code-field');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.login(form.email.value, form.password.value, codeField.hidden ? undefined : form.code.value.trim());
      onSignedIn();
    } catch (err) {
      if (err.code === 'MFA_REQUIRED') {
        // Password was right; this account also needs a code.
        codeField.hidden = false;
        form.code.required = true;
        form.code.focus();
        el.querySelector('#login-error').textContent = '';
      } else {
        form.code.value = '';
        el.querySelector('#login-error').textContent = err.message;
      }
    } finally {
      btn.disabled = false;
    }
  });
}
