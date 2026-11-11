# sigsche changelog

One entry per version, newest first. Each version is one commit on the `sigsche-v13` branch.

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
