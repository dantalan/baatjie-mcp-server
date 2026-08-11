/**
 * Response formatting, pagination envelopes and truncation.
 *
 * Every tool routes its output through here so that markdown/JSON handling,
 * size limits and pagination metadata behave identically across the server.
 */

import { CHARACTER_LIMIT, ResponseFormat } from "../constants.js";
import type { PaginatedResult } from "../types.js";
import { ToolError } from "../types.js";

/** Build a pagination envelope from a page of rows. */
export function paginate<T>(
  items: T[],
  total: number,
  offset: number,
): PaginatedResult<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
  };
}

/** Human-friendly rendering of a single value. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.replace("T", " ").slice(0, 19) + " UTC";
  }
  return String(value);
}

/** Render rows as a markdown list, one block per row. */
export function rowsToMarkdown(
  title: string,
  rows: Record<string, unknown>[],
  opts: { keyField?: string; total?: number } = {},
): string {
  if (rows.length === 0) return `# ${title}\n\nNo matching records.`;

  const lines = [`# ${title}`, ""];
  if (opts.total !== undefined) {
    lines.push(`${opts.total} total, showing ${rows.length}.`, "");
  }

  for (const row of rows) {
    const key = opts.keyField ? row[opts.keyField] : undefined;
    const heading = key !== undefined ? renderValue(key) : "Record";
    lines.push(`## ${heading}`);
    for (const [k, v] of Object.entries(row)) {
      if (opts.keyField && k === opts.keyField) continue;
      lines.push(`- **${k}**: ${renderValue(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Render rows as a compact markdown table. Better for wide, uniform lists. */
export function rowsToTable(
  title: string,
  rows: Record<string, unknown>[],
  columns: string[],
  total?: number,
): string {
  if (rows.length === 0) return `# ${title}\n\nNo matching records.`;
  const lines = [`# ${title}`, ""];
  if (total !== undefined) {
    lines.push(`${total} total, showing ${rows.length}.`, "");
  }
  lines.push(`| ${columns.join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${columns.map((c) => renderValue(row[c])).join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * Enforce the response size ceiling.
 *
 * Rather than cutting mid-sentence, halve the item list and say so, pointing the
 * agent at pagination — a truncated response the agent knows is truncated is far
 * more useful than a silently clipped one.
 */
export function enforceLimit<T>(
  text: string,
  payload: PaginatedResult<T>,
): { text: string; payload: PaginatedResult<T> } {
  if (text.length <= CHARACTER_LIMIT) return { text, payload };

  const keep = Math.max(1, Math.floor(payload.items.length / 2));
  const trimmed: PaginatedResult<T> = {
    ...payload,
    items: payload.items.slice(0, keep),
    count: keep,
    truncated: true,
    truncation_message:
      `Response truncated from ${payload.items.length} to ${keep} items ` +
      `(exceeded ${CHARACTER_LIMIT} characters). Use 'offset' to page through, ` +
      `or pass 'columns' to select fewer fields.`,
  };
  return { text: JSON.stringify(trimmed, null, 2), payload: trimmed };
}

/**
 * Shape of a tool result.
 *
 * The index signature matches the SDK's CallToolResult, which allows arbitrary
 * extra keys; without it TypeScript rejects our narrower type at registration.
 */
export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a successful tool response in the requested format.
 *
 * `structured` is accepted as a plain object and widened internally, so callers
 * can pass typed payloads (PaginatedResult, domain shapes) without casting at
 * every call site.
 */
export function respond(
  format: ResponseFormat,
  markdown: string,
  structured: object,
): ToolResponse {
  const text =
    format === ResponseFormat.MARKDOWN
      ? markdown
      : JSON.stringify(structured, null, 2);

  const finalText =
    text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) +
        `\n\n[truncated at ${CHARACTER_LIMIT} characters — narrow the query or use pagination]`
      : text;

  return {
    content: [{ type: "text", text: finalText }],
    structuredContent: structured as Record<string, unknown>,
  };
}

/** Convert any thrown value into an actionable tool error response. */
export function toErrorResponse(error: unknown): ToolResponse {
  if (error instanceof ToolError) {
    const text = error.suggestion
      ? `Error: ${error.message}\n\nSuggestion: ${error.suggestion}`
      : `Error: ${error.message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text:
          `Error: ${message}\n\n` +
          `Suggestion: Verify the table name, filters and credentials. ` +
          `Run baatjie_describe_schema to see available tables and columns.`,
      },
    ],
    isError: true,
  };
}

export { ResponseFormat };
