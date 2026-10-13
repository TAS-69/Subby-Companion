<div align="center">

# Subby Companion

**Connect Twitch once. Keep your subscriber book growing.**

**[Download the 0.1.0 preview](https://github.com/TAS-69/Subby-Companion/releases/tag/v0.1.0) · [Get Subby for Minecraft](https://github.com/TAS-69/Subby) · [Protocol](PROTOCOL.md) · [Report a bug](https://github.com/TAS-69/Subby-Companion/issues/new)**

</div>

Subby Companion connects Twitch to the Subby Minecraft mod and Paper plugin. Streamers pair Minecraft with a short code, sign in to Twitch in their browser, and confirm their channel. Twitch passwords, application secrets and Twitch tokens never enter Minecraft.

This is a self-hostable service. There is no public Subby Cloud deployment supplied with this source. A hosted installation uses the same pairing flow; its operator registers one Twitch application for the service, rather than asking each streamer to register an application.

## What works

- Browser pairing with expiring codes, browser session checks and an explicit channel confirmation.
- An independent private credential for each Minecraft installation.
- Twitch authorization, encrypted token storage, refresh, periodic validation and EventSub WebSocket reconnects.
- Subscriber, shared resubscription and gift recipient events by default.
- Optional gift batches, Bits, rewards, raids, follows, hype trains, poll and prediction results, moderator and VIP changes, first observed chatters, and observed bans/unbans.
- Optional recovery of missing current active subscribers, with original dates/months marked unknown.
- Durable event delivery with acknowledgements, replay after Minecraft disconnects and duplicate suppression.
- Optional chat commands and feedback. Chat is disabled by default, and uses the connected broadcaster account; a separate SubbyBot account is not implemented.

## Run locally

Install Node.js 24 or newer. In this folder, install the pinned dependencies with `npm ci`.

Register a confidential application at [Twitch’s developer console](https://dev.twitch.tv/console/apps). For a local installation, register `http://localhost:3030/oauth/callback` as its OAuth redirect URL. For a hosted installation, use your HTTPS service origin followed by `/oauth/callback`.

Copy `.env.example` to `.env`. Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `SUBBY_ENCRYPTION_KEY`. Generate the encryption key once with:

```
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep this key and the `data` directory private. Back them up together. Losing the key prevents the service from reading its saved Twitch sign-ins.

Start with `node --env-file=.env src/main.js`. In Minecraft, run `/subby connect`. The default service address is `http://localhost:3030`.

Use Subby 1.1.0-beta.1 or newer for Companion pairing. Subby 1.0.0 uses direct Twitch authentication and does not contain the Companion client.

If **Continue with Twitch** stays on the pairing page, use **Click here if redirect doesn’t work** below it. **Show Twitch sign-in URL** reveals a copyable direct link. Use that link in the same browser; to switch browsers, open the original Minecraft pairing link there first.

## Host for multiple streamers

For Falix, use the automatically maintained [hosting branch](https://github.com/TAS-69/Subby-Companion/tree/hosting). It contains only the runtime files and a settings template, with `index.js`, public binding, and the allocated server port already handled. Every passing push to `main` refreshes it. [Falix setup and automatic deployment](docs/FALIX.md)

Set `SUBBY_BASE_URL` to your public HTTPS origin. Put this process behind a reverse proxy that terminates TLS and forwards HTTP and WebSocket upgrades. Keep the process bound to localhost unless your private network requires otherwise. Set the matching Twitch OAuth redirect URL. Restrict access to the database, environment file and backups to the service operator.

Each Minecraft installation connects outward to `/v1/events`; Minecraft does not need an inbound port. Installations are isolated by private credentials. An existing installation cannot silently change its linked Twitch channel. Unlink it first and use a separate Minecraft library for a different channel.

## Optional events and chat

The default permission is `channel:read:subscriptions`. Optional event types request additional Twitch permissions during pairing. Reconnect and approve the new permissions after changing the selected events. Minecraft must enable Advanced interactions before selecting extra events or running rules.

The optional chat interface requires the `bot` event permission and an authenticated request to `/v1/bot` to enable it. Styles are `silent`, `cute`, `professional`, `chaotic`, and `custom`. Custom feedback supports `{user}` and `{months}`. Replies are limited to one every five seconds.

`!subby pause`, `!subby resume`, `!subby status`, and `!subby lastsub` require broadcaster or moderator badges from Twitch EventSub. `!book` and `!supporters` provide public explanations. Pause and resume control optional Minecraft effects; subscription names continue recording. Chat messages are never used to infer subscriptions.

## Test from the Falix console

Deploy the latest `hosting` branch and restart Companion. Enter these commands directly in the Falix console, replacing `YOUR_TWITCH_USERNAME` with the connected streamer's Twitch username:

```text
subby channels
subby test sub YOUR_TWITCH_USERNAME TestViewer
```

The second command sends a simulated Tier 1 subscription through the normal delivery buffer. Minecraft records **[TEST] TestViewer** in its subscriber book and history. Any matching optional rules run with their usual safety settings and cooldowns. Offline Minecraft installations receive the event when they reconnect. This does not create or purchase a Twitch subscription or contact Twitch to generate an event.

If exactly one Twitch channel is linked, `subby test sub` uses that channel and the default name `TestViewer`. For another tier, use `subby test sub YOUR_TWITCH_USERNAME TestViewer 3`. A Twitch username targets all of its linked Minecraft installations; use an installation ID from `subby channels` in its place to test only that installation. `subby help` lists the commands.

This is a recorded test entry. Hide its name from the current Minecraft book with `/subby remove subby_test_testviewer`. The private journal and existing archive copies retain their history. Minecraft's own local effect preview is separate.

## Delivery limits

Unacknowledged deliveries are retained across restarts, with a limit of 100,000 pending events per installation. A full buffer stops intake for that channel and reports the problem; reconnect Minecraft promptly. Acknowledged deliveries and service duplicate IDs are retained for 30 days. Minecraft also keeps its own durable duplicate IDs.

The buffer covers Minecraft outages while the Companion remains connected to Twitch. Twitch does not replay events missed during a Companion or Twitch outage. Automatic renewals are not shared resubscription messages. Gift recipients do not include a reliable gift giver field; gift batch events report the giver separately. “First chat” means first observed by this installation of the service, not the viewer’s first ever message.

## Verification

Run `npm test`. The 19 tests include the 12 original service checks for browser session and CSRF protection, explicit pairing confirmation, encrypted storage, restart recovery, authenticated WebSocket replay and isolation, and a local EventSub socket with duplicate notifications. Three hosting tests check the runtime export, Falix startup and private settings, console input and shutdown, and rejection of incomplete or insecure configuration. Two sign-in fallback tests cover direct links, typed codes, browser-bound state, expiry, and explicit channel confirmation. Two console tests check simulated delivery, acknowledgements, offline persistence, channel and installation targeting, and input validation. A real Twitch account and a real Minecraft gameplay session are still needed for end-to-end acceptance. [Validation details](VALIDATION.md) · [Release notes](CHANGELOG.md)

The service uses Node’s built-in SQLite support. Node 24 may print an experimental SQLite warning.
