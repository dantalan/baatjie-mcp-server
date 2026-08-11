/**
 * sigscheCore tools — the multi-brand signal scheduler.
 *
 * Scheduling is angel-window aware: the system reserves 08:17, 11:11, 13:13 and
 * 22:22 as broadcast slots, so the scheduling tool surfaces which window a post
 * lands in rather than making the caller work it out.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANGEL_WINDOWS, Project } from "../constants.js";
import {
  paginate,
  respond,
  ResponseFormat,
  rowsToTable,
  toErrorResponse,
} from "../services/format.js";
import { insertRows, queryRows } from "../services/supabase.js";
import {
  actorField,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas.js";

/** Return the angel label for a HH:MM time, if it lands on one. */
function angelLabel(time: string): string | null {
  const [h, m] = time.split(":").map(Number);
  for (const [ah, am] of ANGEL_WINDOWS) {
    if (ah === h && am === m) {
      return `${String(ah).padStart(2, "0")}:${String(am).padStart(2, "0")}`;
    }
  }
  return null;
}

export function registerSigscheTools(server: McpServer): void {
  server.registerTool(
    "baatjie_signal_queue",
    {
      title: "List the Signal Queue",
      description: `List scheduled, sent and failed posts in the sigscheCore broadcast queue,
optionally filtered by brand, status or date.

Args:
  - brand_id (string, optional): Restrict to one brand
  - status ('scheduled' | 'sent' | 'failed', optional): Filter by state
  - from_date (string, optional): YYYY-MM-DD, on or after
  - to_date (string, optional): YYYY-MM-DD, on or before
  - limit (number): Max items (default: 25)
  - offset (number): Pagination offset (default: 0)
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "total","count","offset","items":[{ "id","brand_name","scheduled_date",
    "scheduled_time","angel_label","platforms","status","caption","is_ad" }],
    "has_more","next_offset"? }

Examples:
  - "What's queued today?" -> from_date='2026-08-08', to_date='2026-08-08'
  - "Anything failed?" -> status='failed'
  - "locare's schedule" -> brand_id='locare'`,
      inputSchema: {
        brand_id: z.string().optional(),
        status: z.enum(["scheduled", "sent", "failed"]).optional(),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: limitField,
        offset: offsetField,
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
        const filters: Array<{
          column: string;
          op: "eq" | "gte" | "lte";
          value: string;
        }> = [];
        if (params.brand_id)
          filters.push({ column: "brand_id", op: "eq", value: params.brand_id });
        if (params.status)
          filters.push({ column: "status", op: "eq", value: params.status });
        if (params.from_date)
          filters.push({ column: "scheduled_date", op: "gte", value: params.from_date });
        if (params.to_date)
          filters.push({ column: "scheduled_date", op: "lte", value: params.to_date });

        const { rows, total } = await queryRows({
          project: Project.SIGSCHE,
          table: "queue_items",
          filters,
          orderBy: "scheduled_date",
          ascending: true,
          limit: params.limit,
          offset: params.offset,
        });

        const payload = paginate(rows, total, params.offset);
        const md = rowsToTable(
          "Signal queue",
          rows,
          ["brand_name", "scheduled_date", "scheduled_time", "angel_label", "status", "is_ad"],
          total,
        );
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_schedule_signal",
    {
      title: "Schedule a Signal Post",
      description: `Queue a post or ad for broadcast across platforms, with angel-window awareness.

If the scheduled time matches one of the reserved windows (08:17, 11:11, 13:13, 22:22)
the angel label is set automatically and reported back. Times outside those windows are
accepted without complaint — the label is simply null.

Args:
  - brand_id (string): Brand key, e.g. 'locare', 'dantalan'
  - brand_name (string): Display name
  - caption (string): Post body
  - platforms (string[]): Target platforms, e.g. ['linkedin','x','instagram']
  - scheduled_date (string): YYYY-MM-DD
  - scheduled_time (string): HH:MM (24h)
  - is_ad (boolean): Whether this is a paid ad (default: false)
  - is_master (boolean): Master/primary signal for the slot (default: false)
  - media (string, optional): Media URL or reference
  - item_type (string, optional): Free-form classification
  - user_id (string, uuid): Owning sigscheCore profile id
  - actor (string): Who is scheduling, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "item": {...}, "angel_label": string | null,
    "audit_logged": boolean }

Examples:
  - Launch post -> brand_id='locare', scheduled_date='2026-08-08',
    scheduled_time='13:13', platforms=['linkedin','x']
  - Evening story -> scheduled_time='22:22', platforms=['instagram']

Error Handling:
  - Invalid time format is rejected before the write
  - A user_id with no matching profile returns a foreign key explanation`,
      inputSchema: {
        brand_id: z.string().min(1).describe("Brand key"),
        brand_name: z.string().min(1).describe("Brand display name"),
        caption: z.string().min(1).max(5000).describe("Post body"),
        platforms: z
          .array(z.string())
          .min(1, "Specify at least one platform")
          .describe("Target platforms"),
        scheduled_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
        scheduled_time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM in 24-hour format"),
        is_ad: z.boolean().default(false),
        is_master: z.boolean().default(false),
        media: z.string().optional(),
        item_type: z.string().optional(),
        user_id: z.string().uuid().describe("Owning sigscheCore profile id"),
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
        const label = angelLabel(params.scheduled_time);
        const row: Record<string, unknown> = {
          user_id: params.user_id,
          brand_id: params.brand_id,
          brand_name: params.brand_name,
          caption: params.caption,
          platforms: params.platforms,
          scheduled_date: params.scheduled_date,
          scheduled_time: params.scheduled_time,
          is_ad: params.is_ad,
          is_master: params.is_master,
          status: "scheduled",
        };
        if (label) row["angel_label"] = label;
        if (params.media !== undefined) row["media"] = params.media;
        if (params.item_type !== undefined) row["item_type"] = params.item_type;

        const { rows, audited } = await insertRows(
          { project: Project.SIGSCHE, table: "queue_items", actor: params.actor },
          [row],
        );

        return respond(
          params.response_format,
          `# Signal queued\n\n` +
            `- **${params.brand_name}** on ${params.platforms.join(", ")}\n` +
            `- ${params.scheduled_date} at ${params.scheduled_time}` +
            (label ? ` — angel window **${label}**` : " — outside angel windows") +
            `\n- ${params.is_ad ? "Paid ad" : "Organic post"}`,
          {
            ok: true,
            item: rows[0] ?? null,
            angel_label: label,
            audit_logged: audited,
          },
        );
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_brand_snapshot",
    {
      title: "Brand Snapshot Across Platforms",
      description: `Per-brand status across sigscheCore: platform registration progress, queued
and sent counts, library depth and how many brand cards exist.

Answers "is this brand ready to broadcast" and "where are we still unregistered".

Args:
  - brand_id (string, optional): One brand; omit to roll up every brand present
  - response_format ('markdown' | 'json'): Output format

Returns:
  {
    "brands": [{ "brand_id","queued","sent","failed","library_items",
                 "brand_cards","platforms_registered","platforms_pending" }],
    "totals": { "brands","queued","sent","registered" }
  }

Examples:
  - "Is locare ready to post?" -> brand_id='locare'
  - "Which brands still need registration?" -> no args`,
      inputSchema: {
        brand_id: z.string().optional(),
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
        const filt = params.brand_id
          ? [{ column: "brand_id", op: "eq" as const, value: params.brand_id }]
          : [];

        const [queue, library, cards, reg] = await Promise.all([
          queryRows({
            project: Project.SIGSCHE,
            table: "queue_items",
            columns: ["brand_id", "status"],
            filters: filt,
            limit: 1000,
            offset: 0,
          }),
          queryRows({
            project: Project.SIGSCHE,
            table: "library_items",
            columns: ["brand_id"],
            filters: filt,
            limit: 1000,
            offset: 0,
          }),
          queryRows({
            project: Project.SIGSCHE,
            table: "brand_cards",
            columns: ["brand_id"],
            filters: filt,
            limit: 1000,
            offset: 0,
          }),
          queryRows({
            project: Project.SIGSCHE,
            table: "registration_status",
            columns: ["brand_id", "platform_id", "status"],
            filters: filt,
            limit: 1000,
            offset: 0,
          }),
        ]);

        const brandIds = new Set<string>();
        for (const set of [queue.rows, library.rows, cards.rows, reg.rows]) {
          for (const r of set) {
            if (r["brand_id"]) brandIds.add(String(r["brand_id"]));
          }
        }

        const brands = [...brandIds].map((id) => {
          const q = queue.rows.filter((r) => r["brand_id"] === id);
          const registrations = reg.rows.filter((r) => r["brand_id"] === id);
          return {
            brand_id: id,
            queued: q.filter((r) => r["status"] === "scheduled").length,
            sent: q.filter((r) => r["status"] === "sent").length,
            failed: q.filter((r) => r["status"] === "failed").length,
            library_items: library.rows.filter((r) => r["brand_id"] === id).length,
            brand_cards: cards.rows.filter((r) => r["brand_id"] === id).length,
            platforms_registered: registrations.filter(
              (r) => r["status"] === "registered",
            ).length,
            platforms_pending: registrations.filter(
              (r) => r["status"] === "pending" || r["status"] === "in-progress",
            ).length,
          };
        });

        const totals = brands.reduce(
          (t, b) => ({
            brands: t.brands + 1,
            queued: t.queued + b.queued,
            sent: t.sent + b.sent,
            registered: t.registered + b.platforms_registered,
          }),
          { brands: 0, queued: 0, sent: 0, registered: 0 },
        );

        const md =
          brands.length === 0
            ? "# Brand snapshot\n\nNo brand activity found in sigscheCore yet."
            : rowsToTable(
                "Brand snapshot",
                brands as unknown as Record<string, unknown>[],
                [
                  "brand_id",
                  "queued",
                  "sent",
                  "failed",
                  "library_items",
                  "brand_cards",
                  "platforms_registered",
                  "platforms_pending",
                ],
                brands.length,
              );

        return respond(params.response_format, md, { brands, totals });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}

export { ResponseFormat };
