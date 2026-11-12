// v13.6 hardening: API writes must be JSON, scripts and vendor files are served locally,
// and the brand card price line shows only on _locare.
// Runs the real routes on an ephemeral port against a throwaway data dir.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const dir = mkdtempSync(path.join(tmpdir(), "sigsche-13-6-"));
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
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);

const send = async (method, url, headers = {}, body) => {
  const r = await fetch(base + url, { method, headers, body });
  return r;
};

// 1. Anti-CSRF: cross-site style writes are refused with 415
{
  const r = await send("POST", "/api/card", { "content-type": "application/x-www-form-urlencoded" }, "a=1");
  ok("form-encoded POST to /api is refused (415)", r.status === 415, `got ${r.status}`);
}
{
  const r = await send("PUT", "/api/settings", { "content-type": "text/plain" }, "x");
  ok("text/plain PUT to /api is refused (415)", r.status === 415, `got ${r.status}`);
}
{
  const r = await send("PUT", "/api/settings", { "content-type": "multipart/form-data; boundary=x" }, "--x--");
  ok("multipart PUT to /api is refused (415)", r.status === 415, `got ${r.status}`);
}

// 2. JSON writes still reach their routes
{
  const r = await send("PUT", "/api/settings", { "content-type": "application/json" }, JSON.stringify({}));
  ok("JSON PUT to /api passes the check (not 415)", r.status !== 415, `got ${r.status}`);
}
{
  const r = await send("PUT", "/api/doc/nocollection/none", { "content-type": "application/json; charset=utf-8" }, "{}");
  ok("JSON with charset passes the check (route answers 400 for a bad collection)", r.status === 400, `got ${r.status}`);
}

// 3. Body-less DELETE stays allowed (a cross-site DELETE needs a preflight, which we never allow)
{
  const r = await send("DELETE", "/api/doc/nocollection/none", {}, undefined);
  ok("body-less DELETE passes the check (not 415)", r.status !== 415, `got ${r.status}`);
}

// 4. Reads are untouched
{
  const r = await send("GET", "/api/state");
  ok("GET /api/state answers 200", r.status === 200, `got ${r.status}`);
}

// 5. Scripts and vendor libraries are served from this origin
for (const [url, type] of [
  ["/app.js", "application/javascript"],
  ["/vendor/qrcode-generator-1.4.4.min.js", "application/javascript"],
  ["/vendor/jszip-3.10.1.min.js", "application/javascript"],
]) {
  const r = await send("GET", url);
  ok(`${url} served as JavaScript`, r.status === 200 && (r.headers.get("content-type") || "").startsWith(type), `got ${r.status} ${r.headers.get("content-type")}`);
}

// 6. Dashboard page loads its scripts from this origin only
{
  const r = await send("GET", "/");
  const html = await r.text();
  ok("dashboard page is served", r.status === 200 && html.includes("<title>sigsche"), `got ${r.status}`);
  ok("dashboard page has no inline script", !/<script>(?!\s*<\/script>)/.test(html));
  ok("dashboard page loads app.js", html.includes('<script src="/app.js"></script>'));
  ok("dashboard page loads vendor libraries locally", html.includes('src="/vendor/qrcode-generator-1.4.4.min.js"') && html.includes('src="/vendor/jszip-3.10.1.min.js"'));
  ok("dashboard page has no cdnjs script tags", !html.includes("cdnjs.cloudflare.com/ajax/libs/"));
}

// 7. Brand card footer: locare price only on _locare cards (static check on app.js)
{
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  ok("price line is gated on _locare", js.includes("p.b==='locare'?'Flat monthly from"));
  ok("no ungated locare price line remains", !js.includes("ROLE[p.b]:'Flat monthly"));
}

server.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(out.join("\n"));
console.log(`\n${out.length - failed} of ${out.length} pass`);
process.exitCode = failed ? 1 : 0;
