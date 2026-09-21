import { Effect } from "effect";
import { Repository, event } from "../adapters/sqlite/repository";
import { LocalEngine } from "../adapters/duckdb/engine";
import { Databricks } from "../adapters/databricks/client";
import { AI } from "../adapters/ai";
import { appError } from "../domain/errors";
import type { Run } from "../domain/models";
import { validateSpec } from "../compiler/pipeline";

export const processRun = (initial: Run) =>
  Effect.gen(function* () {
    const repo = yield* Repository;
    const local = yield* LocalEngine;
    const remote = yield* Databricks;
    const ai = yield* AI;
    const source = yield* repo.getSource(initial.sourceId);
    let run = yield* repo.getRun(initial.id);
    if (run.cancelled) return;
    if (!run.evidence) {
      run = yield* repo.saveRun(
        event(run, "profiling", "Computing profiles and gathering representative evidence."),
      );
      const evidence = yield* source.kind === "databricks"
        ? remote.profile(source, source.description + "\n" + run.intent, run.id)
        : local.profile(source, source.description + "\n" + run.intent);
      run = yield* repo.saveRun({ ...run, evidence });
    }
    const evidence = run.evidence!;
    if (!run.spec) {
      run = yield* repo.saveRun(
        event(
          run,
          "drafting",
          run.mode === "fixture"
            ? "Building a clearly labeled fixture proposal."
            : "OpenRouter is drafting a typed transformation proposal.",
        ),
      );
      const draft = yield* ai.draft(evidence, run.intent, run.mode, run.includeSamples);
      run = yield* repo.saveRun({ ...run, spec: draft.spec, calls: [...run.calls, draft.call] });
    }
    // At most one automatic revision. Every subsequent pass uses persisted inputs.
    for (;;) {
      if (!run.judgments.length) {
        run = yield* repo.saveRun(
          event(
            run,
            "judging",
            run.mode === "fixture"
              ? "Applying deterministic fixture judgments (no model calls)."
              : "Jev is checking each semantic decision against source evidence.",
          ),
        );
        const judgment = yield* ai.judge(evidence, run.spec!, run.mode, run.includeSamples);
        run = yield* repo.saveRun({
          ...run,
          judgments: judgment.judgments,
          calls: [...run.calls, ...judgment.calls],
        });
      }
      run = yield* repo.saveRun(
        event(run, "compiling", "Compiling the typed specification into executable SQL."),
      );
      yield* Effect.try({
        try: () =>
          validateSpec(
            run.spec!,
            evidence.columns.map((c) => c.name),
          ),
        catch: (e) => appError(e instanceof Error ? e.message : "Invalid specification.", "SPEC"),
      });
      if (!run.validation) {
        run = yield* repo.saveRun(
          event(
            run,
            "validating",
            "Executing transformations and checking row accounting, conversions, and duplicate ordering.",
          ),
        );
        const validation = yield* source.kind === "databricks"
          ? remote.validate(source, run.spec!, evidence, run.id)
          : local.validate(source, run.spec!, evidence);
        run = yield* repo.saveRun({ ...run, validation });
      }
      const problems = [
        ...run.judgments
          .filter((j) => j.review)
          .map((j) => `${j.column}: ${j.question} -> ${j.answer}`),
        ...run.validation!.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.detail}`),
      ];
      if (!problems.length && !run.spec!.unresolved.length) {
        yield* repo.saveRun(
          event(run, "ready", "Validation passed. The proposal is ready for your review."),
        );
        return;
      }
      if (
        run.mode === "live" &&
        run.repairCount === 0 &&
        !run.parentId &&
        !run.spec!.unresolved.length
      ) {
        // Persist the repair count before calling the provider; a crash cannot open an unbounded loop.
        run = yield* repo.saveRun({
          ...event(run, "drafting", "One bounded revision is addressing specific findings."),
          repairCount: 1,
        });
        const draft = yield* ai.draft(
          evidence,
          run.intent,
          run.mode,
          run.includeSamples,
          JSON.stringify({ previous: run.spec, findings: problems }),
        );
        run = yield* repo.saveRun({
          ...run,
          spec: draft.spec,
          judgments: [],
          validation: null,
          calls: [...run.calls, draft.call],
        });
        continue;
      }
      yield* repo.saveRun(
        event(
          run,
          "needs_input",
          "Some decisions need attention. Review findings and create a revised proposal.",
        ),
      );
      return;
    }
  }).pipe(Effect.withSpan("proposal.run", { attributes: { "run.id": initial.id } }));
