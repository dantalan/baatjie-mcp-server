/**
 * Operational workflow tools — the daily-driver views over tanOS.
 *
 * Dashboard, sales pipeline, BRM sprint logging and the arrears report. Each one
 * answers a question that would otherwise take several generic queries plus
 * client-side arithmetic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANGEL_WINDOWS, Project, SPRINT } from "../constants.js";
import {
  respond,
  ResponseFormat,
  rowsToTable,
  toErrorResponse,
} from "../services/format.js";
import {
  ALL_TANOS_TABLES,
  countRows,
  insertRows,
  queryRows,
} from "../services/supabase.js";
import { actorField, limitField, responseFormatField } from "../schemas.js";

/** Current time in Africa/Johannesburg as {h, m}. */
function sastNow(): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { h, m };
}

/** Which BDOP phase and 33/22 sprint block the clock is currently in. */
function sprintState(): {
  phase: string;
  sprint: number | null;
  block: string | null;
  minutes_left: number | null;
  next_angel_window: string;
} {
  const { h, m } = sastNow();
  const now = h * 60 + m;
  const start = SPRINT.factoryStart[0] * 60 + SPRINT.factoryStart[1];
  const end = SPRINT.factoryEnd[0] * 60 + SPRINT.factoryEnd[1];

  let nextAngel = "08:17 (tomorrow)";
  for (const [ah, am] of ANGEL_WINDOWS) {
    if (ah * 60 + am > now) {
      nextAngel = `${String(ah).padStart(2, "0")}:${String(am).padStart(2, "0")}`;
      break;
    }
  }

  if (now < 7 * 60 + 7) {
    return {
      phase: "CLOSED",
      sprint: null,
      block: null,
      minutes_left: null,
      next_angel_window: nextAngel,
    };
  }
  if (now < start) {
    return {
      phase: "OPEN",
      sprint: null,
      block: null,
      minutes_left: start - now,
      next_angel_window: nextAngel,
    };
  }
  if (now >= end) {
    return {
      phase: now < 20 * 60 + 20 ? "WIND-DOWN" : "CLOSED",
      sprint: null,
      block: null,
      minutes_left: null,
      next_angel_window: nextAngel,
    };
  }

  const cycle = SPRINT.buildMinutes + SPRINT.breakMinutes;
  const since = now - start;
  const pos = since % cycle;
  const isBuild = pos < SPRINT.buildMinutes;
  return {
    phase: "FACTORY WINDOW",
    sprint: Math.floor(since / cycle) + 1,
    block: isBuild ? "BUILD" : "BREAK",
    minutes_left: isBuild ? SPRINT.buildMinutes - pos : cycle - pos,
    next_angel_window: nextAngel,
  };
}

