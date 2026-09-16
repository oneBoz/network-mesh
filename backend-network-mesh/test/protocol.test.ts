import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_OVERHEAD, MAX_DATAGRAM, decodeWith, deriveKey, encodeWith, wireSizeWith } from "../src/protocol.js";
import type { Message } from "../src/protocol.js";

const KEY = deriveKey("test-secret-a")!;
const OTHER = deriveKey("test-secret-b")!;
const msg = { type: "ping", seq: 7, from: { id: "aegis-mac", host: "127.0.0.1", port: 4002, inc: 3 }, note: "SECRET-THREAT-PAYLOAD" } as unknown as Message;
const drops = () => { const r: string[] = []; return { r, on: (s: string) => { r.push(s); } }; };

test("deriveKey: 32 bytes, deterministic, different per secret, null without a secret", () => {
  assert.equal(KEY.length, 32);
  assert.deepEqual(deriveKey("test-secret-a"), KEY);
  assert.notDeepEqual(KEY, OTHER);
  assert.equal(deriveKey(""), null);
});

test("encrypted frame round-trips, is small, hides the payload, and never reuses a nonce", () => {
  const a = encodeWith(msg, KEY), b = encodeWith(msg, KEY);
  assert.equal(a[0], 0x02, "version byte");
  const json = JSON.stringify(msg).length;
  assert.ok(a.length <= json + FRAME_OVERHEAD + 14, `overhead ${a.length - json} bytes`); // + timestamp line
  assert.ok(!a.toString("latin1").includes("SECRET-THREAT-PAYLOAD") && !a.toString("latin1").includes("aegis"), "plaintext leaked");
  assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13), "nonces differ");
  assert.notDeepEqual(a, b);
  assert.deepEqual(decodeWith(a, KEY), msg);
  assert.deepEqual(decodeWith(b, KEY), msg);
});

test("the wrong key, a flipped bit, or a truncated frame is rejected with a reason", () => {
  const frame = encodeWith(msg, KEY);
  let d = drops();
  assert.equal(decodeWith(frame, OTHER, d.on), null);
  assert.match(d.r[0], /authentication failed/);

  for (const i of [0, 5, 20, frame.length - 1]) { // version byte, nonce, ciphertext, tag
    const bad = Buffer.from(frame); bad[i] ^= 0x01;
    d = drops();
    assert.equal(decodeWith(bad, KEY, d.on), null, `byte ${i}`);
    assert.equal(d.r.length, 1, `byte ${i} reported`);
  }
  assert.equal(decodeWith(frame.subarray(0, 20), KEY), null);
  assert.equal(decodeWith(Buffer.alloc(0), KEY), null);
});

test("a replayed frame is dropped once it is outside the window", () => {
  const now = 1_700_000_000_000;
  const frame = encodeWith(msg, KEY, now);
  assert.deepEqual(decodeWith(frame, KEY, undefined, now + 59_000), msg);
  const d = drops();
  assert.equal(decodeWith(frame, KEY, d.on, now + 61_000), null);
  assert.match(d.r[0], /replay window/);
  assert.equal(decodeWith(frame, KEY, undefined, now - 61_000), null, "future-dated frames too");
});

test("mixed configurations are rejected loudly, plaintext meshes still work", () => {
  const plain = encodeWith(msg, null);
  assert.equal(plain[0], 0x7b);
  assert.deepEqual(decodeWith(plain, null), msg);
  let d = drops();
  assert.equal(decodeWith(plain, KEY, d.on), null);
  assert.match(d.r[0], /plaintext packet on an encrypted mesh/);
  d = drops();
  assert.equal(decodeWith(encodeWith(msg, KEY), null, d.on), null);
  assert.match(d.r[0], /encrypted frame on a plaintext mesh/);
  d = drops();
  const oldHmac = Buffer.from("ab12cd\n1700000000000\n{\"type\":\"ping\"}"); // the pre-encryption frame shape
  assert.equal(decodeWith(oldHmac, KEY, d.on), null);
  assert.match(d.r[0], /older build/);
});

test("wireSizeWith predicts the encoded length exactly, encrypted and plaintext", () => {
  const multibyte = { type: "ping", pad: "é✱".repeat(150) } as unknown as Message; // byte length ≠ string length
  for (const m of [msg, multibyte]) {
    assert.equal(wireSizeWith(m, KEY), encodeWith(m, KEY).length);
    assert.equal(wireSizeWith(m, null), encodeWith(m, null).length);
  }
});

test("a maximum-size datagram still fits after encryption", () => {
  const big = { type: "ping", pad: "x".repeat(MAX_DATAGRAM - FRAME_OVERHEAD - 60) } as unknown as Message;
  const frame = encodeWith(big, KEY);
  assert.ok(frame.length <= MAX_DATAGRAM, `${frame.length} > ${MAX_DATAGRAM}`);
  assert.deepEqual(decodeWith(frame, KEY), big);
});
