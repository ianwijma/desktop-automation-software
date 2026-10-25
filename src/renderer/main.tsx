import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Workflow,
  Activity,
  CalendarClock,
  Settings2,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Play,
  Check,
  CheckCircle2,
  X,
  Moon,
  Sun,
  Folder,
  Layers3,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
  Redo2,
  Save,
  MoreHorizontal,
  ShieldCheck,
  CircleAlert,
  Copy,
  Trash2,
  Video,
  ArrowRight,
  LoaderCircle,
} from "lucide-react";
import type {
  WorkspaceState,
  RelayAPI,
  FlowDefinition,
  FlowNode,
  NodeKind,
  ValidationIssue,
  RecordingState,
  RecordingInsertOptions,
  RecordingInsertionAnchor,
  Json,
  FlowSaveResult,
} from "../shared/types";
import { previewAPI } from "./preview-api";
import { catalog, blankFlow, uid } from "./catalog";
import { GraphEditor, Inspector, NodePalette } from "./editor";
import { Recorder } from "./recorder";
import type { RecordingReviewCache } from "./recording-review";
import { Settings } from "./settings";
import { Runs, Schedules } from "./runs";
import { Button, IconButton, Modal, JsonField } from "./components";
import "@xyflow/react/dist/style.css";
import "./styles.css";
const api: RelayAPI = window.relay ?? previewAPI;
type Page = "flows" | "runs" | "schedules" | "settings";
type Toast = { id: string; message: string; error: boolean };
function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [draft, setDraft] = useState<FlowDefinition | null>(null);
  const [page, setPage] = useState<Page>("flows");
  const [flowTab, setFlowTab] = useState<"flow" | "record" | "runs">("flow");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [palette, setPalette] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [bootError, setBootError] = useState("");
  const [undo, setUndo] = useState<FlowDefinition[]>([]);
  const [redo, setRedo] = useState<FlowDefinition[]>([]);
  const [runInputs, setRunInputs] = useState<Record<string, Json> | null>(null);
  const [saveConflict, setSaveConflict] = useState<
    | (Extract<FlowSaveResult, { status: "conflict" }> & { flowId: string })
    | null
  >(null);
  const baseRevisions = useRef(new Map<string, number>());
  const saving = useRef<Promise<FlowDefinition | null> | null>(null);
  const clipboard = useRef<FlowNode | null>(null);
  const recordingReviewCache = useRef<RecordingReviewCache | null>(null);
  const insertionHistory = useRef(
    new Map<string, { revision: number; previous: FlowDefinition }>(),
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    setSelectedEdge(null);
  }, [draft?.id]);
  const toast = useCallback((message: string, error = false) => {
    const id = uid();
    setToasts((t) => [...t.slice(-3), { id, message, error }]);
    setTimeout(
      () => setToasts((t) => t.filter((item) => item.id !== id)),
      error ? 10000 : 4500,
    );
  }, []);
  const onError = useCallback(
    (error: unknown) =>
      toast(error instanceof Error ? error.message : String(error), true),
    [toast],
  );
  const refresh = useCallback(async () => {
    const next = await api.bootstrap();
    setWorkspace(next);
    if (!draftRef.current && next.flows.length) {
      setDraft(next.flows[0]);
      draftRef.current = next.flows[0];
      baseRevisions.current.set(next.flows[0].id, next.flows[0].revision);
    }
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setBootError(String(error)));
    return api.onEvent((event) => {
      if (event.type === "run")
        setWorkspace((w) =>
          w
            ? {
                ...w,
                runs: [
                  event.run,
                  ...w.runs.filter((r) => r.id !== event.run.id),
                ],
              }
            : w,
        );
      else if (event.type === "recording")
        setWorkspace((w) => (w ? { ...w, recording: event.recording } : w));
      else if (event.type === "capabilities")
        setWorkspace((w) =>
          w ? { ...w, capabilities: event.capabilities } : w,
        );
      else void refresh().catch(onError);
    });
  }, [refresh, onError]);
  useEffect(() => {
    if (workspace?.recording.phase === "idle")
      recordingReviewCache.current = null;
  }, [workspace?.recording.phase]);
  useEffect(() => {
    if (!workspace) return;
    const apply = () => {
      const theme =
        workspace.settings.theme === "system"
          ? matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : workspace.settings.theme;
      document.documentElement.dataset.theme = theme;
      const accent = /^#[\da-f]{6}$/i.test(workspace.settings.accent)
        ? workspace.settings.accent
        : "#9292ff";
      document.documentElement.style.setProperty("--accent-raw", accent);
      document.documentElement.style.setProperty(
        "--accent",
        readableAccent(accent, theme),
      );
      document.documentElement.style.setProperty(
        "--accent-ink",
        theme === "light"
          ? "#ffffff"
          : luminance(readableAccent(accent, theme)) > 0.3
            ? "#111318"
            : "#ffffff",
      );
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [workspace?.settings.theme, workspace?.settings.accent]);
  const change = useCallback((next: FlowDefinition) => {
    const previous = draftRef.current;
    if (previous)
      setUndo((items) => [...items.slice(-59), structuredClone(previous)]);
    draftRef.current = next;
    setDraft(next);
    setRedo([]);
    setDirty(true);
  }, []);
  const rememberSaved = useCallback((flow: FlowDefinition) => {
    baseRevisions.current.set(flow.id, flow.revision);
    setWorkspace((current) =>
      current
        ? {
            ...current,
            flows: current.flows.some((item) => item.id === flow.id)
              ? current.flows.map((item) => (item.id === flow.id ? flow : item))
              : [...current.flows, flow],
          }
        : current,
    );
  }, []);
  const finishSaved = useCallback(
    async (result: Extract<FlowSaveResult, { status: "saved" }>) => {
      let warning = result.warning;
      try {
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warning = [warning, `The workspace could not refresh: ${message}`]
          .filter(Boolean)
          .join(" ");
      }
      toast(
        warning ? `Flow saved. ${warning}` : "Flow saved.",
        Boolean(warning),
      );
      return !warning;
    },
    [refresh, toast],
  );
  const save = useCallback(async () => {
    if (saving.current) return saving.current;
    const current = draftRef.current;
    if (!current) return null;
    const operation = (async () => {
      setBusy("save");
      try {
        const result = await api.saveFlow(current, {
          expectedRevision:
            baseRevisions.current.get(current.id) ?? current.revision,
        });
        if (result.status === "conflict") {
          setSaveConflict({ ...result, flowId: current.id });
          await refresh();
          return null;
        }
        const saved = result.flow;
        rememberSaved(saved);
        if (draftRef.current?.id === current.id) {
          if (draftRef.current === current) {
            draftRef.current = saved;
            setDraft(saved);
            setDirty(false);
          } else {
            const latest = {
              ...draftRef.current,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
            };
            draftRef.current = latest;
            setDraft(latest);
          }
        }
        setSaveConflict(null);
        return (await finishSaved(result)) ? saved : null;
      } catch (error) {
        onError(error);
        return null;
      } finally {
        setBusy(null);
        saving.current = null;
      }
    })();
    saving.current = operation;
    return operation;
  }, [refresh, finishSaved, rememberSaved, onError]);
  const chooseFlow = (id: string) => {
    if (
      dirty &&
      !window.confirm(
        "You have unsaved changes. Discard them and open another flow?",
      )
    )
      return;
    const next = workspace?.flows.find((f) => f.id === id);
    if (next) {
      const opened = structuredClone(next);
      draftRef.current = opened;
      setDraft(opened);
      baseRevisions.current.set(next.id, next.revision);
      setSaveConflict(null);
      setDirty(false);
      setSelected(null);
      setIssues([]);
      const inserted = insertionHistory.current.get(next.id);
      setUndo(inserted?.revision === next.revision ? [inserted.previous] : []);
      setRedo([]);
      setPage("flows");
      setFlowTab("flow");
    }
  };
  const newFlow = async () => {
    if (
      dirty &&
      !window.confirm("Discard unsaved changes and create a new flow?")
    )
      return;
    try {
      const result = await api.saveFlow(blankFlow(), {
        expectedRevision: null,
      });
      if (result.status === "conflict") throw new Error(result.reason);
      const flow = result.flow;
      draftRef.current = flow;
      setDraft(flow);
      rememberSaved(flow);
      setSaveConflict(null);
      setSelected(null);
      setDirty(false);
      setPage("flows");
      setFlowTab("flow");
      setUndo([]);
      setRedo([]);
      await finishSaved(result);
    } catch (error) {
      onError(error);
    }
  };
  const addNode = (kind: NodeKind) => {
    if (!draft) return;
    const parent =
      draft.nodes.find((n) => n.id === selected) ?? draft.nodes.at(-1);
    const id = uid();
    const node: FlowNode = {
      id,
      kind,
      label: catalog[kind].label,
      position: {
        x: parent ? parent.position.x + 310 : 80,
        y: parent ? parent.position.y : 180,
      },
      config: structuredClone(catalog[kind].defaults),
    };
    const canConnect =
      parent &&
      parent.kind !== "end" &&
      !draft.edges.some((e) => e.source === parent.id);
    change({
      ...draft,
      nodes: [...draft.nodes, node],
      edges: canConnect
        ? [
            ...draft.edges,
            {
              id: uid(),
              source: parent.id,
              target: id,
              port: catalog[parent.kind].ports?.[0] ?? "next",
            },
          ]
        : draft.edges,
    });
    setSelected(id);
  };
  const deleteNode = () => {
    if (!draft || !selected) return;
    change({
      ...draft,
      nodes: draft.nodes.filter((n) => n.id !== selected),
      edges: draft.edges.filter(
        (e) => e.source !== selected && e.target !== selected,
      ),
    });
    setSelected(null);
  };
  const duplicateNode = () => {
    if (!draft || !selected) return;
    const node = draft.nodes.find((n) => n.id === selected);
    if (!node) return;
    const copy = {
      ...structuredClone(node),
      id: uid(),
      position: { x: node.position.x + 40, y: node.position.y + 180 },
      label: `${node.label} copy`,
    };
    change({ ...draft, nodes: [...draft.nodes, copy] });
    setSelected(copy.id);
  };
  const undoAction = () => {
    if (!draft || !undo.length) return;
    setRedo((values) => [...values, structuredClone(draft)]);
    const restored = undo[undo.length - 1];
    draftRef.current = restored;
    setDraft(restored);
    setUndo((values) => values.slice(0, -1));
    setDirty(true);
  };
  const redoAction = () => {
    if (!draft || !redo.length) return;
    setUndo((values) => [...values, structuredClone(draft)]);
    const restored = redo[redo.length - 1];
    draftRef.current = restored;
    setDraft(restored);
    setRedo((values) => values.slice(0, -1));
    setDirty(true);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[role="dialog"]')
      )
        return;
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.matches("input,textarea,select") ||
          event.target.isContentEditable);
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        // Review edits use their own revisioned save. Saving the graph here
        // would invalidate the bound insertion revision without changing it.
        if (page === "flows" && flowTab === "record") return;
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        queueMicrotask(() => void save());
        return;
      }
      if (editing || page !== "flows" || flowTab !== "flow") return;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoAction();
        else undoAction();
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoAction();
      } else if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateNode();
      } else if (command && event.key.toLowerCase() === "c" && selected) {
        event.preventDefault();
        clipboard.current = structuredClone(
          draft?.nodes.find((n) => n.id === selected) ?? null,
        );
        toast("Node copied.");
      } else if (
        command &&
        event.key.toLowerCase() === "v" &&
        clipboard.current &&
        draft
      ) {
        event.preventDefault();
        const n = {
          ...structuredClone(clipboard.current),
          id: uid(),
          position: {
            x: clipboard.current.position.x + 60,
            y: clipboard.current.position.y + 180,
          },
        };
        change({ ...draft, nodes: [...draft.nodes, n] });
        setSelected(n.id);
      } else if (!command && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const validate = async () => {
    if (!draft) return;
    setBusy("validate");
    try {
      const result = await api.validateFlow(draft);
      setIssues(result);
      setShowValidation(true);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };
  const run = async (inputs?: Record<string, Json>) => {
    if (!draft) return;
    setBusy("run");
    try {
      const result = await api.validateFlow(draft);
      setIssues(result);
      if (result.some((issue) => issue.severity === "error")) {
        setShowValidation(true);
        return;
      }
      let flow = draft;
      if (dirty) {
        const saved = await save();
        if (!saved) return;
        flow = saved;
        setBusy("run");
        const savedIssues = await api.validateFlow(flow);
        setIssues(savedIssues);
        if (savedIssues.some((issue) => issue.severity === "error")) {
          setShowValidation(true);
          return;
        }
      }
      const resultRun = await api.runFlow(flow.id, inputs ?? flow.inputs);
      setWorkspace((w) =>
        w
          ? {
              ...w,
              runs: [resultRun, ...w.runs.filter((r) => r.id !== resultRun.id)],
            }
          : w,
      );
      setRunInputs(null);
      toast("Flow started.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };
  const updateRecordingState = useCallback((recording: RecordingState) => {
    setWorkspace((current) => (current ? { ...current, recording } : current));
  }, []);
  const startRecording = async (
    targetId: string,
    mode: "guided" | "direct",
    anchor?: RecordingInsertionAnchor,
  ) => {
    const current = draftRef.current;
    if (!current)
      throw new Error("Open a workflow before starting a recording.");
    const saved = await save();
    if (!saved)
      throw new Error(
        "Recording has not started. Resolve the workflow save issue first.",
      );
    if (draftRef.current !== saved)
      throw new Error(
        "The workflow changed while saving. Save your latest changes before recording.",
      );
    const recording = await api.startRecording({
      targetId,
      mode,
      flowId: saved.id,
      flowRevision: saved.revision,
      anchor,
    });
    updateRecordingState(recording);
    return recording;
  };
  const insertRecording = async (
    sessionId: string,
    revision: number,
    options: RecordingInsertOptions,
  ) => {
    if (dirty && draftRef.current) {
      const saved = await save();
      if (!saved || draftRef.current !== saved)
        throw new Error(
          "Your recording is preserved. Save or resolve the current workflow draft before inserting.",
        );
    }
    const previousDraft = draftRef.current;
    const result = await api.insertRecording(sessionId, revision, options);
    if (result.previousFlow)
      insertionHistory.current.set(result.flow.id, {
        revision: result.flow.revision,
        previous: result.previousFlow,
      });
    updateRecordingState(result.recording);
    // A user may navigate or edit while IPC is pending. Never replace that draft.
    const canOpen = draftRef.current === previousDraft;
    if (canOpen || draftRef.current?.id !== result.flow.id) {
      rememberSaved(result.flow);
    } else {
      // Keep the edited draft's old CAS base so saving it cannot erase the
      // insertion that committed while the user was editing.
      setWorkspace((current) =>
        current
          ? {
              ...current,
              flows: current.flows.map((flow) =>
                flow.id === result.flow.id ? result.flow : flow,
              ),
            }
          : current,
      );
    }
    if (canOpen) {
      draftRef.current = result.flow;
      setSelectedEdge(null);
      setDraft(result.flow);
      setSaveConflict(null);
      setUndo(
        result.previousFlow
          ? [
              ...(previousDraft?.id === result.flow.id ? undo : []).slice(-59),
              result.previousFlow,
            ]
          : [],
      );
      setRedo([]);
      setDirty(false);
      setSelected(null);
      setIssues([]);
      setPage("flows");
      setFlowTab("flow");
    }
    let warning = result.warning;
    try {
      await refresh();
    } catch (error) {
      warning = [
        warning,
        `Workspace refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join(" ");
    }
    toast(
      `Recording inserted into “${result.flow.name}”.${canOpen ? "" : " Your current draft is preserved; open the inserted workflow from the sidebar."}${warning ? ` ${warning}` : ""}`,
      Boolean(warning),
    );
    return result;
  };
  const importFlow = async () => {
    if (dirty && !window.confirm("Discard unsaved changes and import a flow?"))
      return;
    try {
      const flow = await api.importFlow();
      if (flow) {
        await refresh();
        setDraft(flow);
        draftRef.current = flow;
        baseRevisions.current.set(flow.id, flow.revision);
        setSaveConflict(null);
        setUndo([]);
        setRedo([]);
        setDirty(false);
        setPage("flows");
        setFlowTab("flow");
        toast("Flow imported.");
      }
    } catch (error) {
      onError(error);
    }
  };
  if (bootError)
    return (
      <div className="boot-screen">
        <CircleAlert size={36} />
        <h1>Relay couldn’t open your workspace</h1>
        <p>{bootError}</p>
        <Button
          onClick={() => {
            setBootError("");
            void refresh().catch((error) => setBootError(String(error)));
          }}
        >
          Try again
        </Button>
      </div>
    );
  if (!workspace)
    return (
      <div className="boot-screen">
        <RelayLogo />
        <LoaderCircle className="spin" size={22} />
        <p>Opening your workspace…</p>
      </div>
    );
  const flowRuns = workspace.runs
    .filter((r) => r.flowId === draft?.id && !r.parentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const currentRun = flowRuns.find((r) =>
    ["running", "paused"].includes(r.status),
  );
  const selectedNode = draft?.nodes.find((n) => n.id === selected);
  const filteredFlows = workspace.flows.filter((f) =>
    `${f.name} ${f.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const folders = Array.from(
    new Set(filteredFlows.map((f) => f.folder || "My flows")),
  );
  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label="Main navigation">
        <button
          className="brand-mark"
          aria-label="Relay workflows"
          onClick={() => setPage("flows")}
        >
          <RelayLogo />
        </button>
        <div className="rail-separator" />
        {(
          [
            { id: "flows", label: "Workflows", icon: Workflow },
            { id: "runs", label: "Run history", icon: Activity },
            { id: "schedules", label: "Schedules", icon: CalendarClock },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`rail-button ${page === id ? "active" : ""}`}
            title={label}
            aria-label={label}
            onClick={() => setPage(id)}
          >
            <Icon size={22} />
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className="rail-button"
          aria-label="Toggle light and dark theme"
          title="Toggle theme"
          onClick={() =>
            void api
              .saveSettings({
                ...workspace.settings,
                theme:
                  document.documentElement.dataset.theme === "dark"
                    ? "light"
                    : "dark",
              })
              .then(refresh)
              .catch(onError)
          }
        >
          {document.documentElement.dataset.theme === "light" ? (
            <Moon size={20} />
          ) : (
            <Sun size={20} />
          )}
        </button>
        <button
          className={`rail-button ${page === "settings" ? "active" : ""}`}
          aria-label="Settings"
          title="Settings"
          onClick={() => setPage("settings")}
        >
          <Settings2 size={21} />
        </button>
        <div className="rail-separator" />
        <span className="workspace-avatar" title="Local workspace">
          L<span />
        </span>
      </nav>
      <aside className="flow-sidebar">
        <div className="workspace-heading">
          <span className="workspace-icon">
            <Layers3 size={17} />
          </span>
          <div>
            <strong>My workspace</strong>
            <small>Local & yours</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="sidebar-search">
          <Search size={14} />
          <input
            aria-label="Search flows"
            placeholder="Find a flow…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </div>
        <button className="new-flow-button" onClick={() => void newFlow()}>
          <Plus size={15} /> New workflow <span>+</span>
        </button>
        <div className="flow-navigation">
          <div className="sidebar-section-label">
            WORKFLOWS <span>{workspace.flows.length}</span>
          </div>
          {folders.map((folder) => (
            <section className="flow-folder" key={folder}>
              <div className="folder-name">
                <ChevronDown size={12} />
                <Folder size={13} />
                {folder}
                <span>
                  {
                    filteredFlows.filter(
                      (f) => (f.folder || "My flows") === folder,
                    ).length
                  }
                </span>
              </div>
              {filteredFlows
                .filter((f) => (f.folder || "My flows") === folder)
                .map((flow) => (
                  <button
                    key={flow.id}
                    className={`flow-nav-item ${draft?.id === flow.id && page === "flows" ? "active" : ""}`}
                    onClick={() => chooseFlow(flow.id)}
                  >
                    <Workflow size={15} />
                    <span>{flow.name}</span>
                    {draft?.id === flow.id && dirty ? (
                      <span className="unsaved-dot" />
                    ) : null}
                  </button>
                ))}
            </section>
          ))}
          {!filteredFlows.length ? (
            <p className="sidebar-empty">No flows found.</p>
          ) : null}
        </div>
        <div className="sidebar-bottom">
          {workspace.recording.phase !== "idle" ? (
            <button
              className="recording-draft-nav"
              aria-label="Open recording draft"
              onClick={() => {
                setPage("flows");
                setFlowTab("record");
              }}
            >
              <span>
                <Video size={14} />
                {workspace.recording.phase === "capturing"
                  ? "Recording in progress"
                  : workspace.recording.phase === "paused"
                    ? "Recording paused"
                    : "Review recording draft"}
              </span>
              <small>
                {workspace.recording.destination?.flowName} ·{" "}
                {workspace.recording.actions.length} steps
              </small>
            </button>
          ) : null}
          <button onClick={() => void importFlow()}>
            <ArrowDownToLine size={15} /> Import a workflow
          </button>
          <div className="local-status">
            <span className="online-dot" />
            <span>
              {workspace.desktop ? "On your device" : "Browser preview"}
            </span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main-area">
        {page === "flows" && draft ? (
          <>
            <header className="flow-header">
              <div className="breadcrumb">
                <Workflow size={16} />
                <span>Workflows</span>
                <ChevronRight size={13} />
                <strong>{draft.name}</strong>
                {dirty ? (
                  <span className="unsaved-dot" title="Unsaved changes" />
                ) : (
                  <span className="saved-check" title="Saved">
                    <Check size={13} />
                  </span>
                )}
              </div>
              <div className="header-actions">
                <span className="saved-label">
                  {dirty ? "Unsaved changes" : "All changes saved"}
                </span>
                <IconButton
                  label="Export flow"
                  onClick={() =>
                    void (dirty ? save() : Promise.resolve(draft))
                      .then((flow) => (flow ? api.exportFlow(flow.id) : false))
                      .catch(onError)
                  }
                >
                  <ArrowUpFromLine size={16} />
                </IconButton>
                <details className="more-menu">
                  <summary aria-label="More flow actions">
                    <MoreHorizontal size={18} />
                  </summary>
                  <div>
                    <button
                      onClick={() => {
                        const copy = {
                          ...structuredClone(draft),
                          id: uid(),
                          name: `${draft.name} copy`,
                          revision: 1,
                          createdAt: new Date().toISOString(),
                          updatedAt: new Date().toISOString(),
                        };
                        void api
                          .saveFlow(copy, { expectedRevision: null })
                          .then(async (result) => {
                            if (result.status === "conflict")
                              throw new Error(result.reason);
                            draftRef.current = result.flow;
                            setDraft(result.flow);
                            rememberSaved(result.flow);
                            setSaveConflict(null);
                            setUndo([]);
                            setRedo([]);
                            setDirty(false);
                            await finishSaved(result);
                          })
                          .catch(onError);
                      }}
                    >
                      <Copy size={14} /> Duplicate flow
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete “${draft.name}”? This removes the saved flow.`,
                          )
                        )
                          void api
                            .deleteFlow(draft.id)
                            .then(async () => {
                              setDraft(null);
                              draftRef.current = null;
                              setDirty(false);
                              await refresh();
                            })
                            .catch(onError);
                      }}
                    >
                      <Trash2 size={14} /> Delete flow
                    </button>
                  </div>
                </details>
              </div>
            </header>
            <div className="flow-toolbar">
              <div className="flow-tabs">
                {(["flow", "record", "runs"] as const).map((tab) => (
                  <button
                    key={tab}
                    className={flowTab === tab ? "active" : ""}
                    onClick={() => setFlowTab(tab)}
                  >
                    {tab === "flow" ? (
                      <Workflow size={15} />
                    ) : tab === "record" ? (
                      <Video size={15} />
                    ) : (
                      <Activity size={15} />
                    )}{" "}
                    {tab === "flow"
                      ? "Editor"
                      : tab === "record"
                        ? "Record"
                        : "Runs"}
                    {tab === "runs" && flowRuns.length ? (
                      <span>{flowRuns.length}</span>
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="toolbar-actions">
                {flowTab === "flow" ? (
                  <>
                    <div className="undo-controls">
                      <IconButton
                        label="Undo (Ctrl+Z)"
                        onClick={undoAction}
                        disabled={!undo.length}
                      >
                        <Undo2 size={15} />
                      </IconButton>
                      <IconButton
                        label="Redo (Ctrl+Shift+Z)"
                        onClick={redoAction}
                        disabled={!redo.length}
                      >
                        <Redo2 size={15} />
                      </IconButton>
                    </div>
                    <Button
                      variant="ghost"
                      busy={busy === "validate"}
                      onClick={() => void validate()}
                    >
                      <ShieldCheck size={15} /> Validate
                    </Button>
                    <Button
                      busy={busy === "save"}
                      onClick={() => void save()}
                      disabled={!dirty}
                    >
                      <Save size={14} /> Save
                    </Button>
                    <Button
                      variant="primary"
                      busy={busy === "run"}
                      onClick={() =>
                        Object.keys(draft.inputs).length
                          ? setRunInputs(structuredClone(draft.inputs))
                          : void run()
                      }
                    >
                      <Play size={14} fill="currentColor" /> Run flow
                    </Button>
                    <IconButton
                      label={
                        showInspector ? "Hide properties" : "Show properties"
                      }
                      onClick={() => setShowInspector(!showInspector)}
                    >
                      {showInspector ? (
                        <PanelRightClose size={17} />
                      ) : (
                        <PanelRightOpen size={17} />
                      )}
                    </IconButton>
                  </>
                ) : null}
              </div>
            </div>
            {flowTab === "flow" ? (
              <>
                <div className="editor-body">
                  <GraphEditor
                    key={draft.id}
                    flow={draft}
                    workspace={workspace}
                    selected={selected}
                    selectedEdge={selectedEdge}
                    onSelect={(id) => {
                      setSelected(id);
                      setSelectedEdge(null);
                    }}
                    onSelectEdge={(id) => {
                      setSelected(null);
                      setSelectedEdge(id);
                    }}
                    onChange={change}
                    onAdd={() => setPalette(true)}
                    issues={issues}
                    run={currentRun}
                  />
                  {showInspector ? (
                    <Inspector
                      key={selected ?? "flow"}
                      flow={draft}
                      node={selectedNode}
                      workspace={workspace}
                      onChange={change}
                      onDelete={deleteNode}
                      onDuplicate={duplicateNode}
                      onTest={(config) =>
                        void api
                          .testDetector(config)
                          .then((result) =>
                            toast(
                              `Detector: ${result.outcome}${result.confidence !== undefined ? ` (${Math.round(result.confidence * 100)}%)` : ""}${result.evidence ? ` — ${result.evidence}` : ""}`,
                            ),
                          )
                          .catch(onError)
                      }
                      issues={issues}
                    />
                  ) : null}
                </div>
                <footer className="editor-status">
                  <span>
                    <span
                      className={`tiny-dot ${currentRun ? "running" : ""}`}
                    />
                    {currentRun
                      ? `${currentRun.status === "paused" ? "Paused" : "Running"} · ${draft.nodes.find((n) => n.id === currentRun.currentNodeId)?.label ?? draft.name}`
                      : "Ready to connect the dots"}
                  </span>
                  <div>
                    {currentRun ? (
                      <>
                        <button
                          onClick={() =>
                            void api
                              .controlRun(
                                currentRun.id,
                                currentRun.status === "paused"
                                  ? "resume"
                                  : "pause",
                              )
                              .catch(onError)
                          }
                        >
                          {currentRun.status === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="danger-text"
                          onClick={() =>
                            void api
                              .controlRun(currentRun.id, "stop")
                              .catch(onError)
                          }
                        >
                          Stop
                        </button>
                      </>
                    ) : null}
                    <span>{draft.nodes.length} nodes</span>
                    <span>{draft.edges.length} connections</span>
                    <span>
                      {workspace.desktop
                        ? workspace.capabilities.platform
                        : "Design preview"}
                    </span>
                  </div>
                </footer>
              </>
            ) : flowTab === "record" ? (
              <Recorder
                api={api}
                workspace={workspace}
                currentFlow={draft}
                selectedNodeId={selected}
                selectedEdgeId={selectedEdge}
                onStart={startRecording}
                onInsert={insertRecording}
                onState={updateRecordingState}
                onOpenBoundFlow={chooseFlow}
                onError={onError}
                reviewCache={recordingReviewCache}
              />
            ) : (
              <Runs
                workspace={workspace}
                api={api}
                onError={onError}
                flowId={draft.id}
                onOpenFlow={chooseFlow}
              />
            )}
          </>
        ) : page === "flows" &&
          flowTab === "record" &&
          workspace.recording.phase !== "idle" ? (
          <div className="recording-standalone">
            <Recorder
              api={api}
              workspace={workspace}
              currentFlow={null}
              selectedNodeId={null}
              selectedEdgeId={null}
              onStart={startRecording}
              onInsert={insertRecording}
              onState={updateRecordingState}
              onOpenBoundFlow={chooseFlow}
              onError={onError}
              reviewCache={recordingReviewCache}
            />
          </div>
        ) : page === "flows" ? (
          <div className="welcome-page">
            <div className="welcome-orbit">
              <RelayLogo />
            </div>
            <span className="section-eyebrow">
              LESS REPETITION. MORE POSSIBILITY.
            </span>
            <h1>
              Make your desktop
              <br />
              work for you.
            </h1>
            <p>
              Connect a few actions. Add a little intelligence.
              <br />
              Get back to what you love doing.
            </p>
            <Button variant="primary" onClick={() => void newFlow()}>
              <Plus size={16} /> Create your first flow <ArrowRight size={16} />
            </Button>
          </div>
        ) : page === "settings" ? (
          <Settings
            workspace={workspace}
            api={api}
            refresh={refresh}
            onError={onError}
            onSuccess={toast}
          />
        ) : page === "runs" ? (
          <Runs
            workspace={workspace}
            api={api}
            onError={onError}
            onOpenFlow={chooseFlow}
          />
        ) : (
          <Schedules
            workspace={workspace}
            api={api}
            refresh={refresh}
            onError={onError}
            onSuccess={toast}
          />
        )}
      </main>
      <NodePalette
        open={palette}
        onClose={() => setPalette(false)}
        onAdd={addNode}
      />
      <Modal
        open={showValidation}
        onClose={() => setShowValidation(false)}
        title={
          issues.some((i) => i.severity === "error")
            ? "A few things need your attention"
            : "Your flow is looking good"
        }
        description="Check your graph before taking it for a run."
      >
        {issues.length ? (
          <div className="validation-list">
            {issues.map((issue, index) => (
              <button
                key={index}
                onClick={() => {
                  if (issue.nodeId) {
                    setSelected(issue.nodeId);
                    setShowInspector(true);
                    setShowValidation(false);
                  }
                }}
              >
                <span
                  className={
                    issue.severity === "error" ? "error-text" : "warning-text"
                  }
                >
                  <CircleAlert size={18} />
                </span>
                <span>
                  {issue.message}
                  <small>
                    {issue.nodeId
                      ? draft?.nodes.find((n) => n.id === issue.nodeId)?.label
                      : issue.severity}
                  </small>
                </span>
                {issue.nodeId ? <ChevronRight size={15} /> : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="validation-success">
            <CheckCircle2 size={40} />
            <h3>All checks passed</h3>
            <p>Your flow is connected and ready to run.</p>
          </div>
        )}
        <div className="modal-actions">
          <Button onClick={() => setShowValidation(false)}>Back to flow</Button>
        </div>
      </Modal>
      <Modal
        open={saveConflict !== null}
        onClose={() => setSaveConflict(null)}
        title="This flow changed elsewhere"
        description="Your local edits are still here. Nothing was overwritten."
      >
        <p>{saveConflict?.reason}</p>
        <p className="muted small">
          {saveConflict?.current
            ? "Keep editing to preserve your draft, or reload the latest saved flow to discard your local changes. You can also keep your changes using Duplicate flow."
            : "This flow is no longer saved. Keep your draft and use Duplicate flow to save it as a new workflow."}
        </p>
        <div className="modal-actions">
          <Button onClick={() => setSaveConflict(null)}>Keep editing</Button>
          {saveConflict?.current ? (
            <Button
              variant="primary"
              busy={busy === "reload"}
              onClick={() => {
                const id = saveConflict.flowId;
                setBusy("reload");
                void api
                  .bootstrap()
                  .then((latest) => {
                    const flow = latest.flows.find((item) => item.id === id);
                    setWorkspace(latest);
                    if (!flow)
                      throw new Error(
                        "The flow was deleted. Your local draft is still available.",
                      );
                    draftRef.current = flow;
                    setDraft(flow);
                    baseRevisions.current.set(flow.id, flow.revision);
                    setDirty(false);
                    setSelected(null);
                    setIssues([]);
                    setUndo([]);
                    setRedo([]);
                    setSaveConflict(null);
                  })
                  .catch(onError)
                  .finally(() => setBusy(null));
              }}
            >
              Reload latest and discard edits
            </Button>
          ) : null}
        </div>
      </Modal>
      <Modal
        open={runInputs !== null}
        onClose={() => setRunInputs(null)}
        title="Run with inputs"
        description="These values are passed to this run only."
      >
        {runInputs ? (
          <>
            <JsonField
              label="Inputs"
              value={runInputs}
              onChange={(value) => {
                if (value && typeof value === "object" && !Array.isArray(value))
                  setRunInputs(value);
              }}
            />
            <div className="modal-actions">
              <Button onClick={() => setRunInputs(null)}>Cancel</Button>
              <Button
                variant="primary"
                busy={busy === "run"}
                onClick={() => void run(runInputs)}
              >
                <Play size={14} /> Run flow
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
      <div className="toast-container" aria-live="polite">
        {toasts.map((item) => (
          <div className={`toast ${item.error ? "error" : ""}`} key={item.id}>
            {item.error ? (
              <CircleAlert size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
            <span>{item.message}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() =>
                setToasts((t) => t.filter((i) => i.id !== item.id))
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function RelayLogo() {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 8h9a7 7 0 0 1 0 14h-2"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M8 15v9M15 22l6 6"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function readableAccent(hex: string, theme: "light" | "dark") {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16));
  let result = hex;
  for (let blend = 0; blend <= 1; blend += 0.02) {
    const brightness = luminance(result);
    if (theme === "light" ? brightness <= 0.15 : brightness >= 0.31)
      return result;
    result =
      "#" +
      channels
        .map((value) =>
          Math.round(
            theme === "light"
              ? value * (1 - blend)
              : value + (255 - value) * blend,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
  }
  return result;
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="boot-screen">
        <CircleAlert size={32} />
        <h1>Something interrupted the interface</h1>
        <p>{this.state.error}</p>
        <Button onClick={() => location.reload()}>Reload workspace</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
