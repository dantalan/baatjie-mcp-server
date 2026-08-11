/**
 * Shared constants for the Baatjie Group MCP server.
 */

/** Maximum characters in any single tool response before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/** Default page size for list operations. */
export const DEFAULT_LIMIT = 25;

/** Hard ceiling on page size, to keep agent context manageable. */
export const MAX_LIMIT = 200;

/** Request timeout for Supabase calls, milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export enum Project {
  TANOS = "tanos",
  SIGSCHE = "sigsche",
}

/**
 * Table allowlists. Anything not named here is unreachable through this server,
 * which keeps a typo'd table name from silently hitting the wrong data and stops
 * the generic tools becoming an arbitrary-schema backdoor.
 */
export const TANOS_TABLES = [
  "landlords",
  "properties",
  "rooms",
  "tenants",
  "foreign_nationals",
  "leases",
  "lease_agreements",
  "payments",
  "maintenance",
  "notices",
  "audit_log",
  "ai_agents",
  "brms",
  "agents",
  "employers",
  "policies",
  "locare_accounts",
  "daily_activity",
  "todos",
] as const;

export const SIGSCHE_TABLES = [
  "profiles",
  "queue_items",
  "library_items",
  "brand_cards",
  "registration_status",
] as const;

export type TanosTable = (typeof TANOS_TABLES)[number];
export type SigscheTable = (typeof SIGSCHE_TABLES)[number];

/**
 * Columns holding direct personal identifiers. Reads of these tables default to
 * excluding these fields unless the caller explicitly asks for them via
 * `include_pii`, so routine queries don't pull ID numbers and passport numbers
 * into an agent's context for no reason.
 */
export const PII_COLUMNS: Record<string, string[]> = {
  tenants: ["identity_number", "phone", "email"],
  foreign_nationals: ["passport_number"],
  landlords: ["banking_details", "phone", "email"],
  agents: ["surname", "first_name"],
};

/**
 * Tables whose rows describe or act on a named occupant. Writes here are
 * annotated as destructive so a calling agent treats them with the weight they
 * carry -- a notice row is a real message to a real tenant.
 */
export const OCCUPANT_TABLES = new Set([
  "tenants",
  "foreign_nationals",
  "leases",
  "notices",
  "payments",
  "lease_agreements",
]);

/** Angel-number broadcast windows used by sigscheCore, as [hour, minute]. */
export const ANGEL_WINDOWS: Array<[number, number]> = [
  [8, 17],
  [11, 11],
  [13, 13],
  [22, 22],
];

export const SPRINT = {
  factoryStart: [10, 10] as [number, number],
  factoryEnd: [18, 19] as [number, number],
  buildMinutes: 33,
  breakMinutes: 22,
};
