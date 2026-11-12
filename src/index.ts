#!/usr/bin/env node
/**
 * MCP server for the Baatjie Group.
 *
 * One master server for three systems:
 *   tanOS       — property OS, sales pipeline, dependency-aware action plan (Supabase)
 *   sigscheCore — multi-brand signal queue (Supabase)
 *   sigsche     — the sigsche.co.za dashboard: brands, 33 platforms, signals,
 *                 leads, Taluna, sign-in and upload (local, on this computer)
 *
 * Whichever way it starts, it also serves the sigsche dashboard and the MCP
 * endpoint on http://localhost:8641 (PORT). stdio is the default transport for
 * Claude Desktop; TRANSPORT=http runs the HTTP service alone.
 */

// Loads .env into process.env. Variables already present in the environment take
// precedence, so run.ps1 or a shell export overrides the file rather than the
// other way round.
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { registerGenericTools } from "./tools/generic.js";
import { registerSequencingTools } from "./tools/sequencing.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerSigscheTools } from "./tools/sigsche.js";
import { registerSigscheLocalTools } from "./tools/sigsche-local.js";
import { registerSigscheAccountTools } from "./tools/sigsche-accounts.js";
import { localOnly, mountSigsche } from "./sigsche/http.js";

const VERSION = "2.0.0";

const REQUIRED_ENV = [
  "TANOS_URL",
  "TANOS_SERVICE_KEY",
  "SIGSCHE_URL",
  "SIGSCHE_SERVICE_KEY",
] as const;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "baatjie-mcp-server",
    version: VERSION,
  });

  registerGenericTools(server);
  registerSequencingTools(server);
  registerOperationsTools(server);
  registerSigscheTools(server);
  registerSigscheLocalTools(server);
  registerSigscheAccountTools(server);

  return server;
}

function checkEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // stdio servers must never write to stdout — it corrupts the protocol stream.
    console.error(
      `ERROR: missing required environment variable(s): ${missing.join(", ")}\n` +
        `Copy .env.example and fill in both project URLs and service keys.`,
    );
    process.exit(1);
  }
}

/** The dashboard, its local API and the MCP endpoint on one localhost port. */
function startHttp(): Promise<boolean> {
  const app = express();
  app.use(localOnly);
  app.use(express.json({ limit: "24mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: "baatjie-mcp-server", version: VERSION });
  });

  mountSigsche(app);

  app.post("/mcp", async (req, res) => {
    // A fresh stateless transport per request keeps request ids from colliding
    // across concurrent clients.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
    });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = Number.parseInt(process.env["PORT"] ?? "8641", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  return new Promise<boolean>((resolve) => {
    const listener = app.listen(port, host, () => {
      console.error(`sigsche dashboard on http://localhost:${port}/  ·  MCP on http://localhost:${port}/mcp`);
      resolve(true);
    });
    listener.on("error", (err: NodeJS.ErrnoException) => {
      // Another copy of this server already holds the port (Claude Desktop's
      // stdio copy and a standalone copy can both be running): that one serves.
      console.error(
        err.code === "EADDRINUSE"
          ? `Port ${port} is already served by another baatjie-mcp-server; not starting a second dashboard.`
          : `HTTP did not start: ${err.message}`,
      );
      resolve(false);
    });
  });
}

async function runStdio(): Promise<void> {
  checkEnv();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("baatjie-mcp-server running on stdio");
  if (process.env["SIGSCHE_HTTP"] !== "off") await startHttp();
}

async function runHttp(): Promise<void> {
  checkEnv();
  const ok = await startHttp();
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(
      [
        "baatjie-mcp-server — tanOS, sigscheCore and the sigsche dashboard",
        "",
        "Usage:",
        "  baatjie-mcp-server              Run on stdio (default)",
        "  TRANSPORT=http baatjie-mcp-server   Run the dashboard + streamable HTTP only",
        "",
        "Required environment:",
        ...REQUIRED_ENV.map((k) => `  ${k}`),
        "",
        "Optional:",
        "  TRANSPORT   'stdio' (default) or 'http'",
        "  PORT        HTTP port (default 8641)",
        "  SIGSCHE_HTTP=off   Do not serve the dashboard from the stdio process",
        "  HOST        HTTP bind address (default 127.0.0.1)",
      ].join("\n"),
    );
    process.exit(0);
  }

  const transport = process.env["TRANSPORT"] ?? "stdio";
  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Fatal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
