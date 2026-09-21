import { Effect } from "effect";
import { createRuntime, initialize } from "../src/server/runtime.server";
import { Repository } from "../src/adapters/sqlite/repository";
import { LocalEngine } from "../src/adapters/duckdb/engine";
import { AI } from "../src/adapters/ai";
import { fixtureSpec } from "../fixtures/orders";

const live = process.argv.includes("--live");
const runtime = createRuntime();
try {
  await initialize(runtime);
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const source = yield* (yield* Repository).getSource("sample-orders");
      const engine = yield* LocalEngine;
      const evidence = yield* engine.profile(source, source.description);
      const ai = yield* AI;
      const started = Date.now();
      const draft = yield* ai.draft(
        evidence,
        "Build clean orders using the supplied source contract.",
        live ? "live" : "fixture",
        true,
      );
      const judgment = yield* ai.judge(evidence, draft.spec, live ? "live" : "fixture", true);
      const validation = yield* engine.validate(source, draft.spec, evidence);
      const correctOperations = fixtureSpec.columns.filter((expected) =>
        draft.spec.columns.some(
          (actual) => actual.source === expected.source && actual.operation === expected.operation,
        ),
      ).length;
      return {
        mode: live ? "live — paid provider calls" : "fixture — no model accuracy claim",
        elapsedMs: Date.now() - started,
        correctOperations,
        expectedOperations: fixtureSpec.columns.length,
        reviewFindings: judgment.judgments.filter((j) => j.review).length,
        counts: {
          input: validation.inputRows,
          silver: validation.accepted,
          quarantine: validation.quarantined,
          duplicate: validation.duplicates,
        },
        tests: validation.tests,
        calls: [draft.call, ...judgment.calls],
      };
    }),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.tests.some((t) => !t.passed)) process.exitCode = 1;
} finally {
  await runtime.dispose();
}
