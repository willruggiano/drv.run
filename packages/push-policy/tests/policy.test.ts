import assert from "node:assert/strict";
import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { bytes, pushURL, pushSubscription, vapidKey, vapidPublic } from "../index.ts";

await test("push endpoints enforce one HTTPS, credential, fragment, and length policy", () => {
  const origin = "https://push.example";
  const prefix = origin + "/";
  assert.equal(pushURL(prefix + "x".repeat(4096 - prefix.length), [origin]).origin, origin);
  for (const endpoint of [
    prefix + "x".repeat(4097 - prefix.length),
    "http://push.example",
    "https://user:pass@push.example",
    prefix + "#",
    prefix + "#fragment",
    "https://other.example",
    "invalid",
  ])
    assert.throws(() => pushURL(endpoint, [origin]));
  assert.equal(pushURL("https://other.example").origin, "https://other.example");
});

await test("subscription decoding is independent of deployment origin policy", () => {
  const ecdh = createECDH("prime256v1");
  const subscription = {
    endpoint: "https://push.example/id",
    keys: {
      p256dh: ecdh.generateKeys().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  assert.deepEqual(pushSubscription(subscription), subscription);
  assert.deepEqual(pushSubscription(subscription, ["https://push.example"]), subscription);
  assert.throws(() => pushSubscription(subscription, []));
  for (const value of [
    null,
    [],
    {},
    { ...subscription, keys: null },
    { ...subscription, endpoint: 1 },
    {
      ...subscription,
      keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") },
    },
  ])
    assert.throws(() => pushSubscription(value));
  for (const value of [0, "=", "AA", "AB", "AAAA"]) assert.throws(() => bytes(value, 2));
});

await test("VAPID keys must contain matching P-256 public and private coordinates", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "jwk",
  });
  assert.deepEqual(vapidKey(key), key);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(bytes(key.d, 32));
  assert.equal(vapidPublic(key), ecdh.getPublicKey().toString("base64url"));
  for (const value of [
    { ...key, kty: "RSA" },
    { ...key, crv: "P-384" },
    { ...key, x: "invalid" },
    { ...key, d: randomBytes(32).toString("base64url") },
  ])
    assert.throws(() => vapidKey(value));
});
