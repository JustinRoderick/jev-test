import { afterEach, test, expect, vi } from "vite-plus/test";
import { decodeJev } from "../src/adapters/ai";
import { AI } from "../src/adapters/ai";
import { LocalEngine } from "../src/adapters/duckdb/engine";
import { Effect, Redacted } from "effect";
import { fixtureSpec } from "../fixtures/orders";
import { harness } from "./helpers";
import { executeStatement, validateHost, remoteSourceSql } from "../src/adapters/databricks/client";
afterEach(() => vi.unstubAllGlobals());

test("live provider adapters use typed requests, bounded evidence and cached Jev judgments", async () => {
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json();
      requests.push({ url: request.url, body });
      if (request.url.includes("openrouter.ai"))
        return Response.json({
          id: "test",
          object: "chat.completion",
          system_fingerprint: null,
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(fixtureSpec), refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
        });
      return Response.json({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([id, question]: [string, any]) => [
            id,
            question.type === "noul"
              ? { type: "noul", noul: 0.95 }
              : {
                  type: "score",
                  score: 0.1,
                  confidence: 0.9,
                  probabilities: { "0": 0.9, "1": 0.1, "2": 0, "3": 0 },
                },
          ]),
        ),
        usage: { input_tokens: 250, output_tokens: 40 },
      });
    }),
  );
  const h = await harness(undefined, {
    typesafeKey: Redacted.make("test-only-key"),
    openrouterKey: Redacted.make("test-only-key"),
  });
  try {
    const result = await h.runtime.runPromise(
      Effect.gen(function* () {
        const evidence = yield* (yield* LocalEngine).profile(h.source, h.source.description);
        const ai = yield* AI;
        const draft = yield* ai.draft(evidence, "Clean orders", "live", false);
        const first = yield* ai.judge(evidence, draft.spec, "live", false);
        const cached = yield* ai.judge(evidence, draft.spec, "live", false);
        return { draft, first, cached };
      }),
    );
    expect(result.draft.spec.name).toBe(fixtureSpec.name);
    expect(result.first.judgments).toHaveLength(14);
    expect(result.cached.calls[0].inputTokens).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.response_format.type).toBe("json_schema");
    expect(requests[1].body.state.evidence.columns[0]).not.toHaveProperty("topValues");
    expect(requests[1].body.state.evidence).not.toHaveProperty("preview");
  } finally {
    await h.dispose();
  }
});

test("Jev validates question identity, types, confidence and score bounds", () => {
  const expected = {
    support: { type: "noul", column: "id", instructions: "supported?" },
    risk: { type: "score", column: "id", instructions: "risk?" },
  };
  const response = {
    model: "jev-1.13.0",
    answers: {
      support: { type: "noul", noul: 0.3 },
      risk: {
        type: "score",
        score: 2.8,
        confidence: 0.9,
        probabilities: { "0": 0, "1": 0, "2": 0.2, "3": 0.8 },
      },
    },
    usage: { input_tokens: 200, output_tokens: 10 },
  };
  expect(decodeJev(response, expected).judgments.every((j) => j.review)).toBe(true);
  expect(() => decodeJev({ ...response, answers: {} }, expected)).toThrow();
  expect(() =>
    decodeJev(
      { ...response, answers: { ...response.answers, support: { type: "noul", noul: 2 } } },
      expected,
    ),
  ).toThrow();
});
test("Databricks URL restriction and fixed snapshot quoting", () => {
  expect(validateHost("https://my-workspace.cloud.databricks.com/")).toBe(
    "https://my-workspace.cloud.databricks.com",
  );
  for (const host of [
    "http://localhost",
    "https://example.com",
    "https://x.cloud.databricks.com.evil.com",
    "https://secret@x.cloud.databricks.com",
  ])
    expect(() => validateHost(host)).toThrow();
  expect(remoteSourceSql("catalog.bronze.orders", 42)).toContain("VERSION AS OF 42");
  expect(() => remoteSourceSql("catalog.bronze.orders", NaN)).toThrow();
});

test("Databricks resumes a persisted statement without another submission", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      statement_id: "known-id",
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "n" }] } },
      result: { data_array: [["42"]] },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const started = vi.fn(async () => {});
  const rows = await executeStatement(
    "https://x.cloud.databricks.com",
    "test-token",
    "warehouse",
    "SELECT 42",
    10,
    undefined,
    { id: "known-id", started, cleared: async () => {} },
  );
  expect(rows).toEqual([{ n: "42" }]);
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0][0]).toContain("/statements/known-id");
  expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  expect(started).toHaveBeenCalledWith("known-id");
});

test("Databricks rejects truncated results instead of treating them as complete", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        statement_id: "s1",
        status: { state: "SUCCEEDED" },
        manifest: { truncated: true },
      }),
    )
    .mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    executeStatement("https://x.cloud.databricks.com", "test-token", "warehouse", "SELECT 1", 10),
  ).rejects.toThrow("result budget");
});
test("Databricks polls and paginates bounded statement results", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ statement_id: "s1", status: { state: "RUNNING" } }))
    .mockResolvedValueOnce(
      Response.json({
        statement_id: "s1",
        status: { state: "SUCCEEDED" },
        manifest: { schema: { columns: [{ name: "value" }] } },
        result: {
          data_array: [["a"]],
          next_chunk_internal_link: "/api/2.0/sql/statements/s1/result/chunks/1",
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ data_array: [["b"]] }));
  vi.stubGlobal("fetch", fetcher);
  expect(
    await executeStatement(
      "https://x.cloud.databricks.com",
      "test-token",
      "warehouse",
      "SELECT 1",
      10,
    ),
  ).toEqual([{ value: "a" }, { value: "b" }]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    row_limit: 200,
    disposition: "INLINE",
  });
});
test("Databricks rejects truncated results and cancels statements on deadline", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ statement_id: "s1", status: { state: "RUNNING" } }))
    .mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    executeStatement("https://x.cloud.databricks.com", "test-token", "warehouse", "SELECT 1", 0),
  ).rejects.toThrow("timed out");
  expect(fetcher.mock.calls[1][0]).toContain("/cancel");
});
