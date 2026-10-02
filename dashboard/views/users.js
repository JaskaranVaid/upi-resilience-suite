import { api } from '../api/client.js';
import { errorBox, forbidden, loading } from '../components/panels.js';
import { busy, toast } from '../components/ui.js';
import { when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

const ROLES = [
  ['ADMIN', 'Admin — manage users and act on payments'],
  ['SUPPORT', 'Support — investigate and act on payments'],
  ['VIEWER', 'Viewer — read only'],
];

export async function renderUsers(el, { me }) {
  if (me.user.role !== 'ADMIN') return mount(el, forbidden());
  mount(el, loading());
  let users;
  try {
    ({ data: users } = await api.users());
  } catch (e) {
    return mount(el, errorBox(e.message));
  }
  const roleSelect = (name, current) =>
    html`<select name="${name}">${ROLES.map(([v, l]) => html`<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`)}</select>`;

  mount(
    el,
    html`<div class="page-head"><h1>Team</h1></div>
      <div class="table-wrap mb"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${users.map(
          (u) => html`<tr data-id="${u.id}">
            <td>${u.name}</td><td>${u.email}</td>
            <td>${roleSelect('role', u.role)}</td>
            <td>${u.disabled ? html`<span class="badge tone-neutral">Disabled</span>` : html`<span class="badge tone-good">Active</span>`}</td>
            <td>${when(u.lastLoginAt)}</td>
            <td><button class="btn" data-toggle>${u.disabled ? 'Enable' : 'Disable'}</button></td>
          </tr>`,
        )}</tbody>
      </table></div>
      <form class="card grid" id="new-user">
        <h2>Add a team member</h2>
        <div class="grid grid-2">
          <label class="field">Name<input name="name" required maxlength="200" /></label>
          <label class="field">Email<input name="email" type="email" required /></label>
          <label class="field">Temporary password (12+ characters)<input name="password" type="password" minlength="12" required autocomplete="new-password" /></label>
          <label class="field">Role${roleSelect('role', 'SUPPORT')}</label>
        </div>
        <div class="btn-row"><button class="btn btn-primary">Add user</button></div>
      </form>`,
  );

  const rerender = () => renderUsers(el, { me });
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const u = users.find((x) => x.id === id);
    tr.querySelector('select').addEventListener('change', async (e) => {
      const ok = await busy(e.target, () => api.updateUser(id, { role: e.target.value }));
      if (ok) toast('Role updated');
      rerender();
    });
    tr.querySelector('[data-toggle]').addEventListener('click', async (e) => {
      const ok = await busy(e.currentTarget, () => api.updateUser(id, { disabled: !u.disabled }));
      if (ok) toast(u.disabled ? 'User enabled' : 'User disabled');
      rerender();
    });
  });
  el.querySelector('#new-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const ok = await busy(f.querySelector('button'), () =>
      api.createUser({ name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value }),
    );
    if (ok) {
      toast('User added');
      rerender();
    }
  });
}
