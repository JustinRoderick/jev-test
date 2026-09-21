import type { PipelineSpec } from "../src/domain/models";

export const fixtureDescription =
  "Synthetic commerce orders. Order and customer IDs preserve leading zeros. order_total is USD in dollars. ordered_at and updated_at use UTC and YYYY-MM-DD HH:mm:ss. Status codes: P=paid, S=shipped, C=cancelled. Latest updated_at wins for repeated order_id. Country codes are uppercase ISO alpha-2.";

export function ordersFixture() {
  const rows: Record<string, string>[] = [];
  const countries = ["US", "GB", "CA", "DE", "AU"];
  for (let i = 1; i <= 1200; i++) {
    const row = {
      order_id: String(i).padStart(7, "0"),
      customer_ref: `  ${String(1000 + (i % 180)).padStart(6, "0")}  `,
      ordered_at: `2026-09-${String((i % 18) + 1).padStart(2, "0")} 10:30:00`,
      order_total: (19 + ((i * 37) % 28000) / 100).toFixed(2),
      status: ["P", "S", "C"][i % 3],
      country: countries[i % 5],
      updated_at: `2026-09-${String((i % 18) + 1).padStart(2, "0")} 12:00:00`,
    };
    if (i % 113 === 0) row.order_total = "pending";
    if (i % 197 === 0) row.ordered_at = "yesterday";
    if (i % 251 === 0) row.status = "?";
    rows.push(row);
    if (i % 50 === 0)
      rows.push({
        ...row,
        updated_at: row.updated_at.replace("12:00", "13:00"),
        order_total: "49.00",
      });
  }
  return rows;
}

export const fixtureSpec: PipelineSpec = {
  version: 1,
  name: "orders_silver",
  description:
    "Validated commerce orders with stable identifiers, USD amounts, UTC timestamps, and canonical statuses.",
  columns: [
    {
      source: "order_id",
      target: "order_id",
      operation: "trim",
      required: true,
      rationale: "Keep leading zeros: source documentation identifies a business identifier.",
    },
    {
      source: "customer_ref",
      target: "customer_id",
      operation: "trim",
      required: true,
      rationale: "Remove surrounding whitespace while preserving identifier characters.",
    },
    {
      source: "ordered_at",
      target: "ordered_at",
      operation: "timestamp",
      required: true,
      format: "%Y-%m-%d %H:%M:%S",
      timezone: "UTC",
      rationale: "The supplied source contract explicitly states UTC.",
    },
    {
      source: "order_total",
      target: "amount_usd",
      operation: "decimal",
      required: true,
      precision: 12,
      scale: 2,
      rationale: "Source contract specifies USD dollars; keep two decimal places.",
    },
    {
      source: "status",
      target: "status",
      operation: "enum",
      required: true,
      mapping: [
        { from: "P", to: "paid" },
        { from: "S", to: "shipped" },
        { from: "C", to: "cancelled" },
      ],
      rationale: "Map documented codes; quarantine unrecognized values.",
    },
    {
      source: "country",
      target: "country",
      operation: "trim",
      required: true,
      rationale: "Preserve the supplied country code.",
    },
    {
      source: "updated_at",
      target: "updated_at",
      operation: "timestamp",
      required: true,
      format: "%Y-%m-%d %H:%M:%S",
      timezone: "UTC",
      rationale: "Use documented event ordering to select the most recent order.",
    },
  ].map((c) => ({
    nullValues: ["", "N/A", "null"],
    format: null,
    timezone: null,
    precision: null,
    scale: null,
    mapping: [],
    jsonPath: null,
    ...c,
  })) as PipelineSpec["columns"],
  dedup: { keys: ["order_id"], orderBy: "updated_at", direction: "desc" },
  assumptions: [
    "Source documentation defines USD dollars and UTC timestamps.",
    "Latest updated_at represents the authoritative order version.",
  ],
  unresolved: [],
};
