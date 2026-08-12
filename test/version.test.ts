import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('VERSION', () => {
  it('matches package.json', () => {
    // The version rides on every User-Agent. Drift here makes support chase a
    // build that was never published.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});
