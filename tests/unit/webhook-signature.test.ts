/**
 * The webhook's whole security is this HMAC check, so it gets a hostile suite.
 *
 * The endpoint has no session — if the signature check is weak, the internet has
 * a free "build anything" button. Every case here is a way that check could be
 * wrong: a forged signature, a tampered body, a swapped secret, a truncated
 * digest, a missing header.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  verifyGithubSignature,
} from '../../apps/api/src/auth/webhook.js';

const SECRET = 'whsec_' + 'a'.repeat(64);

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyGithubSignature — accepts', () => {
  it('a correct signature', () => {
    const body = '{"ref":"refs/heads/main"}';
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('a body with unicode, exactly as bytes', () => {
    const body = JSON.stringify({ message: 'café — build 🚀', ref: 'refs/heads/main' });
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('an empty body, if that is what was signed', () => {
    expect(verifyGithubSignature('', sign(''), SECRET)).toBe(true);
  });
});

describe('verifyGithubSignature — rejects', () => {
  const body = '{"ref":"refs/heads/main"}';

  it('a signature made with a different secret', () => {
    const forged = sign(body, 'whsec_' + 'b'.repeat(64));
    expect(verifyGithubSignature(body, forged, SECRET)).toBe(false);
  });

  it('a valid signature over a DIFFERENT body (tampering)', () => {
    const signature = sign(body);
    const tampered = '{"ref":"refs/heads/main","injected":true}';
    expect(verifyGithubSignature(tampered, signature, SECRET)).toBe(false);
  });

  it('a one-byte change to the body', () => {
    const signature = sign(body);
    expect(verifyGithubSignature(body.replace('main', 'mair'), signature, SECRET)).toBe(false);
  });

  it('a missing signature header', () => {
    expect(verifyGithubSignature(body, undefined, SECRET)).toBe(false);
  });

  it('an empty signature header', () => {
    expect(verifyGithubSignature(body, '', SECRET)).toBe(false);
  });

  it('the sha1 scheme GitHub also offers (we require sha256)', () => {
    const sha1 = 'sha1=' + createHmac('sha1', SECRET).update(body).digest('hex');
    expect(verifyGithubSignature(body, sha1, SECRET)).toBe(false);
  });

  it('a bare hex digest with no scheme prefix', () => {
    const bare = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyGithubSignature(body, bare, SECRET)).toBe(false);
  });

  it('a truncated signature', () => {
    const signature = sign(body);
    expect(verifyGithubSignature(body, signature.slice(0, 20), SECRET)).toBe(false);
  });

  it('a signature padded with extra characters', () => {
    expect(verifyGithubSignature(body, sign(body) + 'ff', SECRET)).toBe(false);
  });

  it('non-hex garbage after the prefix', () => {
    expect(verifyGithubSignature(body, 'sha256=not-hex-at-all', SECRET)).toBe(false);
  });

  it('an empty secret — a misconfigured project must not accept everything', () => {
    expect(verifyGithubSignature(body, sign(body, ''), '')).toBe(false);
  });

  it('the correct signature against the wrong stored secret', () => {
    // The signature is real, but the project's stored secret is a different one:
    // this is what a project-A signature replayed at project B looks like.
    const signature = sign(body, 'whsec_' + 'c'.repeat(64));
    expect(verifyGithubSignature(body, signature, SECRET)).toBe(false);
  });
});

describe('generateWebhookSecret', () => {
  it('is prefixed and unguessable', () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateWebhookSecret()));
    expect(set.size).toBe(1000);
  });
});
