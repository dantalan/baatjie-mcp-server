// v13.5 email per account: an account may hold an email, a username, or both.
// Runs against a throwaway data dir so the real store is never touched.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sigsche-13-5-"));
writeFileSync(path.join(dir, "sigsche.json"), JSON.stringify({ settings: { plat: { instagram: { on: true, h: "@dantalan" } } } }), "utf8");
process.env.SIGSCHE_DATA_DIR = dir;

const A = await import("../dist/sigsche/accounts.js");
const M = await import("../dist/sigsche/model.js");

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const throwsWith = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(String(e.message)); }
};

// 1. cleanEmail: lower-cases and trims; empty is allowed; junk is refused
ok("cleanEmail lower-cases and trims", A.cleanEmail("  Hello@Locare.CO.ZA ") === "hello@locare.co.za", A.cleanEmail("  Hello@Locare.CO.ZA "));
ok("cleanEmail allows empty", A.cleanEmail("") === "" && A.cleanEmail(undefined) === "");
ok("cleanEmail refuses no @", throwsWith(() => A.cleanEmail("hello.locare.co.za"), /not an email address/));
ok("cleanEmail refuses spaces", throwsWith(() => A.cleanEmail("a b@c.za"), /not an email address/));
ok("cleanEmail refuses no dot in domain", throwsWith(() => A.cleanEmail("a@localhost"), /not an email address/));

// 2. saveAccount add paths
const emailOnly = A.saveAccount({ platform: "tiktok", email: "Ops@Locare.co.za", brand: "locare", session: "locare" });
ok("email-only add succeeds", emailOnly.email === "ops@locare.co.za" && emailOnly.handle === "", JSON.stringify(emailOnly));
ok("email-only add becomes primary on an empty platform", emailOnly.primary === true);

const handleOnly = A.saveAccount({ platform: "instagram", handle: "@locare.co.za", label: "locare page" });
ok("handle-only add succeeds", handleOnly.handle === "@locare.co.za" && handleOnly.email === "", JSON.stringify(handleOnly));

const both = A.saveAccount({ platform: "instagram", email: "hello@dantalan.co.za", handle: "@dantalan.test", session: "dantalan" });
ok("both email and handle saved", both.email === "hello@dantalan.co.za" && both.handle === "@dantalan.test");

ok("neither email nor handle refused", throwsWith(() => A.saveAccount({ platform: "instagram", email: "", handle: "" }), /Give an email, a handle, or both/));
ok("bad email refused on add", throwsWith(() => A.saveAccount({ platform: "instagram", email: "nope", handle: "@x" }), /not an email address/));
ok("duplicate handle still refused", throwsWith(() => A.saveAccount({ platform: "instagram", handle: "https://instagram.com/locare.co.za/" }), /already saved/));
ok("email-only add is not checked for duplicate handles", A.saveAccount({ platform: "instagram", email: "second@locare.co.za" }).email === "second@locare.co.za");

// 3. patch paths
const shown = (id) => A.accounts(M.readState()).find((a) => a.id === id);
ok("email can be changed on an existing account", A.saveAccount({ id: handleOnly.id, email: "Page@Locare.co.za" }).email === "page@locare.co.za");
ok("handle can be emptied when an email is set", A.saveAccount({ id: both.id, handle: "" }).handle === "" && shown(both.id).email === "hello@dantalan.co.za");
ok("email can be cleared when a handle is set", A.saveAccount({ id: both.id, email: "", handle: "@dantalan.test" }).email === "" && shown(both.id).handle === "@dantalan.test");
const soloH = A.saveAccount({ platform: "tiktok", handle: "@solo" });
ok("handle cannot be emptied when there is no email", throwsWith(() => A.saveAccount({ id: soloH.id, handle: "" }), /needs an email or a handle/));
ok("email cannot be cleared when there is no handle", throwsWith(() => A.saveAccount({ id: emailOnly.id, email: "" }), /needs an email or a handle/));
ok("bad email refused on patch", throwsWith(() => A.saveAccount({ id: handleOnly.id, email: "bad" }), /not an email address/));

// 4. the register keeps the email through the store
const row = shown(emailOnly.id);
ok("email kept in the register", row?.email === "ops@locare.co.za", row?.email);

const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(out.join("\n"));
console.log(`\n${out.length - failed} of ${out.length} pass`);
process.exit(failed ? 1 : 0);
