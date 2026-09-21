import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig, type Config } from "../src/server/config.server";
import { RepositoryLive, Repository } from "../src/adapters/sqlite/repository";
import { LocalEngineLive } from "../src/adapters/duckdb/engine";
import { AILive } from "../src/adapters/ai";
import { DatabricksLive } from "../src/adapters/databricks/client";
import type { Source, Run } from "../src/domain/models";
import { hash } from "../src/compiler/pipeline";
import { ordersFixture, fixtureDescription } from "../fixtures/orders";

export async function harness(
  rows: Record<string, unknown>[] = ordersFixture(),
  overrides: Partial<Config> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "silverline-test-"));
  const filename = path.join(dir, "source.jsonl");
  const content = rows.map((r) => JSON.stringify(r)).join("\n");
  await writeFile(filename, content);
  const config: Config = {
    mode: "fixture",
    typesafeKey: Redacted.make(""),
    typesafeModel: "jev-1.13.0",
    openrouterKey: Redacted.make(""),
    openrouterModel: "unused",
    databricksHost: "",
    databricksToken: Redacted.make(""),
    dataDir: dir,
    maxUploadBytes: 26214400,
    runTimeout: 300,
    modelAttempts: 2,
    modelConcurrency: 2,
    modelRPM: 60000,
    contextBudget: 8000,
    statementTimeout: 120,
    ...overrides,
  };
  const infra = Layer.mergeAll(
    SqliteClient.layer({ filename: path.join(dir, "test.sqlite") }),
    Layer.succeed(AppConfig, config),
    LocalEngineLive,
    FetchHttpClient.layer,
  );
  const repository = RepositoryLive.pipe(Layer.provideMerge(infra));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(AILive, DatabricksLive).pipe(Layer.provideMerge(repository)),
  );
  const source: Source = {
    id: "sample-orders",
    name: "test orders",
    kind: "sample",
    format: "jsonl",
    path: filename,
    size: content.length,
    createdAt: new Date().toISOString(),
    description: fixtureDescription,
    fingerprint: hash(content),
    table: null,
    connectionId: null,
    warehouseId: null,
  };
  const repo = await runtime.runPromise(Repository);
  await runtime.runPromise(repo.init);
  await runtime.runPromise(repo.putSource(source));
  return {
    runtime,
    repo,
    source,
    dir,
    dispose: async () => {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export function newRun(id = crypto.randomUUID()): Run {
  const now = new Date().toISOString();
  return {
    id,
    sourceId: "sample-orders",
    sourceName: "test orders",
    revision: 1,
    parentId: null,
    includeSamples: false,
    stage: "queued",
    mode: "fixture",
    createdAt: now,
    updatedAt: now,
    intent: "",
    evidence: null,
    spec: null,
    judgments: [],
    calls: [],
    validation: null,
    error: null,
    approvedAt: null,
    cancelled: false,
    events: [],
    repairCount: 0,
  };
}
