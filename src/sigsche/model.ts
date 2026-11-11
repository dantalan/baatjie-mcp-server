/**
 * sigsche domain model: the catalog (brands, platforms, sprint posts, moons)
 * and the local store that the dashboard and the MCP tools share.
 *
 * Everything lives on this computer under data/ — signals, leads, Taluna
 * entries, platform settings, saved cards and platform tokens. Nothing here
 * touches Supabase.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const PUBLIC_DIR = path.join(ROOT, "public");
export const DATA_DIR = process.env["SIGSCHE_DATA_DIR"] ?? path.join(ROOT, "data");
export const CARDS_DIR = path.join(DATA_DIR, "cards");
const STATE_FILE = path.join(DATA_DIR, "sigsche.json");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.json");

// ───────────────────────── catalog ─────────────────────────

export interface Brand {
  key: string;
  name: string;
  ref: string;
  color: string;
  role: string;
  group: boolean;
  site: string;
  set: string;
}
export interface Platform {
  id: string;
  name: string;
  group: string;
  mode: "intent" | "open" | "app";
  url: string;
}
export interface SprintPost {
  id: string;
  d: number;
  t: string;
  b: string;
  k: string;
  hook: string;
  sub: string;
  body: string;
}
export interface Catalog {
  product: string;
  site: string;
  version: string;
  brands: Brand[];
  platforms: Platform[];
  defaultOn: string[];
  sprint: SprintPost[];
  moons: Array<{ name: string; moonName: string; theme: string }>;
  layer: Array<{ eth: string; brand: string; anime: string; theme: string }>;
  stages: string[];
  tagMap: Record<string, string>;
}

let catalogCache: Catalog | null = null;
export function catalog(): Catalog {
  if (!catalogCache) {
    catalogCache = JSON.parse(
      readFileSync(path.join(PUBLIC_DIR, "catalog.json"), "utf8"),
    ) as Catalog;
  }
  return catalogCache;
}
export function brandOf(key: string, s?: SigscheState): Brand {
  const brands = allBrands(s ?? readState());
  const alias = key === "baatjietec" ? "sigsche" : key;
  const found =
    brands.find((b) => b.key === alias) ??
    brands.find((b) => b.ref.replace(/^_/, "") === alias.replace(/^_/, ""));
  const fallback = brands[0];
  if (found) return found;
  if (!fallback) throw new Error("catalog.json has no brands");
  return fallback;
}
export function platformOf(id: string): Platform | undefined {
  return catalog().platforms.find((p) => p.id === id);
}

// ───────────────────────── store ─────────────────────────

export type Doc = Record<string, unknown>;
export interface SigscheState {
  settings: Doc;
  edits: Record<string, Doc>;
  signals: Record<string, Doc>;
  leads: Record<string, Doc>;
  taluna: Record<string, Doc>;
  logins: Record<string, { detected?: boolean; marked?: boolean; at?: number }>;
  uploads: Doc[];
}
const EMPTY: SigscheState = {
  settings: {},
  edits: {},
  signals: {},
  leads: {},
  taluna: {},
  logins: {},
  uploads: [],
};
export const COLLECTIONS = {
  posts: "edits",
  signals: "signals",
  leads: "leads",
  taluna: "taluna",
} as const;
export type CollectionName = keyof typeof COLLECTIONS;

function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CARDS_DIR)) mkdirSync(CARDS_DIR, { recursive: true });
}
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  renameSync(tmp, file);
}

/** Read fresh from disk every time: the dashboard and the stdio server may be separate processes. */
export function readState(): SigscheState {
  const raw = readJson<Partial<SigscheState>>(STATE_FILE, {});
  return { ...structuredClone(EMPTY), ...raw };
}
export function mutate<T>(fn: (s: SigscheState) => T): T {
  const s = readState();
  const out = fn(s);
  writeJson(STATE_FILE, s);
  return out;
}
export function setDoc(coll: CollectionName, id: string, doc: Doc): void {
  mutate((s) => {
    s[COLLECTIONS[coll]][id] = doc;
  });
}
export function deleteDoc(coll: CollectionName, id: string): void {
  mutate((s) => {
    delete s[COLLECTIONS[coll]][id];
  });
}

