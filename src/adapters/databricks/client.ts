import { Context, Effect, Layer, Redacted } from "effect";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Repository } from "../sqlite/repository";
import { AppConfig } from "../../server/config.server";
import { appError, errorMessage } from "../../domain/errors";
import type { Evidence, PipelineSpec, Row, Source } from "../../domain/models";
import { qualified, hash } from "../../compiler/pipeline";
import { profileQuery, validateQuery } from "../duckdb/engine";

export function validateHost(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw appError("Enter an HTTPS Databricks workspace URL.", "CONNECTION");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/.test(url.hostname)
  )
    throw appError("Use your HTTPS Databricks workspace URL (AWS, Azure, or GCP).", "CONNECTION");
  return url.origin;
}
type Warehouse = { id: string; name: string; state: string };
type Statement = {
  statement_id: string;
  status: { state: string; error?: { message?: string } };
  manifest?: { schema: { columns: { name: string }[] }; truncated?: boolean };
  result?: { data_array?: (string | null)[][]; next_chunk_internal_link?: string };
};

export async function databricksRequest<A>(
  host: string,
  token: string,
  endpoint: string,
  init: RequestInit = {},
): Promise<A> {
  if (!endpoint.startsWith("/api/")) throw appError("Invalid Databricks API path.", "CONNECTION");
  const response = await fetch(`${validateHost(host)}${endpoint}`, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok)
    throw appError(
      `Databricks returned ${response.status}. Check the workspace, PAT permissions, and warehouse access.`,
      "DATABRICKS",
      response.status === 429 || response.status >= 500,
    );
  return (await response.json()) as A;
}

export async function executeStatement(
  host: string,
  token: string,
  warehouseId: string,
  statement: string,
  timeout: number,
  signal?: AbortSignal,
  checkpoint?: {
    id?: string;
    started: (id: string) => Promise<void>;
    cleared: () => Promise<void>;
  },
): Promise<Row[]> {
  let id: string | undefined;
  try {
    let result = checkpoint?.id
      ? await databricksRequest<Statement>(
          host,
          token,
          `/api/2.0/sql/statements/${encodeURIComponent(checkpoint.id)}`,
          { signal },
        )
      : await databricksRequest<Statement>(host, token, "/api/2.0/sql/statements", {
          method: "POST",
          signal,
          body: JSON.stringify({
            warehouse_id: warehouseId,
            statement,
            wait_timeout: "0s",
            disposition: "INLINE",
            format: "JSON_ARRAY",
            row_limit: 200,
            byte_limit: 1_000_000,
          }),
        });
    id = result.statement_id;
    if (checkpoint) await checkpoint.started(id);
    const deadline = Date.now() + timeout * 1000;
    while (["PENDING", "RUNNING"].includes(result.status.state)) {
      if (signal?.aborted || Date.now() >= deadline)
        throw appError("Databricks query cancelled or timed out.", "TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await databricksRequest<Statement>(
        host,
        token,
        `/api/2.0/sql/statements/${encodeURIComponent(id)}`,
        { signal },
      );
    }
    if (result.status.state !== "SUCCEEDED")
      throw appError(
        `Databricks statement ${result.status.state.toLowerCase()}. Check query history for details.`,
        "DATABRICKS_SQL",
      );
    if (result.manifest?.truncated)
      throw appError("Databricks result exceeded the bounded result budget.", "RESULT_LIMIT");
    const names = result.manifest?.schema.columns.map((c) => c.name) ?? [];
    const data = [...(result.result?.data_array ?? [])];
    let next = result.result?.next_chunk_internal_link;
    while (next) {
      const chunk = await databricksRequest<NonNullable<Statement["result"]>>(host, token, next, {
        signal,
      });
      data.push(...(chunk.data_array ?? []));
      if (data.length > 200)
        throw appError("Databricks result exceeded the row budget.", "RESULT_LIMIT");
      next = chunk.next_chunk_internal_link;
    }
    return data.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])));
  } catch (e) {
    if (id)
      await databricksRequest(
        host,
        token,
        `/api/2.0/sql/statements/${encodeURIComponent(id)}/cancel`,
        { method: "POST", signal: AbortSignal.timeout(5000) },
      )
        .then(() => checkpoint?.cleared())
        .catch(() => undefined);
    throw e;
  }
}

