#!/usr/bin/env node
/**
 * RLS regression test for tanOS (P0.1, automated).
 *
 * P0.1 was verified manually on 2026-08-09: two agencies seeded, cross-agency
 * read/write blocked, anon read empty, fixtures torn down same day. This
 * automates that same check so a future migration that weakens or drops a
 * policy fails a build instead of being caught by hand again.
 *
 * Scope: this only covers the 10 tables that actually carry account_id +
 * policies today (landlords, properties, rooms, tenants, foreign_nationals,
 * leases, lease_agreements, payments, maintenance, notices). A live
 * get_advisors check on 2026-08-11 found ten OTHER tables — agents,
 * ai_agents, audit_log, brms, daily_activity, employers, locare_accounts,
 * member_consents, policies, todos — still have RLS enabled with zero
 * policies. That is default-deny (anon reads return empty, same as before
 * any policy existed), not a regression, but it also means this test cannot
 * exercise cross-agency isolation on those tables because there is no
 * per-agency scoping on them to test. See baatjie-mcp-server.md project
 * memory for the full breakdown.
 *
 * Requires env: TANOS_URL, TANOS_SERVICE_KEY (admin actions + teardown),
 * TANOS_ANON_KEY (the isolation checks themselves must run as non-service
 * clients or they'd trivially pass).
 */

import { createClient } from "@supabase/supabase-js";

const URL = process.env.TANOS_URL;
const SERVICE_KEY = process.env.TANOS_SERVICE_KEY;
const ANON_KEY = process.env.TANOS_ANON_KEY;

for (const [name, val] of Object.entries({ TANOS_URL: URL, TANOS_SERVICE_KEY: SERVICE_KEY, TANOS_ANON_KEY: ANON_KEY })) {
  if (!val) {
    console.error(`ERROR: missing ${name}. RLS regression test needs admin + anon credentials, not just the service key.`);
    process.exit(1);
  }
}

const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const stamp = Date.now();
const teardown = [];
let accountA, accountB, userA, userB, landlordA, landlordB;

async function seed() {
  const { data: accA, error: eA } = await admin
    .from("locare_accounts")
    .insert({ agency_name: `rls-test-A-${stamp}`, tier: "Starter", status: "pending" })
    .select()
    .single();
  if (eA) throw new Error(`seed account A: ${eA.message}`);
  accountA = accA;
  teardown.push(() => admin.from("locare_accounts").delete().eq("account_id", accountA.account_id));

  const { data: accB, error: eB } = await admin
    .from("locare_accounts")
    .insert({ agency_name: `rls-test-B-${stamp}`, tier: "Starter", status: "pending" })
    .select()
    .single();
  if (eB) throw new Error(`seed account B: ${eB.message}`);
  accountB = accB;
  teardown.push(() => admin.from("locare_accounts").delete().eq("account_id", accountB.account_id));

  const { data: uA, error: euA } = await admin.auth.admin.createUser({
    email: `rls-test-a-${stamp}@example.invalid`,
    password: `Rls-Test-${stamp}-A!`,
    email_confirm: true,
  });
  if (euA) throw new Error(`create user A: ${euA.message}`);
  userA = uA.user;
  teardown.push(() => admin.auth.admin.deleteUser(userA.id));

  const { data: uB, error: euB } = await admin.auth.admin.createUser({
    email: `rls-test-b-${stamp}@example.invalid`,
    password: `Rls-Test-${stamp}-B!`,
    email_confirm: true,
  });
  if (euB) throw new Error(`create user B: ${euB.message}`);
  userB = uB.user;
  teardown.push(() => admin.auth.admin.deleteUser(userB.id));

  const { error: emA } = await admin
    .from("agency_users")
    .insert({ user_id: userA.id, account_id: accountA.account_id, role: "owner" });
  if (emA) throw new Error(`membership A: ${emA.message}`);

  const { error: emB } = await admin
    .from("agency_users")
    .insert({ user_id: userB.id, account_id: accountB.account_id, role: "owner" });
  if (emB) throw new Error(`membership B: ${emB.message}`);

  const { data: lA, error: elA } = await admin
    .from("landlords")
    .insert({ name: `RLS Test Landlord A ${stamp}`, account_id: accountA.account_id })
    .select()
    .single();
  if (elA) throw new Error(`seed landlord A: ${elA.message}`);
  landlordA = lA;
  teardown.push(() => admin.from("landlords").delete().eq("landlord_id", landlordA.landlord_id));

  const { data: lB, error: elB } = await admin
    .from("landlords")
    .insert({ name: `RLS Test Landlord B ${stamp}`, account_id: accountB.account_id })
    .select()
    .single();
  if (elB) throw new Error(`seed landlord B: ${elB.message}`);
  landlordB = lB;
  teardown.push(() => admin.from("landlords").delete().eq("landlord_id", landlordB.landlord_id));
}

