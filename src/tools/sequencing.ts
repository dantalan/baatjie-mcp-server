/**
 * Sequencing tools — the dependency-aware action list.
 *
 * The todos table carries wave/track/blocked_by/effort, which turns a flat list
 * into a dependency graph. These tools compute what is genuinely startable and
 * how much each item unblocks, so an agent works the critical path rather than
 * the top of the list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Project } from "../constants.js";
import {
  paginate,
  respond,
  ResponseFormat,
  rowsToTable,
  toErrorResponse,
} from "../services/format.js";
import { insertRows, queryRows, updateRows } from "../services/supabase.js";
import type { SequencedTodo, TodoRow } from "../types.js";
import {
  actorField,
  limitField,
  offsetField,
  responseFormatField,
} from "../schemas.js";

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Pull every todo and compute blockers + transitive unblock counts. */
async function loadSequenced(): Promise<SequencedTodo[]> {
  const { rows } = await queryRows({
    project: Project.TANOS,
    table: "todos",
    limit: 1000,
    offset: 0,
  });
  const all = rows as unknown as TodoRow[];
  const doneIds = new Set(
    all.filter((t) => t.status === "done").map((t) => t.id),
  );
  const open = all.filter((t) => t.status !== "done");

  const withBlockers = open.map((t) => {
    const openBlockers = (t.blocked_by ?? []).filter((b) => !doneIds.has(b));
    return {
      ...t,
      open_blockers: openBlockers.length,
      startable: openBlockers.length === 0,
      unblocks: 0,
    } as SequencedTodo;
  });

  // Transitive downstream count: finishing X frees everything reachable from X.
  for (const item of withBlockers) {
    const seen = new Set<string>();
    const stack = [item.id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      for (const other of withBlockers) {
        if ((other.blocked_by ?? []).includes(current) && !seen.has(other.id)) {
          seen.add(other.id);
          stack.push(other.id);
        }
      }
    }
    item.unblocks = seen.size;
  }

  return withBlockers;
}

function sortForWork(items: SequencedTodo[]): SequencedTodo[] {
  return [...items].sort(
    (a, b) =>
      (a.wave ?? 9) - (b.wave ?? 9) ||
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      b.unblocks - a.unblocks,
  );
}

