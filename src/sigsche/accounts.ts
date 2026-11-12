/**
 * sigsche accounts (v13.3): one platform, many handles.
 *
 * Every handle Baatjie posts from lives in settings.acct, keyed by its own id.
 * A platform can hold up to ACCT_MAX of them; one is primary, and the primary's
 * handle is mirrored back into settings.plat[pid].h so every part of sigsche
 * written before v13.3 keeps working unchanged.
 *
 * No passwords and no tokens are kept here. A handle is a name and a target.
 * Signing in still happens in the sigsche browser, and API tokens still live in
 * data/secrets.json.
 */

import {
  SESSION_RE,
  allBrands,
  catalog,
  handleOf,
  isOn,
  mutate,
  platformOf,
  type Doc,
  type SigscheState,
} from "./model.js";

export const ACCT_MAX = 8;

export interface Account {
  id: string;
  pid: string;
  platform: string;
  handle: string;
  label: string;
  brand: string;
  session: string;
  on: boolean;
  primary: boolean;
  at: number;
  legacy: boolean;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function bag(s: SigscheState): Record<string, Doc> {
  const a = s.settings["acct"];
  return typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, Doc>) : {};
}
/** A handle, a page link, or '@you@instance'. One line, no empties. */
export function cleanHandle(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}
/**
 * The same account typed two ways: '@locare.co.za' and
 * 'https://instagram.com/locare.co.za/' are one handle, so the second one is
 * refused instead of quietly sitting there twice. '@you@instance' is left whole.
 */
function same(a: string, b: string): boolean {
  const k = (v: string): string => {
    let t = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (t.includes("/")) {
      const parts = t.split("/").filter(Boolean);
      t = parts[parts.length - 1] ?? t;
    }
    return t.replace(/^@/, "");
  };
  return k(a) === k(b);
}
function order(pid: string): number {
  const i = catalog().platforms.findIndex((p) => p.id === pid);
  return i < 0 ? 99 : i;
}

/** Every saved handle, plus any pre-v13.3 platform handle shown as that platform's first account. */
export function accounts(s: SigscheState, pid?: string): Account[] {
  const out: Account[] = [];
  for (const [id, rec] of Object.entries(bag(s))) {
    const p = str(rec["pid"]);
    const pl = platformOf(p);
    if (!pl) continue;
    out.push({
      id,
      pid: p,
      platform: pl.name,
      handle: str(rec["handle"]),
      label: str(rec["label"]),
      brand: str(rec["brand"]),
      session: str(rec["session"], "main"),
      on: rec["on"] !== false,
      primary: rec["primary"] === true,
      at: typeof rec["at"] === "number" ? rec["at"] : 0,
      legacy: false,
    });
  }
  for (const pl of catalog().platforms) {
    const h = handleOf(s, pl.id);
    if (!h || out.some((a) => a.pid === pl.id)) continue;
    out.push({
      id: `${pl.id}:0`,
      pid: pl.id,
      platform: pl.name,
      handle: h,
      label: "saved before v13.3",
      brand: "",
      session: "main",
      on: true,
      primary: true,
      at: 0,
      legacy: true,
    });
  }
  out.sort((a, b) => order(a.pid) - order(b.pid) || Number(b.primary) - Number(a.primary) || a.at - b.at);
  return pid === undefined ? out : out.filter((a) => a.pid === pid);
}

export function primaryOf(s: SigscheState, pid: string): Account | undefined {
  const list = accounts(s, pid);
  return list.find((a) => a.primary) ?? list[0];
}

/**
 * Where a post actually goes on one platform: the handles tied to that brand if
 * there are any, otherwise the handles tied to no brand. Switched-off handles
 * never receive anything.
 */
export function targetAccounts(s: SigscheState, pid: string, brand?: string): Account[] {
  const live = accounts(s, pid).filter((a) => a.on);
  if (!brand) return live;
  const mine = live.filter((a) => a.brand === brand);
  return mine.length > 0 ? mine : live.filter((a) => a.brand === "");
}

/**
 * The account a post goes out from: the one named, else the first handle that
 * takes this brand (or any unbranded one). Undefined when the platform has no
 * handle, and the caller falls back to the main session.
 */
export function chooseAccount(
  s: SigscheState,
  pid: string,
  opts: { accountId?: string | undefined; brand?: string | undefined } = {},
): Account | undefined {
  if (opts.accountId) {
    const a = accounts(s, pid).find((x) => x.id === opts.accountId);
    if (!a) throw new Error(`No handle '${opts.accountId}' on that platform. Call baatjie_sigsche_accounts for the ids.`);
    return a;
  }
  return targetAccounts(s, pid, opts.brand)[0];
}

/**
 * Keep settings.plat[pid].h pointing at the platform's primary handle. It reads
 * the saved register only, never the legacy handle derived from plat itself,
 * so removing the last handle on a platform really does empty it.
 */