/** Tokens for the direct-API platforms. Stored locally, never returned to callers. */
export type Secrets = Record<string, Record<string, string>>;
export function readSecrets(): Secrets {
  return readJson<Secrets>(SECRETS_FILE, {});
}
export function setSecret(pid: string, fields: Record<string, string> | null): void {
  const all = readSecrets();
  if (fields === null) delete all[pid];
  else all[pid] = fields;
  writeJson(SECRETS_FILE, all);
}

export function safeFileName(name: string): string {
  const clean = path.basename(name).replace(/[^\w.\-]+/g, "-");
  if (!/\.png$/i.test(clean)) throw new Error("Cards are PNG files");
  return clean;
}
export function cardPath(name: string): string {
  return path.join(CARDS_DIR, safeFileName(name));
}
export function saveCard(name: string, bytes: Buffer): string {
  ensureDirs();
  const file = cardPath(name);
  writeFileSync(file, bytes);
  return file;
}


// ───────────────────────── business register ─────────────────────────
// Records live in settings.biz so the dashboard and the tools share one copy.

export const BIZ_FIELDS = ["domain", "sector", "entity", "status", "contact", "about"] as const;
export type BizField = (typeof BIZ_FIELDS)[number];
export const BIZ_STATUS = ["Idea", "Building", "Live", "Parked"] as const;
export interface Business extends Record<BizField, string> {
  key: string;
  name: string;
  set: string;
  custom: boolean;
  open: BizField[];
}
const BIZ_KEY = /^[a-z0-9]{2,24}$/;
const BIZ_NAME = /^[\w .'&|-]{2,40}$/;
const HEX = /^#[0-9a-f]{6}$/i;

function bizBag(s: SigscheState): Record<string, Doc> {
  const b = s.settings["biz"];
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, Doc>) : {};
}
export function cleanDomain(v: unknown): string {
  const d = (typeof v === "string" ? v : "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(d) ? d : "";
}
/** The catalog brands (with any saved domain as their site) plus the businesses added in the register. */
export function allBrands(s: SigscheState): Brand[] {
  const bag = bizBag(s);
  const base = catalog().brands.map((b) => {
    const d = cleanDomain(bag[b.key]?.["domain"]);
    return d ? { ...b, site: d } : b;
  });
  const taken = new Set(base.map((b) => b.key));
  const added: Brand[] = [];
  for (const [key, rec] of Object.entries(bag)) {
    const name = typeof rec["name"] === "string" ? rec["name"] : "";
    if (rec["custom"] !== true || taken.has(key) || !BIZ_KEY.test(key) || !BIZ_NAME.test(name)) continue;
    const color = typeof rec["color"] === "string" && HEX.test(rec["color"]) ? rec["color"] : "#7DA2FF";
    const sector = typeof rec["sector"] === "string" ? rec["sector"].trim() : "";
    added.push({ key, name: `_${name}`, ref: `_${key}`, color, role: sector || name, group: true, site: cleanDomain(rec["domain"]), set: "Group" });
  }
  return base.concat(added);
}
export function businesses(s: SigscheState): Business[] {
  const bag = bizBag(s);
  const catalogSite = new Map(catalog().brands.map((b) => [b.key, b.site]));
  return allBrands(s).map((b) => {
    const rec = bag[b.key] ?? {};
    const get = (f: BizField): string => (typeof rec[f] === "string" ? (rec[f] as string).trim() : "");
    const row: Record<BizField, string> = {
      domain: get("domain") || catalogSite.get(b.key) || "",
      sector: get("sector"),
      entity: get("entity"),
      status: get("status"),
      contact: get("contact"),
      about: get("about"),
    };
    return { key: b.key, name: b.name, set: b.set, custom: rec["custom"] === true, ...row, open: BIZ_FIELDS.filter((f) => row[f] === "") };
  });
}
export function saveBusiness(
  key: string,
  patch: { [K in BizField]?: string | undefined },
  create?: { name: string; color?: string | undefined },
): Business {
  return mutate((s) => {
    const bag = { ...bizBag(s) };
    if (!allBrands(s).some((b) => b.key === key)) {
      if (!create) throw new Error(`Unknown business '${key}'. Call baatjie_sigsche_businesses for the keys, or pass name to add it.`);
      if (!BIZ_KEY.test(key)) throw new Error("A new key must be 2 to 24 lowercase letters or digits");
      if (!BIZ_NAME.test(create.name)) throw new Error("Name: 2 to 40 letters, digits, spaces or . ' & | -");
      bag[key] = { custom: true, name: create.name, color: create.color && HEX.test(create.color) ? create.color : "#7DA2FF" };
    }
    const rec: Doc = { ...(bag[key] ?? {}) };
    for (const f of BIZ_FIELDS) {
      const v = patch[f];
      if (typeof v === "string") rec[f] = f === "domain" ? cleanDomain(v) || v.trim() : v.trim();
    }
    bag[key] = rec;
    s.settings["biz"] = bag;
    const row = businesses(s).find((b) => b.key === key);
    if (!row) throw new Error("The business was not saved");
    return row;
  });
}
// ───────────────────────── items (sprint posts + signals) ─────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5,
  );
}
export function fname(parts: Array<string | number>, ext: string): string {
  const c = catalog();
  return (
    [`${c.product}-${c.version}`, ...parts]
      .map((x) => String(x).replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean)
      .join("_") + `.${ext}`
  );
}

