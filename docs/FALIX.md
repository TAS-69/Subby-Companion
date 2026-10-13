# Hosting on Falix

Use the repository’s [hosting branch](https://github.com/TAS-69/Subby-Companion/tree/hosting). It contains only the runtime files, production dependencies, license, and settings template. Tests, workflows, Docker files, and development documentation stay on `main`.

Every push to `main` starts the hosting workflow. After the tests and production dependency install pass, it publishes a new commit to `hosting`. The branch keeps its deployment history and is never force-pushed. For rapid consecutive pushes, the newest source version takes priority. Failed checks leave the previous hosting commit intact. GitHub’s Actions page shows each result, and **Run workflow** can republish the current main version.

## Connect Falix

1. Connect your GitHub account on Falix and select `TAS-69/Subby-Companion`.
2. Select branch **hosting**, enable **Auto-deploy**, and choose **Restart** after deployment.
3. Select **Node.js 24** and leave **Main file** set to **index.js**. Falix installs the production dependencies from the included package files.
4. Set up an HTTPS reverse proxy to the server’s allocated port. Keep WebSocket upgrades enabled.
5. Copy `.env.example` to `.env` using the Falix file manager and fill in the settings below. Alternatively, provide these values through the process environment.

Use an OAuth-connected repository for deployment on every push. Falix’s public-URL mode uses scheduled polling instead. The GitHub repositories are currently private, so grant the Falix GitHub connection access to Companion. [Falix auto-deploy guide](https://client.falixnodes.net/guides/deploy/auto-deploy)

## Settings you supply once

| Setting | Value |
| --- | --- |
| `SUBBY_BASE_URL` | Your public HTTPS origin, such as `https://subby.example.com`, without a path. |
| `TWITCH_CLIENT_ID` | Your registered confidential Twitch application’s client ID. |
| `TWITCH_CLIENT_SECRET` | That application’s private secret. |
| `SUBBY_ENCRYPTION_KEY` | A persistent random 32-byte key encoded as base64. |
| `SUBBY_DATA_DIR` | Keep `./data` unless you use a different persistent location. |

Register `https://YOUR-DOMAIN/oauth/callback` in the Twitch application’s redirect URLs. Generate the encryption key once on a computer with Node.js:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

The hosting launcher loads `.env`, binds `0.0.0.0`, and uses Falix’s injected `SERVER_PORT`. It refuses to start until the public HTTPS origin and required private settings are supplied. Do not add a port to your public HTTPS address unless your HTTPS proxy actually uses that port. [Falix Node.js guide](https://client.falixnodes.net/guides/languages/nodejs)

The hosting branch never contains `.env`, saved data, or `node_modules`. Falix documents copy-only deploys, so these server-side files survive normal updates. You can also exclude `.env`, `data`, and `node_modules` in Falix’s deploy settings. Back up `data` together with the encryption key; do not regenerate the key on deployment. [Falix deployment rules](https://client.falixnodes.net/guides/deploy/keep-secrets-out-of-git)

## Verify and connect

Start the server and open `https://YOUR-DOMAIN/health`. It should return `{"status":"ok","protocol":1}`. Then set that HTTPS origin under Subby’s **Advanced → Connection settings → Companion address** and run `/subby connect`.

One service can serve multiple independently authorized streamer channels. This branch uses the existing Companion chat interface, which speaks as the broadcaster; it does not add a dedicated shared bot account or unlimited capacity. Keep the host continuously online and test real Twitch authorization and gameplay before a public launch.
