/**
 * Generic CRUD tools covering every allowlisted table in both projects.
 *
 * These give comprehensive coverage without one tool per table. The workflow
 * tools in the other modules sit on top for the paths used daily.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OCCUPANT_TABLES,
  Project,
  SIGSCHE_TABLES,
  TANOS_TABLES,
} from "../constants.js";
import {
  paginate,
  respond,
  ResponseFormat,
  rowsToMarkdown,
  toErrorResponse,
} from "../services/format.js";
import {
  deleteRows,
  insertRows,
  queryRows,
  updateRows,
  type Filter,
} from "../services/supabase.js";
import {
  actorField,
  columnsField,
  filtersField,
  includePiiField,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas.js";

const projectField = z
  .nativeEnum(Project)
  .describe(
    "Which system: 'tanos' (property OS, pipeline, sequencing) or " +
      "'sigsche' (signal scheduler)",
  );

const TABLE_DOCS = `
tanOS tables:
  Property:  landlords, properties, rooms, tenants, foreign_nationals, leases,
             lease_agreements, payments, maintenance, notices
  Commercial: locare_accounts, brms, agents, employers, policies, daily_activity
  Internal:  todos, ai_agents, audit_log

sigscheCore tables:
  profiles, queue_items, library_items, brand_cards, registration_status
`.trim();

export function registerGenericTools(server: McpServer): void {
  server.registerTool(
    "baatjie_describe_schema",
    {
      title: "Describe Baatjie Group Schema",
      description: `List every table reachable through this server, with row counts and column names.

Call this first when you are unsure which table or column to use. It is the cheapest
way to orient before querying.

Args:
  - project ('tanos' | 'sigsche' | omit for both): Which system to describe
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  {
    "projects": {
      "tanos":  { "tables": [{ "name": string, "columns": string[] }] },
      "sigsche": { "tables": [...] }
    }
  }

${TABLE_DOCS}`,
      inputSchema: {
        project: projectField.optional(),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, response_format }) => {
      try {
        const wanted = project
          ? [project]
          : [Project.TANOS, Project.SIGSCHE];
        const out: Record<string, unknown> = {};
        for (const p of wanted) {
          const tables = p === Project.TANOS ? TANOS_TABLES : SIGSCHE_TABLES;
          out[p] = { tables: [...tables] };
        }
        const md =
          `# Baatjie Group Schema\n\n` +
          wanted
            .map((p) => {
              const tables = p === Project.TANOS ? TANOS_TABLES : SIGSCHE_TABLES;
              return `## ${p}\n\n${tables.map((t) => `- ${t}`).join("\n")}`;
            })
            .join("\n\n") +
          `\n\n${TABLE_DOCS}`;
        return respond(response_format, md, { projects: out });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_query",
    {
      title: "Query Any Baatjie Table",
      description: `Read rows from any table in tanOS or sigscheCore, with filtering, column
selection, ordering and pagination.

This is the general-purpose read. For sequencing work prefer baatjie_next_actions,
and for the ops snapshot prefer baatjie_dashboard — both are cheaper and better shaped.

Personal identifiers (ID numbers, passport numbers, phone, email, banking details) are
withheld unless include_pii is true, and the response reports which fields were withheld.

Args:
  - project ('tanos' | 'sigsche'): Which system
  - table (string): Table name — must be in the allowlist
  - columns (string[], optional): Specific columns; omit for all
  - filters (Filter[]): AND-combined filters
  - order_by (string, optional): Column to sort on
  - ascending (boolean): Sort direction (default: true)
  - limit (number): Max rows, 1-200 (default: 25)
  - offset (number): Rows to skip (default: 0)
  - include_pii (boolean): Include personal identifiers (default: false)
  - response_format ('markdown' | 'json'): Output format

Returns:
  {
    "total": number, "count": number, "offset": number,
    "items": object[], "has_more": boolean, "next_offset"?: number,
    "redacted_fields": string[]
  }

Examples:
  - "Which todos are still open?" -> project='tanos', table='todos',
    filters=[{"column":"status","op":"neq","value":"done"}]
  - "Show agencies signed this month" -> table='locare_accounts',
    filters=[{"column":"signed_date","op":"gte","value":"2026-08-01"}]
  - "Biggest BRM books" -> table='brms', order_by='inherited_book_size', ascending=false

Error Handling:
  - "Unknown table" lists the valid table names for that project
  - Column errors suggest calling baatjie_describe_schema

${TABLE_DOCS}`,
      inputSchema: {
        project: projectField,
        table: z.string().min(1).describe("Table name (see allowlist)"),
        columns: columnsField,
        filters: filtersField,
        order_by: z.string().optional().describe("Column to sort by"),
        ascending: z
          .boolean()
          .default(true)
          .describe("Sort ascending (default true)"),
        limit: limitField,
        offset: offsetField,
        include_pii: includePiiField,
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
        const { rows, total, redacted } = await queryRows({
          project: params.project,
          table: params.table,
          columns: params.columns,
          filters: params.filters as Filter[],
          orderBy: params.order_by,
          ascending: params.ascending,
          limit: params.limit,
          offset: params.offset,
          includePii: params.include_pii,
        });

        const payload = {
          ...paginate(rows, total, params.offset),
          redacted_fields: redacted,
        };
        const md =
          rowsToMarkdown(`${params.project}.${params.table}`, rows, { total }) +
          (redacted.length
            ? `\n\n_Withheld personal fields: ${redacted.join(", ")}. Pass include_pii=true if the task requires them._`
            : "");
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_insert",
    {
      title: "Insert Rows",
      description: `Insert one or more rows into any table in tanOS or sigscheCore.
Every insert is recorded in tanOS audit_log with the actor you supply.

Args:
  - project ('tanos' | 'sigsche'): Which system
  - table (string): Target table
  - rows (object[]): Rows to insert, 1-100. Omit columns with database defaults.
  - actor (string): Who is writing, for the audit trail (default: 'mcp')
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "table": string, "action": "insert", "affected": number,
    "rows": object[], "audit_logged": boolean, "note"?: string }

Examples:
  - Log a signed agency -> table='locare_accounts',
    rows=[{"agency_name":"Cape Letting","brm_id":"...","tier":"Growth","status":"active"}]
  - Record a payment -> table='payments',
    rows=[{"lease_id":"...","amount":3400,"payment_date":"2026-08-08","method":"payroll"}]

Note: writes to occupant-facing tables (tenants, leases, notices, payments) are flagged
in the response, because a row there corresponds to a real person's tenancy or money.
A 'notices' row in particular represents a notice served on an occupant — South African
arrears and eviction notices carry statutory requirements, so route the wording through
your legal-exposure-check skill before sending rather than after.

Error Handling:
  - Foreign key failures name the missing parent record
  - CHECK constraint failures point at columns with restricted values`,
      inputSchema: {
        project: projectField,
        table: z.string().min(1).describe("Target table"),
        rows: z
          .array(z.record(z.unknown()))
          .min(1, "Provide at least one row")
          .max(100, "Insert at most 100 rows per call")
          .describe("Rows to insert"),
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
        const { rows, audited } = await insertRows(
          {
            project: params.project,
            table: params.table,
            actor: params.actor,
          },
          params.rows as Record<string, unknown>[],
        );

        const note = OCCUPANT_TABLES.has(params.table)
          ? `'${params.table}' is occupant-facing — these rows describe real tenancies, money or notices.`
          : undefined;

        const payload = {
          ok: true,
          table: params.table,
          action: "insert" as const,
          affected: rows.length,
          rows,
          audit_logged: audited,
          ...(note ? { note } : {}),
        };
        const md =
          `# Inserted ${rows.length} row(s) into ${params.project}.${params.table}\n\n` +
          rowsToMarkdown("Inserted", rows) +
          (audited ? "" : "\n\n_Audit log write failed — mutation still applied._") +
          (note ? `\n\n_${note}_` : "");
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_update",
    {
      title: "Update Rows",
      description: `Update rows matching a filter, in any table in either system.
At least one filter is required — an unfiltered update is refused rather than
rewriting the whole table. Recorded in tanOS audit_log.

Args:
  - project ('tanos' | 'sigsche'): Which system
  - table (string): Target table
  - patch (object): Columns and new values
  - filters (Filter[]): Which rows to change — must not be empty
  - actor (string): Who is writing, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "table": string, "action": "update", "affected": number,
    "rows": object[], "audit_logged": boolean }

Examples:
  - Mark a todo done -> table='todos', patch={"status":"done"},
    filters=[{"column":"id","op":"eq","value":"<uuid>"}]
  - Close a maintenance ticket -> table='maintenance',
    patch={"status":"resolved","resolved_at":"2026-08-08T12:00:00Z"},
    filters=[{"column":"ticket_id","op":"eq","value":"<uuid>"}]

Error Handling:
  - Empty filters are rejected with an explanation
  - Unknown columns in the patch are reported by name`,
      inputSchema: {
        project: projectField,
        table: z.string().min(1).describe("Target table"),
        patch: z
          .record(z.unknown())
          .refine((p) => Object.keys(p).length > 0, "patch must not be empty")
          .describe("Columns to set"),
        filters: filtersField,
        actor: actorField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { rows, audited } = await updateRows(
          {
            project: params.project,
            table: params.table,
            actor: params.actor,
          },
          params.patch as Record<string, unknown>,
          params.filters as Filter[],
        );
        const payload = {
          ok: true,
          table: params.table,
          action: "update" as const,
          affected: rows.length,
          rows,
          audit_logged: audited,
        };
        const md =
          `# Updated ${rows.length} row(s) in ${params.project}.${params.table}\n\n` +
          rowsToMarkdown("Updated", rows);
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_delete",
    {
      title: "Delete Rows",
      description: `Permanently delete rows matching a filter. Requires confirm=true and at
least one filter. Recorded in tanOS audit_log.

Deletes are irreversible and there is no soft-delete on these tables. Prefer a status
change (baatjie_update) over deletion wherever the schema has a status column — the
ledger is append-only by design, and payment corrections belong as compensating rows
rather than deletions.

Args:
  - project ('tanos' | 'sigsche'): Which system
  - table (string): Target table
  - filters (Filter[]): Which rows to delete — must not be empty
  - confirm (boolean): Must be true; guards against accidental invocation
  - actor (string): Who is deleting, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "table": string, "action": "delete", "affected": number,
    "audit_logged": boolean }

Error Handling:
  - confirm=false returns an explanation without deleting anything
  - Foreign key violations name the dependent rows blocking the delete`,
      inputSchema: {
        project: projectField,
        table: z.string().min(1).describe("Target table"),
        filters: filtersField,
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to actually delete"),
        actor: actorField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        if (!params.confirm) {
          return respond(
            params.response_format,
            `# Delete not executed\n\nSet \`confirm: true\` to delete from ` +
              `\`${params.project}.${params.table}\`. Nothing was changed.\n\n` +
              `Consider updating a status column instead — deletes here are irreversible.`,
            {
              ok: false,
              table: params.table,
              action: "delete",
              affected: 0,
              audit_logged: false,
              note: "confirm was false; no rows deleted",
            },
          );
        }
        const { count, audited } = await deleteRows(
          {
            project: params.project,
            table: params.table,
            actor: params.actor,
          },
          params.filters as Filter[],
        );
        return respond(
          params.response_format,
          `# Deleted ${count} row(s) from ${params.project}.${params.table}`,
          {
            ok: true,
            table: params.table,
            action: "delete",
            affected: count,
            audit_logged: audited,
          },
        );
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}

export { ResponseFormat };
