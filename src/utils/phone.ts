import { COUNTRY_METADATA } from '@config/countries';

/** Every distinct dialling code yebomart supports, longest first so a longer
 *  code is always preferred over a shorter one that prefixes it (+27 vs +254
 *  don't collide, but +20 prefixes nothing today and might tomorrow). */
const PHONE_CODES: string[] = Array.from(
  new Set(Object.values(COUNTRY_METADATA).map((c) => c.phoneCode)),
).sort((a, b) => b.length - a.length);

/**
 * Every stored form a typed phone number could plausibly be saved as.
 *
 * Staff PIN login is a bare phone + PIN form on the login screen — there is no
 * shop selected yet, so the server cannot know which country the number belongs
 * to. The old code assumed Eswatini unconditionally: it prefixed `268` onto
 * anything that didn't already start with it, so a South African `+27821234567`
 * became `+26827821234567` and simply never matched. It only worked at all
 * because the lookup also tried the raw input verbatim.
 *
 * Instead of guessing one country, we offer every supported one and let the
 * lookup decide. This is safe because of how the cost splits: candidate
 * STRINGS are nearly free (one indexed `IN (...)`), while candidate ROWS are
 * expensive (a bcrypt compare each). A bare national number expands to ~21
 * strings but still returns 0 or 1 rows, because the same national significant
 * digits being live in two different countries' shops is vanishingly rare.
 *
 * If it ever does return more than one row, AuthService.loginUser refuses the
 * login rather than guessing a tenant — the same rule it applies to a phone
 * shared across shops. So a wider candidate set can never silently sign
 * somebody into the wrong shop; at worst it asks a human to break the tie.
 */
export function phoneCandidates(input: string): string[] {
  const out = new Set<string>();
  const trimmed = input.trim();
  if (trimmed) out.add(trimmed); // exactly as typed — matches legacy rows verbatim

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return [...out];

  const knownCode = PHONE_CODES.find((code) => digits.startsWith(code.slice(1)));

  if (knownCode) {
    // Already carries a country code. Canonical E.164, plus the bare national
    // part in case a row was saved without the prefix.
    out.add(`+${digits}`);
    out.add(digits.slice(knownCode.length - 1));
    return [...out];
  }

  // No recognisable country code. Strip a trunk '0' if present, then offer the
  // number under every supported dialling code.
  const national = digits.startsWith('0') ? digits.slice(1) : digits;
  if (!national) return [...out];

  out.add(national);
  out.add(`+${digits}`);
  for (const code of PHONE_CODES) out.add(`${code}${national}`);

  return [...out];
}
