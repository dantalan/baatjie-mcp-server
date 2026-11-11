/**
 * Direct posting for the platforms whose own APIs accept a personal token
 * with no developer-app approval: Bluesky, Mastodon, Telegram and Discord.
 * Each posts the caption and, when present, the card image.
 */

import { readFileSync } from "node:fs";
import { readSecrets } from "./model.js";

export const DIRECT_FIELDS: Record<string, Array<{ key: string; label: string; hint: string }>> = {
  bluesky: [
    { key: "handle", label: "Handle", hint: "you.bsky.social" },
    { key: "app_password", label: "App password", hint: "Settings → Privacy and security → App passwords" },
  ],
  mastodon: [
    { key: "instance", label: "Instance", hint: "mastodon.social" },
    { key: "access_token", label: "Access token", hint: "Preferences → Development → New application (write:statuses, write:media)" },
  ],
  telegram: [
    { key: "bot_token", label: "Bot token", hint: "From @BotFather" },
    { key: "chat_id", label: "Channel or chat", hint: "@yourchannel (the bot must be an admin)" },
  ],
  discord: [{ key: "webhook_url", label: "Webhook URL", hint: "Channel → Integrations → Webhooks" }],
};

export function directConfigured(pid: string): boolean {
  const need = DIRECT_FIELDS[pid];
  if (!need) return false;
  const have = readSecrets()[pid] ?? {};
  return need.every((f) => (have[f.key] ?? "").trim() !== "");
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
async function fail(r: Response, what: string): Promise<never> {
  const body = (await r.text().catch(() => "")).slice(0, 300);
  throw new Error(`${what} answered ${r.status}. ${body}`);
}
function png(file: string): Blob {
  return new Blob([readFileSync(file)], { type: "image/png" });
}

async function bluesky(s: Record<string, string>, caption: string, file: string | null): Promise<string> {
  const pds = "https://bsky.social";
  const login = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: (s["handle"] ?? "").replace(/^@/, ""), password: s["app_password"] }),
  });
  if (!login.ok) await fail(login, "Bluesky sign-in");
  const session = (await login.json()) as { accessJwt: string; did: string; handle: string };
  const auth = { Authorization: `Bearer ${session.accessJwt}` };
  const text = clip(caption, 300);
  const enc = new TextEncoder();
  const facets: object[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s…]+/g)) {
    const start = enc.encode(text.slice(0, m.index)).length;
    facets.push({
      index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    ...(facets.length ? { facets } : {}),
  };
  if (file) {
    const up = await fetch(`${pds}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: png(file),
    });
    if (!up.ok) await fail(up, "Bluesky image upload");
    const blob = ((await up.json()) as { blob: unknown }).blob;
    record["embed"] = { $type: "app.bsky.embed.images", images: [{ alt: clip(caption, 280), image: blob }] };
  }
  const post = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
  });
  if (!post.ok) await fail(post, "Bluesky post");
  const uri = ((await post.json()) as { uri: string }).uri;
  return `https://bsky.app/profile/${session.handle}/post/${uri.split("/").pop() ?? ""}`;
}

async function mastodon(s: Record<string, string>, caption: string, file: string | null): Promise<string> {
  const base = `https://${(s["instance"] ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const auth = { Authorization: `Bearer ${s["access_token"] ?? ""}` };
  const mediaIds: string[] = [];
  if (file) {
    const form = new FormData();
    form.append("file", png(file), "card.png");
    const up = await fetch(`${base}/api/v2/media`, { method: "POST", headers: auth, body: form });
    if (!up.ok) await fail(up, "Mastodon image upload");
    mediaIds.push(((await up.json()) as { id: string }).id);
  }
  const post = await fetch(`${base}/api/v1/statuses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ status: clip(caption, 500), media_ids: mediaIds }),
  });
  if (!post.ok) await fail(post, "Mastodon post");
  return ((await post.json()) as { url?: string }).url ?? base;
}

async function telegram(s: Record<string, string>, caption: string, file: string | null): Promise<string> {
  const api = `https://api.telegram.org/bot${s["bot_token"] ?? ""}`;
  let r: Response;
  if (file) {
    const form = new FormData();
    form.append("chat_id", s["chat_id"] ?? "");
    form.append("caption", clip(caption, 1024));
    form.append("photo", png(file), "card.png");
    r = await fetch(`${api}/sendPhoto`, { method: "POST", body: form });
  } else {
    r = await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: s["chat_id"], text: clip(caption, 4096) }),
    });
  }
  if (!r.ok) await fail(r, "Telegram");
  return `Telegram ${s["chat_id"] ?? ""}`;
}

async function discord(s: Record<string, string>, caption: string, file: string | null): Promise<string> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: clip(caption, 2000) }));
  if (file) form.append("files[0]", png(file), "card.png");
  const r = await fetch(`${s["webhook_url"] ?? ""}?wait=true`, { method: "POST", body: form });
  if (!r.ok) await fail(r, "Discord");
  return "Discord channel";
}

/** Post through the platform's API. Returns where the post landed. */
export async function directPost(pid: string, caption: string, file: string | null): Promise<string> {
  const s = readSecrets()[pid] ?? {};
  switch (pid) {
    case "bluesky":
      return bluesky(s, caption, file);
    case "mastodon":
      return mastodon(s, caption, file);
    case "telegram":
      return telegram(s, caption, file);
    case "discord":
      return discord(s, caption, file);
    default:
      throw new Error(`'${pid}' has no direct API connection`);
  }
}
