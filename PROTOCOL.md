# Companion protocol 1

All public connections require HTTPS/WSS. HTTP/WS is accepted only for a localhost service. The Minecraft client stores its installation credential separately from transferable settings.

## Pairing

`POST /v1/pair` with JSON `{ "label": "My world", "events": [] }` creates an installation and returns `instanceId`, a private `token`, a display `code`, a browser `link`, and `expiresAt` in Unix milliseconds. The token is returned only when the installation is created.

To replace an expired code or request optional permissions, include `instanceId` in the body and send `Authorization: Bearer <token>`. An existing Minecraft library also sends `expectedChannel` so a different account cannot be linked accidentally. The service always includes `sub`, `resub`, and `gift`. Supported extra event IDs are defined in `src/catalog.js`. Codes expire after ten minutes. The browser flow verifies its own session and asks for explicit account confirmation before linking. Expired unlinked installations are removed; HTTP 410 lets the client request a fresh installation when necessary.

## Event delivery

Open `/v1/events?instanceId=<id>` with the same Authorization header. The service sends `{ "type": "welcome", "protocol": 1 }`, followed by status and event frames.

An event frame contains `type: "event"`, integer `seq`, and `event`:

```json
{
  "messageId": "twitch-message-id",
  "broadcasterId": "123",
  "userId": "456",
  "name": "ExampleViewer",
  "kind": "sub",
  "tier": "1000",
  "months": 1,
  "receivedAt": "2026-10-13T12:00:00.000Z",
  "details": { "login": "exampleviewer" }
}
```

After durable local storage, acknowledge that exact delivery with `{ "type": "ack", "seq": 1 }`. Acknowledgements are not cumulative. Up to 100 events are in flight at once. Reconnecting replays unacknowledged events in order. The client must deduplicate `messageId` persistently before applying effects.

Status frames contain `type: "status"`, `linked`, `approvalRequired`, `channel`, `status`, and `buffered`. They contain no Twitch token or Twitch password. Status is refreshed every 30 seconds. WebSocket ping/pong detects disconnected Minecraft installations. Optional permission approval keeps the basic subscription listener active.

Control events have `kind: "control"` and `details.command` equal to `pause` or `resume`. They originate only from authenticated broadcaster/moderator chat commands when the bot is opted in. They never carry arbitrary Minecraft commands.

## Operator console simulation

`subby test sub <channel-or-instance-id> [viewer] [tier 1-3]` in the Companion process console queues a normal `kind: "sub"` event. Its display name begins with `[TEST]`, its message ID begins with `console-test-`, and its synthetic user ID begins with `subby-test-`. Details include `login: "subby_test_<viewer>"`, `simulated: "true"`, and `source: "companion_console"`. The same channel and test viewer have a stable synthetic user ID; each command has a fresh message ID.

Existing protocol 1 clients record the entry and apply any matching optional rules with normal safety settings. Delivery, acknowledgements, replay and duplicate handling use the existing protocol. A channel selector targets its linked installations; an installation selector targets only that installation. The channel can be omitted only when exactly one is linked.

Simulation is available only through the trusted host console. There is no public simulation endpoint or Twitch chat simulation command. It does not call Twitch or test Twitch's EventSub source.

## Removal and optional chat

`POST /v1/unlink` with installation authentication and `{ "instanceId": "..." }` deletes that installation, its outstanding deliveries, and its service sign-in when no other installation uses the account. It does not delete Minecraft’s local book history.

`POST /v1/bot` accepts authenticated `{ "instanceId": "...", "enabled": true, "style": "silent", "template": "..." }`. Enabling requires the optional `bot` event permission. The interface speaks as the broadcaster; a separate bot account is not supported yet.

`GET /health` returns service status and protocol version without private account information.

`POST /v1/recover` with installation authentication and `instanceId` starts current-active-subscriber recovery. It returns `{ "queued": true }`; status frames report progress. Recovery delivers `kind: "sync"`, zero/unknown original months, `details.recovered: "true"`, and `details.timestamp_known: "false"`. It is limited to the requesting installation and does not reconstruct historical events.
