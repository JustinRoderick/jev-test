import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Braces,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Columns3,
  Database,
  FileCode2,
  FileInput,
  FlaskConical,
  GitBranch,
  History,
  Layers3,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DataTable } from "@/components/data-table";
import { cn } from "@/lib/utils";
import type { ColumnSpec, PipelineSpec, Run } from "@/domain/models";
import {
  addRemoteSource,
  approveRun,
  cancelRun,
  connectDatabricks,
  exportRun,
  getCompiled,
  getDashboard,
  getRun,
  listCatalog,
  listWarehouses,
  retryRun,
  reviseRun,
  startRun,
  uploadSource,
} from "@/server/functions/app";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    run: typeof search.run === "string" ? search.run : "",
  }),
  component: Workspace,
});
const terminal = ["ready", "needs_input", "failed", "cancelled"];
const stageNames: Record<string, string> = {
  queued: "Queued",
  profiling: "Profiling data",
  drafting: "Drafting proposal",
  judging: "Checking with Jev",
  compiling: "Compiling SQL",
  validating: "Running validation",
  ready: "Ready for review",
  needs_input: "Needs attention",
  failed: "Run failed",
  cancelled: "Cancelled",
};
const stages = ["Profile", "Propose", "Evaluate", "Validate", "Review"];
const stageIndex: Record<string, number> = {
  queued: -1,
  profiling: 0,
  drafting: 1,
  judging: 2,
  compiling: 3,
  validating: 3,
  ready: 4,
  needs_input: 4,
  failed: -1,
  cancelled: -1,
};
const number = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
function Badge({ children, tone = "" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Workspace() {
  const { run: selectedId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => getDashboard(),
    refetchInterval: 3000,
  });
  const runQuery = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => getRun({ data: { id: selectedId } }),
    enabled: !!selectedId,
    refetchInterval: (q) => (q.state.data && terminal.includes(q.state.data.stage) ? false : 1000),
  });
  const run = selectedId ? runQuery.data : undefined;
  const [sourceId, setSourceId] = useState("sample-orders");
  const [intent, setIntent] = useState(
    "Create a clean orders table. Preserve identifiers, standardize amounts and statuses, and quarantine invalid records.",
  );
  const [mode, setMode] = useState<"fixture" | "live">("fixture");
  const [includeSamples, setIncludeSamples] = useState(false);
  const [tab, setTab] = useState("proposal");
  const [modal, setModal] = useState<"upload" | "connect" | "spec" | "settings" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editColumn, setEditColumn] = useState<ColumnSpec | null>(null);
  const [originalTarget, setOriginalTarget] = useState("");
  const [specText, setSpecText] = useState("");
  const sources = dashboard.data?.sources ?? [];
  const source = sources.find((s) => s.id === (run?.sourceId ?? sourceId));
  const active = !!run && !terminal.includes(run.stage);
  useEffect(() => {
    if (dashboard.data?.config.mode) setMode(dashboard.data.config.mode);
  }, [dashboard.data?.config.mode]);
  const selectRun = (id: string) => {
    setTab("proposal");
    setError("");
    void navigate({ search: { run: id } });
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["run"] });
  };
  async function perform<T>(task: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError("");
    try {
      const result = await task();
      refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed.");
      return undefined;
    } finally {
      setPending(false);
    }
  }
  const generate = async () => {
    const result = await perform(() =>
      startRun({ data: { sourceId: run?.sourceId ?? sourceId, intent, mode, includeSamples } }),
    );
    if (result) selectRun(result.id);
  };
  const download = async () => {
    const result = await perform(() => exportRun({ data: { id: selectedId } }));
    if (result) {
      const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  };
  const saveSpec = async (spec: PipelineSpec) => {
    const result = await perform(() => reviseRun({ data: { id: selectedId, spec } }));
    if (result) {
      setEditColumn(null);
      setModal(null);
      selectRun(result.id);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <i />
            <i />
            <i />
          </div>
          silverline
          <span className="ml-auto text-[9px] font-normal tracking-normal text-[#919789]">POC</span>
        </div>
        <div className="workspace-label">
          <Monitor size={14} />
          <span>Local workspace</span>
          <ChevronDown size={12} className="ml-auto" />
        </div>
        <div className="side-label">Workspace</div>
        <button className="nav-item active" onClick={() => selectRun("")}>
          <Layers3 />
          Silver proposals
          <span className="ml-auto text-[10px]">{dashboard.data?.runs.length ?? 0}</span>
        </button>
        <button
          className="nav-item"
          onClick={() => {
            selectRun("");
            setModal("upload");
          }}
        >
          <Database />
          Data sources
        </button>
        <button className="nav-item" onClick={() => setModal("connect")}>
          <GitBranch />
          Connections
        </button>
        <div className="side-label mt-7">Recent proposals</div>
        <div className="max-h-[42vh] overflow-auto">
          {dashboard.data?.runs.slice(0, 9).map((r) => (
            <button
              key={r.id}
              className={cn("history-item", selectedId === r.id && "selected")}
              onClick={() => selectRun(r.id)}
            >
              <FileCode2 size={13} />
              <span className="history-name">{r.sourceName}</span>
              <span className="ml-auto text-[9px]">r{r.revision}</span>
            </button>
          ))}
          {!dashboard.data?.runs.length && (
            <div className="px-3 py-3 text-[11px] leading-5 text-[#a0a697]">
              Your proposals will
              <br />
              appear here.
            </div>
          )}
        </div>
        <div className="side-bottom">
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings2 />
            Model settings
          </button>
          <div className="system-status">
            <span className="status-dot" />
            Local engine ready <span className="ml-auto text-[9px]">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <Layers3 size={14} />
            <span>Workspace</span>
            <ChevronRight size={12} />
            <span>Silver proposals</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[10px] text-[#8d9583]">
              BRONZE <span className="mx-2">→</span> SILVER
            </span>
            <div className="avatar">JR</div>
          </div>
        </header>
        <div className="page">
          <div className="heading-row">
            <div>
              <div className="eyebrow">Data engineering workbench</div>
              <h1>{run ? "Your Silver proposal" : "From raw data to a clear proposal."}</h1>
              <p>
                {run
                  ? "Inspect the evidence. Review each decision. Ship with confidence."
                  : "Build, test, and review your next transformation—with evidence at every step."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {run && (
                <>
                  <Button variant="outline" disabled={!run.spec || pending} onClick={download}>
                    <ArrowDownToLine />
                    Export {run.approvedAt ? "bundle" : "draft"}
                  </Button>
                  <Button
                    disabled={run.stage !== "ready" || !!run.approvedAt || pending}
                    onClick={() => perform(() => approveRun({ data: { id: selectedId } }))}
                  >
                    <CheckCheck />
                    {run.approvedAt ? "Approved" : "Approve proposal"}
                  </Button>
                </>
              )}
              {!run && (
                <Button variant="outline" onClick={() => setModal("upload")}>
                  <Plus />
                  Add source
                </Button>
              )}
            </div>
          </div>
          {(error || dashboard.error || runQuery.error) && (
            <div role="alert" className="notice error">
              <TriangleAlert size={16} />
              <span>{error || dashboard.error?.message || runQuery.error?.message}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")} className="ml-auto">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="source-bar">
            <div className="source-icon">
              <Database size={18} />
            </div>
            <div>
              <select
                aria-label="Bronze source"
                className="source-select"
                value={run?.sourceId ?? sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setIncludeSamples(false);
                  selectRun("");
                }}
              >
                {sources.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <div className="source-sub">
                {source?.kind === "databricks"
                  ? "DATABRICKS · DELTA TABLE"
                  : source?.kind === "sample"
                    ? "LOCAL SAMPLE · SYNTHETIC COMMERCE DATA"
                    : "LOCAL FILE · BRONZE SOURCE"}
              </div>
            </div>
            <Badge tone="orange">Bronze</Badge>
            <div className="source-actions">
              <Badge>
                {run
                  ? run.mode === "fixture"
                    ? "Fixture AI"
                    : "Live AI"
                  : mode === "fixture"
                    ? "Fixture AI"
                    : "Live AI"}
              </Badge>
              {run && (
                <Badge
                  tone={run.stage === "ready" ? "green" : run.stage === "failed" ? "red" : "orange"}
                >
                  {stageNames[run.stage]}
                </Badge>
              )}
              <span className="divider" />
              {run ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSourceId(run.sourceId);
                    selectRun("");
                  }}
                >
                  <Plus />
                  New proposal
                </Button>
              ) : (
                <Button size="sm" onClick={generate} disabled={pending || !source}>
                  {pending ? <LoaderCircle className="spin" /> : <Sparkles />}Generate proposal
                </Button>
              )}
            </div>
          </div>
          <div className="workflow-strip">
            {stages.map((name, i) => (
              <div
                key={name}
                className={cn(
                  "workflow-step",
                  run && i < stageIndex[run.stage] && "complete",
                  run && i === stageIndex[run.stage] && "current",
                )}
              >
                <span className="step-num">
                  {run && i < stageIndex[run.stage] ? <Check size={11} /> : i + 1}
                </span>
                <span>{name}</span>
                {i !== 4 && <ChevronRight size={11} className="ml-auto mr-3 text-[#c1c8b6]" />}
              </div>
            ))}
          </div>

          {!run && !selectedId && (
            <>
              <div className="welcome-grid">
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <FileInput />
                      Start with your source
                    </div>
                    <Badge>01 / 05</Badge>
                  </div>
                  <div className="welcome-content">
                    <div className="intro-icon">
                      <Layers3 size={26} strokeWidth={1.4} />
                    </div>
                    <h2>
                      Good pipelines start with
                      <br />
                      understanding the raw data.
                    </h2>
                    <p>
                      Silverline profiles your source, proposes a transformation, and tests it on
                      actual data. You review the decisions before anything leaves this workspace.
                    </p>
                    <label className="intent-field" htmlFor="intent">
                      What should this Silver table look like?
                    </label>
                    <textarea
                      id="intent"
                      className="field"
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                      maxLength={4000}
                    />
                    <div className="flex items-center justify-between mt-5 gap-3">
                      <select
                        aria-label="AI mode"
                        className="field max-w-[175px]"
                        value={mode}
                        onChange={(e) => setMode(e.target.value as "fixture" | "live")}
                      >
                        <option value="fixture">Fixture AI · no API calls</option>
                        <option value="live">Live AI · Jev + Luna</option>
                      </select>
                      <Button onClick={generate} disabled={pending || !source}>
                        {pending ? <LoaderCircle className="spin" /> : <Sparkles />}Generate
                        proposal
                        <ArrowRight />
                      </Button>
                    </div>
                    <label className="mt-4 flex items-start gap-2 text-[11px] text-[#8c957e]">
                      <input
                        type="checkbox"
                        checked={includeSamples}
                        onChange={(e) => setIncludeSamples(e.target.checked)}
                        className="mt-0.5 accent-[#a85d36]"
                      />
                      Include bounded example values with provider requests. Schema, statistics, and
                      your instructions are always included.
                    </label>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <ListChecks />A proposal you can inspect
                    </div>
                  </div>
                  <div className="recipe">
                    <Recipe
                      icon={<Database size={16} />}
                      title="Understand the source"
                      text="Exact local profiles, common values, and rare examples make the raw data visible."
                    />
                    <Recipe
                      icon={<Sparkles size={16} />}
                      title="Make evidence-backed decisions"
                      text="Luna proposes transformations. Jev evaluates their meaning against your source context."
                    />
                    <Recipe
                      icon={<FlaskConical size={16} />}
                      title="Test on actual data"
                      text="Execute SQL, isolate invalid records, and account for every source row."
                    />
                    <Recipe
                      icon={<FileCode2 size={16} />}
                      title="Take a reviewable pipeline with you"
                      text="Export SQL, quality rules, evidence, and a Databricks bundle when you are ready."
                    />
                  </div>
                </section>
              </div>
              <div className="footnote">
                <ShieldCheck size={14} className="shrink-0 mt-0.5" />
                <span>
                  {mode === "fixture"
                    ? "Fixture AI uses predetermined suggestions. DuckDB profiling and validation still run on the actual source data."
                    : "Live mode sends the selected evidence to TypeSafe and OpenRouter. Provider keys are loaded server-side through Varlock."}
                </span>
              </div>
            </>
          )}

          {selectedId && !run && (
            <div className="panel progress-line">
              <LoaderCircle className="spin" size={18} />
              Loading proposal…
            </div>
          )}
          {run && (
            <>
              {run.mode === "fixture" && (
                <div className="mb-5 flex items-center gap-2 text-[11px] text-[#949b88]">
                  <FlaskConical size={13} />
                  Fixture AI · Deterministic suggestions, real database execution.{" "}
                  <button
                    className="underline underline-offset-2"
                    onClick={() => setModal("settings")}
                  >
                    Configure live models
                  </button>
                </div>
              )}
              {active && (
                <div className="notice">
                  <LoaderCircle size={16} className="spin shrink-0 mt-0.5" />
                  <div>
                    {stageNames[run.stage]}
                    <div className="text-[11px] opacity-80">
                      {run.events.at(-1)?.message}
                      {run.stage === "queued" && " Ensure pnpm dev or pnpm worker is running."}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => perform(() => cancelRun({ data: { id: run.id } }))}
                  >
                    <Square />
                    Cancel
                  </Button>
                </div>
              )}
              {run.error && (
                <div className="notice error">
                  <TriangleAlert size={16} className="shrink-0" />
                  <span>{run.error}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => perform(() => retryRun({ data: { id: run.id } }))}
                  >
                    <RefreshCw />
                    Resume
                  </Button>
                </div>
              )}
              {run.stage === "cancelled" && (
                <div className="notice">
                  This run was cancelled. Saved stages can be resumed.
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => perform(() => retryRun({ data: { id: run.id } }))}
                  >
                    Resume run
                  </Button>
                </div>
              )}
              <div className="stats">
                <Stat
                  label="Source rows"
                  value={number(run.evidence?.rowCount)}
                  caption={
                    run.evidence ? "Profiled on this source snapshot" : "Waiting for source profile"
                  }
                  icon={<Database size={14} />}
                />
                <Stat
                  label="Silver rows"
                  value={number(run.validation?.accepted)}
                  caption="Validated, accepted records"
                  icon={<Layers3 size={14} />}
                />
                <Stat
                  label="Quarantined"
                  value={number(run.validation?.quarantined)}
                  caption="Preserved with failure reasons"
                  icon={<ShieldCheck size={14} />}
                />
                <Stat
                  label="Duplicate versions"
                  value={number(run.validation?.duplicates)}
                  caption="Tracked separately from invalid rows"
                  icon={<GitBranch size={14} />}
                />
              </div>
              <div className="tabs">
                {[
                  ["proposal", "Transformation plan"],
                  ["evidence", "Source evidence"],
                  ["validation", "Validation results"],
                  ["judgments", "Jev assessments"],
                  ["code", "Pipeline code"],
                  ["activity", "Activity"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={cn("tab", tab === id && "active")}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === "proposal" && (
                <>
                  <section className="panel">
                    <div className="panel-head">
                      <div className="panel-title">
                        <Columns3 />
                        Column transformations<Badge>{run.spec?.columns.length ?? 0} columns</Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!run.spec || active}
                        onClick={() => {
                          setSpecText(JSON.stringify(run.spec, null, 2));
                          setModal("spec");
                        }}
                      >
                        <Braces />
                        Edit specification
                      </Button>
                    </div>
                    {run.spec?.columns.map((c) => (
                      <div className="mapping-row" key={c.target}>
                        <div>
                          <div className="mapping-name">{c.source}</div>
                          <div className="mapping-reason">
                            {run.evidence?.columns.find((p) => p.name === c.source)?.type}
                          </div>
                        </div>
                        <ArrowRight size={14} className="text-[#a1ab93]" />
                        <div>
                          <div className="mapping-name">
                            {c.target}{" "}
                            {c.required && (
                              <span className="ml-1 text-[#bc8052] text-[9px]">REQUIRED</span>
                            )}
                          </div>
                          <div className="mapping-reason">{c.rationale}</div>
                        </div>
                        <div className="mapping-op">{c.operation}</div>
                        <button
                          title={`Edit ${c.target}`}
                          aria-label={`Edit ${c.target}`}
                          disabled={active}
                          onClick={() => {
                            setOriginalTarget(c.target);
                            setEditColumn({ ...c });
                          }}
                          className="p-1 text-[#8c997b]"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    ))}
                    {!run.spec && (
                      <div className="empty-small">
                        The transformation plan will appear after drafting.
                      </div>
                    )}
                  </section>
                  {run.spec && (
                    <div className="grid md:grid-cols-2 gap-4 mt-4">
                      <section className="panel p-5">
                        <div className="panel-title mb-3">
                          <GitBranch />
                          Deduplication policy
                        </div>
                        <p className="mini-note">
                          {run.spec.dedup
                            ? `Group by ${run.spec.dedup.keys.join(", ")}. Keep the ${run.spec.dedup.direction === "desc" ? "latest" : "earliest"} ${run.spec.dedup.orderBy}. Ambiguous ties block approval.`
                            : "No deduplication. All valid records are retained."}
                        </p>
                      </section>
                      <section className="panel p-5">
                        <div className="panel-title mb-3">
                          <CircleHelp />
                          Assumptions & open decisions
                        </div>
                        {[...run.spec.assumptions, ...run.spec.unresolved].map((a, i) => (
                          <p className="mini-note mb-2" key={i}>
                            {a}
                          </p>
                        ))}
                      </section>
                    </div>
                  )}
                </>
              )}
              {tab === "evidence" && (
                <>
                  {run.evidence ? (
                    <>
                      <div className="mini-note mb-4">
                        {run.evidence.coverage} · Collected{" "}
                        {new Date(run.evidence.collectedAt).toLocaleTimeString()}
                      </div>
                      <section className="panel mb-4">
                        <div className="panel-head">
                          <div className="panel-title">
                            <ListChecks />
                            Column profiles
                          </div>
                          <Badge>Measured</Badge>
                        </div>
                        <DataTable
                          rows={run.evidence.columns.map((c) => ({
                            column: c.name,
                            type: c.type,
                            nulls: c.nulls,
                            distinct: c.distinct,
                            numeric: c.numeric,
                            blanks: c.blanks,
                            rare_examples: c.examples.join(", "),
                          }))}
                        />
                      </section>
                      <section className="panel">
                        <div className="panel-head">
                          <div className="panel-title">
                            <Database />
                            Raw source preview
                          </div>
                          <Badge>First 12 rows</Badge>
                        </div>
                        <DataTable rows={run.evidence.preview} />
                      </section>
                    </>
                  ) : (
                    <div className="empty-small">Profiling has not completed.</div>
                  )}
                </>
              )}
              {tab === "validation" && <ValidationView run={run} />}
              {tab === "judgments" && (
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <Sparkles />
                      Semantic assessments
                    </div>
                    <Badge tone="orange">
                      {run.mode === "fixture" ? "Fixture · not model inference" : "TypeSafe Jev"}
                    </Badge>
                  </div>
                  {run.judgments.map((j, i) => (
                    <div className="test-row" key={i}>
                      {j.review ? (
                        <TriangleAlert size={16} className="text-[#b67c45]" />
                      ) : (
                        <Check size={16} className="text-[#6b8857]" />
                      )}
                      <div className="flex-1">
                        <h3>
                          {j.column}{" "}
                          <span className="ml-2 text-[9px] text-[#a1aa94] uppercase">{j.kind}</span>
                        </h3>
                        <p>{j.question}</p>
                        <div className="mt-2 text-[11px] text-[#687957]">
                          {j.answer} ·{" "}
                          {j.kind === "noul"
                            ? `P(yes) ${(j.value * 100).toFixed(1)}%`
                            : `Confidence ${((j.confidence ?? 0) * 100).toFixed(1)}%`}
                        </div>
                        {Object.keys(j.probabilities).length > 0 && (
                          <div className="mt-1 font-mono text-[10px] text-[#99a58b]">
                            {Object.entries(j.probabilities)
                              .map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`)
                              .join(" · ")}
                          </div>
                        )}
                      </div>
                      <Badge tone={j.review ? "orange" : "green"}>
                        {j.review ? "Review" : "Supported"}
                      </Badge>
                    </div>
                  ))}
                  {!run.judgments.length && (
                    <div className="empty-small">
                      Assessments will appear after Jev evaluates the proposal.
                    </div>
                  )}
                </section>
              )}
              {tab === "code" && <CodeView runId={run.id} enabled={!!run.spec} />}
              {tab === "activity" && (
                <section className="panel">
                  <div className="panel-head">
                    <div className="panel-title">
                      <History />
                      Run timeline
                    </div>
                    <Badge>Revision {run.revision}</Badge>
                  </div>
                  {run.events.map((e, i) => (
                    <div key={i} className="test-row">
                      <Clock3 size={14} className="text-[#9aaa89] mt-0.5" />
                      <div>
                        <h3>{e.message}</h3>
                        <p>
                          {new Date(e.at).toLocaleTimeString()} · {e.stage}
                        </p>
                      </div>
                    </div>
                  ))}
                  {run.calls.map((c, i) => (
                    <div className="test-row" key={`call-${i}`}>
                      <Sparkles size={14} className="text-[#9aaa89] mt-0.5" />
                      <div>
                        <h3>
                          {c.provider} · {c.model}
                        </h3>
                        <p>
                          {c.milliseconds} ms · {c.inputTokens} input tokens · {c.outputTokens}{" "}
                          output tokens · {c.mode}
                        </p>
                      </div>
                    </div>
                  ))}
                </section>
              )}
              <div className="footnote">
                <ShieldCheck size={14} className="shrink-0 mt-0.5" />
                <span>
                  Source data is preserved. Local validation covers the executed snapshot.
                  Databricks SQL: {run.validation?.databricks ?? "not run"} · Lakeflow runtime: not
                  run.
                </span>
                <span className="ml-auto whitespace-nowrap font-mono text-[9px]">
                  {run.id.slice(0, 8)} · r{run.revision}
                </span>
              </div>
            </>
          )}
        </div>
      </main>

      <Dialog
        open={modal === "upload"}
        onOpenChange={(open) => !open && setModal(null)}
        title="Add a Bronze source"
        description="Import a local CSV, JSONL, or Parquet file. Raw values are preserved."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const result = await perform(() => uploadSource({ data }));
            if (result) {
              setSourceId(result.id);
              setIncludeSamples(false);
              setModal(null);
              selectRun("");
            }
          }}
        >
          <label>
            Source file
            <input
              className="field"
              type="file"
              name="file"
              accept=".csv,.jsonl,.parquet"
              required
            />
          </label>
          <label>
            Source documentation
            <textarea
              className="field"
              name="description"
              placeholder="Known units, timestamp timezone, enum meanings, or business identifiers…"
              maxLength={4000}
            />
          </label>
          <p className="mini-note">
            Up to 25 MiB per file. For larger data, connect Databricks and profile remotely.
          </p>
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              <Upload />
              Import source
            </Button>
          </div>
        </form>
      </Dialog>
      <ConnectionDialog
        open={modal === "connect"}
        onClose={() => setModal(null)}
        onAdded={(id) => {
          setSourceId(id);
          setIncludeSamples(false);
          setModal(null);
          refresh();
          selectRun("");
        }}
      />
      <Dialog
        open={modal === "settings"}
        onOpenChange={(open) => !open && setModal(null)}
        title="Model configuration"
        description="API keys are loaded on the server through Varlock. Put your keys in .env and restart."
      >
        <div className="form-stack">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">TypeSafe Jev</div>
              <div className="mini-note font-mono">{dashboard.data?.config.jevModel}</div>
            </div>
            <Badge tone={dashboard.data?.config.jevReady ? "green" : "orange"}>
              {dashboard.data?.config.jevReady ? "Key configured" : "Key needed"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">OpenRouter</div>
              <div className="mini-note font-mono">{dashboard.data?.config.openrouterModel}</div>
            </div>
            <Badge tone={dashboard.data?.config.openrouterReady ? "green" : "orange"}>
              {dashboard.data?.config.openrouterReady ? "Key configured" : "Key needed"}
            </Badge>
          </div>
          <pre className="code rounded-md">
            {"AI_MODE=live\nTYPESAFE_API_KEY=your-key\nOPENROUTER_API_KEY=your-key"}
          </pre>
          <p className="mini-note">
            Fixture mode makes no provider requests. Live mode calls both providers and displays
            measured timing and token usage.
          </p>
        </div>
      </Dialog>
      <Dialog
        open={modal === "spec"}
        onOpenChange={(open) => !open && setModal(null)}
        title="Revise the specification"
        description="Saving creates a new revision and reruns judgments and validation. Previously approved results do not apply to edited code."
      >
        <textarea
          aria-label="Proposal specification"
          className="field font-mono text-[10px] min-h-[350px]"
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
        />
        <div className="form-actions">
          <Button variant="outline" onClick={() => setModal(null)}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              try {
                void saveSpec(JSON.parse(specText));
              } catch {
                setError("Specification must be valid JSON.");
              }
            }}
          >
            Save & revalidate
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        )}
      </Dialog>
      <Dialog
        open={!!editColumn}
        onOpenChange={(open) => !open && setEditColumn(null)}
        title={`Edit ${editColumn?.target ?? "column"}`}
        description="Every change creates a new proposal revision. The source column remains unchanged."
      >
        {editColumn && (
          <div className="form-stack">
            <label>
              Target name
              <input
                className="field"
                value={editColumn.target}
                onChange={(e) => setEditColumn({ ...editColumn, target: e.target.value })}
              />
            </label>
            <label>
              Operation
              <select
                className="field"
                value={editColumn.operation}
                onChange={(e) =>
                  setEditColumn({
                    ...editColumn,
                    operation: e.target.value as ColumnSpec["operation"],
                  })
                }
              >
                {[
                  "string",
                  "trim",
                  "integer",
                  "decimal",
                  "boolean",
                  "date",
                  "timestamp",
                  "enum",
                  "json",
                ].map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
            </label>
            <label className="!flex-row items-center">
              <input
                type="checkbox"
                checked={editColumn.required}
                onChange={(e) => setEditColumn({ ...editColumn, required: e.target.checked })}
              />
              Required value
            </label>
            {["date", "timestamp"].includes(editColumn.operation) && (
              <>
                <label>
                  Explicit format
                  <select
                    className="field"
                    value={editColumn.format ?? ""}
                    onChange={(e) =>
                      setEditColumn({ ...editColumn, format: e.target.value, timezone: "UTC" })
                    }
                  >
                    <option value="">Select format</option>
                    {[
                      "%Y-%m-%d",
                      "%m/%d/%Y",
                      "%d/%m/%Y",
                      "%Y-%m-%d %H:%M:%S",
                      "%Y-%m-%dT%H:%M:%SZ",
                    ].map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <p className="mini-note">
                  Timestamp operations require documented UTC source values.
                </p>
              </>
            )}
            {editColumn.operation === "decimal" && (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  Precision
                  <input
                    type="number"
                    className="field"
                    value={editColumn.precision ?? 12}
                    onChange={(e) =>
                      setEditColumn({ ...editColumn, precision: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Scale
                  <input
                    type="number"
                    className="field"
                    value={editColumn.scale ?? 2}
                    onChange={(e) =>
                      setEditColumn({ ...editColumn, scale: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            )}
            <label>
              Decision rationale
              <textarea
                className="field"
                value={editColumn.rationale}
                onChange={(e) => setEditColumn({ ...editColumn, rationale: e.target.value })}
              />
            </label>
            <p className="mini-note">
              Use “Edit specification” for enum maps, JSON paths, null sentinels, and deduplication
              policy.
            </p>
            <div className="form-actions">
              <Button variant="outline" onClick={() => setEditColumn(null)}>
                Cancel
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  run?.spec &&
                  saveSpec({
                    ...run.spec,
                    columns: run.spec.columns.map((c) =>
                      c.target === originalTarget ? editColumn : c,
                    ),
                    dedup: run.spec.dedup
                      ? {
                          ...run.spec.dedup,
                          keys: run.spec.dedup.keys.map((k) =>
                            k === originalTarget ? editColumn.target : k,
                          ),
                          orderBy:
                            run.spec.dedup.orderBy === originalTarget
                              ? editColumn.target
                              : run.spec.dedup.orderBy,
                        }
                      : null,
                  })
                }
              >
                Save & revalidate
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Recipe({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="recipe-row">
      <div className="recipe-symbol">{icon}</div>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  );
}
function Stat({
  label,
  value,
  caption,
  icon,
}: {
  label: string;
  value: string;
  caption: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-caption">{caption}</div>
    </div>
  );
}
function ValidationView({ run }: { run: Run }) {
  const v = run.validation;
  const [preview, setPreview] = useState("silver");
  if (!v)
    return <div className="panel empty-small">Validation results will appear after execution.</div>;
  return (
    <>
      <div className="mini-note mb-4">
        {v.engine} · {v.coverage} · Executed {new Date(v.executedAt).toLocaleTimeString()}
      </div>
      <section className="panel mb-5">
        <div className="panel-head">
          <div className="panel-title">
            <FlaskConical />
            Executed checks
          </div>
          <Badge tone={v.passed ? "green" : "orange"}>
            {v.passed ? "Passed" : "Needs attention"}
          </Badge>
        </div>
        {v.tests.map((t) => (
          <div className="test-row" key={t.name}>
            {t.passed ? (
              <Check size={16} className="text-[#75935e] mt-0.5" />
            ) : (
              <TriangleAlert size={16} className="text-[#b9844f] mt-0.5" />
            )}
            <div>
              <h3>{t.name}</h3>
              <p>{t.detail}</p>
            </div>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">
            <Database />
            Output preview
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={preview === "silver" ? "outline" : "ghost"}
              onClick={() => setPreview("silver")}
            >
              Silver ({number(v.accepted)})
            </Button>
            <Button
              size="sm"
              variant={preview === "quarantine" ? "outline" : "ghost"}
              onClick={() => setPreview("quarantine")}
            >
              Quarantine ({number(v.quarantined)})
            </Button>
          </div>
        </div>
        <DataTable
          rows={preview === "silver" ? v.preview : v.quarantine}
          empty="No quarantined records in this snapshot."
        />
      </section>
      <p className="mini-note mt-3">
        Showing up to 100 rows. Invalid values are quarantined; duplicate versions are accounted for
        separately.
      </p>
    </>
  );
}
function CodeView({ runId, enabled }: { runId: string; enabled: boolean }) {
  const code = useQuery({
    queryKey: ["code", runId],
    queryFn: () => getCompiled({ data: { id: runId } }),
    enabled,
  });
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <FileCode2 />
          pipeline.sql
        </div>
        <Badge>Lakeflow · batch proposal</Badge>
      </div>
      {code.error ? (
        <div className="notice error">{code.error.message}</div>
      ) : (
        <pre className="code">
          {code.data?.pipeline ?? "Generate a proposal to inspect its compiled SQL."}
        </pre>
      )}
    </section>
  );
}

function ConnectionDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [table, setTable] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = useQuery({ queryKey: ["dashboard"], queryFn: () => getDashboard() });
  const warehouses = useQuery({
    queryKey: ["warehouses", connectionId],
    queryFn: () => listWarehouses({ data: { id: connectionId } }),
    enabled: open && !!connectionId,
  });
  const catalogs = useQuery({
    queryKey: ["catalogs", connectionId, warehouseId],
    queryFn: () => listCatalog({ data: { connectionId, warehouseId, catalog: "", schema: "" } }),
    enabled: open && !!warehouseId,
  });
  const schemas = useQuery({
    queryKey: ["schemas", connectionId, warehouseId, catalog],
    queryFn: () => listCatalog({ data: { connectionId, warehouseId, catalog, schema: "" } }),
    enabled: open && !!warehouseId && !!catalog,
  });
  const tables = useQuery({
    queryKey: ["tables", connectionId, warehouseId, catalog, schema],
    queryFn: () => listCatalog({ data: { connectionId, warehouseId, catalog, schema } }),
    enabled: open && !!warehouseId && !!catalog && !!schema,
  });
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await connectDatabricks({ data: { host, token } });
      setToken("");
      setConnectionId(r.id);
      setWarehouseId(r.warehouses.length === 1 ? r.warehouses[0].id : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }
  const queryError = warehouses.error || catalogs.error || schemas.error || tables.error;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setToken("");
          onClose();
        }
      }}
      title="Connect Databricks"
      description="Use your workspace URL and personal access token. Choose an accessible SQL warehouse after connecting."
    >
      <div className="form-stack">
        {!connectionId ? (
          <>
            {!!saved.data?.connections.length && (
              <label>
                Saved workspace
                <select
                  className="field"
                  value=""
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  <option value="">Choose a saved connection</option>
                  {saved.data.connections.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.host}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Workspace URL
              <input
                className="field"
                type="url"
                placeholder="https://your-workspace.cloud.databricks.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
            <label>
              User PAT
              <input
                className="field"
                type="password"
                autoComplete="off"
                placeholder="Personal access token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p className="mini-note flex gap-2">
              <LockKeyhole size={14} className="shrink-0" />
              The token is encrypted in this local workspace and is never returned to the browser.
              Your user permissions determine accessible data.
            </p>
            <Button disabled={busy || !host || !token} onClick={connect}>
              {busy ? <LoaderCircle className="spin" /> : <GitBranch />}Connect workspace
            </Button>
          </>
        ) : (
          <>
            <label>
              SQL warehouse
              <select
                className="field"
                value={warehouseId}
                onChange={(e) => {
                  setWarehouseId(e.target.value);
                  setCatalog("");
                  setSchema("");
                  setTable("");
                }}
              >
                <option value="">
                  {warehouses.isLoading ? "Loading warehouses…" : "Choose an accessible warehouse"}
                </option>
                {warehouses.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.state}
                  </option>
                ))}
              </select>
            </label>
            {warehouseId && (
              <>
                <label>
                  Catalog
                  <select
                    className="field"
                    value={catalog}
                    onChange={(e) => {
                      setCatalog(e.target.value);
                      setSchema("");
                      setTable("");
                    }}
                  >
                    <option value="">{catalogs.isFetching ? "Loading…" : "Choose catalog"}</option>
                    {catalogs.data?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Schema
                  <select
                    className="field"
                    value={schema}
                    onChange={(e) => {
                      setSchema(e.target.value);
                      setTable("");
                    }}
                    disabled={!catalog}
                  >
                    <option value="">Choose schema</option>
                    {schemas.data?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Delta table
                  <select
                    className="field"
                    value={table}
                    onChange={(e) => setTable(e.target.value)}
                    disabled={!schema}
                  >
                    <option value="">Choose table</option>
                    {tables.data?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <p className="mini-note">
              Profiling reads up to 10,000 rows of a fixed Delta version. Selecting a stable subset
              can scan the source table and use warehouse compute. No production data is modified.
            </p>
            <div className="form-actions">
              <Button
                variant="outline"
                onClick={() => {
                  setConnectionId("");
                  setWarehouseId("");
                }}
              >
                Different workspace
              </Button>
              <Button
                disabled={!table || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await addRemoteSource({
                      data: { connectionId, warehouseId, catalog, schema, table },
                    });
                    onAdded(r.id);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Unable to add source");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Add source
                <ArrowRight />
              </Button>
            </div>
          </>
        )}
        {(error || queryError) && (
          <div role="alert" className="notice error">
            {error || queryError?.message}
          </div>
        )}
      </div>
    </Dialog>
  );
}
