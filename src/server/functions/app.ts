import { createServerFn } from "@tanstack/react-start";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { getRuntime } from "../runtime.server";
import { AppConfig } from "../config.server";
import { Repository } from "../../adapters/sqlite/repository";
import { Databricks } from "../../adapters/databricks/client";
import {
  CatalogInput,
  ConnectInput,
  EditRunInput,
  IdInput,
  RemoteSourceInput,
  StartRunInput,
  type Run,
} from "../../domain/models";
import { appError } from "../../domain/errors";
import { databricksBundle, hash, hashContent, validateSpec } from "../../compiler/pipeline";

export const getDashboard = createServerFn({ method: "GET" }).handler(async () =>
  (await getRuntime()).runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      const config = yield* AppConfig;
      const sources = yield* repo.listSources;
      const runs = yield* repo.listRuns;
      return {
        sources: sources.map(({ path: _path, ...s }) => s),
        runs: runs.map(({ evidence, validation, spec, judgments, ...r }) => ({
          ...r,
          rowCount: evidence?.rowCount ?? 0,
          columnCount: spec?.columns.length ?? 0,
          accepted: validation?.accepted ?? null,
          findings: judgments.filter((j) => j.review).length,
        })),
        connections: yield* repo.listConnections,
        config: {
          mode: config.mode,
          jevReady: !!Redacted.value(config.typesafeKey),
          openrouterReady: !!Redacted.value(config.openrouterKey),
          jevModel: config.typesafeModel,
          openrouterModel: config.openrouterModel,
          maxUploadBytes: config.maxUploadBytes,
        },
      };
    }),
  ),
);
export const getRun = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Repository).getRun(data.id);
      }),
    ),
  );
export const getCompiled = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const run = yield* repo.getRun(data.id);
        const source = yield* repo.getSource(run.sourceId);
        return run.spec
          ? databricksBundle(
              run.spec,
              source.table ?? "catalog.bronze.source_table",
              Object.fromEntries(run.evidence?.columns.map((c) => [c.name, c.type]) ?? []),
            )
          : null;
      }),
    ),
  );
export const startRun = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(StartRunInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const config = yield* AppConfig;
        if (data.intent.length > 4000)
          return yield* Effect.fail(
            appError("Keep source instructions under 4,000 characters.", "INPUT"),
          );
        if (
          data.mode === "live" &&
          (!Redacted.value(config.typesafeKey) || !Redacted.value(config.openrouterKey))
        )
          return yield* Effect.fail(
            appError("Add both provider keys to .env and restart to use live AI.", "CONFIG"),
          );
        const source = yield* repo.getSource(data.sourceId);
        const now = new Date().toISOString();
        const run: Run = {
          id: randomUUID(),
          sourceId: source.id,
          sourceName: source.name,
          revision: 1,
          parentId: null,
          stage: "queued",
          mode: data.mode,
          includeSamples: data.includeSamples,
          createdAt: now,
          updatedAt: now,
          intent: data.intent,
          evidence: null,
          spec: null,
          judgments: [],
          calls: [],
          validation: null,
          error: null,
          approvedAt: null,
          cancelled: false,
          events: [{ stage: "queued", at: now, message: "Proposal run queued." }],
          repairCount: 0,
        };
        yield* repo.insertRun(run);
        return run;
      }),
    ),
  );
export const reviseRun = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(EditRunInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const parent = yield* repo.getRun(data.id);
        const spec = yield* Effect.try({
          try: () =>
            validateSpec(
              data.spec,
              parent.evidence?.columns.map((c) => c.name),
            ),
          catch: (e) => appError(e instanceof Error ? e.message : "Invalid proposal", "SPEC"),
        });
        return yield* repo.revise(parent, spec);
      }),
    ),
  );
export const approveRun = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Repository).approve(data.id);
      }),
    ),
  );
export const cancelRun = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Repository).cancel(data.id);
      }),
    ),
  );
export const retryRun = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Repository).retry(data.id);
      }),
    ),
  );

export const uploadSource = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!(input instanceof FormData)) throw new Error("Expected a file upload.");
    return input;
  })
  .handler(async ({ data }) => {
    const runtime = await getRuntime();
    return runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const config = yield* AppConfig;
        const file = data.get("file");
        if (!(file instanceof File) || !file.size || file.size > config.maxUploadBytes)
          return yield* Effect.fail(
            appError("Choose a nonempty file no larger than 25 MiB.", "UPLOAD"),
          );
        const ext = path.extname(file.name).toLowerCase();
        if (![".csv", ".jsonl", ".parquet"].includes(ext))
          return yield* Effect.fail(appError("Use CSV, JSONL, or Parquet.", "UPLOAD"));
        const id = randomUUID();
        const filename = path.join(config.dataDir, "sources", id + ext);
        const content = yield* Effect.promise(async () => Buffer.from(await file.arrayBuffer()));
        yield* Effect.tryPromise({
          try: () => writeFile(filename, content, { mode: 0o600, flag: "wx" }),
          catch: () => appError("Could not save the uploaded file.", "UPLOAD"),
        });
        const source = {
          id,
          name: file.name.slice(0, 200),
          kind: "file" as const,
          format: ext.slice(1) as "csv" | "jsonl" | "parquet",
          path: filename,
          size: file.size,
          description: String(data.get("description") ?? "").slice(0, 4000),
          createdAt: new Date().toISOString(),
          fingerprint: hash(content.toString("base64")),
          table: null,
          connectionId: null,
          warehouseId: null,
        };
        yield* repo.putSource(source);
        return { id: source.id, name: source.name };
      }),
    );
  });

