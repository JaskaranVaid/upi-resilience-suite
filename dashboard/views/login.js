import { api } from '../api/client.js';
import { html, mount } from '../lib/html.js';

export function renderLogin(el, onSignedIn) {
  mount(
    el,
    html`<main class="login">
      <form class="card" id="login-form">
        <div>
          <h1>Payment Resolution Console</h1>
          <p class="muted mt4">Sign in to investigate payments and disputes.</p>
        </div>
        <label class="field">Email<input name="email" type="email" autocomplete="username" required /></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <p id="login-error" class="error-text" role="alert"></p>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </main>`,
  );
  const form = el.querySelector('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.login(form.email.value, form.password.value);
      onSignedIn();
    } catch (err) {
      el.querySelector('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
