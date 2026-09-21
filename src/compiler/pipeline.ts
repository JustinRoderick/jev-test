import { createHash } from "node:crypto";
import { Schema } from "effect";
import { PipelineSpec, type ColumnSpec } from "../domain/models";
import { appError } from "../domain/errors";

export type Dialect = "duckdb" | "databricks";
export const sqlLiteral = (value: string, dialect: Dialect = "duckdb") =>
  dialect === "databricks"
    ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : `'${value.replaceAll("'", "''")}'`;
export const identifier = (name: string, dialect: Dialect = "duckdb") => {
  const quote = dialect === "duckdb" ? '"' : "`";
  return quote + name.replaceAll(quote, quote + quote) + quote;
};
export const qualified = (name: string) =>
  name
    .split(".")
    .map((n) => identifier(n, "databricks"))
    .join(".");
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const hashContent = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const formats: Record<string, string> = {
  "%Y-%m-%d": "yyyy-MM-dd",
  "%m/%d/%Y": "MM/dd/yyyy",
  "%d/%m/%Y": "dd/MM/yyyy",
  "%Y-%m-%d %H:%M:%S": "yyyy-MM-dd HH:mm:ss",
  "%Y-%m-%dT%H:%M:%SZ": "yyyy-MM-dd'T'HH:mm:ss'Z'",
};

export function validateSpec(input: unknown, sourceColumns?: readonly string[]): PipelineSpec {
  const spec = Schema.decodeUnknownSync(PipelineSpec)(input);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(spec.name))
    throw appError("Use a lowercase SQL name for the Silver table.", "SPEC");
  if (!spec.columns.length || spec.columns.length > 60)
    throw appError("A proposal needs 1–60 columns.", "SPEC");
  const targets = new Set<string>();
  for (const c of spec.columns) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(c.target) || targets.has(c.target))
      throw appError(`Invalid or repeated target column: ${c.target}`, "SPEC");
    targets.add(c.target);
    if (sourceColumns && !sourceColumns.includes(c.source))
      throw appError(`Source column does not exist: ${c.source}`, "SPEC");
    if (
      c.operation === "decimal" &&
      (!Number.isInteger(c.precision) ||
        !Number.isInteger(c.scale) ||
        c.precision! < 1 ||
        c.precision! > 38 ||
        c.scale! < 0 ||
        c.scale! > c.precision!)
    )
      throw appError(`Set valid precision and scale for ${c.target}.`, "SPEC");
    if (["date", "timestamp"].includes(c.operation) && (!c.format || !formats[c.format]))
      throw appError(`Choose an explicit supported date format for ${c.target}.`, "SPEC");
    if (c.operation === "timestamp" && c.timezone !== "UTC")
      throw appError(
        `Timestamp ${c.target} needs an explicit UTC source convention. Other timezone conversions require manual engineering.`,
        "SPEC",
      );
    if (
      c.operation === "enum" &&
      (!c.mapping.length || new Set(c.mapping.map((m) => m.from)).size !== c.mapping.length)
    )
      throw appError(`Enum ${c.target} needs unique source values.`, "SPEC");
    if (
      c.operation === "json" &&
      (!c.jsonPath || !/^\$\.[A-Za-z_][A-Za-z0-9_.]*$/.test(c.jsonPath))
    )
      throw appError("JSON extraction supports simple $.field paths.", "SPEC");
  }
  if (
    spec.dedup &&
    (!spec.dedup.keys.length ||
      !targets.has(spec.dedup.orderBy) ||
      spec.dedup.keys.some((k) => !targets.has(k)))
  )
    throw appError(
      "Deduplication must reference existing target columns and an ordering column.",
      "SPEC",
    );
  return spec;
}