export function sprintStart(s: SigscheState): string {
  const v = str(s.settings["start"]);
  return ISO.test(v) ? v : "2026-11-10";
}
export function isOn(s: SigscheState, pid: string): boolean {
  const plat = s.settings["plat"] as Record<string, { on?: boolean }> | undefined;
  const on = plat?.[pid]?.on;
  return typeof on === "boolean" ? on : catalog().defaultOn.includes(pid);
}
export function handleOf(s: SigscheState, pid: string): string {
  const plat = s.settings["plat"] as Record<string, { h?: string }> | undefined;
  return plat?.[pid]?.h ?? "";
}
export function activeIds(s: SigscheState): string[] {
  return catalog()
    .platforms.filter((p) => isOn(s, p.id))
    .map((p) => p.id);
}
export function linkFor(brand: Brand, src = "sigsche"): string {
  if (brand.group) return brand.site ? `https://${brand.site}` : "";
  return `https://locare.co.za/demo?ref=${encodeURIComponent(brand.ref)}&src=${src}`;
}

export interface Item {
  id: string;
  custom: boolean;
  date: string;
  time: string;
  brand: Brand;
  kind: string;
  hook: string;
  body: string;
  caption: string;
  link: string;
  platforms: string[];
  done: Record<string, number>;
  posted: boolean;
  card_file: string;
}
function firstLine(text: string): string {
  const l = (text.split(/\n/)[0] ?? "").trim();
  return l.length > 64 ? `${l.slice(0, 61).replace(/\s+\S*$/, "")}…` : l;
}
function build(
  id: string,
  custom: boolean,
  date: string,
  time: string,
  brand: Brand,
  kind: string,
  hook: string,
  body: string,
  tags: string,
  cta: string,
  platforms: string[],
  rec: Doc,
): Item {
  const link = linkFor(brand);
  const text = body.replace(/\{link\}/g, link);
  let caption: string;
  if (custom) {
    const hasLink = /\{link\}/.test(body);
    const c =
      hasLink || cta === "none"
        ? ""
        : brand.group
          ? link
          : cta === "partner"
            ? `Partner 26%: ${linkFor(brand, "partner")}`
            : `Demo: ${link}`;
    caption = [text, c, tags].filter(Boolean).join("\n\n");
  } else {
    caption = `${text}\n\n${tags}`;
  }
  const done = (rec["done"] as Record<string, number> | undefined) ?? {};
  return {
    id,
    custom,
    date,
    time,
    brand,
    kind,
    hook,
    body,
    caption,
    link,
    platforms,
    done,
    posted: rec["posted"] === true || Object.keys(done).length > 0,
    card_file: fname(
      ["card", brand.key === "node1" ? "nodeone" : brand.ref.replace(/^_/, ""), date, time.replace(":", ""), "square"],
      "png",
    ),
  };
}
export function items(s: SigscheState): Item[] {
  const c = catalog();
  const start = sprintStart(s);
  const active = activeIds(s);
  const out: Item[] = [];
  for (const p of c.sprint) {
    const e = s.edits[p.id] ?? {};
    const brand = brandOf(p.b, s);
    const extra = c.tagMap[p.b];
    const tags =
      "#locare #proptech #southafrica" + (extra && extra !== "#locare" ? ` ${extra}` : "");
    out.push(
      build(
        p.id,
        false,
        addDays(start, p.d),
        p.t,
        brand,
        p.k,
        str(e["hook"], p.hook),
        str(e["body"], p.body),
        tags,
        "demo",
        active,
        e,
      ),
    );
  }
  const custom = Object.values(s.signals)
    .map((g) => {
      const body = str(g["body"]);
      const plats = Array.isArray(g["plats"])
        ? (g["plats"] as unknown[]).filter(
            (x): x is string => typeof x === "string" && !!platformOf(x),
          )
        : [];
      return build(
        str(g["id"]),
        true,
        str(g["date"]),
        str(g["time"], "08:17"),
        brandOf(str(g["brand"], "locare"), s),
        "custom",
        str(g["hook"]) || firstLine(body) || "Signal",
        body,
        str(g["tags"]),
        str(g["cta"], "demo"),
        plats,
        g,
      );
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return out.concat(custom);
}
export function findItem(s: SigscheState, id: string): Item | undefined {
  return items(s).find((i) => i.id === id);
}

/** Tick or untick platforms on a sprint post or a signal. Returns the updated item. */
export function markPosted(id: string, pids: string[], posted: boolean): Item {
  return mutate((s) => {
    const isSprint = catalog().sprint.some((p) => p.id === id);
    const bag = isSprint ? s.edits : s.signals;
    if (!isSprint && !bag[id]) throw new Error(`No signal with id '${id}'`);
    const rec: Doc = { ...(bag[id] ?? {}) };
    const done = { ...((rec["done"] as Record<string, number> | undefined) ?? {}) };
    if (pids.length === 0) {
      rec["posted"] = posted;
      rec["postedAt"] = posted ? Date.now() : null;
      if (!posted) for (const k of Object.keys(done)) delete done[k];
    } else {
      for (const pid of pids) {
        if (!platformOf(pid)) throw new Error(`Unknown platform '${pid}'`);
        if (posted) done[pid] = Date.now();
        else delete done[pid];
      }
      if (posted && !rec["postedAt"]) rec["postedAt"] = Date.now();
    }
    rec["done"] = done;
    bag[id] = rec;
    const item = findItem(s, id);
    if (!item) throw new Error(`No post or signal with id '${id}'`);
    return item;
  });
}

// ───────────────────────── Taluna ─────────────────────────

export interface TalunaDay {
  iso: string;
  year: number;
  god: boolean;
  day_of_year: number;
  moon?: number;
  day?: number;
  name?: string;
  moon_name?: string;
  theme?: string;
  layer?: { eth: string; brand: string; anime: string; theme: string };
}
export function talunaDay(iso: string): TalunaDay {
  if (!ISO.test(iso)) throw new Error("Date must be YYYY-MM-DD");
  const Y = Number(iso.slice(0, 4));
  const year = Number(iso.slice(5, 7)) >= 3 ? Y : Y - 1;
  const td = dayDiff(`${year}-03-01`, iso) + 1;
  if (td > 364) return { iso, year, god: true, day_of_year: td };
  const m = Math.floor((td - 1) / 28);
  const moon = catalog().moons[m];
  const layer = catalog().layer[m];
  return {
    iso,
    year,
    god: false,
    day_of_year: td,
    moon: m + 1,
    day: ((td - 1) % 28) + 1,
    ...(moon ? { name: moon.name, moon_name: moon.moonName, theme: moon.theme } : {}),
    ...(layer ? { layer } : {}),
  };
}
