# Bronze-to-Silver proposal agent

Planning baseline: 2026-09-20. Status: local POC implemented and verified; live credential-dependent checks remain. See the implementation reconciliation below and README for runnable commands.

## Outcome and agreed scope

Turn raw-table evidence into reviewable, tested Silver pipeline proposals.

## Implementation reconciliation

The local workflow, review UI, typed compiler, SQLite-backed worker, revisions/approval/export, Varlock integration, Jev/OpenRouter adapters, and workspace-URL/PAT Databricks adapter are implemented. Effect dependencies are pinned together at `4.0.0-rc.116`; the correct Effect repository is cloned under ignored `.references/effect`.

Verification executes the synthetic fixture in DuckDB: 1,224 input rows → 1,180 accepted + 20 quarantined + 24 duplicate versions. Automated checks cover unsafe conversions, identifier preservation, dedup ties, leases/recovery, cancellation, stale approval, provider request/response contracts, and Databricks statement lifecycle. Browser tests cover generation, editing, revalidation, approval, and ZIP contents. The production build and TypeScript/Vite+ checks pass.

Implementation choices relative to the initial design:

- SQLite stores validated run/revision documents with stage checkpoints and embedded judgments, calls, reports, and events; it uses a smaller schema rather than a separate table for each entity. The native adapter enables WAL. This is a single-worker POC, not a distributed job platform.
- Evidence is bounded and persisted within run documents. Imports and exported ZIPs live on disk; exports include hashes. Remote query IDs and bounded result checkpoints share the cache table and are keyed by run, stage, SQL, and occurrence. Exactly-once remote submission/billing is not guaranteed across the response-before-persistence crash window.
- Remote validation executes read-only SQL on a selected subset of a fixed Delta version. Lakeflow pipeline deployment/runtime testing is a separate manual step. No Databricks writes or deployment are initiated by the app.
- Local CSV/JSONL/Parquet uploads replace a general-purpose dataset connector. There is one documented synthetic orders fixture. Evidence sampling has an explicit opt-in for sending values; automatic PII detection/redaction is not implemented.
- Validation establishes the listed checks on the executed data. Its replay comparison covers the first 100 accepted rows, not a full-output hash or an idempotent production MERGE. A blocked or unresolved proposal can be exported as a clearly labeled draft.
- Provider and Databricks contract tests use mock HTTP responses. Live accuracy/latency, PAT authorization, remote SQL compatibility, and Lakeflow runtime checks require user credentials. The adapters are implemented; those integrations have not been claimed as live-verified.

The remaining sections preserve the original design baseline. Where they propose broader infrastructure or validation, the reconciliation above and README describe the delivered POC precisely.

The first POC uses local samples and includes a Databricks integration. Live Jev and OpenRouter calls work with local data as soon as their API keys are supplied through Varlock. A separate, explicitly labeled fixture mode supports development and CI without paid calls.

The initial application is a local, single-user workbench. One run handles one Bronze table and produces one Silver dataset plus quarantine and duplicate-disposition outputs. It supports batch transformations. Streaming state, CDC/SCD semantics, cross-table joins, arbitrary Python execution, production deployment, and multi-user authentication are later extensions. Preserve those extension points without implementing them in the first release.

A successful demonstration: load dirty orders, profile the data, generate a typed proposal with OpenRouter, assess semantic choices with Jev, compile transformations, execute them locally, review before/after results, revise one decision, rerun validation, and export a versioned Databricks pipeline bundle. With Databricks credentials, perform remote discovery, profiling, and validation through the same workflow.

## Verified stack and decisions

