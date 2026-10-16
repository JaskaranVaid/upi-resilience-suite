import { api } from '../api/client.js';
import { busy, toast } from '../components/ui.js';
import { html, mount, raw } from '../lib/html.js';

/** The signed-in user's own sign-in security: turn two-factor sign-in on or off. */
export async function renderSecurity(el, ctx) {
  const { me } = ctx;
  // Both endpoints answer with the updated user.
  const rerender = (user) => {
    me.user = user;
    renderSecurity(el, ctx);
  };

  if (me.user.twoFactor) {
    mount(
      el,
      html`<div class="page-head"><h1>Security</h1></div>
        <div class="card grid">
          <h2>Two-factor sign-in <span class="badge tone-good">On</span></h2>
          <p class="muted m0">Signing in needs your password and a code from your authenticator app.</p>
          <form class="grid grid-2" id="disable-2fa">
            <label class="field">Password<input name="password" type="password" autocomplete="current-password" required /></label>
            <label class="field">Current code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
            <div class="btn-row"><button class="btn">Turn off</button></div>
          </form>
        </div>`,
    );
    el.querySelector('#disable-2fa').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const ok = await busy(f.querySelector('button'), () => api.twoFactorDisable(f.password.value, f.code.value.trim()));
      if (ok) {
        toast('Two-factor sign-in is off');
        rerender(ok.user);
      }
    });
    return;
  }

  mount(
    el,
    html`<div class="page-head"><h1>Security</h1></div>
      <div class="card grid">
        <h2>Two-factor sign-in <span class="badge tone-neutral">Off</span></h2>
        <p class="muted m0">Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) to every sign-in.
          Recommended for admins.</p>
        <form class="grid grid-2" id="start-2fa">
          <label class="field">Your password<input name="password" type="password" autocomplete="current-password" required /></label>
          <div class="btn-row"><button class="btn btn-primary">Set up</button></div>
        </form>
        <div id="enrol"></div>
      </div>`,
  );
  const start = el.querySelector('#start-2fa');
  start.addEventListener('submit', async (e) => {
    e.preventDefault();
    const setup = await busy(start.querySelector('button'), () => api.twoFactorSetup(start.password.value));
    if (!setup) return;
    start.hidden = true;
    const host = el.querySelector('#enrol');
    mount(
      host,
      html`<div class="grid">
        <p class="m0">1. Scan this with your authenticator app, or enter the key by hand.</p>
        <div class="svg-host qr">${raw(setup.qrSvg)}</div>
        <p class="m0">Key: <span class="mono">${setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span></p>
        <form class="grid grid-2" id="confirm-2fa">
          <label class="field">2. Enter the 6-digit code it shows<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
          <div class="btn-row"><button class="btn btn-primary">Turn on</button></div>
        </form>
        <p class="muted m0">Turning it on signs out your other sessions.</p>
      </div>`,
    );
    host.querySelector('#confirm-2fa').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const done = await busy(f.querySelector('button'), () => api.twoFactorConfirm(f.code.value.trim()));
      if (done) {
        toast('Two-factor sign-in is on');
        rerender(done.user);
      }
    });
  });
}
