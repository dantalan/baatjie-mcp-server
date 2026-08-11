#!/usr/bin/env node
/**
 * MCP server for the Baatjie Group.
 *
 * Exposes two Supabase-backed systems through one interface:
 *   tanOS       — property OS, sales pipeline, dependency-aware action plan
 *   sigscheCore — multi-brand signal scheduler
 *
 * Transport defaults to stdio for local clients. Set TRANSPORT=http to run as a
 * streamable-HTTP service instead.
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

const REQUIRED_ENV = [
  "TANOS_URL",
  "TANOS_SERVICE_KEY",
  "SIGSCHE_URL",
  "SIGSCHE_SERVICE_KEY",
] as const;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "baatjie-mcp-server",
    version: "1.0.0",
  });

  registerGenericTools(server);
  registerSequencingTools(server);
  registerOperationsTools(server);
  registerSigscheTools(server);

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

async function runStdio(): Promise<void> {
  checkEnv();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("baatjie-mcp-server running on stdio");
}

async function runHttp(): Promise<void> {
  checkEnv();
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: "baatjie-mcp-server", version: "1.0.0" });
  });

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

  const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  app.listen(port, host, () => {
    console.error(`baatjie-mcp-server running on http://${host}:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(
      [
        "baatjie-mcp-server — MCP interface to tanOS and sigscheCore",
        "",
        "Usage:",
        "  baatjie-mcp-server              Run on stdio (default)",
        "  TRANSPORT=http baatjie-mcp-server   Run as streamable HTTP on PORT (default 3000)",
        "",
        "Required environment:",
        ...REQUIRED_ENV.map((k) => `  ${k}`),
        "",
        "Optional:",
        "  TRANSPORT   'stdio' (default) or 'http'",
        "  PORT        HTTP port (default 3000)",
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
