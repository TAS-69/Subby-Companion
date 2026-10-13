# Companion validation

Checked on 13 October 2026 with Node.js 24.11.1. This is a service preview for Subby 1.1.0-beta.1.

The current main branch adds three hosting checks to the 12 service checks below. They verify an exact runtime-only export, rejection of overlapping/nonempty output directories, private `.env` loading, the assigned Falix port and public binding, an actual HTTP health response, and startup refusal with missing settings or public HTTP. The first published 0.1.0 source bundle contains the original 12 service tests.

Two additional sign-in checks bring the current total to 17. They exercise the direct Twitch fallback from a prefilled pairing link, a manually typed code without a form redirect, browser-bound OAuth state, rejection of cross-origin submissions, expired codes, no credentials in the displayed URL, and explicit channel confirmation before linking.

Two console checks bring the current total to 19. They send console input through the normal store and an authenticated local Minecraft WebSocket, acknowledge delivery, preserve an offline installation's event across a store restart, isolate other channels, select an individual installation, preserve synthetic viewer identity, and reject ambiguous targets and invalid input. The hosting startup check also sends console help and stop commands to an exported process and verifies a clean exit.

All 19 automated tests pass. The original service coverage includes minimal default scopes, event normalization, encrypted SQLite storage, wrong-key rejection, durable duplicate suppression, restart replay, browser cookies and CSRF checks, explicit channel confirmation, authenticated WebSocket isolation, and a local EventSub socket.

Additional checks cover current-subscriber recovery, moderator chat permissions, duplicate chat handling, concurrent token refresh and validation, preserving scopes across installations, keeping subscription delivery running during optional permission approval, channel fencing, and saving events without waiting for slow chat replies.

The dependency lockfile pins ws 8.22.0. `npm audit --omit=dev` reported no known vulnerabilities when checked.

The pairing page was loaded in a browser. Computed styles confirmed labelled controls, a 50-pixel button, a 520-pixel card, and no horizontal overflow at a 1280-pixel desktop viewport. Screenshot capture was unavailable, so no screenshot review is claimed.

No real broadcaster account or paid subscription was used. A real Twitch authorization and Minecraft gameplay session remain necessary for end-to-end acceptance. The optional Docker/Compose configuration was not executed here. No public service or dedicated bot account is deployed.
