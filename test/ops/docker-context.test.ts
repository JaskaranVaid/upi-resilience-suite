import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');

describe('Docker build context', () => {
  it('lets in every path the Dockerfile copies from the context', () => {
    // .dockerignore is an allowlist: "*" then "!path" per included path.
    const allowed = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('!'))
      .map((l) => l.slice(1).replace(/\/$/, ''));
    const sources = read('Dockerfile')
      .split('\n')
      .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
      .flatMap((l) => l.replace(/^COPY\s+(--\S+\s+)*/, '').trim().split(/\s+/).slice(0, -1))
      .map((s) => s.replace(/^\.\//, '').replace(/\/$/, ''));
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter((s) => !allowed.includes(s))).toEqual([]);
  });
});