| Area                     | Planned choice                                                 | Reason                                                                                           |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Language/runtime         | Strict TypeScript, Node 24 LTS with a pinned compatible patch  | One application language; supports native DuckDB and SQLite adapters                             |
| Framework                | TanStack Start + React + TanStack Router                       | Full-stack UI and server functions                                                               |
| UI                       | shadcn/ui, Tailwind CSS, TanStack Query, TanStack Table        | Review tables, forms, progress, and query caching                                                |
| Application architecture | Effect v4                                                      | Services, schemas, typed failures, concurrency, cancellation, retry policies, resources, tracing |
| Jev                      | TypeSafe HTTP API in an Effect service                         | Full control over question batching, decoding, limits, and retries                               |
| Reasoning                | OpenRouter through the v4-compatible Effect OpenRouter adapter | Structured proposal generation using Effect AI schemas                                           |
| Configuration            | Varlock schema, Vite integration, runtime loader               | Validated, typed server configuration and secret handling                                        |
| Package management       | pnpm, pinned in packageManager, committed lockfile             | Reproducible dependency installation                                                             |
| Tooling                  | Project-local Vite+                                            | Development, build, lint, format, type checks, and Vitest                                        |
| Local data engine        | DuckDB through @duckdb/node-api                                | SQL profiling and actual execution over local files                                              |
| Application persistence  | SQLite through the v4 Effect SQL adapter                       | Runs, revisions, checkpoints, reviews, provider calls, and job leases                            |
| Remote data engine       | Databricks SQL Statement Execution API                         | Execute profiling and bounded validation where the data lives                                    |

Important findings:

- OpenRouter's public catalog currently exposes `openai/gpt-5.6-luna` and `~openai/gpt-luna-latest`; an exact `openai/gpt-6-luna` entry was not present. Use configurable `OPENROUTER_MODEL=openai/gpt-5.6-luna` as the proposed initial default, and validate structured-output capability before a live run. Do not silently substitute models. Record requested and returned model/provider identifiers.
- Effect's main `Effect-TS/effect` repository currently contains v4 RC code. The older effect-smol repository description is not sufficient to choose the current source. A mutually available package baseline verified during planning is `4.0.0-rc.116` for `effect`, `@effect/platform-node`, `@effect/ai-openrouter`, and `@effect/sql-sqlite-node`. Recheck and pin a matching set at implementation; do not combine v3 latest tags with v4 adapters.
- Clone the user-supplied Effect repository into ignored `.references/effect` during the foundation milestone, recording its commit. Prefer the selected package release's source/tag when consulting APIs; do not build the app against an unpinned main checkout.
- The selected v4 APIs include `Context.Service`, `Layer`, `ManagedRuntime`, `Schema`, `effect/unstable/http`, and `effect/unstable/ai`. Verify exact imports against pinned packages. Old examples using `@effect/platform` and `@effect/ai` are not the v4 import baseline.
- Jev's current documented version is `jev-1.13.0`. Pin it initially for evaluation reproducibility, with `TYPESAFE_MODEL` configurable. Current limits include 64k total request tokens and 32k for state plus the longest question; our default evidence budget will be substantially smaller. Provider limits are configurable and may change.
- TanStack Start, Vite+, Varlock, and Effect RC compatibility needs a runnable foundation check before feature implementation. Varlock's TanStack example includes older configuration structure: use current Start/Vite+ configuration and the documented Varlock plugin, rather than copying the old wrapper verbatim.

## User workflow

1. Choose a bundled sample, import a CSV/JSONL/Parquet file, or select a Databricks table.
2. Describe the intended Silver table and supply optional source documentation, known units/timezones, and business rules.
3. Inspect a profile: schema, distributions, nulls, parse failures, candidate keys, duplicates, and representative exceptions.
4. Start proposal generation. Display saved stage progress while work runs independently of the browser request.
5. Review each proposed column mapping and operation alongside evidence, measured statistics, Jev judgments, assumptions, and unresolved questions.
6. Execute validation and view accepted rows, quarantine reasons, duplicate dispositions, before/after differences, and assertion results.
7. Edit supported decisions or provide feedback. Create a new immutable revision and rerun affected judgments and tests.
8. Approve a tested revision and download its pipeline bundle. Draft/blocked proposals may be exported as clearly marked drafts; approval never means a pipeline was deployed.

Primary screens:

- **Sources:** local sample picker, bounded upload, Databricks catalog/schema/table selection, connection availability.
- **Evidence:** column profiles, sampled records, exceptional values, scope and sampling metadata.
- **Proposal workbench:** source-to-target mappings, transformation editor, semantic judgments, assumptions, generated code view.
- **Validation:** coverage, test outcomes, metrics, before/after rows, quarantine and duplicate previews.
- **Run history:** stages, revisions, provider latency/usage, failures, retry/resume/cancel controls, export history.

Use a table-oriented interface with shadcn sheets, tabs, badges, dialogs, and progress components. React Query owns remote UI state; ordinary React state owns unsaved edits. Use paginated/virtualized rows and bounded previews. Avoid sending data frames into browser state.

