import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { test } from "node:test";
import https, { type RequestOptions } from "node:https";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { IncomingMessage, type ClientRequest } from "node:http";
import { Socket } from "node:net";
import { Writable } from "node:stream";
import {
  encryptedPush,
  publicAddress,
  pushSubscription,
  pushTarget,
  pushURL,
  sendPush,
  vapidAuthorization,
  vapidKey,
  vapidPublic,
} from "../push.ts";

import { pushMessage, encodePushMessage } from "../push-message.ts";

const message = pushMessage({
  id: 123,
  source: {
    instance: "host-pi",
    incarnation: "12345678-1234-1234-1234-123456789abc",
    terminal: "api",
  },
  record: "1",
  event: {
    type: "status",
    record: { id: "1", state: "done", title: "My conversation", msg: "Original message" },
  },
  received: 1000,
  read: false,
  delivery: "pending",
});
const origins = ["https://push.example"];
await test("push endpoints reject untrusted schemes, origins, credentials and fragments", () => {
  for (const endpoint of [
    "http://push.example/path",
    "https://other.example/path",
    "https://push.example:444/path",
    "https://u:p@push.example/path",
    "https://push.example/path#x",
    "https://push.example/path#",
  ])
    assert.throws(() => pushURL(endpoint, origins));
  assert.equal(pushURL("https://push.example/path?opaque", origins).origin, origins[0]);
});
await test("only public unicast addresses are allowed, including IPv6 and mapped forms", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "ff00::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "2002:7f00:1::",
    "not an IP",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
await test("all DNS answers are checked and each attempt resolves afresh", async () => {
  const endpoint = "https://push.example/path";
  let calls = 0;
  const resolver = async () => {
    calls++;
    return [{ address: calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
  };
  const target = await pushTarget(endpoint, origins, resolver);
  assert.equal(target.address, "8.8.8.8");
  assert.equal(target.hostname, "push.example");
  await assert.rejects(pushTarget(endpoint, origins, resolver));
  assert.equal(calls, 2);
  await assert.rejects(
    pushTarget(endpoint, origins, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ]),
  );
  await assert.rejects(pushTarget("https://[::ffff:127.0.0.1]/", ["https://[::ffff:7f00:1]"]));
});
await test("RFC 8291 payload decrypts with the subscriber key and contains the original message and conversation destination", () => {
  const ua = createECDH("prime256v1");
  const peer = ua.generateKeys();
  const auth = randomBytes(16);
  const sub = pushSubscription(
    {
      endpoint: "https://push.example/id",
      keys: { p256dh: peer.toString("base64url"), auth: auth.toString("base64url") },
    },
    origins,
  );
  const body = encryptedPush(sub, message);
  const salt = body.subarray(0, 16),
    sender = body.subarray(21, 86);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  const shared = ua.computeSecret(sender);
  const ikm = hkdfSync(
    "sha256",
    shared,
    auth,
    Buffer.concat([Buffer.from("WebPush: info\0"), peer, sender]),
    32,
  );
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", Buffer.from(ikm), salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), message);
});
await test("VAPID signs an audience-bound expiring token with the sops-provided key", () => {
  const ec = createECDH("prime256v1"),
    pub = ec.generateKeys();
  const key = vapidKey({
    kty: "EC",
    crv: "P-256",
    x: pub.subarray(1, 33).toString("base64url"),
    y: pub.subarray(33).toString("base64url"),
    d: ec.getPrivateKey().toString("base64url"),
  });
  assert.equal(vapidPublic(key), pub.toString("base64url"));
  const authorization = vapidAuthorization(key, origins[0], "mailto:operator@example.org", 1000);
  const jwt = authorization.slice("vapid t=".length).split(", ")[0];
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    aud: origins[0],
    exp: 3601,
    sub: "mailto:operator@example.org",
  });
  assert(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.throws(() => vapidKey({ ...key, d: randomBytes(32).toString("base64url") }));
});

await test("delivery pins the checked IP and TLS name, never follows redirects, and rechecks DNS on retry", async (t) => {
  const ec = createECDH("prime256v1"),
    publicKey = ec.generateKeys();
  const key = vapidKey({
    kty: "EC",
    crv: "P-256",
    d: ec.getPrivateKey().toString("base64url"),
    x: publicKey.subarray(1, 33).toString("base64url"),
    y: publicKey.subarray(33).toString("base64url"),
  });
  const subscription = pushSubscription(
    {
      endpoint: "https://push.example/subscription?opaque",
      keys: {
        p256dh: publicKey.toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    origins,
  );
  const policy = {
    origins,
    subject: "mailto:owner@example.org",
    privateKeyFile: "/run/secrets/vapid",
  };
  const requests: RequestOptions[] = [];
  const payloads: Buffer[] = [];
  let address = "8.8.8.8",
    status = 302,
    resolutions = 0;
  const resolver = t.mock.method(dns, "lookup", async () => {
    resolutions++;
    return [{ address, family: 4 }];
  });
  const transport = t.mock.method(
    https,
    "request",
    (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      requests.push(options);
      const response = new IncomingMessage(new Socket());
      response.statusCode = status;
      response.headers.location = "https://127.0.0.1/steal";
      const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          payloads.push(chunk);
          done();
        },
        final(done) {
          queueMicrotask(() => callback(response));
          done();
        },
      });
      // Narrow HTTP transport double; all production destination/TLS options remain intact.
      return stream as ClientRequest;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    resolver.mock.restore();
    transport.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal(await sendPush(subscription, message, policy, key), 302);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, "8.8.8.8");
  assert.equal(requests[0].servername, "push.example");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].agent, false);
  assert.equal(requests[0].path, "/subscription?opaque");
  assert.equal(requests[0].lookup, undefined);
  assert.notEqual(requests[0].rejectUnauthorized, false);
  assert.equal(payloads.length, 1);
  address = "127.0.0.1";
  await assert.rejects(sendPush(subscription, message, policy, key), TypeError);
  assert.equal(requests.length, 1);
  address = "8.8.8.8";
  status = 201;
  assert.equal(await sendPush(subscription, message, policy, key), 201);
  assert.equal(requests.length, 2);
  assert.equal(resolutions, 3);
});

