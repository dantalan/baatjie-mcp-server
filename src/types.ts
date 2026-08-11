/**
 * Shared type definitions for the Baatjie Group MCP server.
 */

export interface PaginatedResult<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
  truncated?: boolean;
  truncation_message?: string;
}

export interface MutationResult {
  ok: boolean;
  table: string;
  action: "insert" | "update" | "delete";
  affected: number;
  rows?: Record<string, unknown>[];
  audit_logged: boolean;
  note?: string;
}

export interface TodoRow {
  id: string;
  title: string;
  detail: string | null;
  category: string;
  product: string;
  priority: "critical" | "high" | "medium" | "low";
  status: "open" | "in_progress" | "done" | "blocked";
  wave: number | null;
  track: string | null;
  blocked_by: string[] | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
}

export interface SequencedTodo extends TodoRow {
  open_blockers: number;
  startable: boolean;
  unblocks: number;
}

export interface DashboardCounts {
  [table: string]: number | null;
}

export interface BrmPipelineRow {
  brm_id: string;
  display_name?: string;
  inherited_book_size: number;
  accounts_signed: number;
  outreach: number;
  demos: number;
  sales: number;
}

/** A row from tanOS `leases` joined with what's needed to judge arrears. */
export interface ArrearsRow {
  lease_id: string;
  tenant_id: string | null;
  room_id: string | null;
  rent_due_day: number;
  status: string;
  last_payment_date: string | null;
  days_since_payment: number | null;
  total_paid: number;
  notices_sent: number;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
