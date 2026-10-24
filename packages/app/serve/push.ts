import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type JsonWebKey,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { checkServerIdentity } from "node:tls";
import { object } from "./activity.ts";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushPolicy = { origins: string[]; subject: string; privateKeyFile: string };
export type PushTarget = { url: URL; hostname: string; address: string; family: 4 | 6 };
type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && global6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export function pushURL(endpoint: string, origins: readonly string[]): URL {
  if (endpoint.length > 4096) throw new TypeError("Push endpoint too long.");
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    endpoint.includes("#") ||
    !origins.includes(url.origin)
  )
    throw new TypeError("Push origin is not permitted.");
  return url;
}
export async function pushTarget(
  endpoint: string,
  origins: readonly string[],
  resolve: Resolver = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<PushTarget> {
  const url = pushURL(endpoint, origins);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }] : await resolve(hostname);
  const local = new BlockList();
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      local.addAddress(entry.address, entry.family === "IPv4" ? "ipv4" : "ipv6");
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) ||
        isIP(address) !== family ||
        !publicAddress(address) ||
        local.check(address, family === 4 ? "ipv4" : "ipv6"),
    )
  )
    throw new TypeError("Push destination is not public unicast.");
  const chosen = addresses[0];
  if (chosen.family !== 4 && chosen.family !== 6) throw new TypeError("Invalid IP family.");
  return { url, hostname, address: chosen.address, family: chosen.family };
}
function bytes(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new TypeError("Invalid push key.");
  const result = Buffer.from(value, "base64url");
  if (result.length !== length || result.toString("base64url") !== value)
    throw new TypeError("Invalid push key length.");
  return result;
}
export function pushSubscription(value: unknown, origins: readonly string[]): PushSubscription {
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
export function vapidKey(value: unknown): JsonWebKey {
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
/** One aes128gcm record, containing only an opaque host activity ID.
 * https://www.rfc-editor.org/rfc/rfc8291.html#section-3
 */
export function encryptedPush(subscription: PushSubscription, activity: number): Buffer {
  const peer = bytes(subscription.keys.p256dh, 65),
    auth = bytes(subscription.keys.auth, 16);
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const secret = ecdh.computeSecret(peer);
  const ikm = hkdfSync(
    "sha256",
    secret,
    auth,
    Buffer.concat([Buffer.from("WebPush: info\0"), peer, publicKey]),
    32,
  );
  const salt = randomBytes(16);
  const cek = Buffer.from(
    hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const plain = Buffer.concat([Buffer.from(JSON.stringify({ activity })), Buffer.from([2])]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  return Buffer.concat([
    header,
    publicKey,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
/** https://www.rfc-editor.org/rfc/rfc8292.html#section-3 */
export function vapidAuthorization(
  key: JsonWebKey,
  origin: string,
  subject: string,
  now = Date.now(),
): string {
  const contact = new URL(subject);
  if (contact.protocol !== "mailto:" && contact.protocol !== "https:")
    throw new TypeError("Invalid VAPID subject.");
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ aud: origin, exp: Math.floor(now / 1000) + 3600, sub: subject }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey({ key, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `vapid t=${input}.${signature}, k=${vapidPublic(key)}`;
}
export async function sendPush(
  subscription: PushSubscription,
  activity: number,
  policy: PushPolicy,
  key: JsonWebKey,
): Promise<number> {
  // Validate DNS for *each* attempt, then connect directly to that address. Node's
  // https client does not follow redirects, use proxies, or process Alt-Svc.
  const target = await pushTarget(subscription.endpoint, policy.origins);
  const body = encryptedPush(subscription, activity);
  return await new Promise<number>((resolve, reject) => {
    const call = request(
      {
        protocol: "https:",
        hostname: target.address,
        family: target.family,
        port: target.url.port || 443,
        path: target.url.pathname + target.url.search,
        method: "POST",
        agent: false,
        servername: isIP(target.hostname) ? undefined : target.hostname,
        checkServerIdentity: (_, certificate) => checkServerIdentity(target.hostname, certificate),
        signal: AbortSignal.timeout(15_000),
        headers: {
          Host: target.url.host,
          TTL: "300",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
          Authorization: vapidAuthorization(key, target.url.origin, policy.subject),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status); // 3xx is a failed attempt, never a second request.
      },
    );
    call.once("error", reject);
    call.end(body);
  });
}
