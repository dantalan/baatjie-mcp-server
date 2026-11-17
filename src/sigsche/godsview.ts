/**
 * godsview: one live read of a property from tanOS. Rooms, the lease on each,
 * what has been paid since the last rent day, notices sent and open tickets.
 *
 * Read-only. It never sends a notice and never changes a record.
 */

import { Project } from "../constants.js";
import { queryRows } from "../services/supabase.js";
import { addDays, todayISO } from "./model.js";

type Row = Record<string, unknown>;
export interface GvInput {
  properties: Row[];
  rooms: Row[];
  leases: Row[];
  tenants: Row[];
  payments: Row[];
  notices: Row[];
  maintenance: Row[];
}
export type GvState = "paid" | "part" | "behind" | "new" | "nolease";
export interface GvRoom {
  room_id: string;
  room_name: string;
  state: GvState;
  tenant: string;
  lease_start: string;
  due: number;
  paid: number;
  last_payment: string;
  notices: number;
  open_tickets: number;
}
export interface Godsview {
  at: string;
  today: string;
  property: string;
  cycle_start: string;
  days_into_cycle: number;
  days_to_rent_day: number;
  rooms: GvRoom[];
  totals: {
    rooms: number;
    occupied: number;
    paid: number;
    part: number;
    behind: number;
    expected: number;
    received: number;
    notices: number;
    open_tickets: number;
  };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const day = (v: unknown): string => text(v).slice(0, 10);
function diff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}
function monthDay(year: number, month: number, d: number): string {
  // month is 0-based and may run outside 0..11; clamp the day to the month's length
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}
/** The most recent rent day on or before today, and the next one after today. */
export function rentCycle(today: string, dueDay: number): { start: string; next: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const thisMonth = monthDay(y, m, dueDay);
  return thisMonth <= today
    ? { start: thisMonth, next: monthDay(y, m + 1, dueDay) }
    : { start: monthDay(y, m - 1, dueDay), next: thisMonth };
}

export function buildGodsview(d: GvInput, today: string): Godsview {
  const property = d.properties[0];
  const propertyId = property ? text(property["property_id"]) : "";
  const rooms = d.rooms.filter((r) => !propertyId || text(r["property_id"]) === propertyId);
  const tenantName = new Map(d.tenants.map((t) => [text(t["tenant_id"]), text(t["full_name"])]));
  const base = rentCycle(today, 28);

  const out: GvRoom[] = rooms.map((r) => {
    const roomId = text(r["room_id"]);
    const due = num(r["rent_base"]) + num(r["water"]) + num(r["electricity"]) + num(r["gardening"]);
    const lease = d.leases
      .filter((l) => text(l["room_id"]) === roomId && text(l["status"]) === "active")
      .sort((a, b) => day(b["start_date"]).localeCompare(day(a["start_date"])))[0];
    const open = d.maintenance.filter((t) => text(t["room_id"]) === roomId && text(t["status"]) !== "resolved" && !t["resolved_at"]).length;
    if (!lease) {
      return { room_id: roomId, room_name: text(r["room_name"]), state: "nolease", tenant: "", lease_start: "", due, paid: 0, last_payment: "", notices: 0, open_tickets: open };
    }
    const leaseId = text(lease["lease_id"]);
    const start = day(lease["start_date"]);
    const cycle = rentCycle(today, num(lease["rent_due_day"]) || 28);
    const pays = d.payments.filter((p) => text(p["lease_id"]) === leaseId);
    const paid = pays.filter((p) => day(p["payment_date"]) >= cycle.start).reduce((n, p) => n + num(p["amount"]), 0);
    const last = pays.map((p) => day(p["payment_date"])).sort().pop() ?? "";
    const state: GvState = paid >= due && due > 0 ? "paid" : paid > 0 ? "part" : start > cycle.start ? "new" : "behind";
    return {
      room_id: roomId,
      room_name: text(r["room_name"]),
      state,
      tenant: tenantName.get(text(lease["tenant_id"])) ?? "",
      lease_start: start,
      due,
      paid,
      last_payment: last,
      notices: d.notices.filter((n) => text(n["lease_id"]) === leaseId).length,
      open_tickets: open,
    };
  });

  const occupied = out.filter((r) => r.state !== "nolease");
  return {
    at: new Date().toISOString(),
    today,
    property: property ? text(property["address"]) : "",
    cycle_start: base.start,
    days_into_cycle: diff(base.start, today),
    days_to_rent_day: diff(today, base.next),
    rooms: out,
    totals: {
      rooms: out.length,
      occupied: occupied.length,
      paid: out.filter((r) => r.state === "paid").length,
      part: out.filter((r) => r.state === "part").length,
      behind: out.filter((r) => r.state === "behind").length,
      expected: occupied.reduce((n, r) => n + r.due, 0),
      received: occupied.reduce((n, r) => n + r.paid, 0),
      notices: out.reduce((n, r) => n + r.notices, 0),
      open_tickets: out.reduce((n, r) => n + r.open_tickets, 0),
    },
  };
}

async function read(table: string, columns?: string[], sinceColumn?: string, since?: string): Promise<Row[]> {
  const { rows } = await queryRows({
    project: Project.TANOS,
    table,
    ...(columns ? { columns } : {}),
    filters: sinceColumn && since ? [{ column: sinceColumn, op: "gte" as const, value: since }] : [],
    limit: 1000,
    offset: 0,
  });
  return rows;
}

/** Read tanOS and build the view. Tenant names only; no ID numbers, phones or emails are read. */
export async function loadGodsview(): Promise<Godsview> {
  const today = todayISO();
  const [properties, rooms, leases, tenants, payments, notices, maintenance] = await Promise.all([
    read("properties", ["property_id", "address", "created_at"]),
    read("rooms"),
    read("leases"),
    read("tenants", ["tenant_id", "full_name"]),
    read("payments", ["lease_id", "amount", "payment_date"], "payment_date", addDays(today, -120)),
    read("notices", ["lease_id", "notice_type", "sent_at"]),
    read("maintenance", ["room_id", "status", "resolved_at"]),
  ]);
  properties.sort((a, b) => text(a["created_at"]).localeCompare(text(b["created_at"])));
  rooms.sort((a, b) => text(a["created_at"]).localeCompare(text(b["created_at"])));
  return buildGodsview({ properties, rooms, leases, tenants, payments, notices, maintenance }, today);
}
