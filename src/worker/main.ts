import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { createRuntime, initialize } from "../server/runtime.server";
import { Repository, event } from "../adapters/sqlite/repository";
import { processRun } from "../workflows/proposal";
import { AppConfig } from "../server/config.server";

const runtime = createRuntime();
await initialize(runtime);
const owner = randomUUID();
let stopping = false;
const shutdown = () => {
  stopping = true;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log("Silverline worker ready. Waiting for proposal runs.");
try {
  while (!stopping) {
    const job = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Repository).claim(owner);
      }),
    );
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const config = yield* AppConfig;
        const fiber = yield* processRun(job).pipe(
          Effect.timeout(`${config.runTimeout} seconds`),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const current = yield* repo.getRun(job.id);
              if (current.cancelled) return;
              // Persist useful typed errors, but never serialize provider bodies or secrets.
              const { Cause } = yield* Effect.promise(() => import("effect"));
              const failures = Cause.pretty(cause);
              const message = failures.includes("Timeout")
                ? "Run reached its configured deadline. Resume to continue from saved evidence."
                : failures.split("\n")[0].slice(0, 500);
              yield* repo.saveRun({
                ...event(current, "failed", "Run stopped. Completed stages have been saved."),
                error: message,
              });
            }),
          ),
          Effect.forkChild,
        );
        while (true) {
          const status = yield* Effect.sync(() => fiber.pollUnsafe());
          if (status) break;
          const current = yield* repo.getRun(job.id);
          if (current.cancelled || stopping) {
            yield* Fiber.interrupt(fiber);
            break;
          }
          yield* repo.heartbeat(job.id, owner);
          yield* Effect.sleep("500 millis");
        }
      }),
    );
  }
} finally {
  await runtime.dispose();
}
