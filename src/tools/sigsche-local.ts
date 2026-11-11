/**
 * sigsche tools: everything the sigsche.co.za dashboard holds on this
 * computer. The business register and its brands, 33 platforms, the sprint and composed signals with
 * per-platform posted ticks, the agency pipeline, the Taluna calendar, and
 * sign-in and upload through the sigsche browser.
 *
 * These read and write the local store under data/. The Supabase-backed
 * sigscheCore queue keeps its own tools (baatjie_signal_queue and friends).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openLogin } from "../sigsche/browser.js";
import {
  BIZ_STATUS,
  activeIds,
  allBrands,
  brandOf,
  businesses,
  catalog,
  findItem,
  handleOf,
  items,
  markPosted,
  mutate,
  platformOf,
  readState,
  saveBusiness,
  sprintStart,
  talunaDay,
  todayISO,
  type Doc,
} from "../sigsche/model.js";
import { loadGodsview } from "../sigsche/godsview.js";
import { platformRows, upload } from "../sigsche/service.js";
import { respond, toErrorResponse } from "../services/format.js";
import { responseFormatField } from "../schemas.js";

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const timeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const OUTSIDE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function table(head: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return "_None._";
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}
function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function registerSigscheLocalTools(server: McpServer): void {
  server.registerTool(
    "baatjie_sigsche_overview",
    {
      title: "sigsche Overview",
      description: `One call for the whole sigsche picture: sprint progress, composed signals, platforms switched on and signed in, the agency pipeline by stage, and today's Taluna date.

Start here for "where is sigsche?" or before composing, uploading or reviewing the sprint.

Returns:
  { "today", "sprint": { "start","day","posted","total" }, "signals": { "total","posted" },
    "platforms": { "on","signed_in","api_ready","browser_running" },
    "leads": { "total","by_stage": { "<stage>": n }, "demos","pilots","signed" },
    "taluna": { "moon","day","name","god" }, "dashboard": "http://localhost:<port>/" }`,
      inputSchema: { response_format: responseFormatField },
      annotations: READ,
    },
    async (params) => {
      try {
        const s = readState();
        const all = items(s);
        const sprint = all.filter((i) => !i.custom);
        const custom = all.filter((i) => i.custom);
        const { browser, rows } = await platformRows();
        const today = todayISO();
        const start = sprintStart(s);
        const day = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5) + 1;
        const byStage: Record<string, number> = {};
        const leads = Object.values(s.leads);
        for (const l of leads) {
          const st = typeof l["stage"] === "string" ? l["stage"] : "New";
          byStage[st] = (byStage[st] ?? 0) + 1;
        }
        const t = talunaDay(today);
        const payload = {
          today,
          sprint: { start, day, posted: sprint.filter((i) => i.posted).length, total: sprint.length },
          signals: { total: custom.length, posted: custom.filter((i) => i.posted).length },
          platforms: {
            on: rows.filter((r) => r.on).length,
            signed_in: rows.filter((r) => r.login === "signed_in" || r.login === "marked").length,
            api_ready: rows.filter((r) => r.api_ready).length,
            browser_running: browser,
          },
          leads: {
            total: leads.length,
            by_stage: byStage,
            demos: leads.filter((l) => l["demoAt"]).length,
            pilots: leads.filter((l) => l["pilotAt"]).length,
            signed: byStage["Signed"] ?? 0,
          },
          taluna: t.god ? { god: true } : { moon: t.moon, day: t.day, name: t.name, god: false },
          dashboard: `http://localhost:${process.env["PORT"] ?? "8641"}/`,
        };
        const md = [
          `# sigsche · ${today}`,
          `**Sprint** day ${day} of 8 (from ${start}): ${payload.sprint.posted}/${payload.sprint.total} posted`,
          `**Signals** ${payload.signals.posted}/${payload.signals.total} posted`,
          `**Platforms** ${payload.platforms.on}/33 on · ${payload.platforms.signed_in} signed in · ${payload.platforms.api_ready} API-ready · browser ${browser ? "running" : "closed"}`,
          `**Leads** ${leads.length} · demos ${payload.leads.demos} · pilots ${payload.leads.pilots} · signed ${payload.leads.signed}`,
          `**Taluna** ${t.god ? "Day with God" : `Moon ${t.moon} ${t.name}, day ${t.day}`}`,
          `Dashboard: ${payload.dashboard}`,
        ].join("\n");
        return respond(params.response_format, md, payload);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_brands",
    {
      title: "List sigsche Brands",
      description: `The brands sigsche can post as: the ecosystem brands, the white-labels and the group businesses, including any added in the register. Use the 'key' as brand in baatjie_sigsche_compose.

Returns: { "brands": [{ "key","name","role","set","site","signals" }] }`,
      inputSchema: { response_format: responseFormatField },
      annotations: READ,
    },
    async (params) => {
      try {
        const s = readState();
        const all = items(s);
        const brands = allBrands(s).map((b) => ({
          key: b.key,
          name: b.name,
          role: b.role,
          set: b.set,
          site: b.site,
          signals: all.filter((i) => i.brand.key === b.key).length,
        }));
        const md = table(["key", "name", "role", "set", "posts"], brands.map((b) => [b.key, b.name, b.role, b.set, b.signals]));
        return respond(params.response_format, `# sigsche brands (${brands.length})\n\n${md}`, { brands });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_businesses",
    {
      title: "sigsche Business Register",
      description: `The business register: every business sigsche posts for, with its record (domain, what it does, owner entity, status, public contact, description) and the fields still open.

A field that is empty is listed under 'open'. Never fill an open field with a guess; ask Baatjie.

Args:
  - only ('all' | 'open' | 'complete'): Filter (default 'all')

Returns: { "total", "complete", "businesses": [{ "key","name","set","custom","domain","sector","entity","status","contact","about","open": [] }] }`,
      inputSchema: { only: z.enum(["all", "open", "complete"]).default("all"), response_format: responseFormatField },
      annotations: READ,
    },
    async (params) => {
      try {
        const all = businesses(readState());
        const rows = all.filter((b) => (params.only === "open" ? b.open.length > 0 : params.only === "complete" ? b.open.length === 0 : true));
        const complete = all.filter((b) => b.open.length === 0).length;
        const md = table(
          ["key", "name", "set", "status", "domain", "open"],
          rows.map((b) => [b.key, b.name, b.set, b.status || "–", b.domain || "–", b.open.length ? b.open.join(", ") : "complete"]),
        );
        return respond(params.response_format, `# sigsche businesses (${all.length}) · ${complete} complete\n\n${md}`, {
          total: all.length,
          complete,
          businesses: rows,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_business_save",
    {
      title: "Save a Business Record",
      description: `Fill in or change a business record in the register, or add a new business. Only the fields passed are changed. Pass an empty string to mark a field open again.

To add a business, pass a new key together with name (and optionally color). It joins the Group set and can be composed for straight away.

Args:
  - key (string): Business key from baatjie_sigsche_businesses; a new key (2 to 24 lowercase letters or digits) adds a business
  - name (string, optional): Display name, required only when adding
  - color (string, optional): Brand colour as #RRGGBB, only when adding
  - domain, sector, entity, contact, about (string, optional): Record fields
  - status ('Idea' | 'Building' | 'Live' | 'Parked' | '', optional)

Returns: { "ok": true, "business": { ...record, "open": [] } }`,
      inputSchema: {
        key: z.string().regex(/^[a-z0-9]{2,24}$/, "2 to 24 lowercase letters or digits"),
        name: z.string().max(40).optional(),
        color: z.string().optional(),
        domain: z.string().max(120).optional(),
        sector: z.string().max(80).optional(),
        entity: z.string().max(80).optional(),
        status: z.enum(["", ...BIZ_STATUS]).optional(),
        contact: z.string().max(80).optional(),
        about: z.string().max(200).optional(),
        response_format: responseFormatField,
      },
      annotations: WRITE,
    },
    async (params) => {
      try {
        const business = saveBusiness(
          params.key,
          { domain: params.domain, sector: params.sector, entity: params.entity, status: params.status, contact: params.contact, about: params.about },
          params.name ? { name: params.name.trim().replace(/^_+/, ""), color: params.color } : undefined,
        );
        const left = business.open.length ? `Still open: ${business.open.join(", ")}.` : "Record complete.";
        return respond(params.response_format, `Saved **${business.name}**. ${left}`, { ok: true, business });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_godsview",
    {
      title: "godsview: the property, live",
      description: `One live read of the property from tanOS: every room, the tenant on its active lease, what has been paid since the last 28th, notices sent and open maintenance tickets, with totals.

Read-only. It reports the position; it never sends a notice or changes a record. Only tenant names are read, no ID numbers, phones or emails.

Returns:
  { "today","property","cycle_start","days_into_cycle","days_to_rent_day",
    "rooms": [{ "room_name","state": "paid"|"part"|"behind"|"new"|"nolease","tenant","due","paid","last_payment","notices","open_tickets" }],
    "totals": { "rooms","occupied","paid","part","behind","expected","received","notices","open_tickets" } }`,
      inputSchema: { response_format: responseFormatField },
      annotations: READ,
    },
    async (params) => {
      try {
        const g = await loadGodsview();
        const t = g.totals;
        const md = [
          `# godsview · ${g.property || "no property in tanOS yet"} · ${g.today}`,
          `**Rooms** ${t.occupied}/${t.rooms} with a lease · **Paid** ${t.paid} · part ${t.part} · **behind** ${t.behind}`,
          `**Money since ${g.cycle_start}** R${t.received} of R${t.expected} · ${g.days_to_rent_day} day(s) to the next 28th`,
          `**Notices sent** ${t.notices} · **Open tickets** ${t.open_tickets}`,
          "",
          table(
            ["room", "state", "tenant", "paid", "due", "last paid", "notices", "tickets"],
            g.rooms.map((r) => [r.room_name, r.state, r.tenant || "–", r.paid, r.due, r.last_payment || "–", r.notices, r.open_tickets]),
          ),
        ].join("\n");
        return respond(params.response_format, md, g as unknown as Record<string, unknown>);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_platforms",
    {
      title: "sigsche Platform Dashboard",
      description: `All 33 platforms on one table: switched on or off, saved handle, sign-in state in the sigsche browser, whether a direct API token is saved, and how many posts have been ticked there.

login is 'signed_in' / 'signed_out' where a session cookie proves it, 'marked' where Baatjie confirmed it himself, 'unknown' otherwise, 'no_web' for phone-only apps.

Args:
  - only ('all' | 'on' | 'signed_in'): Filter (default 'all')

Returns: { "browser_running", "platforms": [{ "id","name","group","mode","on","handle","login","api","api_ready","posted" }] }`,
      inputSchema: {
        only: z.enum(["all", "on", "signed_in"]).default("all"),
        response_format: responseFormatField,
      },
      annotations: READ,
    },
    async (params) => {
      try {
        const { browser, rows } = await platformRows();
        const list = rows.filter((r) =>
          params.only === "on" ? r.on : params.only === "signed_in" ? r.login === "signed_in" || r.login === "marked" : true,
        );
        const md = table(
          ["id", "name", "on", "login", "api", "posted", "handle"],
          list.map((r) => [r.id, r.name, r.on ? "on" : "off", r.login, r.api ? (r.api_ready ? "ready" : "no token") : "–", r.posted, r.handle]),
        );
        return respond(params.response_format, `# Platforms (${list.length}) · browser ${browser ? "running" : "closed"}\n\n${md}`, {
          browser_running: browser,
          platforms: list,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_platform_set",
    {
      title: "Switch a Platform On/Off or Save its Handle",
      description: `Switch a platform on or off (on = it joins every sprint post and the composer's default set) and/or save the handle or page link.

Args:
  - platform (string): Platform id from baatjie_sigsche_platforms, e.g. 'instagram', 'twitter', 'linkedin_co'
  - on (boolean, optional)
  - handle (string, optional): '@handle' or a page link; for mastodon use '@you@instance'`,
      inputSchema: {
        platform: z.string().min(1),
        on: z.boolean().optional(),
        handle: z.string().max(120).optional(),
        response_format: responseFormatField,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (params) => {
      try {
        const pl = platformOf(params.platform);
        if (!pl) throw new Error(`Unknown platform '${params.platform}'. Call baatjie_sigsche_platforms for the ids.`);
        const now = mutate((s) => {
          const plat = { ...((s.settings["plat"] as Record<string, Doc> | undefined) ?? {}) };
          const cur: Doc = { on: activeIds(s).includes(pl.id), h: handleOf(s, pl.id), ...(plat[pl.id] ?? {}) };
          if (params.on !== undefined) cur["on"] = params.on;
          if (params.handle !== undefined) cur["h"] = params.handle.trim();
          plat[pl.id] = cur;
          s.settings["plat"] = plat;
          return cur;
        });
        return respond(params.response_format, `${pl.name}: ${now["on"] ? "on" : "off"}${now["h"] ? ` · ${String(now["h"])}` : ""}`, {
          ok: true,
          platform: pl.id,
          ...now,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_signals",
    {
      title: "List sigsche Posts and Signals",
      description: `The sprint's 25 posts and every composed signal, with caption, target platforms and which platforms are ticked as posted.

Args:
  - from_date / to_date (YYYY-MM-DD, optional)
  - brand (string, optional): Brand key
  - status ('all' | 'unposted' | 'posted'): default 'all'
  - kind ('all' | 'sprint' | 'signal'): default 'all'
  - include_captions (boolean): Include full captions (default false; headlines only)

Returns: { "total", "items": [{ "id","date","time","brand","kind","hook","platforms","posted_on","posted","card_file","caption"? }] }

Examples:
  - "What goes out today?" -> from_date = to_date = today
  - "What is still unposted?" -> status='unposted'`,
      inputSchema: {
        from_date: dateField.optional(),
        to_date: dateField.optional(),
        brand: z.string().optional(),
        status: z.enum(["all", "unposted", "posted"]).default("all"),
        kind: z.enum(["all", "sprint", "signal"]).default("all"),
        include_captions: z.boolean().default(false),
        response_format: responseFormatField,
      },
      annotations: READ,
    },
    async (params) => {
      try {
        const brandKey = params.brand ? brandOf(params.brand).key : null;
        const list = items(readState())
          .filter((i) => (params.from_date ? i.date >= params.from_date : true))
          .filter((i) => (params.to_date ? i.date <= params.to_date : true))
          .filter((i) => (brandKey ? i.brand.key === brandKey : true))
          .filter((i) => (params.status === "all" ? true : params.status === "posted" ? i.posted : !i.posted))
          .filter((i) => (params.kind === "all" ? true : params.kind === "signal" ? i.custom : !i.custom))
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        const out = list.map((i) => ({
          id: i.id,
          date: i.date,
          time: i.time,
          brand: i.brand.name,
          kind: i.custom ? "signal" : i.kind,
          hook: i.hook,
          platforms: i.platforms,
          posted_on: Object.keys(i.done),
          posted: i.posted,
          card_file: i.card_file,
          ...(params.include_captions ? { caption: i.caption } : {}),
        }));
        const md = table(
          ["id", "date", "time", "brand", "headline", "posted"],
          out.map((i) => [i.id, i.date, i.time, i.brand, i.hook, i.posted ? `${i.posted_on.length}/${i.platforms.length}` : "no"]),
        );
        return respond(params.response_format, `# Posts and signals (${out.length})\n\n${md}`, { total: out.length, items: out });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_compose",
    {
      title: "Compose a Signal",
      description: `Queue a new signal in sigsche: one brand, one message, any of the 33 platforms. It appears in the dashboard's Queue under My signals, with its card.

The demo link (or the brand's own site) and the tags are appended to the caption automatically; write only the message.

Args:
  - brand (string): Brand key from baatjie_sigsche_brands, e.g. 'locare', 'sigsche', 'mastandie'
  - body (string): The message
  - platforms (string[], optional): Platform ids; omit to use the platforms currently switched on
  - date (YYYY-MM-DD, optional): default today (SAST)
  - time (HH:MM, optional): default 08:17. The 13 angel times run 05:55 to 21:21
  - hook (string, optional): Card headline; default is the first line of the message
  - cta ('demo' | 'partner' | 'none'): Link to append (default 'demo')
  - tags (string, optional): Hashtags; default is the brand's set

Returns: { "ok": true, "id", "caption", "platforms", "card_file" }`,
      inputSchema: {
        brand: z.string().min(1),
        body: z.string().min(1).max(5000),
        platforms: z.array(z.string()).optional(),
        date: dateField.optional(),
        time: timeField.optional(),
        hook: z.string().max(70).optional(),
        cta: z.enum(["demo", "partner", "none"]).default("demo"),
        tags: z.string().max(200).optional(),
        response_format: responseFormatField,
      },
      annotations: WRITE,
    },
    async (params) => {
      try {
        const brand = brandOf(params.brand);
        if (brand.key !== params.brand && brand.ref.replace(/^_/, "") !== params.brand.replace(/^_/, "")) {
          throw new Error(`Unknown brand '${params.brand}'. Call baatjie_sigsche_brands for the keys.`);
        }
        const id = newId("S");
        mutate((s) => {
          const plats = params.platforms ?? activeIds(s);
          for (const p of plats) if (!platformOf(p)) throw new Error(`Unknown platform '${p}'`);
          if (plats.length === 0) throw new Error("No platforms: pass platforms or switch some on.");
          const ref = brand.ref.replace(/^_/, "");
          const tags =
            params.tags ?? (brand.group ? `#${ref}` : `#locare #proptech #southafrica${brand.key === "locare" ? "" : ` #${ref}`}`);
          s.signals[id] = {
            id,
            brand: brand.key,
            plats,
            hook: params.hook ?? "",
            body: params.body.trim(),
            cta: params.cta,
            tags,
            media: "image",
            date: params.date ?? todayISO(),
            time: params.time ?? "08:17",
            created: Date.now(),
            done: {},
            by: "mcp",
          };
        });
        const item = findItem(readState(), id);
        if (!item) throw new Error("The signal was not saved");
        return respond(params.response_format, `Queued **${item.brand.name}** for ${item.date} ${item.time} on ${item.platforms.length} platform(s). id: ${id}\n\n${item.caption}`, {
          ok: true,
          id,
          caption: item.caption,
          platforms: item.platforms,
          card_file: item.card_file,
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_mark_posted",
    {
      title: "Tick a Post as Posted",
      description: `Record that a sprint post or signal is live. Pass platforms to tick those platforms; pass none to mark the whole post. posted=false unticks.

Args:
  - id (string): Post or signal id from baatjie_sigsche_signals (e.g. 'd1-0817' or 'S…')
  - platforms (string[], optional)
  - posted (boolean): default true`,
      inputSchema: {
        id: z.string().min(1),
        platforms: z.array(z.string()).default([]),
        posted: z.boolean().default(true),
        response_format: responseFormatField,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (params) => {
      try {
        const item = markPosted(params.id, params.platforms, params.posted);
        return respond(params.response_format, `${item.id}: posted on ${Object.keys(item.done).join(", ") || (item.posted ? "marked posted" : "nothing")}`, {
          ok: true,
          id: item.id,
          posted: item.posted,
          posted_on: Object.keys(item.done),
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_leads",
    {
      title: "List the Agency Pipeline",
      description: `The outreach pipeline from the sigsche dashboard: agencies by stage (New, Messaged, Replied, Demo booked, Pilot, Signed, Lost).

Phone and email are withheld unless include_pii is true.

Args:
  - stage (string, optional), city (string, optional)
  - include_pii (boolean): default false

Returns: { "total", "leads": [{ "id","agency","contact","city","units","plan","stage","notes" }] }`,
      inputSchema: {
        stage: z.string().optional(),
        city: z.string().optional(),
        include_pii: z.boolean().default(false),
        response_format: responseFormatField,
      },
      annotations: READ,
    },
    async (params) => {
      try {
        const leads = Object.values(readState().leads)
          .filter((l) => (params.stage ? l["stage"] === params.stage : true))
          .filter((l) => (params.city ? l["city"] === params.city : true))
          .map((l) => {
            const { phone, email, ...rest } = l;
            return params.include_pii ? l : { ...rest, has_phone: !!phone, has_email: !!email };
          });
        const md = table(
          ["id", "agency", "city", "units", "plan", "stage"],
          leads.map((l) => [String(l["id"]), String(l["agency"] ?? ""), String(l["city"] ?? ""), String(l["units"] ?? ""), String(l["plan"] ?? ""), String(l["stage"] ?? "")]),
        );
        return respond(params.response_format, `# Agency pipeline (${leads.length})\n\n${md}`, { total: leads.length, leads });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_lead_save",
    {
      title: "Add or Update an Agency Lead",
      description: `Add an agency to the pipeline, or update one by id (stage, notes, plan, contact details). Moving a lead forward stamps the stage dates the scoreboard counts (messaged, demo booked, pilot, signed).

Args:
  - id (string, optional): Omit to add a new lead
  - agency (string): Required when adding
  - contact, phone, email, city, units, plan, notes (string, optional)
  - stage (string, optional): New | Messaged | Replied | Demo booked | Pilot | Signed | Lost`,
      inputSchema: {
        id: z.string().optional(),
        agency: z.string().max(80).optional(),
        contact: z.string().max(60).optional(),
        phone: z.string().max(20).optional(),
        email: z.string().max(80).optional(),
        city: z.string().max(40).optional(),
        units: z.string().max(20).optional(),
        plan: z.enum(["Starter", "Growth", "Scale", "Custom"]).optional(),
        stage: z.enum(["New", "Messaged", "Replied", "Demo booked", "Pilot", "Signed", "Lost"]).optional(),
        notes: z.string().max(200).optional(),
        response_format: responseFormatField,
      },
      annotations: WRITE,
    },
    async (params) => {
      try {
        const stamps: Record<string, string> = { Messaged: "messagedAt", Replied: "repliedAt", "Demo booked": "demoAt", Pilot: "pilotAt", Signed: "signedAt", Lost: "lostAt" };
        const order = catalog().stages;
        const saved = mutate((s) => {
          let lead: Doc;
          if (params.id) {
            const found = s.leads[params.id];
            if (!found) throw new Error(`No lead with id '${params.id}'`);
            lead = { ...found };
          } else {
            if (!params.agency) throw new Error("agency is required for a new lead");
            lead = { id: newId("L"), stage: "New", plan: "Growth", created: Date.now() };
          }
          for (const k of ["agency", "contact", "phone", "email", "city", "units", "plan", "notes"] as const) {
            const v = params[k];
            if (v !== undefined) lead[k] = v;
          }
          if (params.stage) {
            lead["stage"] = params.stage;
            if (params.stage === "Lost") lead["lostAt"] ??= Date.now();
            else {
              for (const st of order.slice(1, order.indexOf(params.stage) + 1)) {
                const key = stamps[st];
                if (key && !lead[key]) lead[key] = Date.now();
              }
            }
          }
          lead["updated"] = Date.now();
          s.leads[String(lead["id"])] = lead;
          return lead;
        });
        return respond(params.response_format, `${String(saved["agency"])}: ${String(saved["stage"])} (id ${String(saved["id"])})`, { ok: true, lead: { ...saved, phone: undefined, email: undefined } });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_taluna",
    {
      title: "Taluna Calendar Day",
      description: `The Taluna Calendar – Maktoof position of a date (13 moons of 28 days from 1 March, plus the Day with God), the ecosystem layer for that moon, and the saved devotional entry if one exists.

Args:
  - date (YYYY-MM-DD, optional): default today (SAST)

Returns: { "iso","god","moon","day","name","moon_name","theme","layer", "entry": { "title","opening","reflection","practice","signal","hashtags" } | null }`,
      inputSchema: { date: dateField.optional(), response_format: responseFormatField },
      annotations: READ,
    },
    async (params) => {
      try {
        const iso = params.date ?? todayISO();
        const t = talunaDay(iso);
        const entry = readState().taluna[iso] ?? null;
        const head = t.god ? `Day with God (day ${t.day_of_year})` : `Moon ${t.moon} ${t.name} · ${t.moon_name} · day ${t.day} of 28`;
        const md = `# ${iso} · ${head}\n${t.theme ?? ""}\n\n${entry ? `**${String(entry["title"] ?? "")}**\n\n${String(entry["opening"] ?? "")}\n\n${String(entry["reflection"] ?? "")}\n\nPractice: ${String(entry["practice"] ?? "")}\n\n${String(entry["signal"] ?? "")}` : "_No entry written for this day._"}`;
        return respond(params.response_format, md, { ...t, entry });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_taluna_write",
    {
      title: "Write a Taluna Devotional Entry",
      description: `Save the devotional for a Taluna day. It shows in the dashboard's Taluna tab and on that day's devotional card. Write in dantalan's voice: terse, declarative, present. Original words only; never quote a book.

Args:
  - date (YYYY-MM-DD, optional): default today
  - title (3-5 words), opening (one sentence), reflection (2-3 short paragraphs), practice (starts with a verb), signal (8 words max), hashtags (optional)`,
      inputSchema: {
        date: dateField.optional(),
        title: z.string().min(1).max(60),
        opening: z.string().min(1).max(400),
        reflection: z.string().max(3000).default(""),
        practice: z.string().max(300).default(""),
        signal: z.string().max(80).default(""),
        hashtags: z.string().max(300).optional(),
        response_format: responseFormatField,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (params) => {
      try {
        const iso = params.date ?? todayISO();
        talunaDay(iso);
        mutate((s) => {
          const prev = s.taluna[iso] ?? {};
          s.taluna[iso] = {
            title: params.title,
            opening: params.opening,
            reflection: params.reflection,
            practice: params.practice,
            signal: params.signal,
            hashtags: params.hashtags ?? "#dantalan #ONE #yearofmiracles #86417 #talunaCalendar",
            iso,
            generated: prev["generated"] ?? Date.now(),
            source: "mcp",
            edited: Date.now(),
          };
        });
        return respond(params.response_format, `Saved the Taluna entry for ${iso}: ${params.title}`, { ok: true, iso });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_login",
    {
      title: "Open a Platform Sign-in",
      description: `Open a platform's sign-in page in the sigsche browser (a Chrome window with its own saved profile on this computer). Baatjie signs in himself; the session is kept for later uploads. This never types credentials.

Args:
  - platform (string): Platform id, e.g. 'instagram', 'linkedin', 'tiktok'

After he has signed in, baatjie_sigsche_platforms shows the state.`,
      inputSchema: { platform: z.string().min(1), response_format: responseFormatField },
      annotations: OUTSIDE,
    },
    async (params) => {
      try {
        const pl = platformOf(params.platform);
        if (!pl) throw new Error(`Unknown platform '${params.platform}'`);
        const handle = handleOf(readState(), "mastodon");
        const inst = (handle.match(/^https?:\/\/([^/\s]+)/) ?? handle.match(/@[^@\s]+@([\w.-]+)/))?.[1];
        const { url } = await openLogin(pl.id, inst);
        return respond(params.response_format, `Opened ${pl.name} sign-in in the sigsche browser: ${url}`, { ok: true, platform: pl.id, url });
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );

  server.registerTool(
    "baatjie_sigsche_upload",
    {
      title: "Upload a Post to a Platform",
      description: `Send a sprint post or signal to one platform.

Where an API token is saved (Bluesky, Mastodon, Telegram, Discord) it is posted directly with its card and ticked. Everywhere else the post is prepared in the signed-in sigsche browser — post box opened, caption filled, card attached where the page allows — and Baatjie presses Post himself. The result says exactly what was done and what is left.

The card image is used when the dashboard has saved it (it does so when Upload is pressed there); otherwise the post goes out as text.

Args:
  - id (string): Post or signal id from baatjie_sigsche_signals
  - platform (string): Platform id

Returns: { "platform","method": "api" | "browser" | "clipboard","posted","card_attached","caption_filled","where"?,"next" }`,
      inputSchema: { id: z.string().min(1), platform: z.string().min(1), response_format: responseFormatField },
      annotations: OUTSIDE,
    },
    async (params) => {
      try {
        const r = await upload({ pid: params.platform, itemId: params.id });
        return respond(params.response_format, `**${r.platform}** via ${r.method}: ${r.posted ? `posted${r.where ? ` → ${r.where}` : ""}` : "prepared"}. ${r.next}`, r);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  );
}
