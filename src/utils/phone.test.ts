import { describe, it, expect } from 'vitest';
import { phoneCandidates } from './phone';

describe('phoneCandidates', () => {
  it('keeps the number exactly as typed', () => {
    expect(phoneCandidates('+26876123456')).toContain('+26876123456');
  });

  it('canonicalises a number typed without the plus', () => {
    expect(phoneCandidates('26876123456')).toContain('+26876123456');
  });

  it('strips separators', () => {
    const out = phoneCandidates('+268 7612 3456');
    expect(out).toContain('+26876123456');
  });

  it('offers a South African number under its own country code, not Eswatini', () => {
    // The bug this replaces: the old code prefixed 268 onto anything that
    // didn't already start with it, turning +27821234567 into +26827821234567.
    const out = phoneCandidates('+27821234567');
    expect(out).toContain('+27821234567');
    expect(out.some((c) => c.startsWith('+26827'))).toBe(false);
  });

  it('expands a trunk-zero national number across supported countries', () => {
    const out = phoneCandidates('0821234567');
    expect(out).toContain('+27821234567');   // South Africa
    expect(out).toContain('+268821234567');  // Eswatini
    expect(out).toContain('821234567');      // bare national, if stored that way
  });

  it('does not expand a number that already carries a country code', () => {
    // Already unambiguous — widening here would be pure noise.
    const out = phoneCandidates('+254712345678');
    expect(out).toContain('+254712345678');
    expect(out.some((c) => c.startsWith('+268712345678'))).toBe(false);
  });

  it('returns no junk for empty or non-numeric input', () => {
    expect(phoneCandidates('')).toEqual([]);
    expect(phoneCandidates('   ')).toEqual([]);
    expect(phoneCandidates('abc')).toEqual(['abc']);
  });
});
