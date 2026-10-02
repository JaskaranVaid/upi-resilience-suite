// Tiny safe templating: every interpolated value is HTML-escaped unless wrapped in raw().

const RAW = Symbol('raw');

export function raw(markup) {
  return { [RAW]: true, value: String(markup) };
}

export function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'object' && value[RAW]) return value.value;
  return escape(value);
}

/** html`<p>${userText}</p>` → a raw() fragment safe to nest in other templates. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}

export function mount(el, fragment) {
  el.innerHTML = fragment.value;
}