## Workflow and model responsibilities

The workflow is bounded and controlled by code:

`queued -> profiling -> evidence_ready -> drafting -> judging -> compiling -> validating -> ready_for_review`

Additional states: `needs_input`, `failed`, and `cancelled`. Approval belongs to a particular proposal revision; exports reference that revision. Validation failure may produce a reviewable blocked proposal instead of a technical run failure.

### Profiling and evidence

DuckDB or Databricks computes facts: null counts, distinct estimates, lengths, ranges, parse success, value frequencies, key collisions, and duplicate counts. Never ask Jev to replace exact arithmetic or database checks.

An EvidenceBundle contains:

- Source identity, schema, source file hash or Delta version, collection timestamp, profiler version.
- Coverage: whole local file, sampled rows, selected partitions, or full remote scan; predicates and sample method included.
- Per-column statistics with exact/approximate/sample labels and stable evidence IDs.
- Bounded top values, rare values, parse failures, representative examples, and relevant source documentation.
- Known business constraints and explicit missing context.
- Budget/truncation information and the redaction policy applied to provider-bound examples.

Start local uploads with a configurable 25 MiB limit and small bundled files. Profile files using DuckDB without materializing all rows in JavaScript. Larger datasets belong in Databricks; metadata and profiling queries execute remotely and return bounded summaries.

For remote tables, start with explicit partition/time scope and query budgets. A LIMIT alone does not imply cheap profiling or representative sampling. Separate basic statistics from expensive key searches, correlations, or full scans. Bind all dependent validation to the same Delta version where available; record an explicit consistency limitation otherwise.

The default model context is a compact evidence bundle, targeting at most roughly 8k state tokens per request plus a separate question budget. Slice wide tables into coherent column groups while carrying relevant shared context. Include rare/exception cases alongside typical examples. Missing or truncated evidence produces uncertainty, not invented facts.

### OpenRouter reasoning

Use `LanguageModel.generateObject` from the pinned v4 Effect AI package through a `ReasoningModel` service. Request JSON Schema output and a compatible OpenRouter endpoint (`require_parameters` provider preference where supported). Decode every returned object with Effect Schema and check references against the actual source schema.

The model returns a `PipelineSpec`, brief evidence-linked rationale, assumptions, and unresolved questions. It proposes column semantics and transformations from an allowed operation catalog. It does not get database credentials or an arbitrary SQL execution tool.

First release: one initial draft and at most one automatic revision in response to specific judgment/test failures. Bounded transport retries are separate from semantic revisions. Ambiguous units, identifiers, timestamp interpretations, or missing dedup ordering should lead to `needs_input`. Persist each attempt and its budget.

### Jev judgments

Call `POST https://api.typesafe.ai/v1/systemone` using Effect HTTP, validated request/response schemas, and a provider-specific rate limiter.

Jev evaluates narrow questions about the draft and supporting evidence, such as:

- Which supplied semantic type best fits this field, including `unknown`?
- Does the source description support interpreting this amount as cents?
- Would this proposed cast remove meaningful leading zeros?
- Does the supplied timezone documentation support UTC conversion?
- Is the proposed enum mapping consistent with the documented business meanings?
- Does the supplied evidence support this candidate deduplication key's business meaning?
- How risky is this particular information-losing operation on a defined rubric?

Database checks still establish observed uniqueness, conversion success, and row accounting. Jev's role is interpretation, not mathematical proof.

Batch independent questions over the same evidence in one request. Questions requiring an earlier answer get a separate stage. Enforce current API limits (including Choice options and Score levels), verify all expected question IDs and option keys, and reject malformed or incomplete answers. Store Choice/Score confidence separately from Noul probability; neither is a guarantee of correctness. Jev does not supply invented narrative explanations: show its question, result, distribution, and the referenced evidence.

Readiness combines deterministic test results, supported operations, sufficient evidence, and configurable review thresholds. A high model score cannot override a failing constraint. Human edits are recorded as overrides and invalidate dependent results.

## Typed transformation specification and compilation

Effect Schema is the canonical source for domain types, provider output validation, server-function inputs, persisted JSON, and JSON Schema for the reasoning model. Avoid parallel hand-maintained Zod/domain definitions.

