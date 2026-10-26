# Guest-independent status and events

Status: partially implemented. The requirements below remain the target design.

## Implementation status

- `packages/app/serve/activity.ts`: durable owner-local registry, activity
  history, transition policy, replay deduplication, quotas, and pending
  delivery.
- `packages/app/serve/notifications.ts`: native Pi run-settlement observation
  and the live `/activity` inbox. It observes ownerless conversations through
  Durable `watchEvents`: `run_end` alerts only when no successor run or queued
  input remains. Generation/turn ends, compaction ends and task-owned helper
  conversations do not alert. Snapshots are baselines, not historical alerts.
  Completion previews use the final assistant text (never reasoning, tool
  arguments or prompts); failures use their error message.
- `packages/app/serve/push.ts`: Web Push encryption, VAPID, and destination
  checks. Browser subscriptions are opt-in; failed delivery does not delete
  activity.
- `nixosModules/pi.nix`: opt-in `services.pi.notifications` policy and limits.
  Supply `push.privateKeyFile` from `config.sops.secrets.<name>.path`, readable
  by `services.pi.user`. It contains a P-256 private JWK. The VAPID key stays on
  the host; it must not enter the guest seed image.

Guest D-Bus forwarding and instance-bound SSH collection are implemented in
`notification-guest.ts`, `notification-relay.ts` and the guest/host NixOS
modules. The persistent PTY observer and terminal reconnect links remain
unimplemented. Native Pi observation is not a substitute for detached terminal
coverage.

## Decision

Build a host-owned status registry and event inbox. Keep protocol semantics
separate:

| Source              | Meaning                               | Host representation                     |
| ------------------- | ------------------------------------- | --------------------------------------- |
| OSC 7501            | Current program status in a terminal  | Replaceable status records              |
| D-Bus Notifications | Explicit notification requests        | Events with notification lifecycle      |
| Pi API              | Native application state and events   | Direct adapter, without synthesized OSC |
| OSC 99, later       | Terminal-native notification requests | Events, not status records              |

Notification delivery is a policy-controlled consequence, not the primary data
model. Guests must not depend on Web Push, a particular UI, or a delivery
provider.

The first user-visible outcome is: start Pi in a persistent terminal, disconnect
SSH, receive a phone notification when attention is needed, and open the correct
session from the cross-VM inbox. A disconnected phone must not lose the activity
record.

## Evidence and constraints

- The [OSC 7501 specification][osc7501], revision 0.4, defines terminal-local
  records, not a reliable event stream or approval protocol.
- Pi's pinned source reports `working` during execution or compaction, `blocked`
  for dialogs or authentication, `done` after completion, `error` after an
  unrecovered error, and `idle` at startup or cancellation. Reports exclude
  prompts and model output, but session names, dialog titles, and error messages
  can still be sensitive. See [Pi terminal setup][pi-terminal] and [the
  reporter][pi-reporter].
- Pi normally waits for a support reply. `PI_PROGRAM_STATUS=1 pi` bypasses
  detection; `PI_PROGRAM_STATUS=0` disables reporting. A passive observer alone
  does not make Pi emit reports. See [Pi terminal implementation][pi-tui].
- The development shell includes zmx via `flake.nix`. The pinned nixpkgs
  [package][zmx-package] selects zmx 0.8.1. Its [PTY loop][zmx-loop] feeds
  output into Ghostty's terminal parser independently of attached clients.
- zmx 0.8.1 [pins Ghostty][zmx-deps] at
  `8af6897c0afc63037a8a3efee4162a380e3a4572`. That revision's [OSC
  parser][ghostty-osc] and [terminal C API][ghostty-api] do not expose OSC 7501
  support. A program-status callback in newer libghostty-vt is not an available
  integration in this pin. Updating or backporting support is a prerequisite;
  the exact callback API remains to be verified at the selected revision.
- The guest currently uses a private Cloud Hypervisor VSOCK management path and
  CID 42. CIDs need not be unique across instances. See
  `nixosModules/guest/cloud-hypervisor.nix`; a CID alone cannot identify a
  guest.

