# sigsche on the master MCP

One server, three systems: tanOS and sigscheCore (Supabase) and **sigsche** (local).

## Run it

- **Claude Desktop** starts the server over stdio as before. The same process now also serves
  the dashboard and the MCP endpoint on `http://localhost:8641`. Set `SIGSCHE_HTTP=off` to stop that.
- **Standalone:** double-click `start-sigsche.cmd` (or `TRANSPORT=http node dist/index.js`).
- Dashboard: `http://localhost:8641/` · MCP over HTTP: `http://localhost:8641/mcp` · Health: `/health`
- Only requests from this computer are answered (Host and Origin are checked).

## What is stored where

Everything sigsche holds lives in `data/` next to the server (git-ignored):

| File | Holds |
| --- | --- |
| `data/sigsche.json` | settings, platform switches and handles, sprint edits and ticks, signals, leads, Taluna entries |
| `data/cards/` | card PNGs the dashboard saved for upload |
| `data/secrets.json` | API tokens for Bluesky, Mastodon, Telegram, Discord |
| `data/chrome-profile/` | the sigsche browser's profile (your platform sessions) |

## Sign-in and upload

- **Log in** opens the platform in the *sigsche browser*: Chrome with its own profile, started with a
  local debugging port (9333). You sign in yourself; the session stays in that profile.
- **Upload** on a signed-in platform opens the post box in that window, attaches the card to the
  page's file input and fills the caption where the page allows. **You press Post.** The result
  says what was done and what is left. The caption is also put on the clipboard.
- **Direct API** (Bluesky, Mastodon, Telegram, Discord): save a token in the dashboard and Upload
  posts the caption and card directly and ticks the platform.
- Phone-only apps (Clubhouse, BeReal): the caption is copied.

## MCP tools added (13)

`baatjie_sigsche_overview`, `_brands`, `_platforms`, `_platform_set`, `_signals`, `_compose`,
`_mark_posted`, `_leads`, `_lead_save`, `_taluna`, `_taluna_write`, `_login`, `_upload`.

`public/catalog.json` is the shared list of brands, platforms, sprint posts and moons. It is
generated from the dashboard page; regenerate it when the page's catalog changes.
