/**
 * Supabase client management and shared CRUD primitives.
 *
 * Both Baatjie Group projects are reached through this module so that
 * authentication, filtering, pagination, PII handling and audit logging live in
 * exactly one place rather than being re-implemented per tool.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  PII_COLUMNS,
  Project,
  SIGSCHE_TABLES,
  TANOS_TABLES,
  type SigscheTable,
  type TanosTable,
} from "../constants.js";
import { ToolError } from "../types.js";

let tanosClient: SupabaseClient | null = null;
let sigscheClient: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ToolError(
      `Missing required environment variable ${name}.`,
      `Set ${name} before starting the server. See .env.example for the full list.`,
    );
  }
  return value;
}

export function getClient(project: Project): SupabaseClient {
  if (project === Project.TANOS) {
    if (!tanosClient) {
      tanosClient = createClient(
        requireEnv("TANOS_URL"),
        requireEnv("TANOS_SERVICE_KEY"),
        { auth: { persistSession: false } },
      );
    }
    return tanosClient;
  }
  if (!sigscheClient) {
    sigscheClient = createClient(
      requireEnv("SIGSCHE_URL"),
      requireEnv("SIGSCHE_SERVICE_KEY"),
      { auth: { persistSession: false } },
    );
  }
  return sigscheClient;
}

/** Validate a table name against the project's allowlist. */
export function assertTable(project: Project, table: string): string {
  const allowed: readonly string[] =
    project === Project.TANOS ? TANOS_TABLES : SIGSCHE_TABLES;
  if (!allowed.includes(table)) {
    throw new ToolError(
      `Unknown table '${table}' for project '${project}'.`,
      `Valid tables: ${allowed.join(", ")}.`,
    );
  }
  return table;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "is"
  | "in";

export interface Filter {
  column: string;
  op: FilterOp;
  value: string | number | boolean | null | Array<string | number>;
}

/** Apply a list of filters to a PostgREST query builder. */
function applyFilters<T>(query: T, filters: Filter[]): T {
  let q = query as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const f of filters) {
    const fn = q[f.op];
    if (typeof fn !== "function") {
      throw new ToolError(
        `Unsupported filter operator '${f.op}'.`,
        "Supported: eq, neq, gt, gte, lt, lte, like, ilike, is, in.",
      );
    }
    q = fn.call(q, f.column, f.value) as typeof q;
  }
  return q as unknown as T;
}

/**
 * Decide which columns to select. PII columns are dropped unless explicitly
 * requested, so ordinary queries don't drag identity numbers into context.
 */
export function resolveSelect(
  table: string,
  columns: string[] | undefined,
  includePii: boolean,
): string {
  if (columns && columns.length > 0) return columns.join(",");
  if (includePii) return "*";
  const pii = PII_COLUMNS[table];
  if (!pii || pii.length === 0) return "*";
  // PostgREST has no "all except" syntax, so select * and strip after the fact.
  return "*";
}

/** Remove PII columns from returned rows unless the caller opted in. */
export function stripPii(
  table: string,
  rows: Record<string, unknown>[],
  includePii: boolean,
): { rows: Record<string, unknown>[]; redacted: string[] } {
  const pii = PII_COLUMNS[table];
  if (includePii || !pii || pii.length === 0) return { rows, redacted: [] };
  const present = new Set<string>();
  const cleaned = rows.map((row) => {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (pii.includes(k)) {
        present.add(k);
        continue;
      }
      copy[k] = v;
    }
    return copy;
  });
  return { rows: cleaned, redacted: [...present] };
}

export interface QueryOptions {
  project: Project;
  table: string;
  columns?: string[];
  filters?: Filter[];
  orderBy?: string;
  ascending?: boolean;
  limit: number;
  offset: number;
  includePii?: boolean;
}

export interface QueryOutcome {
  rows: Record<string, unknown>[];
  total: number;
  redacted: string[];
}

export async function queryRows(opts: QueryOptions): Promise<QueryOutcome> {
  const client = getClient(opts.project);
  const table = assertTable(opts.project, opts.table);
  const includePii = opts.includePii ?? false;

  let q = client
    .from(table)
    .select(resolveSelect(table, opts.columns, includePii), { count: "exact" });

  q = applyFilters(q, opts.filters ?? []);

  if (opts.orderBy) {
    q = q.order(opts.orderBy, { ascending: opts.ascending ?? true });
  }
  q = q.range(opts.offset, opts.offset + opts.limit - 1);

  const { data, error, count } = await q;
  if (error) {
    throw new ToolError(
      `Query on '${table}' failed: ${error.message}`,
      error.code === "42703"
        ? "One of the requested columns does not exist. Call the schema tool or omit `columns` to select everything."
        : "Check filter columns and operators against the table schema.",
    );
  }

  const raw = (data ?? []) as unknown as Record<string, unknown>[];
  const { rows, redacted } = stripPii(table, raw, includePii);
  return { rows, total: count ?? rows.length, redacted };
}

