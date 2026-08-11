#!/usr/bin/env node
/**
 * Minimal JSON-RPC exerciser for baatjie-mcp-server over stdio.
 * Verifies the server initialises, registers tools with correct schemas and
 * annotations, and returns well-formed results and errors.
 */

import { spawn } from "node:child_process";

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      /* non-JSON line, ignore */
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }
    }, 20000);
  });
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

try {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness", version: "1.0.0" },
  });
  check("initialize", init.result?.serverInfo?.name === "baatjie-mcp-server",
    init.result?.serverInfo?.name);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await call("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("tools/list returns tools", tools.length > 0, `${tools.length} tools`);

  const names = tools.map((t) => t.name).sort();
  console.log("\n  Tools:", names.join(", "), "\n");

  const expected = [
    "baatjie_describe_schema", "baatjie_query", "baatjie_insert",
    "baatjie_update", "baatjie_delete", "baatjie_next_actions",
    "baatjie_list_todos", "baatjie_create_todo", "baatjie_update_todo",
    "baatjie_dashboard", "baatjie_pipeline", "baatjie_log_activity",
    "baatjie_arrears", "baatjie_signal_queue", "baatjie_schedule_signal",
    "baatjie_brand_snapshot",
  ];
  const missing = expected.filter((e) => !names.includes(e));
  check("all expected tools registered", missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${expected.length}/16`);

  const allAnnotated = tools.every(
    (t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean",
  );
  check("every tool carries annotations", allAnnotated);

  const allDescribed = tools.every((t) => t.description && t.description.length > 120);
  check("every tool has a substantial description", allDescribed);

  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
  const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
  check("read/write split is sane", readOnly.length >= 8 && writers.length >= 5,
    `${readOnly.length} read-only, ${writers.length} write`);

  const del = tools.find((t) => t.name === "baatjie_delete");
  check("delete marked destructive", del?.annotations?.destructiveHint === true);

  const schema = await call("tools/call", {
    name: "baatjie_describe_schema",
    arguments: { response_format: "json" },
  });
  const schemaText = schema.result?.content?.[0]?.text ?? "";
  check("describe_schema executes", schemaText.includes("tanos") && schemaText.includes("todos"));

  const guard = await call("tools/call", {
    name: "baatjie_delete",
    arguments: { project: "tanos", table: "todos", filters: [{ column: "id", op: "eq", value: "x" }], confirm: false },
  });
  const guardText = guard.result?.content?.[0]?.text ?? "";
  check("delete refuses without confirm", guardText.includes("not executed"));

  const badTable = await call("tools/call", {
    name: "baatjie_query",
    arguments: { project: "tanos", table: "not_a_table" },
  });
  const badText = badTable.result?.content?.[0]?.text ?? "";
  check("unknown table gives actionable error",
    badTable.result?.isError === true && badText.includes("Valid tables"));

  const noFilterUpdate = await call("tools/call", {
    name: "baatjie_update",
    arguments: { project: "tanos", table: "todos", patch: { status: "done" }, filters: [] },
  });
  const nfText = noFilterUpdate.result?.content?.[0]?.text ?? "";
  check("unfiltered update refused",
    noFilterUpdate.result?.isError === true && nfText.includes("Refusing"));

  const badArgs = await call("tools/call", {
    name: "baatjie_query",
    arguments: { project: "tanos", table: "todos", limit: 9999 },
  });
  check("zod rejects out-of-range limit",
    badArgs.error !== undefined || badArgs.result?.isError === true);

  const dash = await call("tools/call", {
    name: "baatjie_dashboard",
    arguments: { response_format: "json" },
  });
  const dashOk = (dash.result?.content?.[0]?.text ?? "").includes("clock");
  check("dashboard executes and reports clock", dashOk);

} catch (err) {
  check("harness completed", false, err.message);
} finally {
  child.kill();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
