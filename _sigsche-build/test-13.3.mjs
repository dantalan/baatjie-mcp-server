// v13.3 accounts: add, limit, primary, brand routing, legacy migration, remove.
// Runs against a throwaway data dir so the real store is never touched.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sigsche-13-3-"));
writeFileSync(path.join(dir, "sigsche.json"), JSON.stringify({ settings: { plat: { instagram: { on: true, h: "@dantalan" } } } }), "utf8");
process.env.SIGSCHE_DATA_DIR = dir;

const A = await import("../dist/sigsche/accounts.js");
const M = await import("../dist/sigsche/model.js");

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);

// 1. a handle saved before v13.3 shows up, marked legacy
let list = A.accounts(M.readState());
ok("legacy handle appears", list.length === 1 && list[0].pid === "instagram" && list[0].legacy && list[0].primary, JSON.stringify(list[0]));

// 2. add a second instagram handle; the legacy one is written in properly
const second = A.saveAccount({ platform: "instagram", handle: "@locare.co.za", label: "locare page", brand: "locare" });
list = A.accounts(M.readState(), "instagram");
ok("second handle added", list.length === 2, list.map((a) => a.handle).join(", "));
ok("legacy written in", list.every((a) => !a.legacy));
ok("first stays primary", list.find((a) => a.primary)?.handle === "@dantalan");

// 3. plat[pid].h still mirrors the primary
ok("plat handle mirrors primary", M.handleOf(M.readState(), "instagram") === "@dantalan");

// 4. make the second one primary
A.saveAccount({ id: second.id, primary: true });
ok("primary moved", A.primaryOf(M.readState(), "instagram").handle === "@locare.co.za");
ok("plat handle followed", M.handleOf(M.readState(), "instagram") === "@locare.co.za");

// 5. duplicates refused, unknown platform refused, unknown brand refused
let threw = "";
try { A.saveAccount({ platform: "instagram", handle: "https://instagram.com/locare.co.za" }); } catch (e) { threw = e.message }
ok("duplicate refused", /already saved/i.test(threw), threw);
threw = "";
try { A.saveAccount({ platform: "myspace", handle: "@x" }); } catch (e) { threw = e.message }
ok("unknown platform refused", /Unknown platform/.test(threw), threw);
threw = "";
try { A.saveAccount({ platform: "threads", handle: "@x", brand: "nosuchbrand" }); } catch (e) { threw = e.message }
ok("unknown brand refused", /Unknown brand/.test(threw), threw);

// 6. the per-platform limit holds
threw = "";
for (let i = 0; i < 10 && !threw; i++) {
  try { A.saveAccount({ platform: "twitter", handle: "@acct" + i }); } catch (e) { threw = e.message }
}
ok("limit of " + A.ACCT_MAX + " holds", /limit/.test(threw) && A.accounts(M.readState(), "twitter").length === A.ACCT_MAX, threw);

// 7. brand routing: a brand's own handle wins, otherwise the unbranded ones
A.saveAccount({ platform: "threads", handle: "@dantalan.threads" });
A.saveAccount({ platform: "threads", handle: "@locare.threads", brand: "locare" });
const forLocare = A.targetAccounts(M.readState(), "threads", "locare").map((a) => a.handle);
const forOther = A.targetAccounts(M.readState(), "threads", "node1").map((a) => a.handle);
ok("brand handle wins", forLocare.length === 1 && forLocare[0] === "@locare.threads", forLocare.join(","));
ok("unbranded is the fallback", forOther.length === 1 && forOther[0] === "@dantalan.threads", forOther.join(","));

// 8. switched off receives nothing
const off = A.accounts(M.readState(), "threads").find((a) => a.handle === "@dantalan.threads");
A.saveAccount({ id: off.id, on: false });
ok("off handle excluded", A.targetAccounts(M.readState(), "threads", "node1").length === 0);

// 9. remove the primary: the oldest remaining takes over
const igPrimary = A.primaryOf(M.readState(), "instagram");
A.removeAccount(igPrimary.id);
const after = A.accounts(M.readState(), "instagram");
ok("removed", after.length === 1 && after[0].handle === "@dantalan");
ok("primary handed over", after[0].primary && M.handleOf(M.readState(), "instagram") === "@dantalan");

// 10. removing the last one empties the platform handle without touching on/off
A.removeAccount(after[0].id);
ok("platform emptied", A.accounts(M.readState(), "instagram").length === 0 && M.handleOf(M.readState(), "instagram") === "");
ok("on/off untouched", M.isOn(M.readState(), "instagram") === true);

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
