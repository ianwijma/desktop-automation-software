import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  Circle,
  Monitor,
  MousePointer2,
  Scan,
  Square,
  RefreshCw,
  Keyboard,
  ArrowDown,
  ArrowUp,
  AppWindow,
  Pause,
  Play,
  ArrowLeft,
} from "lucide-react";
import type {
  CaptureFrame,
  FlowDefinition,
  RecordedAction,
  RecordingState,
  RecordingInsertOptions,
  RecordingInsertResult,
  RecordingInsertionAnchor,
  RelayAPI,
  WorkspaceState,
  Json,
} from "../shared/types";
import { recordingInsertionPoints } from "../shared/recording";
import { RecordingPointSelect } from "./recording-point";
import { Button, EmptyState, Field, Notice, Select } from "./components";
import { catalog } from "./catalog";
import { RecordingReview, type RecordingReviewCache } from "./recording-review";
import "./recording-draft.css";

type Box = { x: number; y: number; width: number; height: number };
export function Recorder({
  api,
  workspace,
  currentFlow,
  selectedNodeId,
  selectedEdgeId,
  onStart,
  onInsert,
  onState,
  onOpenBoundFlow,
  onError,
  reviewCache,
}: {
  api: RelayAPI;
  workspace: WorkspaceState;
  currentFlow: FlowDefinition | null;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onStart: (
    targetId: string,
    mode: "guided" | "direct",
    anchor?: RecordingInsertionAnchor,
  ) => Promise<RecordingState>;
  onInsert: (
    sessionId: string,
    revision: number,
    options: RecordingInsertOptions,
  ) => Promise<RecordingInsertResult>;
  onState: (state: RecordingState) => void;
  onOpenBoundFlow: (flowId: string) => void;
  onError: (error: unknown) => void;
  reviewCache: RefObject<RecordingReviewCache | null>;
}) {
  const recording = workspace.recording;
  const points = currentFlow ? recordingInsertionPoints(currentFlow) : [];
  const preferredPoint =
    points.find((point) =>
      selectedEdgeId
        ? point.anchor.edgeId === selectedEdgeId
        : point.anchor.sourceNodeId === selectedNodeId &&
          point.anchor.port === "next" &&
          !["condition", "detect"].includes(
            currentFlow?.nodes.find((node) => node.id === selectedNodeId)
              ?.kind ?? "",
          ),
    )?.key ?? "";
  const [insertionPoint, setInsertionPoint] = useState(preferredPoint);
  useEffect(() => {
    setInsertionPoint(preferredPoint);
  }, [currentFlow?.id, selectedNodeId, selectedEdgeId]);
  const [targetId, setTargetId] = useState(
    recording.targetId ?? workspace.targets[0]?.id ?? "",
  );
  const [mode, setMode] = useState<"guided" | "direct">(recording.mode);
  const [frame, setFrame] = useState<CaptureFrame | null>(null);
  const [captureError, setCaptureError] = useState("");
  const [tool, setTool] = useState<"interact" | "region">("interact");
  const [region, setRegion] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [key, setKey] = useState("Enter");
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const imageRef = useRef<HTMLImageElement>(null);
  const operation = useRef(false);
  const phaseRef = useRef(recording.phase);
  phaseRef.current = recording.phase;
  const session = recording.phase !== "idle";
  const activeTargetId = session ? (recording.targetId ?? "") : targetId;
  const activeMode = session ? recording.mode : mode;
  const selectedTarget = workspace.targets.find(
    (target) => target.id === activeTargetId,
  );
  const browserTarget = selectedTarget?.kind === "browser";
  const canCapture =
    workspace.desktop && (browserTarget || workspace.capabilities.capture);
  const canInput =
    workspace.desktop && (browserTarget || workspace.capabilities.input);
  const canDirect =
    workspace.desktop &&
    (browserTarget || workspace.capabilities.directRecording);
  const capturing = recording.phase === "capturing";
  const paused = recording.phase === "paused";
  const previewEnabled =
    (recording.phase === "idle" || capturing) && canCapture;
  const interactEnabled = capturing && activeMode === "guided" && !busy;
  useEffect(() => {
    if (recording.targetId) setTargetId(recording.targetId);
    setMode(recording.mode);
    setStartPoint(null);
    setRegion(null);
  }, [
    recording.sessionId,
    recording.targetId,
    recording.mode,
    recording.phase,
  ]);
  useEffect(() => {
    setFrame(null);
    setCaptureError("");
  }, [activeTargetId]);
  useEffect(() => {
    if (!activeTargetId || !previewEnabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await api.capture(activeTargetId);
        if (!cancelled) {
          setFrame(next);
          setCaptureError("");
        }
      } catch (error) {
        if (!cancelled)
          setCaptureError(
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        if (!cancelled && tool === "interact")
          timer = setTimeout(() => void refresh(), 900);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, activeTargetId, previewEnabled, tool]);
  const capture = async () => {
    if (!previewEnabled || !activeTargetId) return;
    try {
      const next = await api.capture(activeTargetId);
      if (phaseRef.current === "idle" || phaseRef.current === "capturing") {
        setFrame(next);
        setCaptureError("");
      }
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    }
  };
  const command = async (action: () => Promise<RecordingState>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      onState(await action());
    } catch (error) {
      onError(error);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const perform = async (
    action: Omit<RecordedAction, "id" | "at">,
    execute = true,
  ) => {
    if (!interactEnabled || !recording.sessionId || operation.current) return;
    const sessionId = recording.sessionId;
    await command(() => api.recordAction(sessionId, action, execute));
  };
  const point = (event: PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          (frame?.width ?? 1) - 1,
          Math.round(
            ((event.clientX - rect.left) / rect.width) * (frame?.width ?? 0),
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          (frame?.height ?? 1) - 1,
          Math.round(
            ((event.clientY - rect.top) / rect.height) * (frame?.height ?? 0),
          ),
        ),
      ),
    };
  };
  const addDetector = async () => {
    if (!interactEnabled || !frame || !region || !imageRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = region.width;
    canvas.height = region.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(
      imageRef.current,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    const config: Record<string, Json> = {
      targetId: activeTargetId,
      detector: "image",
      template: canvas.toDataURL("image/png"),
      threshold: 0.85,
      timeoutMs: 30000,
      pollIntervalMs: 750,
      region: { ...region },
    };
    await perform(
      { kind: "wait", label: "Wait for this image", config },
      false,
    );
    setRegion(null);
    setTool("interact");
  };
  const destination = recording.destination;
  const sourceName = destination?.flowName ?? currentFlow?.name;
  return (
    <div className="recorder">
      <div className="recording-workspace">
        <div className="recording-heading">
          <div>
            <span className="section-eyebrow">
              {recording.phase === "review"
                ? "REVIEW BEFORE INSERTING"
                : "TEACH BY DOING"}
            </span>
            <h2>
              {recording.phase === "review"
                ? "Make these steps your own."
                : "Your application. Your next flow."}
            </h2>
            <p>
              {recording.phase === "review"
                ? "Edit the captured steps, then choose where to insert them."
                : "Capture your actions. Review the steps before changing a flow."}
            </p>
          </div>
          <span
            className={`recording-indicator ${capturing ? "active" : ""}`}
            role="status"
          >
            <Circle size={8} fill="currentColor" />
            {capturing
              ? "Recording"
              : paused
                ? "Paused"
                : recording.phase === "review"
                  ? "Review"
                  : "Ready to capture"}
          </span>
        </div>
        {sourceName ? (
          <div className="recording-binding">
            <span>
              Bound workflow <strong>{sourceName}</strong>
              {destination
                ? ` · revision ${destination.flowRevision}`
                : " · saved when recording starts"}
            </span>
            {destination && currentFlow?.id !== destination.flowId ? (
              <Button
                variant="ghost"
                disabled={
                  !workspace.flows.some(
                    (flow) => flow.id === destination.flowId,
                  )
                }
                onClick={() => onOpenBoundFlow(destination.flowId)}
              >
                <ArrowLeft size={13} />
                Return to bound workflow
              </Button>
            ) : null}
            <small>
              {session
                ? "Choose a new workflow or an explicit edge/output in this saved workflow after review. Navigation does not change the bound workflow."
                : "Select an edge in the editor or choose an output below. You can also choose an insertion point after review."}
            </small>
          </div>
        ) : null}
        {recording.recovered ? (
          <Notice>
            Recovered recording draft. Capture is stopped. Review the saved
            steps before inserting them.
          </Notice>
        ) : null}
        {recording.error ? (
          <Notice kind="error">{recording.error}</Notice>
        ) : null}
        {!session && currentFlow ? (
          <RecordingPointSelect
            points={points}
            value={insertionPoint}
            disabled={busy}
            onChange={setInsertionPoint}
          />
        ) : null}
        {recording.phase === "review" ? (
          <RecordingReview
            key={recording.sessionId}
            recording={recording}
            workspace={workspace}
            api={api}
            onState={onState}
            onInsert={onInsert}
            onError={onError}
            cache={reviewCache}
          />
        ) : (
          <>
            <div className="recording-controls">
              <Select
                aria-label="Recording target"
                value={targetId}
                disabled={busy || capturing}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <option value="">Choose an application…</option>
                {targetId &&
                !workspace.targets.some((target) => target.id === targetId) ? (
                  <option value={targetId}>Missing target · {targetId}</option>
                ) : null}
                {workspace.targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </Select>
              {paused ? (
                <Button
                  disabled={
                    busy || !targetId || targetId === recording.targetId
                  }
                  onClick={() =>
                    void command(() =>
                      api.setRecordingTarget(recording.sessionId!, targetId),
                    )
                  }
                >
                  Switch target
                </Button>
              ) : (
                <div className="segmented">
                  <button
                    className={activeMode === "guided" ? "active" : ""}
                    disabled={session || busy}
                    onClick={() => setMode("guided")}
                  >
                    Guided preview
                  </button>
                  <button
                    className={activeMode === "direct" ? "active" : ""}
                    disabled={session || busy || !canDirect}
                    title={
                      !canDirect
                        ? "Direct recording is unavailable in this desktop session"
                        : undefined
                    }
                    onClick={() => setMode("direct")}
                  >
                    Direct use
                  </button>
                </div>
              )}
              {capturing ? (
                <Button
                  busy={busy}
                  onClick={() =>
                    void command(() => api.pauseRecording(recording.sessionId!))
                  }
                >
                  <Pause size={13} />
                  Pause recording
                </Button>
              ) : paused ? (
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={targetId !== recording.targetId}
                  onClick={() =>
                    void command(() =>
                      api.resumeRecording(recording.sessionId!),
                    )
                  }
                >
                  <Play size={13} />
                  Resume recording
                </Button>
              ) : (
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!targetId || !canInput || !currentFlow}
                  onClick={() =>
                    void command(() =>
                      onStart(
                        targetId,
                        mode,
                        points.find((point) => point.key === insertionPoint)
                          ?.anchor,
                      ),
                    )
                  }
                >
                  <Circle size={12} fill="currentColor" />
                  Start recording
                </Button>
              )}
              {session ? (
                <Button
                  variant="danger"
                  busy={busy}
                  onClick={() =>
                    void command(() => api.stopRecording(recording.sessionId!))
                  }
                >
                  <Square size={13} fill="currentColor" />
                  Stop &amp; review
                </Button>
              ) : null}
            </div>
            {paused ? (
              <Notice>
                Recording is paused. Application controls and preview updates
                are stopped. Switch targets explicitly before resuming.
              </Notice>
            ) : !workspace.desktop ? (
              <Notice>
                Recording requires the desktop app. You can build and save flows
                in this browser preview.
              </Notice>
            ) : !canInput ? (
              <Notice kind="error">
                {workspace.capabilities.reasons.join(" ") ||
                  "Desktop input is unavailable. Check permissions in Settings."}
              </Notice>
            ) : null}
            {captureError ? <Notice kind="error">{captureError}</Notice> : null}
            <div className={`capture-preview ${paused ? "is-paused" : ""}`}>
              <div className="preview-toolbar">
                <span>
                  <Monitor size={14} />
                  {selectedTarget?.name ?? "Application preview"}
                </span>
                <div>
                  <button
                    className={tool === "interact" ? "active" : ""}
                    aria-label="Interact with application"
                    disabled={!interactEnabled}
                    onClick={() => {
                      setTool("interact");
                      setRegion(null);
                    }}
                  >
                    <MousePointer2 size={15} />
                  </button>
                  <button
                    className={tool === "region" ? "active" : ""}
                    aria-label="Select an image detector region"
                    disabled={!interactEnabled}
                    onClick={() => setTool("region")}
                  >
                    <Scan size={15} />
                  </button>
                  <button
                    aria-label="Refresh capture"
                    onClick={() => void capture()}
                    disabled={!previewEnabled || !activeTargetId || busy}
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              {frame ? (
                <div
                  className={`capture-stage ${tool === "region" ? "selecting" : ""}`}
                >
                  <div className="capture-image-wrap">
                    <img
                      ref={imageRef}
                      src={frame.dataUrl}
                      draggable={false}
                      alt={`${paused ? "Paused" : "Live"} capture of ${selectedTarget?.name ?? "target"}`}
                      onPointerDown={(event) => {
                        if (
                          !interactEnabled ||
                          frame.targetId !== activeTargetId
                        )
                          return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setStartPoint(point(event));
                        if (tool === "region") setRegion(null);
                      }}
                      onPointerMove={(event) => {
                        if (
                          !interactEnabled ||
                          tool !== "region" ||
                          !startPoint
                        )
                          return;
                        const p = point(event);
                        setRegion({
                          x: Math.min(p.x, startPoint.x),
                          y: Math.min(p.y, startPoint.y),
                          width: Math.abs(p.x - startPoint.x),
                          height: Math.abs(p.y - startPoint.y),
                        });
                      }}
                      onPointerCancel={() => setStartPoint(null)}
                      onPointerUp={(event) => {
                        if (!interactEnabled || !startPoint) return;
                        const p = point(event);
                        if (tool === "interact") {
                          const distance = Math.hypot(
                            p.x - startPoint.x,
                            p.y - startPoint.y,
                          );
                          if (distance > 8)
                            void perform({
                              kind: "drag",
                              label: "Drag across application",
                              config: {
                                targetId: activeTargetId,
                                x: startPoint.x,
                                y: startPoint.y,
                                toX: p.x,
                                toY: p.y,
                                button: event.button === 2 ? "right" : "left",
                                durationMs: 500,
                              },
                            });
                          else
                            void perform({
                              kind: "click",
                              label: `Click at ${p.x}, ${p.y}`,
                              config: {
                                targetId: activeTargetId,
                                x: p.x,
                                y: p.y,
                                button: event.button === 2 ? "right" : "left",
                              },
                            });
                        }
                        setStartPoint(null);
                      }}
                      onContextMenu={(event) => event.preventDefault()}
                    />
                    {region ? (
                      <span
                        className="capture-region"
                        style={{
                          left: `${(region.x / frame.width) * 100}%`,
                          top: `${(region.y / frame.height) * 100}%`,
                          width: `${(region.width / frame.width) * 100}%`,
                          height: `${(region.height / frame.height) * 100}%`,
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={<AppWindow size={40} />}
                  title={
                    paused
                      ? "Preview paused"
                      : targetId
                        ? "Your application appears here"
                        : "Choose your starting point"
                  }
                  description={
                    paused
                      ? "Resume recording to refresh the selected application preview."
                      : workspace.desktop
                        ? "Select a target and check capture permissions to see its live preview."
                        : "In the desktop app, this is a live window you can click to create your workflow."
                  }
                />
              )}
              <div className="preview-bottom">
                <span>
                  <span className="tiny-dot" />
                  {frame ? `${frame.width} × ${frame.height}` : "No capture"}
                </span>
                <span>
                  {paused
                    ? "Frozen preview · no application input"
                    : capturing
                      ? activeMode === "direct"
                        ? "Use the application directly to capture actions"
                        : tool === "region"
                          ? "Drag to select a detector region"
                          : "Interactions control the actual application"
                      : "Start recording to capture your actions"}
                </span>
              </div>
            </div>
            {interactEnabled &&
            region &&
            region.width > 2 &&
            region.height > 2 ? (
              <div className="region-actions">
                <span>
                  Selected {region.width} × {region.height}px
                </span>
                <Button onClick={() => void addDetector()} busy={busy}>
                  <Scan size={14} />
                  Add image detector
                </Button>
              </div>
            ) : null}
            {session && activeMode === "guided" ? (
              <div className="input-controls">
                <Field label="Type into application">
                  <div className="input-action">
                    <input
                      aria-label="Type into application"
                      value={text}
                      disabled={!interactEnabled}
                      onChange={(event) => setText(event.target.value)}
                      placeholder="Text to type…"
                    />
                    <Button
                      disabled={!text || !interactEnabled}
                      onClick={() =>
                        void perform({
                          kind: "type",
                          label: "Type text",
                          config: { targetId: activeTargetId, text },
                        })
                      }
                    >
                      Type
                    </Button>
                  </div>
                </Field>
                <Field label="Press keys">
                  <div className="input-action">
                    <input
                      aria-label="Press keys"
                      value={key}
                      disabled={!interactEnabled}
                      onChange={(event) => setKey(event.target.value)}
                    />
                    <Button
                      aria-label="Send keys"
                      disabled={!key || !interactEnabled}
                      onClick={() =>
                        void perform({
                          kind: "key",
                          label: `Press ${key}`,
                          config: { targetId: activeTargetId, key },
                        })
                      }
                    >
                      <Keyboard size={14} />
                    </Button>
                  </div>
                </Field>
                <Field label="Scroll">
                  <div className="input-action">
                    <Button
                      aria-label="Scroll up"
                      disabled={!interactEnabled}
                      onClick={() =>
                        void perform({
                          kind: "scroll",
                          label: "Scroll up",
                          config: {
                            targetId: activeTargetId,
                            deltaY: -300,
                            deltaX: 0,
                          },
                        })
                      }
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      aria-label="Scroll down"
                      disabled={!interactEnabled}
                      onClick={() =>
                        void perform({
                          kind: "scroll",
                          label: "Scroll down",
                          config: {
                            targetId: activeTargetId,
                            deltaY: 300,
                            deltaX: 0,
                          },
                        })
                      }
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </div>
                </Field>
              </div>
            ) : null}
          </>
        )}
      </div>
      {recording.phase !== "review" ? (
        <aside className="recording-timeline">
          <div className="inspector-title">
            <span>Captured steps</span>
            <span className="badge">{recording.actions.length}</span>
          </div>
          {recording.actions.length ? (
            <div className="captured-actions">
              {recording.actions.map((action, index) => {
                const spec = catalog[action.kind];
                const Icon = spec.icon;
                return (
                  <div className="captured-action" key={action.id}>
                    <span className="step-number">{index + 1}</span>
                    <span className={`node-icon ${spec.color}`}>
                      <Icon size={15} />
                    </span>
                    <div>
                      <strong>{action.label}</strong>
                      <small>
                        {workspace.targets.find(
                          (target) => target.id === action.config.targetId,
                        )?.name ?? spec.label}
                      </small>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<MousePointer2 size={27} />}
              title="A flow starts with one action"
              description="Recorded clicks, typing, and detectors will appear here. Stop to review them before inserting."
            />
          )}
          <div className="recording-note">
            <Scan size={16} />
            <p>
              {paused
                ? "Your captured steps are saved. Resume this session, or stop to review and edit them."
                : "Stop recording to review, reorder, and edit. Your workflow stays unchanged until you insert."}
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