function rawValue(column: ColumnSpec, dialect: Dialect, sourceType = "") {
  const source = identifier(column.source, dialect);
  const complex = /^(STRUCT|MAP|ARRAY|LIST)\b|\[\]$/i.test(sourceType);
  return `CAST(${complex ? `to_json(${source})` : source} AS ${dialect === "duckdb" ? "VARCHAR" : "STRING"})`;
}
function cleaned(column: ColumnSpec, dialect: Dialect, sourceType = "") {
  const s = rawValue(column, dialect, sourceType);
  const value = column.operation === "string" ? s : `TRIM(${s})`;
  return column.nullValues.length
    ? `CASE WHEN ${value} IN (${column.nullValues.map((v) => sqlLiteral(v, dialect)).join(", ")}) THEN NULL ELSE ${value} END`
    : value;
}
function expression(column: ColumnSpec, dialect: Dialect, sourceType = "") {
  const s = cleaned(column, dialect, sourceType);
  const literal = (value: string) => sqlLiteral(value, dialect);
  switch (column.operation) {
    case "string":
    case "trim":
      return s;
    case "integer":
      return `CASE WHEN ${dialect === "duckdb" ? `regexp_full_match(${s}, '[+-]?[0-9]+')` : `${s} RLIKE '^[+-]?[0-9]+$'`} THEN TRY_CAST(${s} AS BIGINT) ELSE NULL END`;
    case "decimal": {
      // Reject excess fractional digits instead of silently rounding money.
      const pattern = `[+-]?[0-9]+${column.scale ? `([.][0-9]{1,${column.scale}})?` : ""}`;
      const matches =
        dialect === "duckdb"
          ? `regexp_full_match(${s}, ${literal(pattern)})`
          : `${s} RLIKE ${literal(`^${pattern}$`)}`;
      return `CASE WHEN ${matches} THEN TRY_CAST(${s} AS DECIMAL(${column.precision}, ${column.scale})) ELSE NULL END`;
    }
    case "boolean":
      return `CASE WHEN LOWER(${s}) IN ('true', '1', 'yes') THEN TRUE WHEN LOWER(${s}) IN ('false', '0', 'no') THEN FALSE ELSE NULL END`;
    case "date":
    case "timestamp": {
      const parse =
        dialect === "duckdb"
          ? `try_strptime(${s}, ${literal(column.format!)})`
          : `try_to_timestamp(${s}, ${literal(formats[column.format!])})`;
      return column.operation === "date" ? `CAST(${parse} AS DATE)` : parse;
    }
    case "enum":
      return `CASE ${s} ${column.mapping.map((m) => `WHEN ${literal(m.from)} THEN ${literal(m.to)}`).join(" ")} ELSE NULL END`;
    case "json":
      return dialect === "duckdb"
        ? `TRY(json_extract_string(${s}, ${literal(column.jsonPath!)}))`
        : `get_json_object(${s}, ${literal(column.jsonPath!)})`;
  }
}