await test("guest previews preserve original text, urgency and replacement identity without trusting URLs", () => {
  const item = {
    id: 17,
    source: { instance: "drv.run.guest", incarnation: "vm", terminal: "dbus-root/server" },
    record: "notification/1",
    received: 1234,
    delivery: "pending",
    read: false,
    event: {
      type: "notify",
      notification: {
        id: 1,
        app: "build",
        summary: "Build failed",
        body: "Original error\nSecond line",
        urgency: 2,
        expires: 0,
      },
    },
  } as const;
  const preview = pushMessage(item);
  assert.equal(preview.title, "Build failed");
  assert.equal(preview.body, "Original error\nSecond line");
  assert.equal(preview.url, "/");
  assert.equal(preview.timestamp, 1234);
  assert.equal(preview.requireInteraction, true);
  assert.equal(preview.silent, false);
  assert.equal(preview.tag, pushMessage({ ...item, id: 18 }).tag);
  assert.notEqual(preview.tag, pushMessage({ ...item, record: "notification/2" }).tag);
  const fallback = pushMessage({
    ...item,
    event: {
      type: "notify",
      notification: { ...item.event.notification, summary: "", body: "", urgency: 0 },
    },
  });
  assert.equal(fallback.title, "build");
  assert.equal(fallback.body, "build has an update.");
  assert.equal(fallback.silent, true);
  assert.equal(fallback.requireInteraction, false);
});

await test("rich push encoding fits a single 4096-byte encrypted message even with escaped Unicode", () => {
  const ec = createECDH("prime256v1");
  const subscription = {
    endpoint: "https://push.example/id",
    keys: {
      p256dh: ec.generateKeys().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  for (const body of ["\n".repeat(2048), '"'.repeat(2048), "🙂".repeat(1024), "x".repeat(10000)]) {
    const payload = { ...message, body };
    const encoded = encodePushMessage(payload);
    assert(encoded.length <= 3993);
    assert(encryptedPush(subscription, payload).length <= 4096);
    const decoded = JSON.parse(encoded.toString());
    assert.equal(decoded.url, message.url);
    assert.equal(decoded.title, message.title);
    assert.equal(decoded.body.isWellFormed(), true);
  }
  assert.throws(() => encodePushMessage({ ...message, title: "x".repeat(5000) }));
});
