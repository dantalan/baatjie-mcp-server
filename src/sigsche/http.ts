/**
 * The sigsche dashboard and its local API, served by the same process as the
 * MCP endpoint. Local only: requests must arrive on localhost.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import path from "node:path";
import { openLogin } from "./browser.js";
import { DIRECT_FIELDS } from "./direct.js";
import { loadGodsview } from "./godsview.js";
import {
  CARDS_DIR,
  COLLECTIONS,
  PUBLIC_DIR,
  catalog,
  cleanSession,
  deleteDoc,
  handleOf,
  mutate,
  platformOf,
  readState,
  saveCard,
  setDoc,
  setSecret,
  type CollectionName,
  type Doc,
} from "./model.js";
import { accountLogins, platformRows, upload } from "./service.js";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Refuse anything that is not this computer talking to itself (blocks DNS rebinding and cross-site calls). */
export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  let originOk = true;
  if (origin) {
    try {
      originOk = LOCAL_HOST.test(new URL(origin).host);
    } catch {
      originOk = false;
    }
  }
  if (!LOCAL_HOST.test(host) || !originOk) {
    res.status(403).json({ error: "sigsche answers on localhost only" });
    return;
  }
  next();
}

function isDoc(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function fail(res: Response, error: unknown, status = 400): void {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}
const ID = /^[\w.\-:]{1,80}$/;

const CSRF_COOKIE = "sigsche_csrf";
const CSRF_SHAPE = /^[0-9a-f]{64}$/;

/** The session token already in this browser's cookie, or null when there is none. */
function cookieToken(req: Request): string | null {
  const match = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie ?? "");
  const token = match?.[1];
  return token && CSRF_SHAPE.test(token) ? token : null;
}

/**
 * Every response carries this browser's session token in an HttpOnly, SameSite=Strict cookie.
 * The page reads the same value from /api/csrf and sends it back on each API write. A cross-site
 * page can neither read it (same-origin policy) nor send the cookie (SameSite=Strict).
 */