export function registerOperationsTools(server: McpServer): void {
  server.registerTool(
    "baatjie_dashboard",
    {
      title: "Baatjie Group Operations Snapshot",
      description: `One call for the whole operational picture: row counts across every tanOS
table, the sales position against the 26/day objective, and where the clock sits in
the BDOP day (phase, 33/22 sprint block, next angel window).

This is the cheapest way to orient at the start of a session or a sprint. It replaces
roughly a dozen separate count queries.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "counts": { "<table>": number | null },
    "sales": { "accounts_signed": number, "daily_target": 26, "brms": number,
               "agent_pool": number, "employer_pool": number,
               "inherited_book": number },
    "property": { "landlords","properties","rooms","tenants","leases",
                  "payments","notices","maintenance" },
    "clock": { "phase","sprint","block","minutes_left","next_angel_window" }
  }

Examples:
  - "Where are we?" / "Status?" -> no args
  - Start of a Factory sprint -> no args, read the clock block

Error Handling:
  - A table that cannot be counted returns null for that entry rather than failing
    the whole call`,
      inputSchema: { response_format: responseFormatField },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      try {
        const entries = await Promise.all(
          ALL_TANOS_TABLES.map(async (t) => [t, await countRows(Project.TANOS, t)] as const),
        );
        const counts = Object.fromEntries(entries) as Record<string, number | null>;

        const { rows: brmRows } = await queryRows({
          project: Project.TANOS,
          table: "brms",
          columns: ["inherited_book_size"],
          limit: 200,
          offset: 0,
        });
        const inheritedBook = brmRows.reduce(
          (sum, r) => sum + Number(r["inherited_book_size"] ?? 0),
          0,
        );

        const clock = sprintState();

        // Every tanOS table reading zero is far more likely to be a credentials
        // problem than a genuinely empty group: RLS is enabled on every table and
        // a non-privileged key returns empty result sets rather than an error.
        // Silently reporting "0 agencies signed" as fact would be worse than
        // saying so, hence this explicit warning.
        const allZero = Object.values(counts).every(
          (c) => c === 0 || c === null,
        );
        const credentialWarning = allZero
          ? "Every table returned zero rows. RLS is enabled on all tanOS tables with no " +
            "policies defined, so a non-service-role key produces empty results rather than " +
            "an error. Verify TANOS_SERVICE_KEY is the service role key before treating " +
            "these counts as real."
          : undefined;

        const payload = {
          ...(credentialWarning ? { warning: credentialWarning } : {}),
          counts,
          sales: {
            accounts_signed: counts["locare_accounts"] ?? 0,
            daily_target: 26,
            brms: counts["brms"] ?? 0,
            agent_pool: counts["agents"] ?? 0,
            employer_pool: counts["employers"] ?? 0,
            inherited_book: inheritedBook,
          },
          property: {
            landlords: counts["landlords"] ?? 0,
            properties: counts["properties"] ?? 0,
            rooms: counts["rooms"] ?? 0,
            tenants: counts["tenants"] ?? 0,
            leases: counts["leases"] ?? 0,
            payments: counts["payments"] ?? 0,
            notices: counts["notices"] ?? 0,
            maintenance: counts["maintenance"] ?? 0,
          },
          clock,
        };

        const md = [
          "# Baatjie Group — operations snapshot",
          "",
          ...(credentialWarning ? [`> **Warning**: ${credentialWarning}`, ""] : []),
          `**Clock**: ${clock.phase}` +
            (clock.block
              ? ` · sprint #${clock.sprint} ${clock.block}, ${clock.minutes_left} min left`
              : "") +
            ` · next angel window ${clock.next_angel_window}`,
          "",
          "## Commercial",
          `- Agencies signed: **${payload.sales.accounts_signed}** (target ${payload.sales.daily_target}/day)`,
          `- BRMs: ${payload.sales.brms} · Agents: ${payload.sales.agent_pool} · Employers: ${payload.sales.employer_pool}`,
          `- Inherited policy book: **${inheritedBook.toLocaleString()}**`,
          "",
          "## Property",
          ...Object.entries(payload.property).map(
            ([k, v]) => `- ${k}: ${v}`,
          ),
        ].join("\n");

        return respond(response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_pipeline",
    {
      title: "Sales Pipeline by BRM",
      description: `Roll up sales performance per Business Relationship Manager: inherited book
size, agencies signed, and logged outreach/demo/sale activity.

Answers "who is performing", "where is the pipeline", and "are we hitting 26/day".

Args:
  - since (string, optional): ISO date (YYYY-MM-DD). Restrict activity to on/after this date.
  - limit (number): Max BRMs to return (default: 25)
  - response_format ('markdown' | 'json'): Output format

Returns:
  {
    "brms": [{ "brm_id","inherited_book_size","accounts_signed",
               "outreach","demos","sales" }],
    "totals": { "accounts_signed","outreach","demos","sales","brm_count" },
    "against_target": { "daily_target": 26, "signed_today": number, "gap": number }
  }

Examples:
  - "How's the pipeline?" -> no args
  - "Activity this week" -> since='2026-08-03'

Error Handling:
  - BRMs with no logged activity appear with zeros rather than being omitted, so
    silence is visible rather than hidden`,
      inputSchema: {
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
          .optional()
          .describe("Only count activity on or after this date"),
        limit: limitField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { rows: brms } = await queryRows({
          project: Project.TANOS,
          table: "brms",
          limit: params.limit,
          offset: 0,
          orderBy: "inherited_book_size",
          ascending: false,
        });

        const { rows: accounts } = await queryRows({
          project: Project.TANOS,
          table: "locare_accounts",
          columns: ["brm_id", "signed_date"],
          limit: 1000,
          offset: 0,
        });

        const activityFilters = params.since
          ? [{ column: "activity_date", op: "gte" as const, value: params.since }]
          : [];
        const { rows: activity } = await queryRows({
          project: Project.TANOS,
          table: "daily_activity",
          filters: activityFilters,
          limit: 1000,
          offset: 0,
        });

        const today = new Date().toISOString().slice(0, 10);
        let signedToday = 0;

        const shaped = brms.map((b) => {
          const id = String(b["brm_id"]);
          const acc = accounts.filter((a) => a["brm_id"] === id);
          signedToday += acc.filter((a) => a["signed_date"] === today).length;
          const act = activity.filter((a) => a["brm_id"] === id);
          const sum = (key: string) =>
            act.reduce((s, r) => s + Number(r[key] ?? 0), 0);
          return {
            brm_id: id,
            inherited_book_size: Number(b["inherited_book_size"] ?? 0),
            accounts_signed: acc.length,
            outreach: sum("outreach_count"),
            demos: sum("demos_count"),
            sales: sum("sales_count"),
          };
        });

        const totals = shaped.reduce(
          (t, r) => ({
            accounts_signed: t.accounts_signed + r.accounts_signed,
            outreach: t.outreach + r.outreach,
            demos: t.demos + r.demos,
            sales: t.sales + r.sales,
            brm_count: t.brm_count + 1,
          }),
          { accounts_signed: 0, outreach: 0, demos: 0, sales: 0, brm_count: 0 },
        );

        const payload = {
          brms: shaped,
          totals,
          against_target: {
            daily_target: 26,
            signed_today: signedToday,
            gap: Math.max(0, 26 - signedToday),
          },
        };

        const md =
          rowsToTable(
            "Pipeline by BRM",
            shaped as unknown as Record<string, unknown>[],
            ["brm_id", "inherited_book_size", "accounts_signed", "outreach", "demos", "sales"],
            shaped.length,
          ) +
          `\n\n**Today**: ${signedToday} signed against a target of 26 ` +
          `(gap ${payload.against_target.gap}).`;

        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_log_activity",
    {
      title: "Log BRM Sprint Activity",
      description: `Record a BRM's outreach, demos and sales for a 33/22 sprint block.
This is how the daily 26/day objective gets measured — unlogged work is invisible
to baatjie_pipeline.

Args:
  - brm_id (string): BRM identifier, must exist in tanOS brms
  - outreach (number): Contacts made in this block (default: 0)
  - demos (number): Demos booked or run (default: 0)
  - sales (number): Agencies signed (default: 0)
  - sprint_block (string, optional): Which block, e.g. 'sprint-3-build'.
      Defaults to the current 33/22 position from the clock.
  - activity_date (string, optional): YYYY-MM-DD, defaults to today
  - actor (string): Who is logging, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "activity": {...}, "clock": {...}, "audit_logged": boolean }

Examples:
  - End of a build block -> brm_id='marius-ai', outreach=12, demos=3
  - Backfill yesterday -> brm_id='...', sales=1, activity_date='2026-08-07'`,
      inputSchema: {
        brm_id: z.string().min(1).describe("BRM identifier"),
        outreach: z.number().int().min(0).default(0),
        demos: z.number().int().min(0).default(0),
        sales: z.number().int().min(0).default(0),
        sprint_block: z.string().max(60).optional(),
        activity_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
          .optional(),
        actor: actorField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const clock = sprintState();
        const row: Record<string, unknown> = {
          brm_id: params.brm_id,
          outreach_count: params.outreach,
          demos_count: params.demos,
          sales_count: params.sales,
          sprint_block:
            params.sprint_block ??
            (clock.sprint ? `sprint-${clock.sprint}-${clock.block?.toLowerCase()}` : "outside-window"),
        };
        if (params.activity_date) row["activity_date"] = params.activity_date;

        const { rows, audited } = await insertRows(
          { project: Project.TANOS, table: "daily_activity", actor: params.actor },
          [row],
        );

        return respond(
          params.response_format,
          `# Activity logged for ${params.brm_id}\n\n` +
            `- outreach: ${params.outreach}\n- demos: ${params.demos}\n- sales: ${params.sales}\n` +
            `- block: ${row["sprint_block"]}`,
          { ok: true, activity: rows[0] ?? null, clock, audit_logged: audited },
        );
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_arrears",
    {
      title: "Arrears Report",
      description: `Identify active leases with no recent payment, ranked by days since last
payment, alongside how many notices have already been sent on each.

Read-only. It reports the position; it does not send anything. Serving a notice is a
separate, deliberate act — in South Africa arrears and eviction notices carry statutory
requirements under the Rental Housing Act and PIE Act, so wording and timing should be
checked before anything reaches an occupant.

Args:
  - min_days_overdue (number): Only leases with no payment in at least this many days
      (default: 1)
  - limit (number): Max leases (default: 25)
  - include_pii (boolean): Include tenant identifiers (default: false)
  - response_format ('markdown' | 'json'): Output format

Returns:
  {
    "leases": [{ "lease_id","room_id","rent_due_day","status",
                 "last_payment_date","days_since_payment","total_paid","notices_sent" }],
    "summary": { "active_leases","in_arrears","never_paid","total_notices_sent" }
  }

Examples:
  - "Who's behind on rent?" -> no args
  - "Anyone more than 30 days down?" -> min_days_overdue=30

Error Handling:
  - Leases with no payment history report last_payment_date=null and are counted
    under never_paid rather than being silently dropped`,
      inputSchema: {
        min_days_overdue: z.number().int().min(0).default(1),
        limit: limitField,
        include_pii: z.boolean().default(false),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { rows: leases } = await queryRows({
          project: Project.TANOS,
          table: "leases",
          filters: [{ column: "status", op: "eq", value: "active" }],
          limit: 500,
          offset: 0,
        });
        const { rows: payments } = await queryRows({
          project: Project.TANOS,
          table: "payments",
          columns: ["lease_id", "amount", "payment_date"],
          limit: 2000,
          offset: 0,
        });
        const { rows: notices } = await queryRows({
          project: Project.TANOS,
          table: "notices",
          columns: ["lease_id"],
          limit: 2000,
          offset: 0,
        });

        const now = Date.now();
        const shaped = leases.map((l) => {
          const id = String(l["lease_id"]);
          const mine = payments.filter((p) => p["lease_id"] === id);
          const dates = mine
            .map((p) => String(p["payment_date"]))
            .filter(Boolean)
            .sort();
          const last = dates.length ? dates[dates.length - 1]! : null;
          const days = last
            ? Math.floor((now - Date.parse(last)) / 86_400_000)
            : null;
          return {
            lease_id: id,
            room_id: l["room_id"] ?? null,
            tenant_id: params.include_pii ? (l["tenant_id"] ?? null) : undefined,
            rent_due_day: Number(l["rent_due_day"] ?? 28),
            status: String(l["status"] ?? "active"),
            last_payment_date: last,
            days_since_payment: days,
            total_paid: mine.reduce((s, p) => s + Number(p["amount"] ?? 0), 0),
            notices_sent: notices.filter((n) => n["lease_id"] === id).length,
          };
        });

        const inArrears = shaped
          .filter(
            (r) =>
              r.days_since_payment === null ||
              r.days_since_payment >= params.min_days_overdue,
          )
          .sort(
            (a, b) => (b.days_since_payment ?? 1e9) - (a.days_since_payment ?? 1e9),
          )
          .slice(0, params.limit);

        const payload = {
          leases: inArrears,
          summary: {
            active_leases: shaped.length,
            in_arrears: inArrears.length,
            never_paid: shaped.filter((r) => r.last_payment_date === null).length,
            total_notices_sent: shaped.reduce((s, r) => s + r.notices_sent, 0),
          },
        };

        const md =
          rowsToTable(
            "Arrears",
            inArrears as unknown as Record<string, unknown>[],
            ["lease_id", "last_payment_date", "days_since_payment", "total_paid", "notices_sent"],
            inArrears.length,
          ) +
          `\n\n${payload.summary.active_leases} active leases, ` +
          `${payload.summary.in_arrears} in arrears, ` +
          `${payload.summary.never_paid} with no payment on record.`;

        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}

export { ResponseFormat };
