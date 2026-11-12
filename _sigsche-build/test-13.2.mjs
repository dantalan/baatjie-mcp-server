// v13.2 godsview: the rent cycle and the room states, from fixture rows.
// Pure functions only: no tanOS call is made.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SIGSCHE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sigsche-13-2-"));
const G = await import("../dist/sigsche/godsview.js");

const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);

// 1. rent cycle: before and after the 28th
let c = G.rentCycle("2026-11-12", 28);
ok("12 Nov is in the cycle that began 28 Oct", c.start === "2026-10-28" && c.next === "2026-11-28", JSON.stringify(c));
c = G.rentCycle("2026-11-28", 28);
ok("on the 28th the new cycle starts", c.start === "2026-11-28" && c.next === "2026-12-28", JSON.stringify(c));
c = G.rentCycle("2027-01-10", 28);
ok("January rolls back to December", c.start === "2026-12-28" && c.next === "2027-01-28", JSON.stringify(c));

// 2. fixture: four rooms, one with no lease, one paid, one part, one behind
const prop = { property_id: "p1", address: "46 Saint James Street" };
const rooms = ["one", "two", "three", "four"].map((w, i) => ({
  room_id: "r" + i, property_id: "p1", room_name: "room _" + w,
  rent_base: 2400, water: 350, electricity: 350, gardening: 300,
}));
const lease = (roomId, id, start) => ({ lease_id: id, room_id: roomId, tenant_id: "t" + roomId, status: "active", start_date: start, rent_due_day: 28 });
const leases = [lease("r0", "L0", "2026-01-01"), lease("r1", "L1", "2026-01-01"), lease("r2", "L2", "2026-01-01")];
const tenants = ["r0", "r1", "r2"].map((r) => ({ tenant_id: "t" + r, full_name: "Tenant " + r }));
const payments = [
  { lease_id: "L0", payment_date: "2026-11-02", amount: 3500 }, // room one: 3500 of 3500 -> paid
  { lease_id: "L1", payment_date: "2026-11-02", amount: 1000 }, // room two: part
  // room three: nothing this cycle -> behind
  { lease_id: "L0", payment_date: "2026-09-02", amount: 3500 }, // before this cycle: ignored
];
const g = G.buildGodsview({ properties: [prop], rooms, leases, tenants, payments, notices: [], maintenance: [] }, "2026-11-12");
const by = Object.fromEntries(g.rooms.map((r) => [r.room_name, r]));
ok("room one is paid", by["room _one"].state === "paid", by["room _one"].state);
ok("room two is part", by["room _two"].state === "part", by["room _two"].state);
ok("room three is behind", by["room _three"].state === "behind", by["room _three"].state);
ok("room four has no lease", by["room _four"].state === "nolease", by["room _four"].state);
ok("due is rent plus levies", by["room _one"].due === 3400, String(by["room _one"].due));
ok("old payment ignored", by["room _one"].paid === 3500, String(by["room _one"].paid));
ok("totals: 3 occupied", g.totals.occupied === 3 && g.totals.rooms === 4);
ok("expected is the three occupied rooms", g.totals.expected === 3400 * 3, String(g.totals.expected));
ok("received is what came in", g.totals.received === 4500, String(g.totals.received));
ok("tenant name shown", by["room _two"].tenant === "Tenant r1");
ok("days to rent day", g.days_to_rent_day === 16, String(g.days_to_rent_day));

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