export function registerSequencingTools(server: McpServer): void {
  server.registerTool(
    "baatjie_next_actions",
    {
      title: "What Can Actually Be Started Now",
      description: `Return the todos that are genuinely startable right now — every blocker done —
ranked by how much each one unblocks downstream.

This is the tool to reach for when asked "what should I do next", "what's the priority",
or "what's blocking us". A raw todo list hides the fact that most items cannot be started;
this one answers the question the list is standing in for.

Args:
  - track ('A' | 'B' | 'SPINE' | 'TODAY', optional): Restrict to one workstream.
      A = agency business, B = payroll housing rail, SPINE = shared infrastructure,
      TODAY = time-boxed launch-day items
  - priority ('critical' | 'high' | 'medium' | 'low', optional): Minimum priority
  - include_blocked (boolean): Also list blocked items with their blocker counts (default: false)
  - limit (number): Max items (default: 25)
  - response_format ('markdown' | 'json'): Output format

Returns:
  {
    "startable": [{ "id","title","priority","track","wave","effort","unblocks" }],
    "blocked_count": number,
    "roots": [...],          // startable items that unblock the most
    "summary": { "total","startable","blocked","by_priority": {...} }
  }

Examples:
  - "What should I work on?" -> no args
  - "What's next on the housing rail?" -> track='B'
  - "Show me everything including what's stuck" -> include_blocked=true

Error Handling:
  - Returns an empty startable list with an explanation if every open item is blocked,
    which itself signals the roots need attention first`,
      inputSchema: {
        track: z
          .enum(["A", "B", "SPINE", "TODAY"])
          .optional()
          .describe("Restrict to one workstream"),
        priority: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("Minimum priority to include"),
        include_blocked: z
          .boolean()
          .default(false)
          .describe("Also return blocked items"),
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
        let items = await loadSequenced();

        if (params.track) {
          items = items.filter((t) => t.track === params.track);
        }
        if (params.priority) {
          const cutoff = PRIORITY_RANK[params.priority] ?? 3;
          items = items.filter(
            (t) => (PRIORITY_RANK[t.priority] ?? 9) <= cutoff,
          );
        }

        const startable = sortForWork(items.filter((t) => t.startable)).slice(
          0,
          params.limit,
        );
        const blocked = items.filter((t) => !t.startable);
        const roots = [...startable]
          .sort((a, b) => b.unblocks - a.unblocks)
          .filter((t) => t.unblocks > 0)
          .slice(0, 5);

        const byPriority: Record<string, number> = {};
        for (const t of items) {
          byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
        }

        const shape = (t: SequencedTodo) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          track: t.track,
          wave: t.wave,
          effort: t.effort,
          unblocks: t.unblocks,
          ...(t.startable ? {} : { open_blockers: t.open_blockers }),
        });

        const payload = {
          startable: startable.map(shape),
          blocked_count: blocked.length,
          ...(params.include_blocked
            ? { blocked: sortForWork(blocked).map(shape) }
            : {}),
          roots: roots.map(shape),
          summary: {
            total: items.length,
            startable: items.filter((t) => t.startable).length,
            blocked: blocked.length,
            by_priority: byPriority,
          },
        };

        const lines: string[] = ["# Startable now", ""];
        if (startable.length === 0) {
          lines.push(
            "Nothing is startable — every open item has an unfinished blocker.",
            "That itself is the finding: the root items need attention before anything else moves.",
          );
        } else {
          lines.push(
            `${payload.summary.startable} startable, ${blocked.length} blocked, ${items.length} open.`,
            "",
            rowsToTable(
              "",
              startable.map(shape) as unknown as Record<string, unknown>[],
              ["title", "priority", "track", "effort", "unblocks"],
            ).replace(/^# \n\n/, ""),
          );
          if (roots.length > 0) {
            lines.push(
              "",
              "## Highest leverage",
              "",
              ...roots.map(
                (r) =>
                  `- **${r.title}** — ${r.effort ?? "effort unknown"}, unblocks ${r.unblocks} item(s)`,
              ),
            );
          }
        }
        if (params.include_blocked && blocked.length > 0) {
          lines.push(
            "",
            "## Blocked",
            "",
            ...sortForWork(blocked)
              .slice(0, 20)
              .map((b) => `- ${b.title} _(${b.open_blockers} blocker(s))_`),
          );
        }

        return respond(params.response_format, lines.join("\n"), payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_list_todos",
    {
      title: "List Todos With Sequencing",
      description: `List todos with their wave, track, effort, blocker count and unblock count.

Use this for a full picture of the board. For "what do I do next", baatjie_next_actions
is the better tool because it filters to what is actually actionable.

Args:
  - status ('open' | 'in_progress' | 'done' | 'blocked', optional): Filter by status.
      Omit to return everything except done.
  - track ('A' | 'B' | 'SPINE' | 'TODAY', optional): Filter by workstream
  - wave (number, optional): Filter by wave (0=today, 1=roots, 2..4=later)
  - priority ('critical' | 'high' | 'medium' | 'low', optional): Filter by priority
  - limit (number): Max items (default: 25)
  - offset (number): Pagination offset (default: 0)
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "total","count","offset","items":[...],"has_more","next_offset"? }
  where each item carries id, title, priority, status, wave, track, effort,
  open_blockers, startable and unblocks.

Examples:
  - "Show the critical list" -> priority='critical'
  - "What's in wave 1?" -> wave=1
  - "Everything on the housing rail" -> track='B'`,
      inputSchema: {
        status: z
          .enum(["open", "in_progress", "done", "blocked"])
          .optional()
          .describe("Filter by status; omit for all non-done"),
        track: z.enum(["A", "B", "SPINE", "TODAY"]).optional(),
        wave: z.number().int().min(0).max(9).optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
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
        let items = await loadSequenced();
        if (params.status) {
          items = items.filter((t) => t.status === params.status);
        }
        if (params.track) items = items.filter((t) => t.track === params.track);
        if (params.wave !== undefined) {
          items = items.filter((t) => (t.wave ?? 9) === params.wave);
        }
        if (params.priority) {
          items = items.filter((t) => t.priority === params.priority);
        }

        const sorted = sortForWork(items);
        const page = sorted.slice(params.offset, params.offset + params.limit);
        const shaped = page.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          status: t.status,
          wave: t.wave,
          track: t.track,
          effort: t.effort,
          open_blockers: t.open_blockers,
          startable: t.startable,
          unblocks: t.unblocks,
        }));

        const payload = paginate(shaped, sorted.length, params.offset);
        const md = rowsToTable(
          "Todos",
          shaped as unknown as Record<string, unknown>[],
          ["title", "priority", "wave", "track", "effort", "startable", "unblocks"],
          sorted.length,
        );
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_create_todo",
    {
      title: "Create a Todo",
      description: `Add a todo to the tanOS action plan, optionally with sequencing metadata.

Args:
  - title (string): Short imperative summary
  - detail (string, optional): Context, why it matters, what "done" looks like
  - category (string): Grouping label, e.g. 'security', 'legal', 'pricing' (default: 'general')
  - product (string): 'locare' | 'tanos' | 'sigschecore' | 'brand' | 'cross-cutting'
      (default: 'cross-cutting')
  - priority ('critical' | 'high' | 'medium' | 'low'): Default 'medium'
  - wave (number, optional): 0=today, 1=root, 2=near, 3=downstream, 4=later
  - track ('A' | 'B' | 'SPINE' | 'TODAY', optional): Which workstream owns it
  - blocked_by (string[], optional): Todo ids that must complete first
  - effort (string, optional): Rough size, e.g. '1 hour', '2-3 days'
  - actor (string): Who is creating it, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "todo": { "id","title",... }, "audit_logged": boolean }

Examples:
  - Quick capture -> title='Confirm iKhokha reversal path', priority='high'
  - Sequenced item -> title='Load the policy book', wave=2, track='SPINE',
    blocked_by=['<rls-todo-uuid>'], effort='1 day'`,
      inputSchema: {
        title: z.string().min(3).max(300).describe("Short imperative summary"),
        detail: z.string().max(4000).optional().describe("Context and definition of done"),
        category: z.string().min(1).max(60).default("general"),
        product: z.string().min(1).max(60).default("cross-cutting"),
        priority: z
          .enum(["critical", "high", "medium", "low"])
          .default("medium"),
        wave: z.number().int().min(0).max(9).optional(),
        track: z.enum(["A", "B", "SPINE", "TODAY"]).optional(),
        blocked_by: z
          .array(z.string().uuid())
          .optional()
          .describe("Todo ids that must be done first"),
        effort: z.string().max(60).optional(),
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
        const row: Record<string, unknown> = {
          title: params.title,
          category: params.category,
          product: params.product,
          priority: params.priority,
          status: "open",
        };
        if (params.detail !== undefined) row["detail"] = params.detail;
        if (params.wave !== undefined) row["wave"] = params.wave;
        if (params.track !== undefined) row["track"] = params.track;
        if (params.blocked_by !== undefined) row["blocked_by"] = params.blocked_by;
        if (params.effort !== undefined) row["effort"] = params.effort;

        const { rows, audited } = await insertRows(
          { project: Project.TANOS, table: "todos", actor: params.actor },
          [row],
        );
        const created = rows[0] ?? {};
        return respond(
          params.response_format,
          `# Todo created\n\n**${params.title}**\n\n` +
            `- priority: ${params.priority}\n- track: ${params.track ?? "—"}\n` +
            `- wave: ${params.wave ?? "—"}\n- effort: ${params.effort ?? "—"}`,
          { ok: true, todo: created, audit_logged: audited },
        );
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_update_todo",
    {
      title: "Update a Todo",
      description: `Change a todo's status or sequencing metadata by id.

Marking an item done automatically unblocks anything that listed it in blocked_by —
the dependency graph is recomputed on read, so the next call to baatjie_next_actions
will surface newly available work.

Args:
  - id (string, uuid): Todo id
  - status ('open' | 'in_progress' | 'done' | 'blocked', optional)
  - priority ('critical' | 'high' | 'medium' | 'low', optional)
  - wave (number, optional)
  - track ('A' | 'B' | 'SPINE' | 'TODAY', optional)
  - blocked_by (string[], optional): Replaces the existing blocker list
  - effort (string, optional)
  - detail (string, optional)
  - actor (string): Who is writing, for the audit trail
  - response_format ('markdown' | 'json'): Output format

Returns:
  { "ok": true, "todo": {...}, "newly_unblocked": [{ "id","title" }], "audit_logged": boolean }

Examples:
  - Close an item -> id='<uuid>', status='done'
  - Re-sequence -> id='<uuid>', wave=1, track='SPINE'`,
      inputSchema: {
        id: z.string().uuid().describe("Todo id"),
        status: z.enum(["open", "in_progress", "done", "blocked"]).optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        wave: z.number().int().min(0).max(9).optional(),
        track: z.enum(["A", "B", "SPINE", "TODAY"]).optional(),
        blocked_by: z.array(z.string().uuid()).optional(),
        effort: z.string().max(60).optional(),
        detail: z.string().max(4000).optional(),
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
        const patch: Record<string, unknown> = {};
        for (const key of [
          "status",
          "priority",
          "wave",
          "track",
          "blocked_by",
          "effort",
          "detail",
        ] as const) {
          const value = params[key];
          if (value !== undefined) patch[key] = value;
        }
        if (Object.keys(patch).length === 0) {
          return respond(
            params.response_format,
            "# Nothing to update\n\nProvide at least one field to change.",
            { ok: false, note: "no fields supplied" },
          );
        }

        const before = await loadSequenced();
        const { rows, audited } = await updateRows(
          { project: Project.TANOS, table: "todos", actor: params.actor },
          patch,
          [{ column: "id", op: "eq", value: params.id }],
        );

        let newlyUnblocked: Array<{ id: string; title: string }> = [];
        if (patch["status"] === "done") {
          const after = await loadSequenced();
          const wasBlocked = new Set(
            before.filter((t) => !t.startable).map((t) => t.id),
          );
          newlyUnblocked = after
            .filter((t) => t.startable && wasBlocked.has(t.id))
            .map((t) => ({ id: t.id, title: t.title }));
        }

        const md =
          `# Todo updated\n\n` +
          Object.entries(patch)
            .map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`)
            .join("\n") +
          (newlyUnblocked.length
            ? `\n\n## Newly unblocked (${newlyUnblocked.length})\n\n` +
              newlyUnblocked.map((t) => `- ${t.title}`).join("\n")
            : "");

        return respond(params.response_format, md, {
          ok: true,
          todo: rows[0] ?? null,
          newly_unblocked: newlyUnblocked,
          audit_logged: audited,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}

export { ResponseFormat };
