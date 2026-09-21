import { DuckDBInstance } from "@duckdb/node-api";
import { Context, Effect, Layer } from "effect";
import type { Evidence, Row, Source, PipelineSpec, Validation } from "../../domain/models";
import { appError, errorMessage } from "../../domain/errors";
import { compile, hash, identifier, sqlLiteral, validateSpec } from "../../compiler/pipeline";

type Query = (sql: string) => Promise<Row[]>;
const safeRows = (values: unknown): Row[] => {
  const rows = JSON.parse(
    JSON.stringify(values, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  ) as Record<string, unknown>[];
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value !== null && typeof value === "object" ? JSON.stringify(value) : value,
        ]),
      ) as Row,
  );
};

async function withLocal<A>(
  source: Source,
  run: (query: Query, rawSql: string) => Promise<A>,
  signal?: AbortSignal,
) {
  const instance = await DuckDBInstance.create(":memory:", { threads: "2", memory_limit: "256MB" });
  const connection = await instance.connect();
  const interrupt = () => connection.interrupt();
  signal?.addEventListener("abort", interrupt, { once: true });
  const query: Query = async (sql) => {
    if (signal?.aborted) throw appError("Run cancelled.", "CANCELLED");
    return safeRows((await connection.runAndReadAll(sql)).getRowObjectsJson());
  };
  try {
    const file = sqlLiteral(source.path);
    const read =
      source.format === "csv"
        ? `read_csv(${file}, header=true, all_varchar=true)`
        : source.format === "parquet"
          ? `read_parquet(${file})`
          : `read_json_auto(${file}, format='newline_delimited')`;
    await query(`SET TimeZone='UTC'`);
    const sourceFields = await query(`DESCRIBE SELECT * FROM ${read}`);
    if (sourceFields.some((f) => String(f.column_name).startsWith("_sl_")))
      throw appError("Source columns cannot use the reserved _sl_ prefix.", "SOURCE");
    await query(`CREATE TABLE bronze AS SELECT ROW_NUMBER() OVER () AS _sl_row_id, * FROM ${read}`);
    const fields = await query("DESCRIBE bronze");
    if (
      fields.some((f) => String(f.column_name).startsWith("_sl_") && f.column_name !== "_sl_row_id")
    )
      throw appError("Source columns cannot use the reserved _sl_ prefix.", "SOURCE");
    // External file access is needed only to import the selected file.
    await query("SET enable_external_access=false");
    return await run(query, "SELECT * FROM bronze");
  } finally {
    signal?.removeEventListener("abort", interrupt);
    connection.closeSync();
    instance.closeSync();
  }
}

export async function profileQuery(
  query: Query,
  rawSql: string,
  source: Source,
  context: string,
  dialect: "duckdb" | "databricks",
  snapshot: number | null = null,
): Promise<Evidence> {
  const id = (s: string) => identifier(s, dialect);
  const types =
    dialect === "duckdb" ? await query("DESCRIBE bronze") : await query(`DESCRIBE QUERY ${rawSql}`);
  const fields = types
    .map((r) => ({
      name: String(r.column_name ?? r.col_name),
      type: String(r.column_type ?? r.data_type),
    }))
    .filter((c) => !c.name.startsWith("_sl_"));
  if (!fields.length || fields.length > 60)
    throw appError("Choose a source with 1–60 columns for this POC.", "SOURCE");
  const count = await query(`WITH src AS (${rawSql}) SELECT COUNT(*) AS n FROM src`);
  const rowCount = Number(count[0].n);
  if (!rowCount) throw appError("This source contains no rows.", "SOURCE");
  const columns = [];
  for (const f of fields) {
    const col = id(f.name);
    const cast = `CAST(${col} AS ${dialect === "duckdb" ? "VARCHAR" : "STRING"})`;
    const metrics = await query(
      `WITH src AS (${rawSql}) SELECT COUNT(*) - COUNT(${col}) AS nulls, COUNT(DISTINCT ${cast}) AS distinct_count, SUM(CASE WHEN TRIM(${cast}) = '' THEN 1 ELSE 0 END) AS blanks, SUM(CASE WHEN TRY_CAST(${cast} AS DOUBLE) IS NOT NULL THEN 1 ELSE 0 END) AS numeric_count FROM src`,
    );
    const top = await query(
      `WITH src AS (${rawSql}) SELECT ${cast} AS value, COUNT(*) AS n FROM src GROUP BY ${cast} ORDER BY n DESC, value LIMIT 5`,
    );
    const rare = await query(
      `WITH src AS (${rawSql}) SELECT ${cast} AS value, COUNT(*) AS n FROM src WHERE ${col} IS NOT NULL GROUP BY ${cast} ORDER BY n ASC, value LIMIT 5`,
    );
    columns.push({
      name: f.name,
      type: f.type,
      rows: rowCount,
      nulls: Number(metrics[0].nulls),
      distinct: Number(metrics[0].distinct_count),
      numeric: Number(metrics[0].numeric_count),
      blanks: Number(metrics[0].blanks),
      topValues: top.map((r) => ({
        value: r.value === null ? null : String(r.value),
        count: Number(r.n),
      })),
      examples: rare.map((r) => String(r.value)),
    });
  }
  return {
    sourceId: source.id,
    sourceName: source.name,
    fingerprint: source.fingerprint,
    columns,
    rowCount,
    preview: await query(`WITH src AS (${rawSql}) SELECT * FROM src LIMIT 12`),
    collectedAt: new Date().toISOString(),
    coverage:
      dialect === "duckdb"
        ? "Full local file · exact counts; bounded top/rare examples"
        : "Bounded remote snapshot · up to 10,000 rows; counts apply to this subset",
    engine: dialect === "duckdb" ? "DuckDB 1.5" : "Databricks SQL",
    context,
    snapshot,
  };
}

