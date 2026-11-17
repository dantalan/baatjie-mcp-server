# sigsche changelog

One entry per version, newest first. Each version is one commit on the `sigsche-v13` branch.

## v13.5 · 12.11.2026 · email per account

- Every account can hold an email it signs in with, a username, or both. Give
  at least one. An email is lower-cased and must look like an address.
- Dashboard: an email field on the add form, and inline edits on every saved
  account (email, username, what it is, business). Clearing a field is refused
  when it would leave the account with neither an email nor a username.
- MCP: `baatjie_sigsche_account_save` takes `email`; `baatjie_sigsche_accounts`
  shows an email column.
- Duplicate checks still apply to usernames only. No passwords are stored.
- Test: `_sigsche-build/test-13.5.mjs`, 20 of 20.

## v13.4 · 12.11.2026 · per-session browsers

- Each sign-in session now has its own Chrome profile folder and remote-debugging
  port. `main` keeps the original profile on port 9333; other sessions get the
  next free port, persisted in `data/sessions.json`.
- Every saved handle has a session (default `main`). A handle signs in on its
  own session, so two handles on one platform can stay signed in at once.
- Posting uses the handle the brand routes to (or the one named) and posts from
  that handle's session. The upload result reports `from` and `session`.
- Dashboard **Accounts**: a Log in button on each handle, a live signed-in
  state per handle, and corrected copy about sessions.
- MCP: `baatjie_sigsche_login` takes `session`; `baatjie_sigsche_upload` takes
  `account_id`; `baatjie_sigsche_accounts` shows the signed-in state; the
  account save note describes sessions.
- HTTP: `POST /api/login/:pid` accepts `session`; new `GET /api/accounts`;
  `POST /api/upload` accepts `accountId`.

Tested: `_sigsche-build/test-13.4.mjs` (20 of 20), with 13.1 (12), 13.2 (14) and
13.3 (18) re-run. Typecheck and build clean. Not yet run against live
platform pages: that needs the master MCP restarted and a sign-in on a second
session.

## v13.3 · 12.11.2026 · many handles per platform

- Up to 8 handles per platform (`settings.acct`), one primary per platform. The
  primary is mirrored into `settings.plat[pid].h`, so existing code keeps working.
- A handle can be tied to a business, switched on or off, and labelled. A handle
  tied to no business is the fallback for any business.
- Duplicate handles are refused, comparing links and @ forms as the same name.
- Handles saved before v13.3 appear as the platform's first account (marked
  legacy) and are written into the register on the next save.
- Dashboard **Accounts** tab and three MCP tools: `baatjie_sigsche_accounts`,
  `baatjie_sigsche_account_save`, `baatjie_sigsche_account_remove`.

Tested: `_sigsche-build/test-13.3.mjs` (18 of 18), with 13.1 and 13.2 restored
and re-run.

## v13.2 · 11.11.2026 · godsview

- New **godsview** tab: one live screen for the property, read from tanOS and
  refreshed every 15 seconds. Each room shows the tenant on its active lease,
  what has been paid since the last 28th, the last payment date, notices sent
  and open maintenance tickets, with totals across the property.
- Read-only. It never sends a notice or changes a record, and reads tenant
  names only (no ID numbers, phones or emails).
- New MCP tool: `baatjie_sigsche_godsview`.

Tested: the arithmetic against made-up fixture rows, a live read of tanOS from
a second copy of the server, and the tab in a browser (empty state and a
fixture state). Not yet tested with real rooms: on 11.11.2026 the tanOS
property tables (properties, rooms, tenants, leases, payments) were empty.

## v13.1 · 11.11.2026 · business register

- New **Businesses** tab: every business on one register, each with a record
  (domain, what it does, owner entity, status, public contact, description).
  An empty field is shown as open. Nothing is pre-filled with a guess.
- **zaaka.io** and **budha pets** added to the Group set (26 built-in businesses).
  Their marks and colours are placeholders until the brand kit step.
- **Add a business** from the dashboard or with `baatjie_sigsche_business_save`.
  It becomes a brand you can compose for without a code change.
- A saved domain becomes the link that a group business's posts and cards carry.
- Two new MCP tools: `baatjie_sigsche_businesses`, `baatjie_sigsche_business_save`.
- Records are stored in `data/sigsche.json` under `settings.biz`, so backups and
  imports carry them.

Tested: model tests against a throwaway data folder, and the tab driven in a
browser against a second copy of the server (fill, add, compose, remove).
Not yet tested: the two new MCP tools through Claude Desktop, which needs a restart.

## v13 · 10.11.2026 · baseline

- Local dashboard on the master MCP, 13 sigsche tools, sign-in and upload
  through the sigsche browser, four direct connections (untested with real tokens).
