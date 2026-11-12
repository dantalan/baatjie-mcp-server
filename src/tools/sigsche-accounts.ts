/**
 * sigsche account tools (v13.3): more than one handle per platform.
 *
 * Read the register, add or change a handle, remove one. Nothing here holds a
 * password or a token: signing in happens in the sigsche browser, and API
 * tokens stay in data/secrets.json.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACCT_MAX, accounts, removeAccount, saveAccount, targetAccounts } from "../sigsche/accounts.js";
import { catalog, platformOf, readState } from "../sigsche/model.js";
import { accountLogins } from "../sigsche/service.js";
import { respond, toErrorResponse } from "../services/format.js";
import { responseFormatField } from "../schemas.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

function table(head: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return "_None._";
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

export function registerSigscheAccountTools(server: McpServer): void {
  server.registerTool(
    "baatjie_sigsche_accounts",
    {
      title: "sigsche Handles: Every Account on Every Platform",
      description: `Every handle sigsche posts from, across the 33 platforms. A platform can hold up to ${ACCT_MAX} handles; one of them is primary, which is the one the rest of sigsche uses where a single handle is expected.

A handle saved before v13.3 appears here as that platform's first account, marked legacy, and is written into the register properly the next time anything on that platform is saved.

Switched-off handles receive nothing. A handle tied to a brand takes that brand's posts; a handle tied to no brand takes anything that has no handle of its own.

Args:
  - platform (string, optional): Platform id, e.g. 'instagram'
  - brand (string, optional): Brand key, to see what that brand would post to
  - only ('all' | 'on' | 'primary'): Filter (default 'all')

Returns: { "total","platforms_used","limit","accounts":[{ "id","pid","platform","handle","label","brand","session","on","primary","legacy" }] }`,
      inputSchema: {
        platform: z.string().optional(),
        brand: z.string().optional(),
        only: z.enum(["all", "on", "primary"]).default("all"),
        response_format: responseFormatField,
      },
      annotations: READ,
    },
    async (params) => {
      try {
        const s = readState();
        if (params.platform !== undefined && !platformOf(params.platform))
          throw new Error(`Unknown platform '${params.platform}'. Call baatjie_sigsche_platforms for the 33 ids.`);
        let list = params.platform === undefined ? accounts(s) : accounts(s, params.platform);
        if (params.brand !== undefined) {
          const want = new Set(
            catalog()
              .platforms.flatMap((p) => targetAccounts(s, p.id, params.brand))
              .map((a) => a.id),
          );
          list = list.filter((a) => want.has(a.id));
        }
        if (params.only === "on") list = list.filter((a) => a.on);
        if (params.only === "primary") list = list.filter((a) => a.primary);
        const used = new Set(list.map((a) => a.pid)).size;
        const logins = await accountLogins().catch(() => ({} as Record<string, string>));
        const md = table(
          ["platform", "handle", "label", "brand", "primary", "on", "session", "signed in", "id"],
          list.map((a) => [
            a.pid,
            a.handle,
            a.label || "–",
            a.brand || "any",
            a.primary ? "yes" : "",
            a.on ? "on" : "off",
            a.session,
            logins[a.id] ?? "unknown",
            a.id,
          ]),
        );
        const head = `# Handles (${list.length}) on ${used} of 33 platforms${params.brand ? ` · what _${params.brand} posts to` : ""}`;
        return respond(params.response_format, `${head}\n\n${md}`, {
          total: list.length,
          platforms_used: used,
          limit: ACCT_MAX,
          accounts: list,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_account_save",
    {
      title: "Add or Change a Handle on a Platform",
      description: `Add a second, third or further handle to a platform, or change one that is already saved.

Pass platform and handle to add one. Pass id (from baatjie_sigsche_accounts) with the fields to change to edit one. The first handle on a platform becomes its primary automatically.

Args:
  - id (string, optional): Existing handle id; leave out to add a new one
  - platform (string, optional): Platform id, required when adding
  - handle (string, optional): '@name', a page link, or '@you@instance' for Mastodon
  - label (string, optional): What this account is, e.g. 'dantalan main', 'locare page'
  - brand (string, optional): Brand key this handle posts for; '' for any brand
  - session (string, optional): Which sigsche browser profile this handle signs in on (default 'main')
  - on (boolean, optional): Off means it receives nothing
  - primary (boolean, optional): Make it the platform's primary handle

Returns: { "ok": true, "account": {...} }

Note: each session name is its own browser profile, and one platform can be signed in once per profile. Two handles on the same platform can both stay signed in when they use different session names (e.g. 'main' and 'locare'). Baatjie signs in to each himself with baatjie_sigsche_login, passing the session.`,
      inputSchema: {
        id: z.string().max(80).optional(),
        platform: z.string().optional(),
        handle: z.string().max(120).optional(),
        label: z.string().max(40).optional(),
        brand: z.string().max(24).optional(),
        session: z.string().max(24).optional(),
        on: z.boolean().optional(),
        primary: z.boolean().optional(),
        response_format: responseFormatField,
      },
      annotations: WRITE,
    },
    async (params) => {
      try {
        if (!params.id && !params.platform) throw new Error("Give platform and handle to add one, or id to change one.");
        const a = saveAccount({
          ...(params.id !== undefined ? { id: params.id } : {}),
          ...(params.platform !== undefined ? { platform: params.platform } : {}),
          ...(params.handle !== undefined ? { handle: params.handle } : {}),
          ...(params.label !== undefined ? { label: params.label } : {}),
          ...(params.brand !== undefined ? { brand: params.brand } : {}),
          ...(params.session !== undefined ? { session: params.session } : {}),
          ...(params.on !== undefined ? { on: params.on } : {}),
          ...(params.primary !== undefined ? { primary: params.primary } : {}),
        });
        const n = accounts(readState(), a.pid).length;
        return respond(
          params.response_format,
          `${a.platform}: ${a.handle}${a.label ? ` · ${a.label}` : ""} · ${a.brand ? `_${a.brand}` : "any brand"} · ${a.primary ? "primary" : "secondary"} · ${a.on ? "on" : "off"} · session ${a.session}\n\n${n} of ${ACCT_MAX} handles on ${a.platform}.`,
          { ok: true, account: a, on_platform: n, limit: ACCT_MAX },
        );
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_account_remove",
    {
      title: "Remove a Handle from a Platform",
      description: `Take one handle off a platform. The platform stays switched on or off as it was, and no post is changed or unticked. If the handle was primary, the oldest remaining handle on that platform becomes primary.

Args:
  - id (string): Handle id from baatjie_sigsche_accounts

Returns: { "ok": true, "removed": { "id","pid","platform","handle" }, "left": number }`,
      inputSchema: {
        id: z.string().min(1).max(80),
        response_format: responseFormatField,
      },
      annotations: DESTRUCTIVE,
    },
    async (params) => {
      try {
        const gone = removeAccount(params.id);
        const left = accounts(readState(), gone.pid).length;
        return respond(params.response_format, `Removed ${gone.handle} from ${gone.platform}. ${left} handle${left === 1 ? "" : "s"} left there.`, {
          ok: true,
          removed: gone,
          left,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}