Version selection comes from `flake.lock`. Pi references below use its pinned
revision, `71023aec1546d6d677a65669c5665c0927ce0dd0`, rather than relying on the
historical Pi 1.1.0 release claim. Existing instance and persistence boundaries
are documented in [[docs/architecture.md]].

## Ownership and data flow

```text
Guest
  Pi / terminal program --> persistent PTY owner (e.g. zmx)
                              | terminal parser + status observer
                              | survives SSH detach
                              v
  non-terminal program --> user D-Bus --> notification server
                              |                    |
                              +--------+-----------+
                                       | narrow relay
                                       v
Host                         instance-bound ingress
                                       |
                        +--------------+--------------+
                        |                             |
                 status registry              notification events
                        +--------------+--------------+
                                       |
                              durable activity + policy
                                       |
                          +------------+-------------+
                          |                          |
                    live PWA inbox              delivery adapter
                                                     |
                                                  Web Push

Host Pi API integration --> native adapter --> registry / events
```

Placement follows PTY ownership, not the SSH or VM boundary. An SSH stream
interceptor can observe an attached session only while output traverses that
connection. It is not the detached-session solution. A host-owned persistent PTY
can feed the host directly; a guest-owned PTY needs the relay.

The PTY owner supplies terminal identity and session incarnation. Retain the zmx
session name as a display/reconnect attribute, not as a globally unique ID. A
recreated session with the same name must not inherit the old session's records
or action targets.

Use Pi's native events when the app runs Pi through its API. Do not generate OSC
only to parse it again. Avoid observing the same execution through both
adapters.

## OSC 7501 adapter and registry

Integrate at the PTY owner's existing terminal parser. Prefer an upstream
callback over a second escape-sequence parser. The integration must:

1. Consume live output while attached and detached, including split sequences.
2. Answer feature detection through the PTY input path, independently of
   clients. Coordinate with device-attribute replies and attached-client
   forwarding so only one authoritative responder handles OSC 7501 queries.
3. Export validated record replacements, removals, and lifecycle changes with
   stable terminal identity. Do not scrape terminal titles or screen contents.
4. Export a current snapshot on relay reconnect. Replaying terminal scrollback
   must not generate new status transitions or phone notifications.
5. Observe process exit and OSC 133 `A` shell-prompt boundaries. Do not infer
   these boundaries from arbitrary output or an SSH disconnect.

`PI_PROGRAM_STATUS=1` is a useful diagnostic fallback, not a substitute for
parser support or correct detection handling.

The registry key is
`(host owner, instance incarnation, terminal incarnation, record ID)`.
Infrastructure supplies the first three components; the report supplies only its
terminal-local record ID. Keep the reported fields and source availability
distinct from host metadata such as receipt time and read state.

Apply revision 0.4 semantics, including:

- Missing `id` addresses the root. Hierarchical IDs allow concurrent activities;
  there is no single authoritative status for an entire VM.
- A report replaces the addressed record, not a patch of its previous fields.
  Omitted fields disappear. `app` inheritance follows the protocol's ancestry
  rules; a parent update does not replace its children.
- `clear` removes the addressed subtree; without an ID it clears all records.
- Process exit or a new shell prompt removes `working` and `blocked`. drv.run
  also removes `idle` at those boundaries, as the protocol permits. Preserve
  `done` and `error` until a subsequent replacement or clear.
- Validate the entire report before mutation. Follow protocol rules for unknown
  states, keys, invalid fields, encoded text, record limits, and eviction.
  Enforce the 4096-byte sequence cap and reject decoded control characters.
- Progress changes update the live registry; they do not themselves trigger
  push.

No heartbeat is required to keep an OSC record alive. A relay outage marks its
source unavailable, not `error` or `done`. Display the last observation with
that qualification. Guest or terminal destruction retires the source; retain
relevant activity history without presenting old records as a live session.
Reconciliation must not clear durable history or substitute a new incarnation
for an old one.

