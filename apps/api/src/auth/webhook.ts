/**
 * GitHub webhook signature verification.
 *
 * A webhook endpoint has no session and no user — GitHub is calling it. The only
 * thing standing between it and the open internet is the HMAC signature GitHub
 * sends in `X-Hub-Signature-256`, computed over the raw request body with a
 * shared secret. Recompute it, compare in constant time, reject anything that
 * does not match. Without this, the endpoint is a free "build anything" button.
 *
 * The signature MUST be checked against the exact bytes GitHub sent. That is why
 * the handler works from the raw body string, never the parsed object — parsing
 * and re-serialising would reorder keys and change whitespace, and the HMAC of
 * that is a different value.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * True iff `signatureHeader` is a valid signature of `rawBody` under `secret`.
 *
 * Returns false rather than throwing on malformed input, so a garbage header is
 * treated exactly like a wrong one — no distinguishing between "no signature"
 * and "bad signature" from the outside.
 */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return false;
  if (!secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();

  // The header is hex after the prefix. A malformed hex string yields a buffer
  // of the wrong length, which the length guard below rejects.
  let presented: Buffer;
  try {
    presented = Buffer.from(signatureHeader.slice(PREFIX.length), 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws if the lengths differ, so guard first — and a length
  // mismatch is itself a mismatch.
  if (presented.length !== expected.length) return false;

  return timingSafeEqual(presented, expected);
}

/** A webhook secret to hand to GitHub. 256 bits, hex. */
export function generateWebhookSecret(): string {
  // Imported lazily so this module has no side effects at load.
  return `whsec_${cryptoRandomHex(32)}`;
}

function cryptoRandomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
