// v13.4 per-session browsers: session names, handle-to-session routing, port and profile per session.
// Runs against a throwaway data dir so the real store is never touched.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sigsche-13-4-"));
writeFileSync(path.join(dir, "sigsche.json"), JSON.stringify({ settings: { plat: { instagram: { on: true, h: "@dantalan" } } } }), "utf8");
process.env.SIGSCHE_DATA_DIR = dir;

const A = await import("../dist/sigsche/accounts.js");
const M = await import("../dist/sigsche/model.js");
const B = await import("../dist/sigsche/browser.js");

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const throwsWith = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(String(e.message)); }
};

// 1. cleanSession: lower-cases, trims, and falls back to 'main' for anything invalid
ok("cleanSession keeps a valid name", M.cleanSession(" Locare-2 ") === "locare-2", M.cleanSession(" Locare-2 "));
ok("cleanSession falls back on bad chars", M.cleanSession("bad name!") === "main");
ok("cleanSession falls back on empty", M.cleanSession("") === "main" && M.cleanSession(undefined) === "main");
ok("cleanSession falls back when too long", M.cleanSession("a".repeat(25)) === "main");
ok("SESSION_RE allows 24 chars", M.SESSION_RE.test("a".repeat(24)) && !M.SESSION_RE.test("a".repeat(25)));

// 2. saveAccount normalises the session, and refuses an invalid one
const first = A.accounts(M.readState(), "instagram")[0];
ok("legacy handle is on main", first.session === "main", first.session);
const loc = A.saveAccount({ platform: "instagram", handle: "@locare.co.za", label: "locare page", brand: "locare", session: " Locare " });
ok("session saved lower-cased and trimmed", loc.session === "locare", loc.session);
ok("invalid session refused", throwsWith(() => A.saveAccount({ platform: "instagram", handle: "@zz", session: "bad name" }), /Session:/));
ok("session can be changed on an existing handle", A.saveAccount({ id: loc.id, session: "locare-2" }).session === "locare-2");
A.saveAccount({ id: loc.id, session: "locare" });

// 3. chooseAccount: by id, by brand, and the fallback to the primary handle
const pick = (opts) => A.chooseAccount(M.readState(), "instagram", opts);
ok("chooseAccount by id", pick({ accountId: loc.id })?.handle === "@locare.co.za");
ok("chooseAccount unknown id refused", throwsWith(() => pick({ accountId: "nope" }), /No handle 'nope'/));
ok("chooseAccount by brand", pick({ brand: "locare" })?.handle === "@locare.co.za", pick({ brand: "locare" })?.handle);
ok("chooseAccount falls back to primary", pick({ brand: "node1" })?.handle === "@dantalan", pick({ brand: "node1" })?.handle);
ok("chooseAccount with no platform handles is undefined", A.chooseAccount(M.readState(), "tiktok", {}) === undefined);

// 4. per-session browser helpers: each session has its own port and profile folder
const pMain = B.portFor(B.MAIN);
const pLoc = B.portFor("locare");
ok("main keeps its port", pMain === B.peekPort(B.MAIN) && typeof pMain === "number");
ok("locare gets a different port", pLoc !== pMain && pLoc === B.portFor("locare"), `${pMain} vs ${pLoc}`);
ok("port is stable across calls", B.portFor("locare") === pLoc);
ok("profiles differ per session", B.profileDir("main") !== B.profileDir("locare"));
ok("login keys differ per session", B.loginKey("main", "instagram") !== B.loginKey("locare", "instagram"));

// 5. the register survives a round trip through the store
ok("handles on the platform", A.accounts(M.readState(), "instagram").length === 2);

const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(out.join("\n"));
console.log(`\n${out.length - failed} of ${out.length} pass`);
process.exit(failed ? 1 : 0);
