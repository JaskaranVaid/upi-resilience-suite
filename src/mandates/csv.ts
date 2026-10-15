/**
 * Minimal RFC 4180 CSV reader: quoted fields, escaped quotes (""), CRLF or LF line endings.
 * Returns one object per data row keyed by the (trimmed) header names; blank lines are skipped.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, ''); // spreadsheet exports often start with a BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const [header, ...data] = nonEmpty;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}