function vault(keyPath: string) {
  let key: Buffer;
  try {
    key = readFileSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32);
    try {
      writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      key = readFileSync(keyPath);
    }
  }
  return {
    seal(token: string) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([c.update(token, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString("base64");
    },
    open(sealed: string) {
      const raw = Buffer.from(sealed, "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

const makeDatabricks = Effect.gen(function* () {
  const config = yield* AppConfig;
  const repo = yield* Repository;
  const secrets = vault(path.join(config.dataDir, "connection.key"));
  // Bridge the Promise-based SQL profiling API to the scoped Effect repository.
  const execute = Effect.runPromiseWith(yield* Effect.context());
  const runQuery = (
    source: Source,
    host: string,
    token: string,
    runId: string,
    stage: string,
    signal: AbortSignal,
  ) => {
    const occurrences = new Map<string, number>();
    return async (statement: string) => {
      const occurrence = occurrences.get(statement) ?? 0;
      occurrences.set(statement, occurrence + 1);
      const key = `statement:${hash({ runId, stage, occurrence, connection: source.connectionId, warehouse: source.warehouseId, statement })}`;
      const saved = await execute(repo.getCache(key));
      const previous = saved ? (JSON.parse(saved) as { id?: string; rows?: Row[] }) : null;
      if (previous?.rows) return previous.rows;
      const rows = await executeStatement(
        host,
        token,
        source.warehouseId!,
        statement,
        config.statementTimeout,
        signal,
        {
          id: previous?.id,
          started: async (id) => {
            await execute(repo.putCache(key, JSON.stringify({ id })));
          },
          cleared: async () => {
            await execute(repo.deleteCache(key));
          },
        },
      );
      await execute(repo.putCache(key, JSON.stringify({ rows })));
      return rows;
    };
  };
  const attempt = <A>(f: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: (e) => appError(errorMessage(e), "DATABRICKS") });
  const sql = (connectionId: string, warehouseId: string, query: string) =>
    Effect.gen(function* () {
      const connection = yield* repo.getConnection(connectionId);
      return yield* attempt((signal) =>
        executeStatement(
          connection.host,
          secrets.open(connection.sealed),
          warehouseId,
          query,
          config.statementTimeout,
          signal,
        ),
      );
    });
  return {
    seedFromEnv: Effect.gen(function* () {
      if (config.databricksHost && Redacted.value(config.databricksToken)) {
        const host = yield* Effect.try({
          try: () => validateHost(config.databricksHost),
          catch: (e) => appError(errorMessage(e), "CONFIG"),
        });
        yield* repo.putConnection(
          "environment",
          host,
          secrets.seal(Redacted.value(config.databricksToken)),
        );
      }
    }),
    connect: (hostInput: string, token: string) =>
      Effect.gen(function* () {
        const host = yield* Effect.try({
          try: () => validateHost(hostInput),
          catch: (e) => appError(errorMessage(e), "CONNECTION"),
        });
        if (!token.trim())
          return yield* Effect.fail(appError("A user PAT is required.", "CONNECTION"));
        const response = yield* attempt((signal) =>
          databricksRequest<{ warehouses: Warehouse[] }>(host, token, "/api/2.0/sql/warehouses", {
            signal,
          }),
        );
        const id = randomUUID();
        yield* repo.putConnection(id, host, secrets.seal(token));
        return { id, host, warehouses: response.warehouses ?? [] };
      }),
    warehouses: (connectionId: string) =>
      Effect.gen(function* () {
        const c = yield* repo.getConnection(connectionId);
        const r = yield* attempt((signal) =>
          databricksRequest<{ warehouses: Warehouse[] }>(
            c.host,
            secrets.open(c.sealed),
            "/api/2.0/sql/warehouses",
            { signal },
          ),
        );
        return r.warehouses ?? [];
      }),
    sql,
    profile: (source: Source, context: string, runId: string) =>
      Effect.gen(function* () {
        const c = yield* repo.getConnection(source.connectionId!);
        return yield* attempt(async (signal) => {
          const query = runQuery(source, c.host, secrets.open(c.sealed), runId, "profile", signal);
          const timezone = await query("SELECT current_timezone() AS zone");
          if (!["UTC", "Etc/UTC", "Z", "+00:00"].includes(String(timezone[0]?.zone)))
            throw appError(
              "This POC requires the SQL warehouse session timezone to be UTC.",
              "TIMEZONE",
            );
          const history = await query(`DESCRIBE HISTORY ${qualified(source.table!)} LIMIT 1`);
          const version = Number(history[0]?.version);
          if (!Number.isInteger(version))
            throw appError("Select a Delta table with readable version history.", "SNAPSHOT");
          const raw = remoteSourceSql(source.table!, version);
          return profileQuery(query, raw, source, context, "databricks", version);
        });
      }),
    validate: (source: Source, spec: PipelineSpec, evidence: Evidence, runId: string) =>
      Effect.gen(function* () {
        const c = yield* repo.getConnection(source.connectionId!);
        return yield* attempt((signal) =>
          validateQuery(
            runQuery(
              source,
              c.host,
              secrets.open(c.sealed),
              runId,
              `validation:${hash(spec)}`,
              signal,
            ),
            remoteSourceSql(source.table!, evidence.snapshot!),
            spec,
            evidence,
            "databricks",
          ),
        );
      }),
    catalogs: (connectionId: string, warehouseId: string, catalog: string, schema: string) => {
      const query = !catalog
        ? "SHOW CATALOGS"
        : !schema
          ? `SHOW SCHEMAS IN ${qualified(catalog)}`
          : `SHOW TABLES IN ${qualified(`${catalog}.${schema}`)}`;
      return sql(connectionId, warehouseId, query).pipe(
        Effect.map((rows) =>
          rows.map((r) =>
            String(
              r.catalog ?? r.databaseName ?? r.namespace ?? r.tableName ?? Object.values(r)[0],
            ),
          ),
        ),
      );
    },
  };
});
// Stable selected subset of a fixed Delta snapshot. Ordering can scan the full table;
// the UI describes this query cost explicitly rather than equating LIMIT with cheap scans.
export const remoteSourceSql = (table: string, version: number) => {
  if (!Number.isInteger(version) || version < 0)
    throw appError("A valid Delta version is required.", "SNAPSHOT");
  return `SELECT ROW_NUMBER() OVER (ORDER BY _sl_sort) AS _sl_row_id, * EXCEPT (_sl_sort) FROM (SELECT *, to_json(struct(*)) AS _sl_sort FROM ${qualified(table)} VERSION AS OF ${version} ORDER BY _sl_sort LIMIT 10000) sample`;
};
export class Databricks extends Context.Service<
  Databricks,
  Effect.Success<typeof makeDatabricks>
>()("silverline/Databricks") {}
export const DatabricksLive = Layer.effect(Databricks, makeDatabricks);
