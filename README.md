<div align="center">

<img src="Subby-logo.png" alt="Subby Companion logo" width="256">

# Subby Companion

**The connection between Twitch and your Minecraft subscriber book.**

[Download 0.1.1](https://github.com/TAS-69/Subby-Companion/releases/tag/v0.1.1) · [Wiki](https://github.com/TAS-69/Subby-Companion/wiki) · [Get Subby](https://github.com/TAS-69/Subby) · [Report a bug](https://github.com/TAS-69/Subby-Companion/issues/new)

</div>

**Twitch → Companion → Minecraft**

Companion handles Twitch sign-in and sends subscriber events to [Subby](https://github.com/TAS-69/Subby). Minecraft keeps the book. Twitch passwords and tokens stay outside the game.

## Connect in three steps

1. **Host Companion** with Node.js 24. Use the [hosting branch](https://github.com/TAS-69/Subby-Companion/tree/hosting) for a ready-to-deploy runtime. [Self-hosting guide →](https://github.com/TAS-69/Subby-Companion/wiki/Hosting)
2. **Change the host before pairing:** in Minecraft, open `/subby` → **Advanced → Connection settings → Companion address** and enter your Companion URL.
3. **Run `/subby connect`**, follow the browser link, sign in with Twitch and confirm your channel.

> **Development server:** I host [subby.falix.org](https://subby.falix.org) for development and testing only, with **no assurances of reliability**. **Self-hosting is expected.** It is not a production hosting service. The default `localhost` address must be changed unless Companion runs on the same computer as Minecraft.

## What you get

<div align="center">
  
| By default | When enabled in Advanced |
| --- | --- |
| Subs, gift recipients and shared resubs | Extra Twitch events and chat controls |
| Private browser pairing | Current active subscriber recovery |
| Buffered delivery while Minecraft is offline | Additional Twitch permission scopes |

</div>

One service can connect multiple independently authorized channels. Optional chat speaks as the broadcaster; a separate bot account is not included.

[Local setup](https://github.com/TAS-69/Subby-Companion/wiki/Local-setup) · [Console commands](https://github.com/TAS-69/Subby-Companion/wiki/Console-commands) · [Troubleshooting](https://github.com/TAS-69/Subby-Companion/wiki/Troubleshooting) · [Release notes](CHANGELOG.md)

MIT · Copyright © 2026 TAS-69