`PipelineSpec` is a versioned intermediate representation with:

- Source reference and snapshot scope.
- Target columns and an ordered operation graph.
- Typed expression nodes and dependencies.
- Constraints and failure dispositions.
- Optional dedup key, ordering, and tie policy.
- Provenance columns and quarantine reasons.
- Assumptions, evidence references, and unresolved decisions.

Supported v1 operations: select/rename, trim, explicit blank/sentinel-to-null conversion, safe numeric/boolean casts, decimal precision/scale, parsing with explicit timestamp formats and timezone, enum mapping, selected JSON path extraction, deterministic deduplication with adequate ordering, and validation/quarantine.

Unsupported operations are visible suggestions requiring manual engineering; do not fabricate executable support. Freeform SQL or Python is not an executable node type. Identifier quoting, literals, operation ordering, function choices, and source/target binding belong to the compiler.

Compile one spec into:

1. DuckDB SQL for local execution.
2. Databricks SQL SELECT/CTE transformations and validation queries.
3. A Lakeflow SQL batch proposal using materialized-view definitions, explicit quarantine, and appropriate expectations.
4. A Databricks bundle template with environment-specific targets left configurable.

Do not translate SQL by string replacement. Use separate dialect emitters over the same operation graph. Unsupported dialect semantics block that export or receive an explicit unvalidated status.

Avoid claiming incremental behavior for a batch proposal: deduplication, expectations, and query structure can affect Lakeflow refresh eligibility. The export records batch semantics and any observed/examined incremental eligibility separately.

## Execution and validation semantics

Local validation is real DuckDB execution against fixture/imported data. It is not a mock of success. Keep raw data available and associate every result with a source snapshot and spec hash.

Validation includes:

- Schema/type shape and successful compilation.
- Cast and parse failure rates, decimal overflow, and null changes.
- Required-field and enum constraints.
- Key uniqueness and duplicate handling.
- Deterministic dedup winners or an explicit tie ambiguity.
- Row accounting: every source row has exactly one primary disposition, including separately tracked removed duplicates.
- Business invariants supplied by the user.
- Replay on the same snapshot produces the same outputs.
- Before/after examples, per-rule failure counts, and exceptional-value coverage.

Assign stable source row IDs for fixtures/imports. For live sources, use an actual stable key or a documented snapshot-local identity strategy; a hash of all values cannot distinguish identical duplicates. Every run records engine/version, scope, source fingerprint, spec/compiler versions, and test timestamps.

Expose independent validation levels:

- Specification validated.
- Local execution passed/failed with coverage.
- Databricks SQL execution passed/failed/not run with coverage.
- Lakeflow runtime validation passed/failed/not run.

A local pass does not establish Databricks equivalence. A SQL warehouse SELECT test does not prove a Lakeflow pipeline deploys. The initial integration validates Databricks SQL without deploying production pipelines; actual Lakeflow execution can be added via a configured test pipeline after the POC.

## Databricks adapter included in the POC

Implement a real adapter, exercised by contract tests until workspace credentials are configured:

- Discover accessible catalogs, schemas, and tables.
- Read schema/comments and Delta version where available.
- Run scoped aggregate/sample queries using SQL Statement Execution.
- Submit, poll, paginate bounded results, cancel statements, and record statement IDs.
- Execute compiled validation SELECTs against a pinned source version/scope.
- Return aggregate findings and bounded previews to the app.

Use configured workspace host, SQL warehouse ID, and a server-side token initially. Keep an authentication service boundary for OAuth later. SQL identifiers come from validated catalog selection and are quoted; values use parameters where supported. No raw source table is downloaded wholesale. Pipeline export is always available, while live validation clearly reports missing connection/configuration.

## Effect architecture and persistence

Use one package with a web entrypoint and a worker entrypoint. The worker handles long-running jobs; Start server functions enqueue work and return run IDs. React Query polls active run state/events. This avoids tying a job to a browser request and keeps the initial UI simpler than a streaming event transport.

Services built with `Context.Service` and `Layer`:

