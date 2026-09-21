import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppConfig, readConfig } from "./config.server";
import { Repository, RepositoryLive } from "../adapters/sqlite/repository";
import { LocalEngineLive } from "../adapters/duckdb/engine";
import { Databricks, DatabricksLive } from "../adapters/databricks/client";
import { AILive } from "../adapters/ai";
import { ordersFixture, fixtureDescription } from "../../fixtures/orders";
import { hash } from "../compiler/pipeline";

export function createRuntime() {
  const config = readConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.dataDir, "sources"), { recursive: true });
  mkdirSync(path.join(config.dataDir, "artifacts"), { recursive: true });
  const infra = Layer.mergeAll(
    Layer.succeed(AppConfig, config),
    SqliteClient.layer({ filename: path.join(config.dataDir, "silverline.sqlite") }),
    FetchHttpClient.layer,
    LocalEngineLive,
  );
  const repository = RepositoryLive.pipe(Layer.provideMerge(infra));
  return ManagedRuntime.make(
    Layer.mergeAll(AILive, DatabricksLive).pipe(Layer.provideMerge(repository)),
  );
}
export type AppRuntime = ReturnType<typeof createRuntime>;
export function initialize(runtime: AppRuntime) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      const config = yield* AppConfig;
      yield* repo.init;
      yield* (yield* Databricks).seedFromEnv;
      const filename = path.join(config.dataDir, "sources", "orders.jsonl");
      if (!existsSync(filename))
        writeFileSync(
          filename,
          ordersFixture()
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
          { mode: 0o600 },
        );
      const content = readFileSync(filename);
      yield* repo.putSource({
        id: "sample-orders",
        name: "raw_commerce.orders",
        kind: "sample",
        format: "jsonl",
        path: filename,
        description: fixtureDescription,
        createdAt: "2026-09-20T00:00:00.000Z",
        size: content.length,
        fingerprint: hash(content.toString()),
        table: null,
        connectionId: null,
        warehouseId: null,
      });
    }),
  );
}
const globalRuntime = globalThis as typeof globalThis & { __silverline?: Promise<AppRuntime> };
export function getRuntime(): Promise<AppRuntime> {
  if (!globalRuntime.__silverline)
    globalRuntime.__silverline = (async () => {
      const runtime = createRuntime();
      await initialize(runtime);
      return runtime;
    })();
  return globalRuntime.__silverline;
}
