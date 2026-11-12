/**
 * The sigsche browser: a Chrome window with its own profile, kept on this
 * computer, where Baatjie signs in to each platform once. sigsche then opens
 * the platform's post box in that signed-in window, attaches the card and
 * fills the caption. The final Post click stays with the human.
 *
 * Chrome is started as an ordinary browser with a local debugging port and
 * driven over the DevTools protocol, so sign-in pages treat it as a normal
 * browser. No extra packages are needed (Node 22+ has WebSocket built in).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, mutate, readState } from "./model.js";

/**
 * v13.4: one browser window per session. The session "main" keeps the original
 * profile and port; every other session gets its own profile folder and its own
 * debugging port, so two handles on one platform can each stay signed in.
 */
const BASE_PORT = Number.parseInt(process.env["SIGSCHE_CHROME_PORT"] ?? "9333", 10);
export const MAIN = "main";
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

function readPorts(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}
/** The port a session's browser listens on, if it has one yet. */
export function peekPort(session: string): number | undefined {
  if (session === MAIN) return BASE_PORT;
  return readPorts()[session];
}
/** The port for a session, given once and kept, so its window always answers on the same address. */
export function portFor(session: string): number {
  if (session === MAIN) return BASE_PORT;
  const map = readPorts();
  if (typeof map[session] === "number") return map[session];
  const used = new Set<number>([BASE_PORT, ...Object.values(map)]);
  let p = BASE_PORT + 1;
  while (used.has(p)) p++;
  if (p > BASE_PORT + 60) throw new Error("No free debugging port is left for another browser session.");
  map[session] = p;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 1), "utf8");
  return p;
}
/** Each session keeps its own sign-ins in its own folder. "main" stays where it always was. */
export function profileDir(session: string): string {
  return path.join(DATA_DIR, session === MAIN ? "chrome-profile" : `chrome-profile-${session}`);
}
/** The key a session's sign-in state is saved under. Main keeps the plain platform id. */
export function loginKey(session: string, pid: string): string {
  return session === MAIN ? pid : `${session}/${pid}`;
}

