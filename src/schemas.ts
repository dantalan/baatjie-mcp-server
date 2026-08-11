/**
 * Shared Zod schema fragments.
 *
 * Pagination, formatting and filtering shapes are identical across most tools,
 * so they are defined once here and spread into individual tool schemas.
 */

import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, ResponseFormat } from "./constants.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable, 'json' for machine-readable",
  );

export const limitField = z
  .number()
  .int()
  .min(1, "limit must be at least 1")
  .max(MAX_LIMIT, `limit must not exceed ${MAX_LIMIT}`)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum rows to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`);

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Rows to skip, for pagination");

export const actorField = z
  .string()
  .min(1)
  .max(120)
  .default("mcp")
  .describe(
    "Who is performing this write, recorded in tanOS audit_log " +
      "(e.g. 'baatjie', 'marius-ai', 'deon-ai')",
  );

export const filterSchema = z
  .object({
    column: z.string().min(1).describe("Column name to filter on"),
    op: z
      .enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"])
      .describe(
        "Comparison operator. Use 'is' with null for NULL checks, 'in' with an array, " +
          "'ilike' for case-insensitive pattern match (use % as wildcard)",
      ),
    value: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number()])),
      ])
      .describe("Value to compare against"),
  })
  .strict();

export const filtersField = z
  .array(filterSchema)
  .default([])
  .describe(
    "Filters combined with AND. Example: " +
      '[{"column":"status","op":"eq","value":"open"}]',
  );

export const includePiiField = z
  .boolean()
  .default(false)
  .describe(
    "Include direct personal identifiers (ID numbers, passport numbers, phone, " +
      "email, banking details). Defaults to false so routine queries do not pull " +
      "personal data unnecessarily. Set true only when the task genuinely needs it.",
  );

export const columnsField = z
  .array(z.string())
  .optional()
  .describe(
    "Specific columns to return. Omit for all columns. Narrowing columns is the " +
      "cheapest way to keep large result sets inside the response limit.",
  );
