/**
 * What the dashboard and the MCP tools both call: the platform table and the
 * one upload path (API where a token is saved, otherwise the signed-in
 * sigsche browser).
 */

import { existsSync } from "node:fs";
import { accounts, chooseAccount, handleCounts } from "./accounts.js";
import { MAIN, assistPost, copyToClipboard, loginStatuses, type LoginState } from "./browser.js";
import { DIRECT_FIELDS, directConfigured, directPost } from "./direct.js";
import {
  cardPath,
  catalog,
  findItem,
  handleOf,
  isOn,
  items,
  markPosted,
  mutate,
  platformOf,
  readState,
  type Platform,
} from "./model.js";

export interface PlatformRow {
  id: string;
  name: string;
  group: string;
  mode: string;
  on: boolean;
  handle: string;
  handles: number;
  login: LoginState;
  login_detectable: boolean;
  api: boolean;
  api_ready: boolean;
  posted: number;
}

export async function platformRows(): Promise<{ browser: boolean; rows: PlatformRow[] }> {
  const c = catalog();
  const s = readState();
  const counts: Record<string, number> = {};
  for (const it of items(s)) for (const pid of Object.keys(it.done)) counts[pid] = (counts[pid] ?? 0) + 1;
  const { browser, status } = await loginStatuses(c.platforms.map((p) => p.id));
  const handles = handleCounts(s);
  const rows = c.platforms.map((p) => ({
    id: p.id,
    name: p.name,
    group: p.group,
    mode: p.mode,
    on: isOn(s, p.id),
    handle: handleOf(s, p.id),
    handles: handles[p.id] ?? 0,
    login: status[p.id]?.state ?? "unknown",
    login_detectable: status[p.id]?.detectable ?? false,
    api: p.id in DIRECT_FIELDS,
    api_ready: directConfigured(p.id),
    posted: counts[p.id] ?? 0,
  }));
  return { browser, rows };
}

function mastodonInstance(handle: string): string {
  const m = handle.match(/^https?:\/\/([^/\s]+)/) ?? handle.match(/@[^@\s]+@([\w.-]+)/);
  return m?.[1] ?? "";
}

/** The page a post is prepared on, with the caption pre-filled where the platform allows it. */
export function composeUrl(pl: Platform, caption: string, link: string, hook: string): string {
  const c = encodeURIComponent(caption);
  const u = encodeURIComponent(link);
  if (!link && ["facebook", "reddit", "pinterest", "tumblr", "telegram"].includes(pl.id)) return pl.url;
  switch (pl.id) {
    case "twitter":
      return `https://twitter.com/intent/tweet?text=${c}`;
    case "facebook":
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case "linkedin":
    case "linkedin_co":
      return `https://www.linkedin.com/feed/?shareActive=true&text=${c}`;
    case "threads":
      return `https://www.threads.net/intent/post?text=${c}`;
    case "whatsapp":
      return `https://wa.me/?text=${c}`;
    case "telegram":
      return `https://t.me/share/url?url=${u}&text=${c}`;
    case "reddit":
      return `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(hook)}`;
    case "pinterest":
      return `https://pinterest.com/pin/create/button/?url=${u}&description=${c}`;
    case "bluesky":
      return `https://bsky.app/intent/compose?text=${c}`;
    case "tumblr":
      return `https://www.tumblr.com/widgets/share/tool?canonicalUrl=${u}&caption=${c}`;
    case "mastodon": {
      const inst = mastodonInstance(handleOf(readState(), "mastodon"));
      return inst ? `https://${inst}/share?text=${c}` : pl.url;
    }
    default:
      return pl.url;
  }
}

export interface UploadRequest {
  pid: string;
  accountId?: string;
  itemId?: string;
  caption?: string;
  url?: string;
  cardName?: string;
}
export interface UploadResult {
  platform: string;
  method: "api" | "browser" | "clipboard";
  posted: boolean;
  card_attached: boolean;
  caption_filled: boolean;
  where?: string;
  next: string;
  from?: string | null;
  session?: string;
}

export async function upload(req: UploadRequest): Promise<UploadResult> {
  const pl = platformOf(req.pid);
  if (!pl) throw new Error(`Unknown platform '${req.pid}'. Call baatjie_sigsche_platforms for the 33 ids.`);
  const item = req.itemId ? findItem(readState(), req.itemId) : undefined;
  if (req.itemId && !item) throw new Error(`No post or signal with id '${req.itemId}'`);
  // v13.4: post from the handle the brand uses (or the one named), in that handle's own browser session.
  const account = chooseAccount(readState(), req.pid, {
    ...(req.accountId ? { accountId: req.accountId } : {}),
    ...(item ? { brand: item.brand.key } : {}),
  });
  const session = account?.session ?? MAIN;
  const caption = req.caption ?? item?.caption;
  if (!caption) throw new Error("Nothing to post: give an item id or a caption.");
  const cardName = req.cardName ?? item?.card_file;
  let file: string | null = null;
  if (cardName) {
    const p = cardPath(cardName);
    if (existsSync(p)) file = p;
  }

  let result: UploadResult;
  if (directConfigured(pl.id)) {
    const where = await directPost(pl.id, caption, file);
    if (item) markPosted(item.id, [pl.id], true);
    result = {
      platform: pl.name,
      method: "api",
      posted: true,
      card_attached: file !== null,
      caption_filled: true,
      where,
      next: "Posted and ticked.",
    };
  } else if (pl.mode === "app") {
    copyToClipboard(caption);
    result = {
      platform: pl.name,
      method: "clipboard",
      posted: false,
      card_attached: false,
      caption_filled: false,
      next: `${pl.name} is a phone-only app. The caption is on the clipboard.`,
    };
  } else {
    copyToClipboard(caption);
    const url = req.url ?? composeUrl(pl, caption, item?.link ?? "", item?.hook ?? "");
    const r = await assistPost(url, caption, file, pl.mode === "open", session);
    const prefilled = pl.mode === "intent" && url !== pl.url;
    const todo: string[] = [];
    if (!r.caption_filled && !prefilled) todo.push("paste the caption (it is on the clipboard)");
    if (!r.file_attached) todo.push(file ? `attach the card (${file})` : "attach an image if you want one");
    result = {
      platform: pl.name,
      method: "browser",
      posted: false,
      card_attached: r.file_attached,
      caption_filled: r.caption_filled || prefilled,
      next:
        (todo.length ? `In the sigsche browser: ${todo.join(", ")}, then press Post.` : "Ready in the sigsche browser. Check it and press Post.") +
        " Tick it in the Queue once it is up.",
    };
  }
  mutate((s) => {
    s.uploads.push({ at: Date.now(), pid: pl.id, item: item?.id ?? null, method: result.method, posted: result.posted });
    if (s.uploads.length > 500) s.uploads.splice(0, s.uploads.length - 500);
  });
  return { ...result, from: account ? account.handle : null, session };
}

/** Sign-in state for every saved handle, read in the browser session that handle uses. */
export async function accountLogins(): Promise<Record<string, LoginState>> {
  const list = accounts(readState());
  const byS: Record<string, Record<string, LoginState>> = {};
  for (const sess of new Set(list.map((a) => a.session))) {
    const pids = [...new Set(list.filter((a) => a.session === sess).map((a) => a.pid))];
    const { status } = await loginStatuses(pids, sess);
    byS[sess] = Object.fromEntries(pids.map((p) => [p, status[p]?.state ?? "unknown"]));
  }
  return Object.fromEntries(list.map((a) => [a.id, byS[a.session]?.[a.pid] ?? "unknown"]));
}
