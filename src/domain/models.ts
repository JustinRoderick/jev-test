import { Schema } from "effect";

export const Operation = Schema.Literals([
  "string",
  "trim",
  "integer",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "enum",
  "json",
]);
export const ColumnSpec = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
  operation: Operation,
  required: Schema.Boolean,
  nullValues: Schema.Array(Schema.String),
  // Optional operation parameters use null so strict JSON Schema is portable.
  format: Schema.NullOr(Schema.String),
  timezone: Schema.NullOr(Schema.Literals(["UTC", "preserve"])),
  precision: Schema.NullOr(Schema.Number),
  scale: Schema.NullOr(Schema.Number),
  mapping: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  jsonPath: Schema.NullOr(Schema.String),
  rationale: Schema.String,
});
export type ColumnSpec = typeof ColumnSpec.Type;
export const PipelineSpec = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  description: Schema.String,
  columns: Schema.Array(ColumnSpec),
  dedup: Schema.NullOr(
    Schema.Struct({
      keys: Schema.Array(Schema.String),
      orderBy: Schema.String,
      direction: Schema.Literals(["asc", "desc"]),
    }),
  ),
  assumptions: Schema.Array(Schema.String),
  unresolved: Schema.Array(Schema.String),
});
export type PipelineSpec = typeof PipelineSpec.Type;

export const Cell = Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));
export const Row = Schema.Record(Schema.String, Cell);
export type Row = typeof Row.Type;
export const Source = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["sample", "file", "databricks"]),
  path: Schema.String,
  format: Schema.Literals(["csv", "jsonl", "parquet", "table"]),
  createdAt: Schema.String,
  description: Schema.String,
  size: Schema.Number,
  fingerprint: Schema.String,
  table: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
  warehouseId: Schema.NullOr(Schema.String),
});
export type Source = typeof Source.Type;
export const ColumnProfile = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  rows: Schema.Number,
  nulls: Schema.Number,
  distinct: Schema.Number,
  numeric: Schema.Number,
  blanks: Schema.Number,
  topValues: Schema.Array(
    Schema.Struct({ value: Schema.NullOr(Schema.String), count: Schema.Number }),
  ),
  examples: Schema.Array(Schema.String),
});
export type ColumnProfile = typeof ColumnProfile.Type;
export const Evidence = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
  fingerprint: Schema.String,
  rowCount: Schema.Number,
  columns: Schema.Array(ColumnProfile),
  preview: Schema.Array(Row),
  collectedAt: Schema.String,
  coverage: Schema.String,
  engine: Schema.String,
  context: Schema.String,
  snapshot: Schema.NullOr(Schema.Number),
});
export type Evidence = typeof Evidence.Type;
export const Judgment = Schema.Struct({
  column: Schema.String,
  question: Schema.String,
  kind: Schema.Literals(["choice", "noul", "score"]),
  answer: Schema.String,
  value: Schema.Number,
  confidence: Schema.NullOr(Schema.Number),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  review: Schema.Boolean,
});
export type Judgment = typeof Judgment.Type;
export const ModelCall = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  requestedModel: Schema.optional(Schema.String),
  milliseconds: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  mode: Schema.Literals(["fixture", "live"]),
});
export type ModelCall = typeof ModelCall.Type;
export const Validation = Schema.Struct({
  passed: Schema.Boolean,
  engine: Schema.String,
  coverage: Schema.String,
  executedAt: Schema.String,
  specHash: Schema.String,
  fingerprint: Schema.String,
  inputRows: Schema.Number,
  accepted: Schema.Number,
  quarantined: Schema.Number,
  duplicates: Schema.Number,
  tests: Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, detail: Schema.String }),
  ),
  rules: Schema.Array(Schema.Struct({ column: Schema.String, failures: Schema.Number })),
  preview: Schema.Array(Row),
  quarantine: Schema.Array(Row),
  databricks: Schema.Literals(["passed", "failed", "not_run"]),
  lakeflow: Schema.Literal("not_run"),
});
export type Validation = typeof Validation.Type;
export const Stage = Schema.Literals([
  "queued",
  "profiling",
  "drafting",
  "judging",
  "compiling",
  "validating",
  "ready",
  "needs_input",
  "failed",
  "cancelled",
]);
export type Stage = typeof Stage.Type;
export const Run = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  sourceName: Schema.String,
  revision: Schema.Number,
  parentId: Schema.NullOr(Schema.String),
  includeSamples: Schema.Boolean,
  stage: Stage,
  mode: Schema.Literals(["fixture", "live"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  intent: Schema.String,
  evidence: Schema.NullOr(Evidence),
  spec: Schema.NullOr(PipelineSpec),
  judgments: Schema.Array(Judgment),
  calls: Schema.Array(ModelCall),
  validation: Schema.NullOr(Validation),
  error: Schema.NullOr(Schema.String),
  approvedAt: Schema.NullOr(Schema.String),
  cancelled: Schema.Boolean,
  events: Schema.Array(
    Schema.Struct({ stage: Schema.String, message: Schema.String, at: Schema.String }),
  ),
  repairCount: Schema.Number,
});
export type Run = typeof Run.Type;
export const StartRunInput = Schema.Struct({
  sourceId: Schema.String,
  intent: Schema.String,
  mode: Schema.Literals(["fixture", "live"]),
  includeSamples: Schema.Boolean,
});
export type StartRunInput = typeof StartRunInput.Type;
export const EditRunInput = Schema.Struct({ id: Schema.String, spec: PipelineSpec });
export const ConnectInput = Schema.Struct({ host: Schema.String, token: Schema.String });
export const RemoteSourceInput = Schema.Struct({
  connectionId: Schema.String,
  warehouseId: Schema.String,
  catalog: Schema.String,
  schema: Schema.String,
  table: Schema.String,
});
export const IdInput = Schema.Struct({ id: Schema.String });
export const CatalogInput = Schema.Struct({
  connectionId: Schema.String,
  warehouseId: Schema.String,
  catalog: Schema.String,
  schema: Schema.String,
});
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema);
