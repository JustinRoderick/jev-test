import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { randomUUID } from "node:crypto";
import { Run, Source, type Stage } from "../../domain/models";
import { AppError, appError } from "../../domain/errors";

const now = () => new Date().toISOString();
const terminal = ["ready", "needs_input", "failed", "cancelled"];
function makeRepository(sql: SqlClient.SqlClient) {
  const db = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(
      Effect.mapError((e) =>
        e instanceof AppError ? e : appError("The local database operation failed.", "DATABASE"),
      ),
    );
  const getRun = (id: string) =>
    db(
      Effect.gen(function* () {
        const rows = yield* sql<{
          payload: string;
          cancelled: number;
        }>`SELECT payload, cancelled FROM runs WHERE id = ${id}`;
        if (!rows.length) return yield* Effect.fail(appError("Run not found.", "NOT_FOUND"));
        return {
          ...Schema.decodeUnknownSync(Run)(JSON.parse(rows[0].payload)),
          cancelled: !!rows[0].cancelled,
        };
      }),
    );
  const getSource = (id: string) =>
    db(
      Effect.gen(function* () {
        const rows = yield* sql<{ payload: string }>`SELECT payload FROM sources WHERE id = ${id}`;
        if (!rows.length) return yield* Effect.fail(appError("Source not found.", "NOT_FOUND"));
        return Schema.decodeUnknownSync(Source)(JSON.parse(rows[0].payload));
      }),
    );
  const insertRun = (run: Run) =>
    db(
      sql`INSERT INTO runs (id, source_id, stage, payload, created_at, cancelled) VALUES (${run.id}, ${run.sourceId}, ${run.stage}, ${JSON.stringify(run)}, ${run.createdAt}, 0)`,
    );
  const saveRun = (run: Run) =>
    db(
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* getRun(run.id);
          if (current.cancelled && run.stage !== "cancelled")
            return yield* Effect.fail(appError("Run cancelled.", "CANCELLED"));
          const next = { ...run, updatedAt: now() };
          yield* sql`UPDATE runs SET stage = ${next.stage}, payload = ${JSON.stringify(next)}, lease_until = ${terminal.includes(next.stage) ? 0 : Date.now() + 30_000} WHERE id = ${next.id}`;
          return next;
        }),
      ),
    );
  return {
    init: db(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
        yield* sql`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_owner TEXT)`;
        yield* sql`CREATE INDEX IF NOT EXISTS runs_queue ON runs(stage, lease_until)`;
        yield* sql`CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, host TEXT NOT NULL, sealed TEXT NOT NULL)`;
        yield* sql`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
      }),
    ),
    getRun,
    saveRun,
    insertRun,
    getSource,
    listRuns: db(
      sql<{
        payload: string;
        cancelled: number;
      }>`SELECT payload, cancelled FROM runs ORDER BY created_at DESC LIMIT 100`,
    ).pipe(
      Effect.map((rows) =>
        rows.map((r) => ({
          ...Schema.decodeUnknownSync(Run)(JSON.parse(r.payload)),
          cancelled: !!r.cancelled,
        })),
      ),
    ),
    listSources: db(sql<{ payload: string }>`SELECT payload FROM sources`).pipe(
      Effect.map((rows) =>
        rows.map((r) => Schema.decodeUnknownSync(Source)(JSON.parse(r.payload))),
      ),
    ),
    putSource: (source: Source) =>
      db(
        sql`INSERT OR REPLACE INTO sources (id, payload) VALUES (${source.id}, ${JSON.stringify(source)})`,
      ),
    claim: (owner: string) =>
      db(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload: string;
          }>`UPDATE runs SET lease_owner = ${owner}, lease_until = ${Date.now() + 30_000} WHERE id = (SELECT id FROM runs WHERE stage NOT IN ('ready','needs_input','failed','cancelled') AND cancelled = 0 AND lease_until < ${Date.now()} ORDER BY created_at LIMIT 1) RETURNING payload`;
          return rows[0] ? Schema.decodeUnknownSync(Run)(JSON.parse(rows[0].payload)) : null;
        }),
      ),
    heartbeat: (id: string, owner: string) =>
      db(
        sql`UPDATE runs SET lease_until = ${Date.now() + 30_000} WHERE id = ${id} AND lease_owner = ${owner}`,
      ),
    cancel: (id: string) =>
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            const run = yield* getRun(id);
            if (terminal.includes(run.stage)) return run;
            const next: Run = {
              ...run,
              stage: "cancelled",
              cancelled: true,
              updatedAt: now(),
              events: [
                ...run.events,
                { stage: "cancelled", message: "Cancelled by the reviewer.", at: now() },
              ],
            };
            yield* sql`UPDATE runs SET cancelled=1, stage='cancelled', payload=${JSON.stringify(next)} WHERE id=${id}`;
            return next;
          }),
        ),
      ),
    approve: (id: string) =>
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            const run = yield* getRun(id);
            const successors =
              yield* sql`SELECT id FROM runs WHERE json_extract(payload, '$.parentId') = ${id} LIMIT 1`;
            if (successors.length)
              return yield* Effect.fail(
                appError("A newer revision exists. Review the newest revision.", "STALE"),
              );
            if (run.stage !== "ready" || !run.validation?.passed || !run.spec)
              return yield* Effect.fail(
                appError("Resolve findings and pass validation before approval.", "APPROVAL"),
              );
            return yield* saveRun({ ...run, approvedAt: now() });
          }),
        ),
      ),
    revise: (parent: Run, spec: Run["spec"]) =>
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* getRun(parent.id);
            if (!terminal.includes(current.stage) || !current.evidence)
              return yield* Effect.fail(
                appError(
                  "Wait for evidence and the current run to finish before editing.",
                  "REVISION",
                ),
              );
            const successors =
              yield* sql`SELECT id FROM runs WHERE json_extract(payload, '$.parentId') = ${parent.id} LIMIT 1`;
            if (successors.length)
              return yield* Effect.fail(
                appError("A revision has already been created. Open it from history.", "STALE"),
              );
            yield* saveRun({ ...current, approvedAt: null });
            const next: Run = {
              ...current,
              id: randomUUID(),
              parentId: parent.id,
              revision: parent.revision + 1,
              spec,
              stage: "queued",
              judgments: [],
              calls: [],
              validation: null,
              approvedAt: null,
              cancelled: false,
              error: null,
              repairCount: 0,
              createdAt: now(),
              updatedAt: now(),
              events: [
                {
                  stage: "queued",
                  message: "Reviewer revision queued. Previous results have been invalidated.",
                  at: now(),
                },
              ],
            };
            yield* insertRun(next);
            return next;
          }),
        ),
      ),
    retry: (id: string) =>
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            const run = yield* getRun(id);
            if (!["failed", "cancelled"].includes(run.stage))
              return yield* Effect.fail(
                appError("Only failed or cancelled runs can be resumed.", "STATE"),
              );
            const next: Run = {
              ...run,
              stage: "queued",
              cancelled: false,
              error: null,
              updatedAt: now(),
            };
            yield* sql`UPDATE runs SET cancelled=0, stage='queued', lease_until=0, payload=${JSON.stringify(next)} WHERE id=${id}`;
            return next;
          }),
        ),
      ),
    putConnection: (id: string, host: string, sealed: string) =>
      db(sql`INSERT OR REPLACE INTO connections VALUES (${id}, ${host}, ${sealed})`),
    getConnection: (id: string) =>
      db(
        sql<{ id: string; host: string; sealed: string }>`SELECT * FROM connections WHERE id=${id}`,
      ).pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? Effect.succeed(rows[0])
            : Effect.fail(appError("Reconnect to Databricks.", "CONNECTION")),
        ),
      ),
    listConnections: db(sql<{ id: string; host: string }>`SELECT id, host FROM connections`),
    getCache: (key: string) =>
      db(sql<{ payload: string }>`SELECT payload FROM cache WHERE key=${key}`).pipe(
        Effect.map((rows) => rows[0]?.payload ?? null),
      ),
    putCache: (key: string, payload: string) =>
      db(sql`INSERT OR REPLACE INTO cache VALUES (${key}, ${payload})`),
    deleteCache: (key: string) => db(sql`DELETE FROM cache WHERE key=${key}`),
  };
}
export type RepositoryApi = ReturnType<typeof makeRepository>;
export class Repository extends Context.Service<Repository, RepositoryApi>()(
  "silverline/Repository",
) {}
export const RepositoryLive = Layer.effect(
  Repository,
  Effect.gen(function* () {
    return makeRepository(yield* SqlClient.SqlClient);
  }),
);
export const event = (run: Run, stage: Stage, message: string): Run => ({
  ...run,
  stage,
  events: [...run.events, { stage, message, at: now() }],
});
