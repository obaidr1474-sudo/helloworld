/** Normalise phone input to E.164 with UAE defaults (05x / 5x local mobile formats). */
export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  let d = String(input).trim().replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (/^0[1-9]\d{7,8}$/.test(d)) d = '+971' + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = '+971' + d;
  else if (!d.startsWith('+')) d = '+' + d;
  const digits = d.slice(1);
  if (digits.length < 8 || digits.length > 15 || /\D/.test(digits)) return null;
  return d;
}

export const waDigits = (e164?: string | null) => (e164 ?? '').replace(/\D/g, '');
