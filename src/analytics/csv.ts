/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: any text cell that a
 * spreadsheet would treat as a formula (= + - @, tab, CR) is prefixed with an apostrophe.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Paise → "2500.00" (no grouping separators, so spreadsheets parse it as a number). */
export const rupees = (paise: number) => (paise / 100).toFixed(2);

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'merchant';
}
