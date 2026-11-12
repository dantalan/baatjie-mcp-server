// v13.1 business register: records, open fields, domain cleaning, custom businesses.
// Runs on a throwaway data dir so the real store is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SIGSCHE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sigsche-13-1-"));
const M = await import("../dist/sigsche/model.js");

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);

// 1. domain cleaning
ok("strips scheme and slash", M.cleanDomain("https://Locare.co.za/") === "Locare.co.za");
ok("rejects junk", M.cleanDomain("not a domain") === "");

// 2. the catalog brands are all in the register, with the catalog domain as default
const s0 = M.readState();
const rows0 = M.businesses(s0);
ok("every catalog brand is registered", rows0.length === M.allBrands(s0).length && rows0.length > 0, `${rows0.length} businesses`);
const loc = rows0.find((r) => r.key === "locare");
ok("locare present", !!loc);

// 3. saving a field clears it from the open list
M.saveBusiness("locare", { sector: "Property management software", contact: "dantalan" });
const loc2 = M.businesses(M.readState()).find((r) => r.key === "locare");
ok("sector saved", loc2.sector === "Property management software");
ok("saved field no longer open", !loc2.open.includes("sector"));

// 4. a field left empty stays open (nothing guessed)
ok("untouched field stays open", loc2.open.includes("about"));

// 5. a bad domain is cleaned on save
M.saveBusiness("locare", { domain: "https://Example.co.za/" });
ok("domain cleaned on save", M.businesses(M.readState()).find((r) => r.key === "locare").domain === "Example.co.za");

// 6. add a custom business; it joins the register with its own key
M.saveBusiness("zenithco", { sector: "Test" }, { name: "Zenith Co", color: "#ABCDEF" });
const added = M.businesses(M.readState()).find((r) => r.key === "zenithco");
ok("custom business added", !!added && added.custom === true && added.name === "_Zenith Co", added?.name);

// 7. refuse unknown key without a name, and bad keys / names
let threw = "";
try { M.saveBusiness("nobodyhere", { sector: "x" }); } catch (e) { threw = e.message }
ok("unknown key refused without a name", /Unknown business/.test(threw), threw);
threw = "";
try { M.saveBusiness("A!", {}, { name: "Bad" }); } catch (e) { threw = e.message }
ok("bad key refused", /2 to 24/.test(threw), threw);

// 8. status must be one of the set
M.saveBusiness("zenithco", { status: "Building" });
ok("status saved", M.businesses(M.readState()).find((r) => r.key === "zenithco").status === "Building");

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