export const connectDatabricks = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(ConnectInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Databricks).connect(data.host, data.token);
      }),
    ),
  );
export const listWarehouses = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Databricks).warehouses(data.id);
      }),
    ),
  );
export const listCatalog = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(CatalogInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        return yield* (yield* Databricks).catalogs(
          data.connectionId,
          data.warehouseId,
          data.catalog,
          data.schema,
        );
      }),
    ),
  );
export const addRemoteSource = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(RemoteSourceInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        if ([data.catalog, data.schema, data.table].some((n) => !/^[\w-]+$/.test(n)))
          return yield* Effect.fail(
            appError("Select valid catalog, schema and table names.", "INPUT"),
          );
        yield* repo.getConnection(data.connectionId);
        const table = `${data.catalog}.${data.schema}.${data.table}`;
        const source = {
          id: randomUUID(),
          name: table,
          kind: "databricks" as const,
          format: "table" as const,
          path: "",
          size: 0,
          description:
            "Remote Delta source. Profiling uses a bounded 10,000-row subset of a fixed Delta version. Sorting for a stable subset may scan the full table.",
          createdAt: new Date().toISOString(),
          fingerprint: hash({ table, connectionId: data.connectionId }),
          table,
          connectionId: data.connectionId,
          warehouseId: data.warehouseId,
        };
        yield* repo.putSource(source);
        return { id: source.id, name: source.name };
      }),
    ),
  );

export const exportRun = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(IdInput))
  .handler(async ({ data }) =>
    (await getRuntime()).runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const run = yield* repo.getRun(data.id);
        const source = yield* repo.getSource(run.sourceId);
        if (!run.spec)
          return yield* Effect.fail(appError("Generate a proposal before exporting.", "EXPORT"));
        const bundle = databricksBundle(
          run.spec,
          source.table ?? "catalog.bronze.source_table",
          Object.fromEntries(run.evidence?.columns.map((c) => [c.name, c.type]) ?? []),
        );
        const files: Record<string, string> = {
          "proposal.json": JSON.stringify(
            {
              id: run.id,
              revision: run.revision,
              approvedAt: run.approvedAt,
              mode: run.mode,
              spec: run.spec,
              fingerprint: run.evidence?.fingerprint,
            },
            null,
            2,
          ),
          "pipeline.sql": bundle.pipeline,
          "transform.sql": bundle.transformation,
          "validation.sql": bundle.validation,
          "validation-report.json": JSON.stringify(run.validation, null, 2),
          "judgments.json": JSON.stringify(run.judgments, null, 2),
          "review.md": `# ${run.spec.name}\n\nStatus: ${run.approvedAt ? "Reviewed and approved" : "DRAFT — not approved"}\nAI mode: ${run.mode}\nRevision: ${run.revision}\n\n${run.spec.description}\n\nValidation engine: ${run.validation?.engine ?? "Not run"}\nCoverage: ${run.validation?.coverage ?? "None"}\nDatabricks SQL: ${run.validation?.databricks ?? "not_run"}\nLakeflow runtime: not_run\n\nBatch proposal. Replace the Bronze source reference and configure an isolated catalog/schema before deployment. Local execution does not establish Databricks compatibility. Review tie handling, timestamp conventions, and full-refresh costs.\n\nAssumptions:\n${run.spec.assumptions.map((s) => `- ${s}`).join("\n")}\n\nUnresolved:\n${run.spec.unresolved.map((s) => `- ${s}`).join("\n") || "- None recorded"}\n`,
          "databricks.yml": `bundle:\n  name: ${run.spec.name}\nvariables:\n  catalog:\n    description: Target catalog\n  schema:\n    description: Isolated target schema\nresources:\n  pipelines:\n    silver:\n      name: ${run.spec.name}\n      catalog: \${var.catalog}\n      schema: \${var.schema}\n      serverless: true\n      libraries:\n        - file:\n            path: ./pipeline.sql\n`,
        };
        // Source rows are excluded; validation report includes only transformed preview rows.
        if (run.validation)
          files["validation-report.json"] = JSON.stringify(
            { ...run.validation, preview: [], quarantine: [] },
            null,
            2,
          );
        files["manifest.json"] = JSON.stringify(
          {
            runId: run.id,
            compiler: "1.0.0",
            generatedAt: new Date().toISOString(),
            files: Object.fromEntries(
              Object.entries(files).map(([name, content]) => [name, hashContent(content)]),
            ),
          },
          null,
          2,
        );
        const bytes = zipSync(
          Object.fromEntries(
            Object.entries(files).map(([name, content]) => [name, strToU8(content)]),
          ),
        );
        const config = yield* AppConfig;
        yield* Effect.tryPromise({
          try: () =>
            writeFile(
              path.join(
                config.dataDir,
                "artifacts",
                `${run.id}-${hash(Buffer.from(bytes).toString("base64")).slice(0, 12)}.zip`,
              ),
              bytes,
              { mode: 0o600 },
            ),
          catch: () => appError("Could not persist the export artifact.", "EXPORT"),
        });
        return {
          filename: `${run.spec.name}-r${run.revision}.zip`,
          base64: Buffer.from(bytes).toString("base64"),
        };
      }),
    ),
  );