| Service                            | Responsibility                                   |
| ---------------------------------- | ------------------------------------------------ |
| AppConfig                          | Validated Varlock configuration, wrapped secrets |
| SourceRegistry / DataEngine        | Local or Databricks source capabilities          |
| Profiler / EvidenceBuilder         | Measured profiles and bounded model context      |
| ReasoningModel                     | OpenRouter draft/revision calls                  |
| JevJudge                           | Typed semantic judgments                         |
| PipelineCompiler                   | Pure spec-to-dialect compilation                 |
| ValidationRunner                   | Engine execution and assertions                  |
| ProposalRepository / RunRepository | Immutable revisions, state and checkpoints       |
| ArtifactStore                      | Immutable local evidence and export artifacts    |
| JobRunner                          | Leases, stage execution, cancellation and resume |
| Telemetry                          | Stage/provider spans, latency and usage          |

Use Effect `Schedule` for bounded retries, structured concurrency for bounded profiling/question groups, scoped resource acquisition for engine connections, and tagged errors for expected failures. Initialize one managed runtime per process and release it on shutdown. `runPromise` belongs at application entrypoints/server-function boundaries, not scattered throughout service methods. React remains idiomatic React.

SQLite uses WAL and transactional updates for runs, run_steps, job_leases, proposal_revisions, judgments, validation_reports, review_decisions, model_calls, and artifact manifests. Only the worker owns DuckDB write connections; the web process serves stored result previews. Store large artifacts on the local filesystem with hashes and atomic writes, not inside response bodies.

Checkpoint completed stages and persist inputs/results before moving forward. Expired leases permit recovery; compare-and-swap revision/state updates prevent stale work or stale approvals. Persist remote SQL statement IDs so a restarted worker polls an existing statement when known.

Provider requests have at-least-once semantics: a crash after a response but before persistence can repeat a billed request. Do not promise exactly-once inference. Cache successful judgments by evidence/spec/model/question-set hashes, with explicit refresh. Automatic retries cover transient transport errors, 429/overload responses and selected 5xx, not invalid credentials or permanent schema errors. Respect retry-after and configured token/request budgets.

Cancellation persists intent, interrupts local fibers, and attempts remote query cancellation. Shutdown/restart cannot mark partial work successful. User edits create new revisions and invalidate judgments, tests and approval when their dependencies change.

## Varlock configuration

Commit `.env.schema` and a placeholder `.env.example`; ignore actual `.env` values and local artifacts. Varlock owns env loading, validation and generated types. Use `ENV` from `varlock/env` at a server-only boundary and expose an Effect AppConfig service. Use the Vite integration for Start and `varlock run` for the worker and production start. Use runtime initialization rather than embedding resolved secrets into build output.

Planned configuration:

| Variable                             | Purpose/default                                            |
| ------------------------------------ | ---------------------------------------------------------- |
| TYPESAFE_API_KEY                     | Sensitive; required for live AI                            |
| TYPESAFE_MODEL                       | `jev-1.13.0`, configurable                                 |
| OPENROUTER_API_KEY                   | Sensitive; required for live AI                            |
| OPENROUTER_MODEL                     | `openai/gpt-5.6-luna`, pending user's preference           |
| AI_MODE                              | `live` or explicit `fixture`                               |
| DATABRICKS_HOST                      | Optional workspace endpoint                                |
| DATABRICKS_WAREHOUSE_ID              | Required when live Databricks is selected                  |
| DATABRICKS_TOKEN                     | Sensitive; required for the initial token-based connection |
| APP_DATA_DIR                         | Local database/artifact directory                          |
| MAX_UPLOAD_BYTES                     | 25 MiB initial upload cap                                  |
| PROFILE_SAMPLE_ROWS                  | Bounded representative sample budget                       |
| MODEL_CONTEXT_BUDGET                 | Conservative provider-context budget                       |
| MODEL_CONCURRENCY                    | Bounded request concurrency                                |
| MODEL_MAX_ATTEMPTS                   | Bounded transient retry policy                             |
| RUN_TIMEOUT_SECONDS                  | Overall workflow deadline                                  |
| DATABRICKS_STATEMENT_TIMEOUT_SECONDS | Remote query deadline                                      |
| LOG_LEVEL                            | Structured log verbosity                                   |

Varlock secret protection covers configuration secrets, not sensitive business data in samples. Default to schema/aggregates plus synthetic fixtures; make provider-bound sample selection/redaction explicit for imported/live sources. Logs contain IDs and metrics rather than raw sample values or provider bodies. Do not use a model-based sensitivity classifier as the sole redaction boundary.