Reading or dismissing an inbox item is host UI state. It must not inject
terminal input, approve an operation, or pretend the application emitted
`clear`.

## D-Bus notification adapter

Provide an opt-in, lightweight guest notification server. Do not install a
desktop stack or expose the host's real session bus. The freedesktop
specification requires the session-bus name `org.freedesktop.Notifications` and
object path `/org/freedesktop/Notifications`; forwarding without rendering is
sufficient. See [basic design][dbus-design] and [protocol][dbus-protocol].

Prefer a systemd user bus and a user notification service whose lifetime covers
SSH disconnection and detached services. Configure user-manager lifetime and bus
address discovery explicitly, including for the current root guest login model.
A scoped `dbus-run-session` is acceptable for experiments, but serves only its
process tree and is not the default detached-service solution.

The server must implement `GetCapabilities`, `GetServerInformation`, `Notify`,
and `CloseNotification`, with protocol-correct IDs, replacements, expiry, and
`NotificationClosed` reasons. Start with plain-text summary/body support. Do not
advertise markup, images, actions, or persistence until their complete semantics
are implemented. Guest-supplied image paths and URLs must not cause host reads
or network fetches.

Keep these identities separate:

- Guest notification ID: nonzero uint32 allocated by the notification server,
  used for replacement and closure within its lifetime.
- Host event ID: durable identity, namespaced by instance, guest user/bus,
  server incarnation, and notification ID. A replacement updates that
  notification's projection while retaining its lifecycle in activity history.
- Delivery attempt ID: a provider-specific attempt, not a notification ID.

Preserve supported hints and expiry metadata, but treat urgency as advisory.
Expiry or `CloseNotification` closes the active notification, not its historical
record. A browser or push-provider delivery result is not a D-Bus dismissal or
`ActionInvoked` signal. Later action support requires an authenticated return
path to the originating server incarnation and must reject stale targets.

D-Bus notifications do not imply a terminal association. If none is known from
infrastructure, link to the instance's activity item rather than guessing a PTY.

## Relay, durability, and isolation

Use a narrow, versioned status/event transport over an instance-scoped VSOCK
channel or an existing authenticated transport. Transport selection is open;
reusing a management socket's filename or CID is not authentication. Host
ingress must bind the connection to the owning Unix account and instance
lifecycle. Never accept a claimed owner, VM identity, recipient, or trusted
action URL from the guest payload.

The minimum relay contract needs source incarnation, monotonically ordered
updates, explicit removals, and snapshot reconciliation for status. Notification
lifecycle operations need stable operation IDs for retry deduplication.
Reconnect must distinguish replay from new activity and reject updates from
retired source incarnations. Define framing, size limits, acknowledgements, and
backpressure before implementation; do not promise exactly-once delivery.

Commit accepted activity and pending delivery work durably before acknowledging
host acceptance. An acknowledgement means host storage, not phone display or
user attention. Retry delivery from bounded host-owned pending work. Guest-side
buffering may be bounded, but overflow or an unrecoverable sequence gap must be
visible. A status snapshot repairs current state, not lost intermediate events.
Loss before host acceptance remains possible unless the producer has a durable
retry queue; OSC itself provides no such guarantee.

Store data under the host owner's durable state, not an instance's runtime
directory. For the current trusted-LAN/Tailscale deployment, network
reachability is the client trust boundary: anyone who can reach a server may act
as its one host Unix owner. Use the existing same-origin checks and owner-local
process and storage isolation for live subscriptions, history, registration, and
session links. Do not add application authentication as a prerequisite. This
does not relax guest-instance attribution or outbound destination validation.

Define owner selection and delivery policy in Nix. Provision secrets through
sops runtime paths; guest-required credentials enter through the existing seed
image, never through a Nix store value. Reuse instance-bound SSH credentials
rather than accepting guest-selected owner or recipient fields. Revoking an
owner or deleting an instance must also revoke its delivery and reconnect
authority. Retention, queue quotas, and deletion policy must be explicit before
rollout.

