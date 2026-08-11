# baatjie-mcp-server

An MCP server exposing the two Baatjie Group systems through one interface:

- **tanOS** — property OS, sales pipeline, and the dependency-aware action plan
- **sigscheCore** — multi-brand signal scheduler across 33 platforms

Sixteen tools: five generic CRUD tools covering every allowlisted table, and eleven
workflow tools for the paths used daily.

---

## Install

```bash
npm install
npm run build
cp .env.example .env      # then fill in both service role keys
```

## Run

```bash
# stdio (local MCP clients — Claude Desktop, Claude Code)
npm start

# streamable HTTP
TRANSPORT=http PORT=3000 npm start
```

### Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "baatjie": {
      "command": "node",
      "args": ["/absolute/path/to/baatjie-mcp-server/dist/index.js"],
      "env": {
        "TANOS_URL": "https://tlhzwovsgjptifhnzcvh.supabase.co",
        "TANOS_SERVICE_KEY": "...",
        "SIGSCHE_URL": "https://bikmrclrpgxenncqodti.supabase.co",
        "SIGSCHE_SERVICE_KEY": "..."
      }
    }
  }
}
```

---

## ⚠️ Read this before pointing it at production

**Service role keys are required, and this is not a preference.** RLS is enabled on
every table in both projects with **zero policies defined**. A non-privileged key
therefore returns *empty result sets rather than errors* — the server would cheerfully
report `0 agencies signed`, `0 tenants`, `0 todos` as though those were the facts.
This was observed during testing, not theorised.

`baatjie_dashboard` warns when every table reads zero, since all-zero across nineteen
tables is far more likely to be a credentials problem than a genuinely empty group.
Treat that warning as a hard stop.

The same fact has a second consequence worth stating plainly: because there are no RLS
policies, **the service role key is the only thing standing between this server and
every row in both databases** — tenant ID numbers, passport numbers and permit status,
landlord banking details, and the policy book. Until RLS policies exist, guard the key
accordingly and keep the server local rather than exposed over HTTP.

---

## Design notes

**Personal data is withheld by default.** Reads of `tenants`, `foreign_nationals`,
`landlords` and `agents` drop direct identifiers (ID numbers, passport numbers, phone,
email, banking details) unless `include_pii: true` is passed, and the response reports
which fields were withheld. Routine queries shouldn't pull identity numbers into an
agent's context as a side effect.

**Every write is audited.** Inserts, updates and deletes write a row to tanOS
`audit_log` with the `actor` you supply. Pass a meaningful actor (`baatjie`,
`marius-ai`, `deon-ai`) rather than the default. If the audit write fails, the response
says so rather than pretending it succeeded.

**Destructive operations are guarded.** `baatjie_delete` requires `confirm: true`.
Unfiltered updates and deletes are refused outright rather than rewriting a whole table.
Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so
calling agents can reason about consequences.

**Table access is allowlisted.** The generic CRUD tools reach only the nineteen tanOS
and five sigscheCore tables named in `constants.ts`. They are not an arbitrary-schema
backdoor.

---

## Tools

### Generic — comprehensive coverage

| Tool | Purpose |
|---|---|
| `baatjie_describe_schema` | List reachable tables per project. Start here when unsure. |
| `baatjie_query` | Read any table: filters, column selection, ordering, pagination |
| `baatjie_insert` | Insert rows into any table |
| `baatjie_update` | Update rows matching a filter |
| `baatjie_delete` | Delete rows — requires `confirm: true` |

### Sequencing — the dependency graph

| Tool | Purpose |
|---|---|
| `baatjie_next_actions` | What is genuinely startable now, ranked by downstream unblock count |
| `baatjie_list_todos` | Full board with wave, track, effort, blockers |
| `baatjie_create_todo` | Add an item, optionally sequenced |
| `baatjie_update_todo` | Change status/sequencing; reports what the change unblocked |

`baatjie_next_actions` is the one to reach for on "what should I do next". A flat todo
list hides the fact that most items are blocked; this answers the question the list is
standing in for.

### Operations

| Tool | Purpose |
|---|---|
| `baatjie_dashboard` | Counts across every table, sales position, BDOP clock and 33/22 sprint block |
| `baatjie_pipeline` | Sales rollup per BRM against the 26/day objective |
| `baatjie_log_activity` | Record a BRM's outreach/demos/sales for a sprint block |
| `baatjie_arrears` | Active leases with no recent payment, ranked, with notices already sent |

### sigscheCore

| Tool | Purpose |
|---|---|
| `baatjie_signal_queue` | Scheduled, sent and failed posts |
| `baatjie_schedule_signal` | Queue a post; sets the angel-window label automatically |
| `baatjie_brand_snapshot` | Per-brand readiness across platforms |

Angel windows (08:17, 11:11, 13:13, 22:22) are recognised automatically when
scheduling. Times outside them are accepted; the label is simply null.

---

## A note on notices

`notices` rows and the `baatjie_arrears` report describe real occupants. `baatjie_arrears`
is deliberately read-only — it reports the position and does not send anything, because
serving a notice should be a separate deliberate act.

South African arrears and eviction notices carry statutory requirements under the Rental
Housing Act and the PIE Act, and proof-of-service technicalities are exactly where cases
fail. Route wording and timing through the `legal-exposure-check` skill before anything
reaches an occupant rather than after.

---

## Development

```bash
npm run dev            # watch mode
npm run build          # compile to dist/
node test-harness.mjs  # protocol + guardrail checks (needs env vars set)
```

`test-harness.mjs` verifies initialisation, tool registration, annotation coverage,
description quality, the delete confirmation guard, unfiltered-write refusal, Zod range
validation, and actionable error text. All 13 checks should pass.

`evaluations.xml` contains ten questions for testing whether an LLM can actually use
this server to answer realistic operational questions.
