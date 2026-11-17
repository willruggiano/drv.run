# What contract makes notifications independent of coding applications?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (notification-contract discussion)
- Blocked by: [[tasks/010-retained-workflows.md]]
- Map: [[TASKS.md]]

## Question

What producer, relay, and browser contracts preserve device registration and
`notify-send`-originated delivery without app, pds, or knowledge of pi-durable?

Respect the approved scope in [[tasks/010-retained-workflows.md]]: guest-only
sending and the installed-PWA registration path on iPhone. No host-native sending,
inbox, actions, or direct coding-agent integration. Delivery bookkeeping is not a
user-facing inbox requirement. Apply the Go preference for components without
required direct PDS/pi-durable integration in [[tasks/000-foundation.md]]; legacy
TypeScript sources are behavioral evidence, not a language selection.

Settle:

- How guest `notify-send` reaches push, who owns the guest D-Bus name, and how a
  source is bound to its host Unix owner.
- What acceptance means: queueing, acknowledgement, replay/deduplication,
  replacement, close/expiry, rate limits, and behavior after source retirement.
  Distinguish accepted notifications from attempted or successful push delivery.
- Which content and destinations producers may supply. Guest-controlled text must
  not silently become authority to select another owner or arbitrary navigation.
- How devices subscribe, unsubscribe, and receive notifications without a coding
  application, including the browser origin, service worker, and owner-state
  binding of the standalone management interface. Apply the Tailscale/LAN-only
  exposure and deferred application HTTP authn/authz in [[tasks/000-foundation.md]].
- Which existing notification pieces are retained or retired, including delivery
  state and `push-policy`. Do not preserve the inbox/status model or a shared
  package solely because the legacy applications currently use it.

The answer must state delivery guarantees and limitations, not merely choose a
wire format. Prototype or research only a concrete unresolved behavior.

## Resolution

Confirmed by the user, including the explicit rejection of durable notification
delivery and acceptance of subscription-endpoint safeguards. This settles the
component contract, not an implementation or permission to remove code or state.

### Component and source ownership

- Implement the guest D-Bus adapter and host push service in Go, independently of
  app, PDS, and pi-durable. The standalone push component owns its registration
  PWA as well as collection and delivery.
- The adapter owns `org.freedesktop.Notifications` on the guest root user's
  session bus and refuses to displace another notification server. Sending from
  other guest users or the host is not required.
- Retain host-initiated SSH collection. The host selects the guest, SSH identity,
  and host Unix owner binding; guest messages cannot choose an owner or recipient.
  [[tasks/050-infrastructure-contract.md]] settles the deployment interface for
  guest discovery and lifecycle information, rather than making push depend on
  private runtime-directory layouts.
- Send to all registered devices belonging to the configured owner. No per-guest
  device selection or notification routing rules are required.

### Best-effort delivery

- The user rejected durable notification delivery to keep the foundation simple.
  No durable guest outbox, host delivery queue, acknowledgement/replay protocol,
  or delivery-history database is required.
- Drop rather than catch up when no relay is connected or the sender is
  overloaded. Service restarts may lose notifications. Bound transient work and
  diagnostics; do not turn dropped notifications into an inbox.
- Make one bounded send attempt per registered device, with no automatic retries.
  `notify-send` success means local acceptance for best-effort forwarding, not
  host receipt, push-service acceptance, or phone display. Invalid input still
  fails. There is no exactly-once display guarantee.
- Device registrations remain persistent across service restarts. The provisioned
  VAPID key remains separate from disposable delivery state. This does not change
  the clean-slate cutover decision in [[tasks/020-state-continuity.md]].

### Content and lifecycle

- Accept bounded plain text and supported notification metadata from guests, not
  subscription endpoints, navigation URLs, fetched images, or executable actions.
  The host supplies source attribution.
- Track notification IDs, replacement, expiry, and closure only in guest memory.
  Replacements use the same host-generated browser notification tag; phone
  replacement is best effort.
- Expiry or `CloseNotification` does not attempt to retract an already-sent phone
  notification. Guest retirement stops collection; pushes already submitted may
  still arrive.
- Keep the current 300-second Web Push TTL, distinct from the D-Bus timeout.
  Short-lived buffering by the external push service is permitted without a local
  durable queue. Browser display duration is outside the delivery guarantee.

### Independent registration PWA

- The standalone management page registers/unregisters the current device; it is
  not a notification history view. Notification taps open that page, not app
  sessions or PDS conversations. No notification actions are required.
- Push owns its manifest, assets, and narrowly scoped service worker. Deployment
  supplies the HTTPS origin/path. Preserve installed-PWA registration on iPhone
  without requiring PDS to be open or installed.
- The management endpoint is bound to configured host-owner state, not a browser
  identity. Tailscale/LAN-only exposure and deferred HTTP authn/authz remain as
  agreed in [[tasks/000-foundation.md]]. Anyone who can reach the endpoint can
  operate it; no new application authentication requirement is selected.

### Subscription-endpoint safeguards

- Retain the existing endpoint-safety requirements in the Go service. Accept only
  deployment-configured HTTPS push-service origins and validate subscription keys.
- Reject private, local, and other non-public destination addresses. Resolve and
  validate DNS for each send, then connect directly to the validated address with
  hostname verification. Do not follow redirects or allow proxy settings to
  bypass destination validation.
- Bound subscription counts and management request sizes. Require same-origin
  management writes; this is not application authentication and does not change
  the deferred HTTP authn/authz decision.

### Retention and retirement boundary

- Retain the selected D-Bus, SSH collection, owner-binding, subscription, payload,
  and endpoint-safety behavior, not the legacy activity/status model or delivery
  persistence. Existing TypeScript code and tests are evidence, not a requirement
  to port every behavior or preserve their APIs.
- The TypeScript `push-policy` package is not a runtime dependency of the Go push
  component. Its validation requirements belong in that component; the package
  becomes a retirement target once its legacy consumers are removed.
- The durable guest outbox, host inbox/delivery history, replay/acknowledgement
  machinery, coding-agent observation, and app-specific PWA routing are not part
  of the selected push contract. Removal still requires
  [[tasks/060-retirement-gates.md]].
- No Go dependencies are selected or verified by this decision. Implementation
  checks must establish the selected behavior, including the iPhone PWA path;
  source inspection is not end-to-end delivery verification.

## Evidence

- [Guest D-Bus server](../packages/app/serve/notification-guest.ts) and
  [wire protocol](../packages/app/serve/notification-wire.ts).
- [SSH relay and acknowledgement](../packages/app/serve/notification-relay.ts).
- [Activity state](../packages/app/serve/activity.ts) and
  [notification orchestration](../packages/app/serve/notifications.ts).
- [Agent event interpretation](../packages/app/serve/pi-notifications.ts).
- [Push payload and destinations](../packages/app/serve/push-message.ts),
  [delivery](../packages/app/serve/push.ts),
  [service worker](../packages/app/serve/worker.js), and
  [browser registration controls](../packages/app/serve/pwa.ts).
- [Push validation](../packages/push-policy/index.ts) and
  [alternative delivery implementation](../packages/durable/api/src/push.ts).