/**
 * Write an audit row into tanOS `audit_log`.
 *
 * Best-effort: an audit failure must never silently swallow the fact that the
 * underlying mutation succeeded, so the caller is told whether it landed.
 */
export async function writeAudit(
  table: string,
  recordId: string | null,
  action: string,
  actor: string,
): Promise<boolean> {
  try {
    const client = getClient(Project.TANOS);
    const { error } = await client.from("audit_log").insert({
      table_name: table,
      record_id: recordId,
      action,
      actor,
    });
    return !error;
  } catch {
    return false;
  }
}

export interface MutateOptions {
  project: Project;
  table: string;
  actor: string;
}

export async function insertRows(
  opts: MutateOptions,
  rows: Record<string, unknown>[],
): Promise<{ rows: Record<string, unknown>[]; audited: boolean }> {
  const client = getClient(opts.project);
  const table = assertTable(opts.project, opts.table);

  const { data, error } = await client.from(table).insert(rows).select();
  if (error) {
    throw new ToolError(
      `Insert into '${table}' failed: ${error.message}`,
      error.code === "23503"
        ? "A foreign key does not resolve. Create the parent record first, or check the id you passed."
        : error.code === "23514"
          ? "A CHECK constraint rejected the value. Check allowed values for status/tier/priority style columns."
          : "Verify required columns are present and correctly typed.",
    );
  }

  const inserted = (data ?? []) as Record<string, unknown>[];
  const firstId = inserted[0]
    ? ((Object.values(inserted[0])[0] as string) ?? null)
    : null;
  const audited = await writeAudit(
    table,
    typeof firstId === "string" ? firstId : null,
    `insert:${inserted.length}`,
    opts.actor,
  );
  return { rows: inserted, audited };
}

export async function updateRows(
  opts: MutateOptions,
  patch: Record<string, unknown>,
  filters: Filter[],
): Promise<{ rows: Record<string, unknown>[]; audited: boolean }> {
  if (filters.length === 0) {
    throw new ToolError(
      "Refusing to update every row in the table.",
      "Pass at least one filter identifying which rows to change.",
    );
  }
  const client = getClient(opts.project);
  const table = assertTable(opts.project, opts.table);

  let q = client.from(table).update(patch);
  q = applyFilters(q, filters);

  const { data, error } = await q.select();
  if (error) {
    throw new ToolError(
      `Update on '${table}' failed: ${error.message}`,
      "Check the patch columns exist and the filter matches the intended rows.",
    );
  }

  const updated = (data ?? []) as Record<string, unknown>[];
  const audited = await writeAudit(
    table,
    null,
    `update:${updated.length}`,
    opts.actor,
  );
  return { rows: updated, audited };
}

export async function deleteRows(
  opts: MutateOptions,
  filters: Filter[],
): Promise<{ count: number; audited: boolean }> {
  if (filters.length === 0) {
    throw new ToolError(
      "Refusing to delete every row in the table.",
      "Pass at least one filter identifying which rows to remove.",
    );
  }
  const client = getClient(opts.project);
  const table = assertTable(opts.project, opts.table);

  let q = client.from(table).delete();
  q = applyFilters(q, filters);

  const { data, error } = await q.select();
  if (error) {
    throw new ToolError(
      `Delete on '${table}' failed: ${error.message}`,
      error.code === "23503"
        ? "Other rows still reference these records. Delete the dependent rows first."
        : "Check the filter matches the intended rows.",
    );
  }

  const removed = (data ?? []) as Record<string, unknown>[];
  const audited = await writeAudit(
    table,
    null,
    `delete:${removed.length}`,
    opts.actor,
  );
  return { count: removed.length, audited };
}

/** Count rows in a table without pulling any data. */
export async function countRows(
  project: Project,
  table: string,
): Promise<number | null> {
  try {
    const client = getClient(project);
    const { count, error } = await client
      .from(table)
      .select("*", { count: "exact", head: true });
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

export const ALL_TANOS_TABLES: readonly TanosTable[] = TANOS_TABLES;
export const ALL_SIGSCHE_TABLES: readonly SigscheTable[] = SIGSCHE_TABLES;