export async function validateQuery(
  query: Query,
  rawSql: string,
  spec: PipelineSpec,
  evidence: Evidence,
  dialect: "duckdb" | "databricks",
): Promise<Validation> {
  validateSpec(
    spec,
    evidence.columns.map((c) => c.name),
  );
  const compiled = compile(
    spec,
    rawSql,
    dialect,
    Object.fromEntries(evidence.columns.map((c) => [c.name, c.type])),
  );
  const metrics = (await query(compiled.metrics))[0];
  const counts = {
    inputRows: Number(metrics.input_rows),
    accepted: Number(metrics.accepted ?? 0),
    quarantined: Number(metrics.quarantined ?? 0),
    duplicates: Number(metrics.duplicates ?? 0),
  };
  const ties = Number((await query(compiled.ties))[0].ties);
  const preview = await query(compiled.preview);
  const replay = await query(compiled.preview);
  const tests = [
    {
      name: "Every source row accounted for",
      passed: counts.inputRows === counts.accepted + counts.quarantined + counts.duplicates,
      detail: `${counts.accepted} accepted + ${counts.quarantined} quarantined + ${counts.duplicates} duplicate versions = ${counts.inputRows}`,
    },
    {
      name: "Source snapshot matches evidence",
      passed: counts.inputRows === evidence.rowCount,
      detail: `${counts.inputRows} rows executed; ${evidence.rowCount} rows profiled`,
    },
    {
      name: "Unambiguous deduplication order",
      passed: ties === 0,
      detail: ties
        ? `${ties} key/order ties require a better tie policy.`
        : "No duplicate key/order ties.",
    },
    {
      name: "Silver output is nonempty",
      passed: counts.accepted > 0,
      detail: `${counts.accepted} accepted rows`,
    },
    {
      name: "No unresolved assumptions",
      passed: spec.unresolved.length === 0,
      detail: spec.unresolved.join("; ") || "All required decisions are specified.",
    },
    {
      name: "Preview replay is deterministic",
      passed: hash(preview) === hash(replay),
      detail: "Compared two executions of the first 100 accepted rows on this snapshot.",
    },
  ];
  return {
    ...counts,
    passed: tests.every((t) => t.passed),
    engine: evidence.engine,
    coverage: evidence.coverage,
    executedAt: new Date().toISOString(),
    specHash: hash(spec),
    fingerprint: evidence.fingerprint,
    tests,
    rules: compiled.reasons.map((r) => ({
      column: r.target,
      failures: Number(metrics[r.flag] ?? 0),
    })),
    preview,
    quarantine: await query(compiled.quarantine),
    databricks:
      dialect === "databricks" ? (tests.every((t) => t.passed) ? "passed" : "failed") : "not_run",
    lakeflow: "not_run",
  };
}

export class LocalEngine extends Context.Service<
  LocalEngine,
  {
    profile: (
      source: Source,
      context: string,
    ) => Effect.Effect<Evidence, import("../../domain/errors").AppError>;
    validate: (
      source: Source,
      spec: PipelineSpec,
      evidence: Evidence,
    ) => Effect.Effect<Validation, import("../../domain/errors").AppError>;
  }
>()("silverline/LocalEngine") {}
export const LocalEngineLive = Layer.succeed(LocalEngine, {
  profile: (source, context) =>
    Effect.tryPromise({
      try: (signal) =>
        withLocal(source, (q, raw) => profileQuery(q, raw, source, context, "duckdb"), signal),
      catch: (e) => appError(errorMessage(e), "PROFILE"),
    }).pipe(Effect.withSpan("data.profile.local")),
  validate: (source, spec, evidence) =>
    Effect.tryPromise({
      try: (signal) =>
        withLocal(source, (q, raw) => validateQuery(q, raw, spec, evidence, "duckdb"), signal),
      catch: (e) => appError(errorMessage(e), "VALIDATION"),
    }).pipe(Effect.withSpan("data.validate.local")),
});