function syncPlat(s: SigscheState, pid: string, saved: Record<string, Doc>): void {
  const mine = Object.values(saved)
    .filter((r) => str(r["pid"]) === pid)
    .sort((a, b) => (typeof a["at"] === "number" ? a["at"] : 0) - (typeof b["at"] === "number" ? b["at"] : 0));
  const primary = mine.find((r) => r["primary"] === true) ?? mine[0];
  const plat = { ...((s.settings["plat"] as Record<string, Doc> | undefined) ?? {}) };
  const cur: Doc = { on: isOn(s, pid), ...(plat[pid] ?? {}) };
  cur["h"] = primary ? str(primary["handle"]) : "";
  plat[pid] = cur;
  s.settings["plat"] = plat;
}
/** Write any pre-v13.3 handle into settings.acct so it is not lost on the next save. */
function keepLegacy(s: SigscheState, next: Record<string, Doc>): void {
  for (const a of accounts(s)) {
    if (!a.legacy || next[a.id]) continue;
    next[a.id] = { pid: a.pid, handle: a.handle, label: "", brand: "", session: "main", on: true, primary: true, at: Date.now() };
  }
}

export interface AccountPatch {
  id?: string | undefined;
  platform?: string | undefined;
  handle?: string | undefined;
  label?: string | undefined;
  brand?: string | undefined;
  session?: string | undefined;
  on?: boolean | undefined;
  primary?: boolean | undefined;
}

/** Add a handle to a platform, or change one that is already saved. */
export function saveAccount(patch: AccountPatch): Account {
  return mutate((s) => {
    const next = { ...bag(s) };
    keepLegacy(s, next);
    let id = patch.id ?? "";
    let rec: Doc;
    if (id) {
      if (!next[id]) throw new Error(`No handle with id '${id}'. Call baatjie_sigsche_accounts for the ids.`);
      rec = { ...next[id] };
    } else {
      const pid = patch.platform ?? "";
      const pl = platformOf(pid);
      if (!pl) throw new Error(`Unknown platform '${pid}'. Call baatjie_sigsche_platforms for the 33 ids.`);
      const handle = cleanHandle(patch.handle);
      if (!handle) throw new Error("A handle is required: '@name', a page link, or '@you@instance' for Mastodon.");
      const mine = Object.entries(next).filter(([, r]) => str(r["pid"]) === pid);
      if (mine.length >= ACCT_MAX) throw new Error(`${pl.name} already holds ${ACCT_MAX} handles, which is the limit.`);
      if (mine.some(([, r]) => same(str(r["handle"]), handle))) throw new Error(`${handle} is already saved on ${pl.name}.`);
      id = `${pid}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      rec = { pid, handle, label: "", brand: "", session: "main", on: true, primary: mine.length === 0, at: Date.now() };
    }
    if (patch.handle !== undefined && patch.id) {
      const h = cleanHandle(patch.handle);
      if (!h) throw new Error("A handle cannot be emptied. Remove the account instead.");
      const pid = str(rec["pid"]);
      if (Object.entries(next).some(([k, r]) => k !== id && str(r["pid"]) === pid && same(str(r["handle"]), h)))
        throw new Error(`${h} is already saved on that platform.`);
      rec["handle"] = h;
    }
    if (patch.label !== undefined) rec["label"] = patch.label.replace(/[\r\n\t]+/g, " ").trim().slice(0, 40);
    if (patch.brand !== undefined) {
      const b = patch.brand.trim();
      if (b && !allBrands(s).some((x) => x.key === b)) throw new Error(`Unknown brand '${b}'. Call baatjie_sigsche_brands for the keys.`);
      rec["brand"] = b;
    }
    if (patch.session !== undefined) {
      const sess = patch.session.trim().toLowerCase();
      if (!SESSION_RE.test(sess)) throw new Error("Session: 1 to 24 lower-case letters, digits or hyphens, e.g. 'dantalan' or 'locare-2'");
      rec["session"] = sess;
    }
    if (patch.on !== undefined) rec["on"] = patch.on;
    next[id] = rec;
    const pid = str(rec["pid"]);
    if (patch.primary === true) {
      for (const [k, r] of Object.entries(next)) if (str(r["pid"]) === pid) next[k] = { ...r, primary: k === id };
    } else if (!Object.values(next).some((r) => str(r["pid"]) === pid && r["primary"] === true)) {
      next[id] = { ...rec, primary: true };
    }
    s.settings["acct"] = next;
    syncPlat(s, pid, next);
    const row = accounts(s, pid).find((a) => a.id === id);
    if (!row) throw new Error("The handle was not saved");
    return row;
  });
}

/** Take a handle off a platform. The platform itself, and its posts, stay as they are. */
export function removeAccount(id: string): { id: string; pid: string; handle: string; platform: string } {
  return mutate((s) => {
    const next = { ...bag(s) };
    keepLegacy(s, next);
    const rec = next[id];
    if (!rec) throw new Error(`No handle with id '${id}'. Call baatjie_sigsche_accounts for the ids.`);
    const pid = str(rec["pid"]);
    const pl = platformOf(pid);
    const handle = str(rec["handle"]);
    const wasPrimary = rec["primary"] === true;
    delete next[id];
    if (wasPrimary) {
      const rest = Object.entries(next)
        .filter(([, r]) => str(r["pid"]) === pid)
        .sort((a, b) => (typeof a[1]["at"] === "number" ? a[1]["at"] : 0) - (typeof b[1]["at"] === "number" ? b[1]["at"] : 0));
      const first = rest[0];
      if (first) next[first[0]] = { ...first[1], primary: true };
    }
    s.settings["acct"] = next;
    syncPlat(s, pid, next);
    return { id, pid, handle, platform: pl ? pl.name : pid };
  });
}

/** How many handles sit on each platform, for the dashboard and the platform table. */
export function handleCounts(s: SigscheState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of accounts(s)) out[a.pid] = (out[a.pid] ?? 0) + 1;
  return out;
}