Push subscription endpoints are untrusted even when registered by an authorized
client: delivery makes the host POST to a client-supplied URL ([RFC 8030,
section 5][webpush]). Before enabling Web Push:

- Require HTTPS, valid TLS certificates, and an operator-controlled allowlist of
  push-service origins, including ports. Reject URL credentials and fragments.
- Validate literal IPs and all resolved IPv4/IPv6 addresses. Reject loopback,
  private, link-local, unspecified, multicast, and other non-public
  destinations, including IPv4-mapped IPv6 forms and host/guest management
  networks.
- Resolve and validate at connection time for every delivery attempt, including
  retries. Connect only to a validated address while retaining the original
  hostname for TLS verification. Do not let a second DNS lookup, proxy, or
  alternative-service mechanism bypass validation; registration-time checks
  alone do not prevent DNS rebinding.
- Disable automatic redirects and reject redirect responses. Never forward push
  payloads or authorization headers to a redirect target.

Treat all guest content as untrusted, including `app`, labels, messages, hints,
and IDs. Escape plain text, reject control sequences, bound decoded sizes and
record counts, and rate-limit ingress per source and owner. A guest can spoof
applications inside itself; infrastructure attribution does not make its claims
trustworthy. The terminal observer must never forward arbitrary output, prompts,
or model responses as notification content.

## Policy and delivery

Initial host policy:

| Input                                          | Default result                                  |
| ---------------------------------------------- | ----------------------------------------------- |
| New transition into `blocked`                  | Retain activity; eligible for push              |
| New transition into `done` or `error`          | Retain activity; eligible for push              |
| `working`, `idle`, progress-only update, clear | Update view; no push                            |
| Repeated identical status or replayed snapshot | No duplicate activity alert                     |
| Explicit D-Bus notification                    | Retain event; apply permissions and rate limits |

Deduplicate by source incarnation, record or notification identity, and
transition or operation identity. A new run that reaches `done` again is a new
transition, not a permanent duplicate. Coalesce pending pushes for the same
record; suppress obsolete pending alerts when the source has already moved on.
Bound both burst and sustained delivery rates. Guest urgency cannot bypass host
policy.

`kind=permission` describes a blocked state. It does not authorize anything and
must not expose an approve button. Host-generated links open the authenticated
session or activity item where the application's actual workflow lives. Resolve
links against the current source incarnation; show an unavailable-session result
instead of attaching to a newly created session with the same name.

The PWA provides a live cross-VM status view and durable activity inbox,
including source availability and delivery failures. Web Push is opt-in and
replaceable. Encrypted push payloads include message previews: the conversation
name and final assistant text for native Pi events, or the original summary and
body for guest notifications. **These previews may appear on the lock screen.**
Only text content is included; reasoning and tool arguments are excluded. Titles
and bodies are bounded UTF-8 plain text with fallbacks, and the complete
encrypted message stays within the 4096-byte Web Push limit (long previews are
truncated).

Native pushes open `/sessions/<session UUID>/conversations/<conversation ID>`
directly. The host derives this path from its own identities, never message
text. Guest D-Bus events have no conversation identity, so their fallback is
`/sessions`, not an invented conversation or `/activity` link. The worker
validates destinations again and focuses an existing exact-match window when
possible. Older ID-only pushes also fall back to `/sessions`.

Replacement tags are scoped to the source and conversation/notification record;
timestamps come from receipt time. Guest urgency controls silent and persistent
presentation where supported by the browser, but cannot bypass delivery quotas.
Only bundled same-origin icons are used; missing presentation fields have safe
fallbacks. Keep subscriptions and delivery credentials on the host, outside
guests. Push failure, expiry, or lack of browser support must not remove inbox
activity.

## Rollout and acceptance

Implement in this order:

1. Verify a suitable libghostty-vt revision and integrate the OSC observer into
   the persistent PTY owner. Prove detection and detached observation first.
2. Add instance-bound ingress, the status registry, durable activity, and live
   PWA view. Establish authorization and reconnection semantics before push.