The POC binds locally and has no public deployment/authentication promise. Any later hosted multi-user version must add identity and resource authorization before exposing private sources.

## Project layout and commands

```text
src/
  routes/                  # Start routes and screen composition
  components/              # shadcn components and review UI
  features/                # sources, evidence, proposals, validation, history
  domain/                  # Effect Schemas, specs, tagged errors, policies
  services/                # Effect service interfaces
  adapters/
    typesafe/              # Jev HTTP integration and question definitions
    openrouter/            # Effect AI integration
    duckdb/                # local engine and profiling
    databricks/            # Statement Execution and catalog adapter
    sqlite/                # persistence and migrations
  compiler/                # operation graph and dialect emitters
  workflows/               # proposal stages and bounded repair
  server/
    functions/             # thin createServerFn wrappers
    runtime.server.ts      # web runtime and Layers
    config.server.ts       # Varlock-to-Effect config
  worker/                  # durable worker entrypoint and runtime
fixtures/                  # synthetic inputs, contracts, expected outcomes
tests/                     # integration, engine parity, workflow and browser tests
docs/                      # architecture decisions, usage and Databricks setup
.references/effect/        # ignored reference checkout, added at implementation
.data/                     # ignored databases, imports and generated artifacts
.env.schema
.env.example
vite.config.ts
package.json
pnpm-lock.yaml
PROJECT_PLAN.md
```

Keep a single package initially; module boundaries provide structure without premature workspace packages. Pin pnpm and dependency versions. Use the project-local `vp` CLI through pnpm, without requiring a global toolchain change.

Target commands: `pnpm install`, `pnpm dev` (web and worker), `pnpm check` (Vite+ checks), `pnpm test` (Vite+ tests), `pnpm test:e2e`, `pnpm build`, `pnpm start`, `pnpm worker`, and `pnpm eval`. Define exact scripts during the foundation compatibility milestone. Use `vp run` for custom tasks; Vite+ built-in command names have their own semantics.

## Export bundle

A download contains:

- `proposal.json`: immutable typed spec, source fingerprint, assumptions and versions.
- `pipeline.sql`: Lakeflow batch proposal with Silver and quarantine outputs.
- `transform.sql`: compiled Databricks transformation queries.
- `validation.sql`: deterministic assertions and quality metrics.
- `databricks.yml`: configurable deployment bundle template.
- `validation-report.json`: tests, engine, coverage, actual execution status, and metrics.
- `review.md`: decisions, overrides, unresolved issues, and deployment instructions.
- `manifest.json`: hashes and provenance for every included artifact.

Exclude credentials and raw source samples by default. Downloading a bundle is the POC handoff; automatic PR creation or deployment is outside its initial behavior.

## Test strategy and acceptance criteria

Use Effect test layers and Vite+ test tooling. Select the v4-compatible Effect test integration only after verifying the pinned Vitest version, otherwise use Effect runtimes/TestClock directly inside Vitest. Browser tests cover the workbench journey.

Meaningful fixtures include leading-zero IDs, ambiguous numeric dates, mixed explicit timezone offsets, decimal overflow, legitimate nulls, invalid enums, exact duplicates, duplicate-key ties, rare malformed values, and descriptions containing instructions that must be treated as source content.

Required tests:

- Profiler metrics against hand-verifiable fixture counts and sampling metadata.
- Compiler behavior by executing results, not only comparing SQL snapshots.
- Row-disposition conservation and correct dedup winner selection.
- Provider decoding, missing answer IDs, invalid spec references, rate limits and bounded retry.
- Workflow interruption/restart, cancellation, stale revisions, and bounded repair exhaustion.
- Approval invalidation after a change to a tested spec.
- Server-function schema validation and no secret leakage into bundles/responses.
- Databricks API submission, asynchronous polling, pagination, cancellation, and error contracts.
- Local/Databricks output parity on the supported operation subset when credentials exist; otherwise explicitly skipped and reported.

End-to-end acceptance: an engineer can complete import -> profile -> draft -> Jev review -> actual local validation -> edit/revalidate -> approve -> export using synthetic data. Live AI mode invokes both providers when keys are supplied; fixture mode is visibly labeled. A missing Databricks connection does not break local work or imply remote testing occurred.

