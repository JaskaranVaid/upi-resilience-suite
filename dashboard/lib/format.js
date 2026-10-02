// Presentation formatting only — no business rules live in the frontend.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const money = (paise) => (paise === null || paise === undefined ? '—' : inr.format(paise / 100));
export const when = (iso) => (iso ? `${dateTime.format(new Date(iso))} IST` : '—');
export const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
export const typeLabel = (t) => (t === 'AUTOPAY' ? 'AutoPay' : 'Collect');

/** Rupees typed by a person → integer paise for API filters. */
export function rupeesToPaise(text) {
  const n = Number(String(text).replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** A date input (YYYY-MM-DD) → ISO instant at the start of that day in IST. */
export const istDayStart = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toISOString() : null);
export const istDayEnd = (d) => (d ? new Date(new Date(`${d}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : null);