3. Add Web Push for policy-selected `blocked`, `done`, and `error` transitions.
   Gate this stage on the push endpoint SSRF acceptance tests below.
4. Add the optional guest user bus and D-Bus notification server.
5. Consider [OSC 99][osc99] as another explicit-event adapter. Its replacement,
   closure, and interaction callbacks are outside the initial scope.

Acceptance tests must cover:

- Pi starts without an environment override, detects support, and completes
  while all SSH clients are detached. The inbox updates and one eligible alert
  results.
- Attached and detached query handling, partial sequences, multiple clients,
  reattachment, and scrollback replay do not duplicate reports or replies.
- Concurrent hierarchical records, replacement of omitted fields, subtree clear,
  process exit, and prompt boundaries preserve revision 0.4 behavior.
- Relay and host restarts reconcile status, deduplicate retried events, and
  retain accepted activity. Gaps and unavailable sources are visible.
- Reusing VM/session names does not reuse record identity or trusted links.
- A detached non-terminal process can call `notify-send`; replacement, timeout,
  closure, and notification-server restart maintain distinct event identities.
- Malformed or excessive input is bounded; guest payloads cannot select another
  owner's inbox, subscription, instance identity, or action destination.
- Duplicate transitions and progress floods do not generate push floods. A later
  run can alert again. Disabled or failed push leaves the inbox intact.
- Pi API execution uses native events and does not require a PTY.
- Push delivery rejects unauthorized origins, non-HTTPS URLs, and loopback,
  private, link-local/metadata, and management addresses in IPv4 and IPv6,
  including mapped addresses and mixed public/private DNS answers. DNS rebinding
  between registration and delivery or across retries cannot reach a forbidden
  address. Redirects to public or private targets are not followed; no payload
  or credentials reach those targets. An allowed public push endpoint still
  works.

## Open implementation decisions

- Which zmx/Ghostty revision or backport exposes the required callbacks and
  lifecycle events? How does it arbitrate queries with attached terminals?
- Which instance-bound transport and guest service own relay retries? What
  bounded loss is acceptable before durable host acceptance?
- Which durable host store, retention limits, quotas, and live-update interface
  fit the existing application without a new generic event framework?
- How are persistent terminal sessions opened from the PWA? Until that route
  exists, the activity view must show the source and reconnect instructions.
- Which guest user-bus lifecycle, expiry policy, and capability set should the
  D-Bus adapter support initially?

These decisions gate their respective rollout stages. This proposal does not
require a generic plugin framework, a full desktop, arbitrary remote execution
from notifications, OSC 99, or a new approval protocol.

[osc7501]: https://www.superlogical.com/rex/docs/build/program-status
[pi-terminal]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/terminal-setup.md#program-status
[pi-reporter]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/modes/interactive/program-status-reporter.ts
[pi-tui]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/tui/src/terminal.ts
[zmx-package]:
  https://github.com/NixOS/nixpkgs/blob/5adc50831c259f87faeb09ddf930d43597197473/pkgs/by-name/zm/zmx/package.nix
[zmx-loop]: https://github.com/neurosnap/zmx/blob/v0.8.1/src/loop.zig
[zmx-deps]: https://github.com/neurosnap/zmx/blob/v0.8.1/build.zig.zon
[ghostty-osc]:
  https://github.com/ghostty-org/ghostty/blob/8af6897c0afc63037a8a3efee4162a380e3a4572/src/terminal/osc.zig
[ghostty-api]:
  https://github.com/ghostty-org/ghostty/blob/8af6897c0afc63037a8a3efee4162a380e3a4572/include/ghostty/vt/terminal.h
[dbus-design]:
  https://specifications.freedesktop.org/notification-spec/latest/basic-design.html
[dbus-protocol]:
  https://specifications.freedesktop.org/notification-spec/latest/protocol.html
[osc99]: https://sw.kovidgoyal.net/kitty/desktop-notifications/
[webpush]: https://www.rfc-editor.org/rfc/rfc8030.html#section-5
