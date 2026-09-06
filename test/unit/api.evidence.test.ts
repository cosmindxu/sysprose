/**
 * The evidence lane's primitives, pinned where a golden cannot pin them.
 *
 * WHY THIS FILE EXISTS AT ALL. `src/api/evidence.ts` implements SHA-256 by hand
 * — `node:crypto` is unreachable from the browser bundle and `crypto.subtle` is
 * asynchronous where every caller is not — and its own doc comment says "a hash
 * with no known-answer test is a hash nobody can trust". It then named this
 * file, which did not exist. Every digest in the lane, and the twelve L8
 * goldens that quote them, rested on twelve opaque hex strings that agree with
 * each other by construction: a padding bug present from the first run would
 * have been recorded INTO the goldens and nothing would ever have gone red.
 *
 * The vectors below are the published FIPS 180-4 ones plus a length sweep
 * across the padding boundary (a message of 55, 56, 63, 64 or 65 bytes is where
 * a hand-written implementation gets the extra block wrong) and non-ASCII input
 * (the hash is over UTF-8 bytes, not UTF-16 code units). `node:crypto` is the
 * differential oracle — available here because a test runs in Node even though
 * the module under test may not.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '@api/index';

/** The oracle: Node's own SHA-256 over the same UTF-8 bytes. */
const reference = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex — the published known answers', () => {
  // FIPS 180-4 §D and the two standard extras. Written out rather than computed
  // so a reader can check them against the document, and so this file would
  // still be a test if the oracle below were removed.
  const VECTORS: Array<[string, string]> = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [input, expected] of VECTORS) {
    it(`hashes ${input === '' ? 'the empty string' : `${input.length} byte(s)`} to the published digest`, () => {
      expect(sha256Hex(input)).toBe(expected);
      // And the same value the platform computes, so a transcription error in
      // the constant above cannot make this case pass for the wrong reason.
      expect(sha256Hex(input)).toBe(reference(input));
    });
  }

  it('agrees with node:crypto across the whole padding boundary', () => {
    // 0..130 covers every residue mod 64 twice, including the 56..63 band where
    // the length field does not fit in the final block and one more must be
    // emitted — the single most common defect in a hand-written SHA-256.
    for (let n = 0; n <= 130; n++) {
      const s = 'a'.repeat(n);
      expect(sha256Hex(s), `length ${n}`).toBe(reference(s));
    }
  });

  it('hashes the UTF-8 bytes, not the UTF-16 code units', () => {
    // A digest keyed on code units would agree with the oracle on ASCII and
    // silently disagree on every accented character an engineer writes in a
    // requirement, and on any emoji in a doc comment.
    for (const s of ['é', 'ü ber', '日本語', '😀', 'a😀b', '—']) {
      expect(sha256Hex(s), s).toBe(reference(s));
    }
  });

  it('handles a message long enough to need many blocks', () => {
    const s = 'a'.repeat(100_000);
    expect(sha256Hex(s)).toBe(reference(s));
  });

  it('returns 64 lowercase hex characters, always', () => {
    for (const s of ['', 'abc', 'a'.repeat(64), '日本語']) {
      expect(sha256Hex(s), s).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