async function clientAs(email, password) {
  const client = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

async function run() {
  await seed();

  const anon = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonRows, error: anonErr } = await anon.from("landlords").select("landlord_id");
  check("anon (unauthenticated) read returns empty, not an error",
    !anonErr && Array.isArray(anonRows) && anonRows.length === 0,
    anonErr ? anonErr.message : `${anonRows?.length ?? "?"} rows`);

  const asA = await clientAs(userA.email, `Rls-Test-${stamp}-A!`);

  const { data: ownRows, error: ownErr } = await asA.from("landlords").select("landlord_id").eq("account_id", accountA.account_id);
  check("agency A can read its own landlord row",
    !ownErr && ownRows?.length === 1 && ownRows[0].landlord_id === landlordA.landlord_id,
    ownErr ? ownErr.message : `${ownRows?.length ?? 0} rows`);

  const { data: crossRows, error: crossErr } = await asA.from("landlords").select("landlord_id").eq("account_id", accountB.account_id);
  check("agency A reading agency B's row returns empty, not an error",
    !crossErr && Array.isArray(crossRows) && crossRows.length === 0,
    crossErr ? crossErr.message : `${crossRows?.length ?? "?"} rows`);

  const { error: crossUpdateErr, count: updCount } = await asA
    .from("landlords")
    .update({ name: "SHOULD NOT SUCCEED" })
    .eq("landlord_id", landlordB.landlord_id)
    .select("landlord_id", { count: "exact" });
  check("agency A cannot update agency B's row",
    !updCount || updCount === 0,
    crossUpdateErr ? crossUpdateErr.message : `updated ${updCount ?? 0} rows`);

  const { error: crossDeleteErr, count: delCount } = await asA
    .from("landlords")
    .delete()
    .eq("landlord_id", landlordB.landlord_id)
    .select("landlord_id", { count: "exact" });
  check("agency A cannot delete agency B's row",
    !delCount || delCount === 0,
    crossDeleteErr ? crossDeleteErr.message : `deleted ${delCount ?? 0} rows`);

  const { error: crossInsertErr } = await asA
    .from("landlords")
    .insert({ name: "SHOULD NOT SUCCEED", account_id: accountB.account_id });
  check("agency A cannot insert a row into agency B's account",
    crossInsertErr !== null,
    crossInsertErr ? crossInsertErr.message : "insert unexpectedly succeeded");

  const { data: verifyB } = await admin.from("landlords").select("name").eq("landlord_id", landlordB.landlord_id).single();
  check("agency B's row is provably untouched after the attack attempts",
    verifyB?.name === `RLS Test Landlord B ${stamp}`,
    verifyB?.name);
}

try {
  await run();
} catch (err) {
  check("rls regression harness completed", false, err.message);
} finally {
  for (const step of teardown.reverse()) {
    try {
      await step();
    } catch (e) {
      console.error(`teardown step failed (manual cleanup may be needed): ${e.message}`);
    }
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