export function compile(
  specInput: PipelineSpec,
  sourceSql: string,
  dialect: Dialect,
  sourceTypes: Record<string, string> = {},
) {
  const spec = validateSpec(specInput);
  const id = (s: string) => identifier(s, dialect);
  const columns = spec.columns.map((c) => id(c.target));
  const shaped = spec.columns.flatMap((c, i) => [
    `${rawValue(c, dialect, sourceTypes[c.source])} AS ${id(`_sl_original_${i}`)}`,
    `${cleaned(c, dialect, sourceTypes[c.source])} AS ${id(`_sl_raw_${i}`)}`,
    `${expression(c, dialect, sourceTypes[c.source])} AS ${id(c.target)}`,
  ]);
  const reasons = spec.columns.map((c, i) => {
    const missing = c.required
      ? `${id(c.target)} IS NULL`
      : `(${id(`_sl_raw_${i}`)} IS NOT NULL AND ${id(c.target)} IS NULL)`;
    return { target: c.target, expression: missing, flag: `_sl_bad_${i}` };
  });
  const dedupNulls = spec.dedup
    ? [...spec.dedup.keys, spec.dedup.orderBy].map((k) => `${id(k)} IS NULL`).join(" OR ")
    : "FALSE";
  const bad = [...reasons.map((r) => r.expression), dedupNulls].join(" OR ");
  const rank = spec.dedup
    ? `ROW_NUMBER() OVER (PARTITION BY _sl_bad, ${spec.dedup.keys.map(id).join(", ")} ORDER BY ${id(spec.dedup.orderBy)} ${spec.dedup.direction.toUpperCase()}, _sl_row_id)`
    : "1";
  const base = `WITH raw AS (${sourceSql}),
shaped AS (SELECT _sl_row_id, ${shaped.join(",\n  ")} FROM raw),
flagged AS (SELECT *, (${bad}) AS _sl_bad, ${reasons.map((r) => `(${r.expression}) AS ${id(r.flag)}`).join(", ")} FROM shaped),
ranked AS (SELECT *, ${rank} AS _sl_rank FROM flagged),
classified AS (SELECT *, CASE WHEN _sl_bad THEN 'quarantine' WHEN _sl_rank > 1 THEN 'duplicate' ELSE 'accepted' END AS _sl_disposition FROM ranked)`;
  const reasonSql = `concat_ws('; ', ${[...reasons.map((r) => `CASE WHEN ${id(r.flag)} THEN ${sqlLiteral(`${r.target}: missing or invalid value`)} ELSE NULL END`), `CASE WHEN ${dedupNulls} THEN 'missing deduplication key or order' ELSE NULL END`].join(", ")})`;
  const preview = `${base} SELECT _sl_row_id, ${columns.join(", ")} FROM classified WHERE _sl_disposition = 'accepted' ORDER BY _sl_row_id LIMIT 100`;
  const quarantine = `${base} SELECT _sl_row_id, ${columns.join(", ")}, ${reasonSql} AS _sl_reason FROM classified WHERE _sl_disposition = 'quarantine' ORDER BY _sl_row_id LIMIT 100`;
  const metrics = `${base} SELECT COUNT(*) AS input_rows, SUM(CASE WHEN _sl_disposition = 'accepted' THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN _sl_disposition = 'quarantine' THEN 1 ELSE 0 END) AS quarantined, SUM(CASE WHEN _sl_disposition = 'duplicate' THEN 1 ELSE 0 END) AS duplicates, ${reasons.map((r) => `SUM(CASE WHEN ${id(r.flag)} THEN 1 ELSE 0 END) AS ${id(r.flag)}`).join(", ")} FROM classified`;
  const ties = spec.dedup
    ? `${base} SELECT COUNT(*) AS ties FROM (SELECT ${spec.dedup.keys.map(id).join(", ")}, ${id(spec.dedup.orderBy)} FROM flagged WHERE NOT _sl_bad GROUP BY ${[...spec.dedup.keys, spec.dedup.orderBy].map(id).join(", ")} HAVING COUNT(*) > 1) t`
    : `SELECT 0 AS ties`;
  const silver = `${base} SELECT ${columns.join(", ")} FROM classified WHERE _sl_disposition = 'accepted'`;
  const rawColumns = spec.columns.map((_, i) => id(`_sl_original_${i}`));
  const quarantineAll = `${base} SELECT _sl_row_id, ${rawColumns.join(", ")}, ${columns.join(", ")}, ${reasonSql} AS _sl_reason FROM classified WHERE _sl_disposition = 'quarantine'`;
  const duplicateAll = `${base} SELECT _sl_row_id, ${rawColumns.join(", ")}, ${columns.join(", ")} FROM classified WHERE _sl_disposition = 'duplicate'`;
  return { base, metrics, ties, preview, quarantine, silver, quarantineAll, duplicateAll, reasons };
}

export function databricksBundle(
  spec: PipelineSpec,
  sourceName = "catalog.bronze.source_table",
  sourceTypes: Record<string, string> = {},
) {
  const query = compile(
    spec,
    `SELECT ROW_NUMBER() OVER (ORDER BY 1) AS _sl_row_id, * FROM ${qualified(sourceName)}`,
    "databricks",
    sourceTypes,
  );
  const expectations = spec.columns
    .filter((c) => c.required)
    .map(
      (c) =>
        `CONSTRAINT ${identifier(`required_${c.target}`, "databricks")} EXPECT (${identifier(c.target, "databricks")} IS NOT NULL) ON VIOLATION FAIL UPDATE`,
    );
  const pipeline = `-- Silverline proposal. Batch semantics; Lakeflow runtime validation is separate.\n-- Use a test catalog/schema first. UTC source convention is required for timestamp operations.\nSET TIME ZONE 'UTC';\n\nCREATE OR REFRESH MATERIALIZED VIEW ${identifier(spec.name, "databricks")}\n${expectations.length ? `(\n  ${expectations.join(",\n  ")}\n)` : ""}\nAS ${query.silver};\n\nCREATE OR REFRESH MATERIALIZED VIEW ${identifier(`${spec.name}_quarantine`, "databricks")} AS ${query.quarantineAll};\n\nCREATE OR REFRESH MATERIALIZED VIEW ${identifier(`${spec.name}_duplicates`, "databricks")} AS ${query.duplicateAll};\n`;
  return {
    pipeline,
    transformation: `${query.silver};`,
    validation: `${query.metrics};\n\n${query.ties};`,
  };
}