function ensureSessionCookie(req: Request, res: Response, next: NextFunction): void {
  let token = cookieToken(req);
  if (!token) {
    token = randomBytes(32).toString("hex");
    res.append("Set-Cookie", `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
  }
  res.locals["csrf"] = token;
  next();
}

/** True when the X-CSRF-Token header equals this browser's session cookie. */
function csrfMatches(req: Request): boolean {
  const cookie = cookieToken(req);
  const sent = req.headers["x-csrf-token"];
  if (!cookie || typeof sent !== "string" || sent.length !== cookie.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(cookie));
}

export function mountSigsche(app: Express): void {
  app.use(ensureSessionCookie);
  // Anti-CSRF: a cross-site HTML form can only send form or text content types, and a
  // cross-site JSON request needs a CORS preflight this server never allows. So every API
  // write must be JSON. A body-less DELETE is also preflighted, so it is allowed as-is.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const type = req.headers["content-type"];
    const jsonOk = (req.method === "DELETE" && !type) || Boolean(type && /^application\/json\b/i.test(type));
    if (!jsonOk) {
      res.status(415).json({ error: "API writes must be sent as application/json." });
      return;
    }
    if (!csrfMatches(req)) {
      res.status(403).json({ error: "Missing or wrong session token. Reload the page." });
      return;
    }
    next();
  });
  app.get("/", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
  app.get("/app.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(PUBLIC_DIR, "app.js"));
  });
  app.get("/vendor/qrcode-generator-1.4.4.min.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(PUBLIC_DIR, "vendor", "qrcode-generator-1.4.4.min.js"));
  });
  app.get("/vendor/jszip-3.10.1.min.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(PUBLIC_DIR, "vendor", "jszip-3.10.1.min.js"));
  });
  app.get("/catalog.json", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "catalog.json"));
  });

  /** This browser's session token, which the page sends back as X-CSRF-Token on every API write. */
  app.get("/api/csrf", (_req, res) => {
    res.json({ token: res.locals["csrf"] });
  });

  app.get("/api/state", (_req, res) => {
    const s = readState();
    res.json({
      version: catalog().version,
      settings: s.settings,
      edits: s.edits,
      signals: s.signals,
      leads: s.leads,
      taluna: s.taluna,
      cards_dir: CARDS_DIR,
    });
  });

  app.put("/api/settings", (req, res) => {
    if (!isDoc(req.body)) return fail(res, "Body must be an object");
    mutate((s) => {
      s.settings = req.body as Doc;
    });
    res.json({ ok: true });
  });

  app.put("/api/doc/:coll/:id", (req, res) => {
    const coll = String(req.params["coll"]);
    const id = String(req.params["id"]);
    if (!(coll in COLLECTIONS) || !ID.test(id)) return fail(res, "Unknown collection or bad id");
    if (!isDoc(req.body)) return fail(res, "Body must be an object");
    setDoc(coll as CollectionName, id, req.body);
    res.json({ ok: true });
  });
  app.delete("/api/doc/:coll/:id", (req, res) => {
    const coll = String(req.params["coll"]);
    const id = String(req.params["id"]);
    if (!(coll in COLLECTIONS) || !ID.test(id)) return fail(res, "Unknown collection or bad id");
    deleteDoc(coll as CollectionName, id);
    res.json({ ok: true });
  });

  app.post("/api/card", (req, res) => {
    try {
      const body = req.body as { name?: unknown; data?: unknown };
      if (typeof body.name !== "string" || typeof body.data !== "string") throw new Error("name and data are required");
      const b64 = body.data.replace(/^data:image\/png;base64,/, "");
      const file = saveCard(body.name, Buffer.from(b64, "base64"));
      res.json({ ok: true, file });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/platforms", async (_req, res) => {
    try {
      const { browser, rows } = await platformRows();
      res.json({ browser, rows, api_fields: DIRECT_FIELDS });
    } catch (e) {
      fail(res, e, 500);
    }
  });

  app.post("/api/login/:pid", async (req, res) => {
    try {
      const pid = String(req.params["pid"]);
      if (!platformOf(pid)) throw new Error("Unknown platform");
      const body = (isDoc(req.body) ? req.body : {}) as { session?: unknown };
      const session = cleanSession(body.session);
      const handle = handleOf(readState(), "mastodon");
      const inst = (handle.match(/^https?:\/\/([^/\s]+)/) ?? handle.match(/@[^@\s]+@([\w.-]+)/))?.[1];
      res.json({ ok: true, ...(await openLogin(pid, inst, session)) });
    } catch (e) {
      fail(res, e);
    }
  });
  /** Sign-in state for every saved handle, each read in the browser session that handle uses. */
  app.get("/api/accounts", async (_req, res) => {
    try {
      res.json({ logins: await accountLogins() });
    } catch (e) {
      fail(res, e, 500);
    }
  });
  app.post("/api/login/:pid/mark", (req, res) => {
    const pid = String(req.params["pid"]);
    if (!platformOf(pid)) return fail(res, "Unknown platform");
    const on = (req.body as { on?: unknown }).on === true;
    mutate((s) => {
      s.logins[pid] = { ...(s.logins[pid] ?? {}), marked: on, at: Date.now() };
    });
    res.json({ ok: true });
  });

  app.post("/api/secret/:pid", (req, res) => {
    const pid = String(req.params["pid"]);
    const spec = DIRECT_FIELDS[pid];
    if (!spec) return fail(res, "This platform has no token connection");
    const fields = (req.body as { fields?: unknown }).fields;
    if (fields === null) {
      setSecret(pid, null);
      res.json({ ok: true });
      return;
    }
    if (!isDoc(fields)) return fail(res, "fields must be an object or null");
    const clean: Record<string, string> = {};
    for (const f of spec) {
      const v = fields[f.key];
      if (typeof v !== "string" || v.trim() === "") return fail(res, `${f.label} is required`);
      clean[f.key] = v.trim();
    }
    setSecret(pid, clean);
    res.json({ ok: true });
  });

  app.get("/api/godsview", async (_req, res) => {
    try {
      res.json(await loadGodsview());
    } catch (e) {
      fail(res, e, 500);
    }
  });

  app.post("/api/upload", async (req, res) => {
    try {
      const b = req.body as Record<string, unknown>;
      if (typeof b["pid"] !== "string") throw new Error("pid is required");
      const result = await upload({
        pid: b["pid"],
        ...(typeof b["accountId"] === "string" ? { accountId: b["accountId"] } : {}),
        ...(typeof b["itemId"] === "string" ? { itemId: b["itemId"] } : {}),
        ...(typeof b["caption"] === "string" ? { caption: b["caption"] } : {}),
        ...(typeof b["url"] === "string" && /^https:\/\//.test(b["url"]) ? { url: b["url"] } : {}),
        ...(typeof b["cardName"] === "string" ? { cardName: b["cardName"] } : {}),
      });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });
}
