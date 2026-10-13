<div align="center">

<img src="https://raw.githubusercontent.com/TAS-69/Subby-Companion/hosting/Subby-logo.png" alt="Subby Companion logo" width="256">

# Subby Companion · Hosting

**A ready-to-deploy runtime for your own server.**

[Source code](https://github.com/TAS-69/Subby-Companion) · [Wiki](https://github.com/TAS-69/Subby-Companion/wiki) · [Get Subby](https://github.com/TAS-69/Subby)

</div>

This branch contains the service, logo, license and settings template. It is generated from `main` after its checks pass. Changes belong on `main`; successful pushes update this branch automatically.

**Tested only on [falixnodes.net](https://falixnodes.net). Falix is not a sponsor.** Other hosts have not been verified.

## Deploy

1. Select this repository's **hosting** branch in your host's Git deployment settings.
2. Choose **Node.js 24**, install dependencies with `npm ci --omit=dev`, and start **index.js** (`npm start`).
3. Configure an HTTPS reverse proxy to the allocated server port, with WebSocket support.
4. Create the private `.env` file below, then start or restart the service.

On Falix, enable **Auto-deploy** and **Restart after deployment**. The launcher binds `0.0.0.0` and uses `SERVER_PORT` automatically. On another host, set `SUBBY_PORT` if it does not supply `SERVER_PORT`; the fallback port is `3030`.

## Configure `.env`

Copy `.env.example` to `.env` on the host and replace the placeholders:

```ini
SUBBY_BASE_URL=https://YOUR-COMPANION-HOST
TWITCH_CLIENT_ID=YOUR_CLIENT_ID
TWITCH_CLIENT_SECRET=YOUR_CLIENT_SECRET
SUBBY_ENCRYPTION_KEY=YOUR_ENCRYPTION_KEY
SUBBY_DATA_DIR=./data
```

- **Base URL:** your own public HTTPS origin, without a path. Changing this host is required before setup. Register the same origin plus `/oauth/callback` in your confidential [Twitch application](https://dev.twitch.tv/console/apps).
- **Client ID and secret:** the credentials from that Twitch application.
- **Encryption key:** generate once with the command below. Keep the same key across updates.
- **Data:** keep `./data` on persistent storage. Back up the data and encryption key together.

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep `.env`, `data` and `node_modules` out of Git and exclude them from deployment replacement. This branch never includes your private settings or saved data.

## Connect Minecraft

Open `https://YOUR-COMPANION-HOST/health`; it should return `{"status":"ok","protocol":1}`.

In Minecraft, **change Companion address first** under `/subby` → **Advanced → Connection settings**. Then run `/subby connect`, sign in and confirm the channel.

> [subby.falix.org](https://subby.falix.org) is the maintainer's **test/development server**, with **no assurances of reliability**. **Self-hosting is expected.** Use your own host for your deployment's base URL.

[Console tests](https://github.com/TAS-69/Subby-Companion/wiki/Console-commands) · [Troubleshooting](https://github.com/TAS-69/Subby-Companion/wiki/Troubleshooting) · [Delivery limits](https://github.com/TAS-69/Subby-Companion/wiki/Delivery-and-recovery)

MIT · Copyright © 2026 TAS-69