Evaluation records proposal validity, semantic decision accuracy on labeled cases, abstention/needs-input behavior, test failure detection, provider latency, token usage and cost where available. Compare a small reasoning-only baseline with reasoning-plus-Jev to measure whether Jev adds useful judgment. Confidence thresholds remain provisional until evaluated on representative cases. Large-scale performance reporting separates database scan time, provider time and UI response time.

## Implementation milestones

| Milestone                   | Deliverable                                                                                | Exit condition                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 0. Foundation compatibility | Start + Vite+ + pnpm, shadcn, Varlock, pinned Effect v4; ignored Effect reference checkout | Dev, production build, one server function, worker startup, native engine loading, and one Effect test pass together |
| 1. Domain and persistence   | Schemas, typed spec, revisions, SQLite migrations, artifact storage, persisted job runner  | Valid/invalid specs tested; run survives restart; cancellation and stale-write handling verified                     |
| 2. Local evidence           | Dirty-orders fixture, CSV/JSONL/Parquet import, DuckDB profile and evidence UI             | Metrics match known data; limited previews and evidence budgets are enforced                                         |
| 3. Compiler and validation  | Supported operation catalog, DuckDB/Databricks emitters, quarantine, local report          | Hand-authored specs execute with correct row accounting, parsing and dedup semantics                                 |
| 4. AI orchestration         | Live Jev and OpenRouter adapters, fixture test layers, bounded draft/judge/revise workflow | A proposal from local evidence compiles and runs; ambiguous cases ask for input; failures remain inspectable         |
| 5. Review and export        | Complete workbench, revision editing, approval, history and bundle download                | End-to-end local journey works; stale results cannot be presented as current                                         |
| 6. Databricks integration   | Discovery, remote profiles, SQL validation, query cancellation and test coverage labels    | Contract tests pass; live smoke/parity checks run when credentials are available and are otherwise marked pending    |
| 7. Evaluation and handoff   | Labeled benchmark, failure drills, setup/architecture docs and final build                 | Checks, meaningful tests and browser journey pass; measured limitations and remote-test status documented            |

Dependencies: domain/persistence before all stages; compiler and validator before trusting generated proposals; UI built incrementally around real artifacts; remote adapter implements the same capabilities as local where supported. Milestone 0 resolves tooling compatibility before the remaining implementation proceeds.

## Inputs and remaining choices

- Confirmed: local samples first, with Databricks integration included.
- Keys: user will provide TypeSafe and OpenRouter values in `.env`; no keys are needed to complete planning or implement fixture tests.
- Default assumption: local single-user app, SQL-first batch proposals, synthetic orders as the initial walkthrough.
- Model: configured Luna model defaults to the verified `openai/gpt-5.6-luna` until a different available OpenRouter ID is selected.
- Databricks host, warehouse, token and source/sandbox scope are needed only for live integration verification. They do not block the local implementation.

## Primary references

- [TypeSafe introduction](https://docs.typesafe.ai/introduction), [API](https://docs.typesafe.ai/api), [models and limits](https://docs.typesafe.ai/models).
- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [live model catalog](https://openrouter.ai/api/v1/models).
- [Effect v4 onboarding](https://effect.website/docs/v4/onboarding), [source repository](https://github.com/Effect-TS/effect), [v4 OpenRouter source](https://github.com/Effect-TS/effect/tree/main/packages/ai/openrouter).
- [Varlock introduction](https://varlock.dev/getting-started/introduction/), [TanStack Start integration](https://varlock.dev/integrations/tanstack-start/), [Vite runtime/environment integration](https://varlock.dev/integrations/vite/).
- [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview), [server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions), [shadcn setup](https://ui.shadcn.com/docs/installation/tanstack).
- [Vite+ guide](https://viteplus.dev/guide/), [package management](https://viteplus.dev/guide/install).
- [Databricks SQL Statement Execution](https://docs.databricks.com/aws/en/dev-tools/sql-execution-tutorial), [Lakeflow SQL](https://docs.databricks.com/gcp/en/ldp/developer/sql-dev), [materialized view semantics](https://docs.databricks.com/gcp/en/ldp/developer/ldp-sql-ref-create-materialized-view).

Package availability and peer dependencies were also checked directly against the npm registry on the planning date. Planning establishes a documented compatibility baseline; milestone 0 still verifies the assembled stack by running it.
