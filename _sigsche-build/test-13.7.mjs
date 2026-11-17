// v13.7 anti-CSRF: every API write must carry this browser's session token.
// Runs the real routes on an ephemeral port against a throwaway data dir.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const dir = mkdtempSync(path.join(tmpdir(), "sigsche-13-7-"));
writeFileSync(path.join(dir, "sigsche.json"), JSON.stringify({ settings: {} }), "utf8");
process.env.SIGSCHE_DATA_DIR = dir;

const { mountSigsche } = await import("../dist/sigsche/http.js");

const app = express();
app.use(express.json({ limit: "24mb" }));
mountSigsche(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " - " + extra : ""}`);

// A first visit: the response sets this browser's session cookie, and /api/csrf returns its token.
const visit = await fetch(base + "/api/csrf");
const setCookie = visit.headers.get("set-cookie") ?? "";
const session = /sigsche_csrf=([0-9a-f]{64})/.exec(setCookie)?.[1] ?? null;
const visitBody = await visit.json();
ok("first visit sets a 64-hex session cookie", session !== null, `cookie: ${setCookie.slice(0, 40)}`);
ok("/api/csrf returns the same token as the cookie", visitBody.token === session);
ok("session cookie is HttpOnly and SameSite=Strict", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie));

// A second, separate browser gets a different token.
const other = await fetch(base + "/api/csrf");
const otherSession = /sigsche_csrf=([0-9a-f]{64})/.exec(other.headers.get("set-cookie") ?? "")?.[1] ?? null;
ok("a second browser gets its own token", otherSession !== null && otherSession !== session);
await other.arrayBuffer();

const JSON_HEADER = { "content-type": "application/json" };
const cookieHeader = (value) => ({ cookie: `sigsche_csrf=${value}` });
const put = (url, headers, body = "{}") => fetch(base + url, { method: "PUT", headers, body });

// 1. A JSON write needs the session token: no token, half a token, or someone else's token is refused.
{
  const r = await put("/api/settings", JSON_HEADER);
  ok("JSON write with no cookie and no token is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await put("/api/settings", { ...JSON_HEADER, ...cookieHeader(session) });
  ok("JSON write with the cookie but no header is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await put("/api/settings", { ...JSON_HEADER, "x-csrf-token": session });
  ok("JSON write with the header but no cookie is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await put("/api/settings", { ...JSON_HEADER, ...cookieHeader(session), "x-csrf-token": "0".repeat(64) });
  ok("JSON write with a wrong token is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await put("/api/settings", { ...JSON_HEADER, ...cookieHeader(session), "x-csrf-token": otherSession });
  ok("a token from another browser is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await put("/api/settings", { ...JSON_HEADER, ...cookieHeader("abc"), "x-csrf-token": "abc" });
  ok("a malformed cookie is refused (403)", r.status === 403, `got ${r.status}`);
}

// 2. The right token passes both checks and reaches the route.
{
  const r = await put("/api/settings", { ...JSON_HEADER, ...cookieHeader(session), "x-csrf-token": session });
  ok("JSON write with the matching session token succeeds (200)", r.status === 200, `got ${r.status}`);
}
{
  const r = await put("/api/doc/nocollection/none", { ...JSON_HEADER, ...cookieHeader(session), "x-csrf-token": session });
  ok("valid token reaches the route (400 for an unknown collection)", r.status === 400, `got ${r.status}`);
}

// 3. Content type still comes first: a form-encoded write is refused as 415 even with a valid token.
{
  const r = await fetch(base + "/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/x-www-form-urlencoded", ...cookieHeader(session), "x-csrf-token": session },
    body: "a=1",
  });
  ok("form-encoded write is refused (415) even with a valid token", r.status === 415, `got ${r.status}`);
}

// 4. A body-less DELETE is checked for the token too.
{
  const r = await fetch(base + "/api/doc/nocollection/none", { method: "DELETE" });
  ok("body-less DELETE with no token is refused (403)", r.status === 403, `got ${r.status}`);
}
{
  const r = await fetch(base + "/api/doc/nocollection/none", {
    method: "DELETE",
    headers: { ...cookieHeader(session), "x-csrf-token": session },
  });
  ok("body-less DELETE with the token reaches the route (400)", r.status === 400, `got ${r.status}`);
}

// 5. Reads need no token.
{
  const r = await fetch(base + "/api/state");
  ok("GET /api/state needs no token (200)", r.status === 200, `got ${r.status}`);
}

// 6. Every form on the dashboard carries the token field the client fills in.
{
  const html = await (await fetch(base + "/")).text();
  const forms = (html.match(/<form\b/g) || []).length;
  const fields = (html.match(/name="csrf_token"/g) || []).length;
  ok("every form on the dashboard has a csrf_token field", forms > 0 && forms === fields, `${fields} of ${forms} forms`);
}

server.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(out.join("\n"));
console.log(`\n${out.length - failed} of ${out.length} pass`);
process.exitCode = failed ? 1 : 0;
