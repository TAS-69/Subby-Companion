# Release notes

## 0.1.1

- Stable release with maintainer-confirmed Twitch pairing and console simulation reaching the Minecraft book on Falix.
- Shared hosted launcher available on main through `npm run start:hosted`; the hosting branch uses the same runtime code.
- Simple README with a 256px logo, detailed guides in the wiki, and a dedicated hosting README with environment setup.
- Explicit host selection before Minecraft pairing, self-hosting expectations, and the maintainer's test/development address without reliability assurances.
- Updated copyright to TAS-69.

- Add Falix console commands to list linked channels and installations and send a marked test subscription through normal Minecraft delivery, including offline buffering.
- Add a direct Twitch sign-in fallback below the Continue button, with a copyable URL and support for manually entered pairing codes.
- Fix the Twitch sign-in button being blocked by the page policy in Chromium browsers, including Twitch's login redirect.
- A minimal `hosting` branch for Falix, automatically refreshed after passing checks on each main push.
- A public-hosting launcher that loads private `.env` settings, binds all interfaces, and uses the assigned Falix port.
- Hosting export and startup checks, plus a Falix deployment guide.

## 0.1.0 — service preview

The first standalone Companion release connects Twitch to Subby 1.1.0-beta.1 through browser pairing and an authenticated outbound Minecraft connection.

- Subscription, shared resubscription, and gift recipient delivery with minimal default permissions.
- Encrypted Twitch sign-ins, token refresh and validation, expiring pairing codes, and channel confirmation.
- Durable SQLite event buffers, acknowledgement-based replay, and per-installation isolation.
- Optional additional Twitch events and broadcaster-account chat controls, enabled from Subby’s Advanced menu.
- Current active subscriber recovery with unknown original dates and months clearly marked.
- Operator setup, a protocol reference, a pinned dependency lockfile, and optional container configuration.

This is a self-hosted preview. No public cloud service or separate bot account is deployed. Real Twitch account and full Minecraft gameplay acceptance remain outstanding.