/** Where to sign in, and (where it is reliable) the cookie that proves it. */
interface LoginSpec {
  url: string;
  cookie?: { domain: string; name: string; value?: string };
}
export const LOGIN: Record<string, LoginSpec> = {
  instagram: { url: "https://www.instagram.com/accounts/login/", cookie: { domain: "instagram.com", name: "sessionid" } },
  facebook: { url: "https://www.facebook.com/login", cookie: { domain: "facebook.com", name: "c_user" } },
  threads: { url: "https://www.threads.net/login", cookie: { domain: "threads", name: "sessionid" } },
  twitter: { url: "https://x.com/i/flow/login", cookie: { domain: "x.com", name: "auth_token" } },
  tiktok: { url: "https://www.tiktok.com/login", cookie: { domain: "tiktok.com", name: "sessionid" } },
  youtube: { url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://studio.youtube.com/", cookie: { domain: "google.com", name: "SID" } },
  linkedin: { url: "https://www.linkedin.com/login", cookie: { domain: "linkedin.com", name: "li_at" } },
  linkedin_co: { url: "https://www.linkedin.com/login", cookie: { domain: "linkedin.com", name: "li_at" } },
  whatsapp: { url: "https://web.whatsapp.com/" },
  telegram: { url: "https://web.telegram.org/" },
  pinterest: { url: "https://www.pinterest.com/login/", cookie: { domain: "pinterest.com", name: "_auth", value: "1" } },
  discord: { url: "https://discord.com/login" },
  reddit: { url: "https://www.reddit.com/login/", cookie: { domain: "reddit.com", name: "reddit_session" } },
  substack: { url: "https://substack.com/sign-in", cookie: { domain: "substack.com", name: "substack.sid" } },
  medium: { url: "https://medium.com/m/signin", cookie: { domain: "medium.com", name: "sid" } },
  spotify: { url: "https://accounts.spotify.com/login", cookie: { domain: "spotify.com", name: "sp_dc" } },
  behance: { url: "https://www.behance.net/" },
  linktree: { url: "https://linktr.ee/login" },
  bluesky: { url: "https://bsky.app/" },
  mastodon: { url: "https://joinmastodon.org/" },
  snapchat: { url: "https://accounts.snapchat.com/" },
  soundcloud: { url: "https://soundcloud.com/signin", cookie: { domain: "soundcloud.com", name: "oauth_token" } },
  github: { url: "https://github.com/login", cookie: { domain: "github.com", name: "user_session" } },
  vsco: { url: "https://vsco.co/user/login" },
  tumblr: { url: "https://www.tumblr.com/login" },
  patreon: { url: "https://www.patreon.com/login" },
  kofi: { url: "https://ko-fi.com/account/login" },
  applepod: { url: "https://podcastsconnect.apple.com/" },
  lemon8: { url: "https://www.lemon8-app.com/" },
  gbp: { url: "https://accounts.google.com/ServiceLogin?continue=https://business.google.com/", cookie: { domain: "google.com", name: "SID" } },
  dribbble: { url: "https://dribbble.com/session/new" },
};

// ───────────────────────── DevTools protocol client ─────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
class Cdp {
  private ws: any;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  static open(url: string): Promise<Cdp> {
    const c = new Cdp();
    return new Promise<Cdp>((resolve, reject) => {
      const W = (globalThis as any).WebSocket;
      if (!W) {
        reject(new Error("This Node version has no WebSocket. Use Node 22 or newer."));
        return;
      }
      c.ws = new W(url);
      c.ws.onopen = () => resolve(c);
      c.ws.onerror = () => reject(new Error("Could not connect to the sigsche browser."));
      c.ws.onmessage = (ev: any) => {
        const m = JSON.parse(String(ev.data)) as { id?: number; result?: any; error?: { message: string } };
        if (typeof m.id !== "number") return;
        const p = c.pending.get(m.id);
        if (!p) return;
        c.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      };
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function debuggerUrl(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = (await r.json()) as { webSocketDebuggerUrl?: string };
    return j.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}
export async function browserRunning(session: string = MAIN): Promise<boolean> {
  const port = peekPort(session);
  return port !== undefined && (await debuggerUrl(port)) !== null;
}

function chromeExe(): string {
  const env = process.env;
  const candidates = [
    env["SIGSCHE_CHROME"],
    `${env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(
    "Chrome or Edge was not found. Install Chrome, or set SIGSCHE_CHROME to the browser's path.",
  );
}

/** Start the sigsche browser if it is not already running. Returns its DevTools URL. */
export async function ensureBrowser(session: string = MAIN, openUrl?: string): Promise<string> {
  const port = portFor(session);
  const existing = await debuggerUrl(port);
  if (existing) return existing;
  const extra = (process.env["SIGSCHE_CHROME_ARGS"] ?? "").split(" ").filter(Boolean);
  const child = spawn(
    chromeExe(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir(session)}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extra,
      openUrl ?? "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const url = await debuggerUrl(port);
    if (url) return url;
  }
  throw new Error("The sigsche browser did not start within 20 seconds.");
}

async function openTab(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = (await cdp.send("Target.createTarget", { url })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string;
  };
  await cdp.send("Page.bringToFront", {}, sessionId).catch(() => undefined);
  return sessionId;
}

/** Open a platform's sign-in page in the sigsche browser. */
export async function openLogin(pid: string, instance?: string, session: string = MAIN): Promise<{ url: string; session: string }> {
  const spec = LOGIN[pid];
  if (!spec) throw new Error(`'${pid}' is a phone-only app: there is no web sign-in.`);
  const url = pid === "mastodon" && instance ? `https://${instance}/auth/sign_in` : spec.url;
  const was = await browserRunning(session);
  const ws = await ensureBrowser(session, was ? undefined : url);
  if (was) {
    const cdp = await Cdp.open(ws);
    try {
      await openTab(cdp, url);
    } finally {
      cdp.close();
    }
  }
  return { url, session };
}

export type LoginState = "signed_in" | "signed_out" | "marked" | "unknown" | "no_web";
export interface LoginStatus {
  state: LoginState;
  detectable: boolean;
}

/**
 * Sign-in state for every platform. Where a session cookie is a reliable
 * signal it is read from the sigsche browser; otherwise the state is whatever
 * Baatjie marked himself. With the browser closed, the last known state is used.
 */
export async function loginStatuses(
  pids: string[],
  session: string = MAIN,
): Promise<{ browser: boolean; status: Record<string, LoginStatus> }> {
  const port = peekPort(session);
  const ws = port === undefined ? null : await debuggerUrl(port);
  let cookies: Array<{ name: string; value: string; domain: string }> | null = null;
  if (ws) {
    try {
      const cdp = await Cdp.open(ws);
      try {
        const r = (await cdp.send("Storage.getCookies")) as {
          cookies: Array<{ name: string; value: string; domain: string }>;
        };
        cookies = r.cookies;
      } finally {
        cdp.close();
      }
    } catch {
      cookies = null;
    }
  }
  const saved = readState().logins;
  const status: Record<string, LoginStatus> = {};
  const detected: Record<string, boolean> = {};
  for (const pid of pids) {
    const spec = LOGIN[pid];
    if (!spec) {
      status[pid] = { state: "no_web", detectable: false };
      continue;
    }
    const want = spec.cookie;
    if (want && cookies) {
      const hit = cookies.some(
        (c) =>
          c.name === want.name &&
          c.domain.includes(want.domain) &&
          c.value !== "" &&
          (want.value === undefined || c.value === want.value),
      );
      detected[pid] = hit;
      status[pid] = { state: hit ? "signed_in" : "signed_out", detectable: true };
    } else if (want) {
      const last = saved[loginKey(session, pid)]?.detected;
      status[pid] = {
        state: last === true ? "signed_in" : last === false ? "signed_out" : "unknown",
        detectable: true,
      };
    } else {
      status[pid] = { state: saved[loginKey(session, pid)]?.marked ? "marked" : "unknown", detectable: false };
    }
  }
  if (cookies && Object.keys(detected).length > 0) {
    mutate((s) => {
      for (const [pid, hit] of Object.entries(detected)) {
        const key = loginKey(session, pid);
        s.logins[key] = { ...(s.logins[key] ?? {}), detected: hit, at: Date.now() };
      }
    });
  }
  return { browser: ws !== null, status };
}

export interface AssistResult {
  opened: boolean;
  caption_filled: boolean;
  file_attached: boolean;
}

/**
 * Open a post box in the signed-in sigsche browser and prepare the post:
 * attach the card to the page's file input and, when asked, type the caption
 * into the post box. Best effort: every site lays its composer out
 * differently, so the result says exactly what was done.
 */
export async function assistPost(
  url: string,
  caption: string,
  file: string | null,
  fillCaption: boolean,
  browserSession: string = MAIN,
): Promise<AssistResult> {
  const ws = await ensureBrowser(browserSession);
  const cdp = await Cdp.open(ws);
  const out: AssistResult = { opened: false, caption_filled: false, file_attached: false };
  try {
    const session = await openTab(cdp, url);
    out.opened = true;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const r = (await cdp
        .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, session)
        .catch(() => null)) as { result?: { value?: string } } | null;
      if (r?.result?.value === "complete") break;
    }
    await sleep(2500);

    if (file) {
      for (let attempt = 0; attempt < 3 && !out.file_attached; attempt++) {
        try {
          const doc = (await cdp.send("DOM.getDocument", { depth: 0 }, session)) as {
            root: { nodeId: number };
          };
          const found = (await cdp.send(
            "DOM.querySelectorAll",
            { nodeId: doc.root.nodeId, selector: "input[type=file]" },
            session,
          )) as { nodeIds: number[] };
          const nodeId = found.nodeIds[0];
          if (nodeId !== undefined) {
            await cdp.send("DOM.setFileInputFiles", { files: [file], nodeId }, session);
            out.file_attached = true;
          }
        } catch {
          /* try again after the page settles */
        }
        if (!out.file_attached) await sleep(1500);
      }
    }

    if (fillCaption) {
      const focus = `(() => {
        const els = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')];
        const ok = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 18 && getComputedStyle(e).visibility !== 'hidden'; });
        if (!ok) return false; ok.focus(); return document.activeElement === ok || ok.contains(document.activeElement);
      })()`;
      const r = (await cdp
        .send("Runtime.evaluate", { expression: focus, returnByValue: true }, session)
        .catch(() => null)) as { result?: { value?: boolean } } | null;
      if (r?.result?.value === true) {
        await cdp.send("Input.insertText", { text: caption }, session);
        out.caption_filled = true;
      }
    }
  } finally {
    cdp.close();
  }
  return out;
}

/** Put text on the Windows clipboard so it can be pasted where auto-fill could not reach. */
export function copyToClipboard(text: string): void {
  if (process.platform !== "win32") return;
  try {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    ps.stdin.end(text, "utf8");
  } catch {
    /* clipboard is a convenience only */
  }
}
