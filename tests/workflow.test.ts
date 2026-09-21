import { test, expect } from "vite-plus/test";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import { processRun } from "../src/workflows/proposal";
import { harness, newRun } from "./helpers";

test("persisted workflow, review revision, and stale approval protection", async () => {
  const h = await harness();
  try {
    const run = newRun();
    await h.runtime.runPromise(h.repo.insertRun(run));
    await h.runtime.runPromise(processRun(run));
    const ready = await h.runtime.runPromise(h.repo.getRun(run.id));
    expect(ready.stage).toBe("ready");
    expect(ready.calls.every((c) => c.mode === "fixture" && c.inputTokens === 0)).toBe(true);
    expect((await h.runtime.runPromise(h.repo.approve(run.id))).approvedAt).toBeTruthy();
    const revision = await h.runtime.runPromise(h.repo.revise(ready, ready.spec));
    expect(revision).toMatchObject({
      revision: 2,
      validation: null,
      judgments: [],
      approvedAt: null,
    });
    expect((await h.runtime.runPromise(h.repo.getRun(run.id))).approvedAt).toBeNull();
    await expect(h.runtime.runPromise(h.repo.approve(run.id))).rejects.toThrow("newer revision");
    await h.runtime.runPromise(processRun(revision));
    expect((await h.runtime.runPromise(h.repo.getRun(revision.id))).stage).toBe("ready");
  } finally {
    await h.dispose();
  }
});

test("leases prevent duplicate claims and permit recovery; cancellation is durable", async () => {
  const h = await harness();
  try {
    const run = newRun();
    await h.runtime.runPromise(h.repo.insertRun(run));
    expect((await h.runtime.runPromise(h.repo.claim("worker-a")))?.id).toBe(run.id);
    expect(await h.runtime.runPromise(h.repo.claim("worker-b"))).toBeNull();
    await h.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE runs SET lease_until=0 WHERE id=${run.id}`;
      }),
    );
    expect((await h.runtime.runPromise(h.repo.claim("worker-b")))?.id).toBe(run.id);
    await h.runtime.runPromise(h.repo.cancel(run.id));
    await expect(
      h.runtime.runPromise(h.repo.saveRun({ ...run, stage: "profiling" })),
    ).rejects.toThrow("cancelled");
    expect(await h.runtime.runPromise(h.repo.claim("worker-c"))).toBeNull();
    await h.runtime.runPromise(h.repo.retry(run.id));
    expect((await h.runtime.runPromise(h.repo.claim("worker-c")))?.id).toBe(run.id);
  } finally {
    await h.dispose();
  }
});
