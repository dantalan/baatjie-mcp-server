# sigsche changelog

One entry per version, newest first. Each version is one commit on the `sigsche-v13` branch.

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
