import { createECDH, type JsonWebKey } from "node:crypto";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object.");
  return value as Record<string, unknown>;
}

export function pushURL(endpoint: string, origins?: readonly string[]): URL {
  if (endpoint.length > 4096) throw new TypeError("Push endpoint too long.");
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    endpoint.includes("#") ||
    (origins !== undefined && !origins.includes(url.origin))
  )
    throw new TypeError("Push origin is not permitted.");
  return url;
}
export function bytes(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new TypeError("Invalid push key.");
  const result = Buffer.from(value, "base64url");
  if (result.length !== length || result.toString("base64url") !== value)
    throw new TypeError("Invalid push key length.");
  return result;
}
export function pushSubscription(value: unknown, origins?: readonly string[]): PushSubscription {
  const data = object(value),
    keys = object(data.keys);
  if (typeof data.endpoint !== "string") throw new TypeError("Invalid endpoint.");
  pushURL(data.endpoint, origins);
  const publicKey = bytes(keys.p256dh, 65);
  if (publicKey[0] !== 4) throw new TypeError("Expected uncompressed P-256 key.");
  // computeSecret validates that the peer key lies on P-256.
  const test = createECDH("prime256v1");
  test.generateKeys();
  test.computeSecret(publicKey);
  return {
    endpoint: data.endpoint,
    keys: {
      p256dh: publicKey.toString("base64url"),
      auth: bytes(keys.auth, 16).toString("base64url"),
    },
  };
}
export function vapidKey(
  value: unknown,
): Required<Pick<JsonWebKey, "kty" | "crv" | "x" | "y" | "d">> {
  const key = object(value);
  if (key.kty !== "EC" || key.crv !== "P-256") throw new TypeError("Expected a P-256 private JWK.");
  const x = bytes(key.x, 32),
    y = bytes(key.y, 32),
    d = bytes(key.d, 32);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey().equals(Buffer.concat([Buffer.from([4]), x, y])))
    throw new TypeError("VAPID public/private key mismatch.");
  return {
    kty: "EC",
    crv: "P-256",
    x: x.toString("base64url"),
    y: y.toString("base64url"),
    d: d.toString("base64url"),
  };
}
export function vapidPublic(key: JsonWebKey): string {
  return Buffer.concat([Buffer.from([4]), bytes(key.x, 32), bytes(key.y, 32)]).toString(
    "base64url",
  );
}
