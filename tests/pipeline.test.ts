import { describe, test, expect } from "vite-plus/test";
import { Effect, Schema } from "effect";
import { Evidence } from "../src/domain/models";
import { LocalEngine } from "../src/adapters/duckdb/engine";
import { compile, validateSpec } from "../src/compiler/pipeline";
import { fixtureSpec, ordersFixture } from "../fixtures/orders";
import { harness } from "./helpers";

describe("executed transformations", () => {
  test("nested JSON profiles serialize safely and JSON fields extract from native structs", async () => {
    const h = await harness([
      { payload: { customer: { id: "00123" } } },
      { payload: { customer: { id: "00456" } } },
    ]);
    try {
      const result = await h.runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* LocalEngine;
          const evidence = yield* engine.profile(h.source, "Nested customer payload");
          Schema.decodeUnknownSync(Evidence)(evidence);
          expect(JSON.parse(String(evidence.preview[0].payload))).toEqual({
            customer: { id: "00123" },
          });
          const spec = {
            ...fixtureSpec,
            dedup: null,
            columns: [
              {
                ...fixtureSpec.columns[0],
                source: "payload",
                target: "customer_id",
                operation: "json" as const,
                jsonPath: "$.customer.id",
              },
            ],
          };
          return yield* engine.validate(h.source, spec, evidence);
        }),
      );
      expect(result.passed).toBe(true);
      expect(result.preview.map((r) => r.customer_id)).toEqual(["00123", "00456"]);
    } finally {
      await h.dispose();
    }
  });
  test("accounts for all rows, preserves identifiers, quarantines invalid values", async () => {
    const h = await harness();
    try {
      const result = await h.runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* LocalEngine;
          const evidence = yield* engine.profile(h.source, h.source.description);
          return yield* engine.validate(h.source, fixtureSpec, evidence);
        }),
      );
      expect(result).toMatchObject({
        passed: true,
        inputRows: 1224,
        accepted: 1180,
        quarantined: 20,
        duplicates: 24,
        databricks: "not_run",
        lakeflow: "not_run",
      });
      expect(result.preview[0].order_id).toMatch(/^0/);
      expect(result.quarantine.every((r) => r._sl_reason)).toBe(true);
    } finally {
      await h.dispose();
    }
  });
  test("ambiguous key/order ties block approval", async () => {
    const row = ordersFixture()[1];
    const h = await harness([row, { ...row, order_total: "99.99" }]);
    try {
      const result = await h.runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* LocalEngine;
          return yield* engine.validate(h.source, fixtureSpec, yield* engine.profile(h.source, ""));
        }),
      );
      expect(result.passed).toBe(false);
      expect(result.tests.find((t) => t.name.includes("deduplication"))?.passed).toBe(false);
    } finally {
      await h.dispose();
    }
  });
  test("rejects decimal rounding, overflow, and invalid integer coercion", async () => {
    const h = await harness([
      { v: "12.345" },
      { v: "99999999" },
      { v: "12.34" },
      { v: "7" },
      { v: "1.5" },
    ]);
    try {
      const base = {
        ...fixtureSpec,
        dedup: null,
        columns: [
          { ...fixtureSpec.columns[3], source: "v", target: "value", precision: 5, scale: 2 },
        ],
      };
      const results = await h.runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* LocalEngine;
          const evidence = yield* engine.profile(h.source, "");
          const decimal = yield* engine.validate(h.source, base, evidence);
          const integer = yield* engine.validate(
            h.source,
            { ...base, columns: [{ ...base.columns[0], operation: "integer" }] },
            evidence,
          );
          return { decimal, integer };
        }),
      );
      expect(results.decimal.quarantined).toBe(2);
      expect(results.integer.quarantined).toBe(3);
    } finally {
      await h.dispose();
    }
  });
  test("rejects internal column collisions", async () => {
    const h = await harness([{ _sl_row_id: 1, value: "x" }]);
    try {
      await expect(
        h.runtime.runPromise(
          Effect.gen(function* () {
            return yield* (yield* LocalEngine).profile(h.source, "");
          }),
        ),
      ).rejects.toThrow("reserved");
    } finally {
      await h.dispose();
    }
  });
});

test("compiler restricts operations and quotes source names and literals", () => {
  expect(() => validateSpec({ ...fixtureSpec, name: "orders; DROP TABLE source" })).toThrow();
  expect(() =>
    validateSpec({
      ...fixtureSpec,
      columns: [{ ...fixtureSpec.columns[0], operation: "raw_sql" }],
    }),
  ).toThrow();
  expect(() =>
    validateSpec({ ...fixtureSpec, columns: [{ ...fixtureSpec.columns[2], timezone: null }] }),
  ).toThrow("UTC");
  const sql = compile(
    {
      ...fixtureSpec,
      dedup: null,
      columns: [
        { ...fixtureSpec.columns[0], source: 'a"b', nullValues: ["x'); DROP TABLE bronze; --"] },
      ],
    },
    "SELECT * FROM bronze",
    "duckdb",
  );
  expect(sql.silver).toContain('"a""b"');
  expect(sql.silver).toContain("'x''); DROP TABLE bronze; --'");
  expect(sql.quarantineAll).toContain("_sl_original_0");
});
