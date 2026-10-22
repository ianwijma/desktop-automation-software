import { useEffect, useRef, useState, type PointerEvent } from "react";
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
} from "lucide-react";
import type {
  CaptureFrame,
  RecordedAction,
  RecordingState,
  RelayAPI,
  WorkspaceState,
  Json,
} from "../shared/types";
import { Button, EmptyState, Field, Notice, Select } from "./components";
import { catalog } from "./catalog";
type Box = { x: number; y: number; width: number; height: number };
export function Recorder({
  api,
  workspace,
  onRecorded,
  onError,
}: {
  api: RelayAPI;
  workspace: WorkspaceState;
  onRecorded: (actions: RecordedAction[]) => void;
  onError: (error: unknown) => void;
}) {
  const [targetId, setTargetId] = useState(
    workspace.recording.targetId ?? workspace.targets[0]?.id ?? "",
  );
  const [mode, setMode] = useState<"guided" | "direct">("guided");
  const [recording, setRecording] = useState<RecordingState>(
    workspace.recording,
  );
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
  const selectedTarget = workspace.targets.find(
    (target) => target.id === targetId,
  );
  const browserTarget = selectedTarget?.kind === "browser";
  const canCapture =
    workspace.desktop && (browserTarget || workspace.capabilities.capture);
  const canInput =
    workspace.desktop && (browserTarget || workspace.capabilities.input);
  const canDirect =
    workspace.desktop &&
    (browserTarget || workspace.capabilities.directRecording);
  useEffect(() => {
    setRecording(workspace.recording);
  }, [workspace.recording]);
  useEffect(() => {
    if (!targetId || !canCapture) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await api.capture(targetId);
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
  }, [
    api,
    targetId,
    workspace.desktop,
    workspace.capabilities.capture,
    tool,
    canCapture,
  ]);
  const capture = async () => {
    try {
      setFrame(await api.capture(targetId));
      setCaptureError("");
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    }
  };
  const perform = async (
    action: Omit<RecordedAction, "id" | "at">,
    execute = true,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      setRecording(await api.recordAction(action, execute));
      await capture();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const point = (event: PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          frame?.width ?? 0,
          Math.round(
            ((event.clientX - rect.left) / rect.width) * (frame?.width ?? 0),
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          frame?.height ?? 0,
          Math.round(
            ((event.clientY - rect.top) / rect.height) * (frame?.height ?? 0),
          ),
        ),
      ),
    };
  };
  const stop = async () => {
    setBusy(true);
    try {
      const result = await api.stopRecording();
      setRecording(result);
      if (result.actions.length) onRecorded(result.actions);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const addDetector = async () => {
    if (!frame || !region || !imageRef.current) return;
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
      targetId,
      detector: "image",
      template: canvas.toDataURL("image/png"),
      threshold: 0.85,
      timeoutMs: 30000,
      pollMs: 750,
      region: { ...region },
    };
    await perform(
      { kind: "wait", label: "Wait for this image", config },
      false,
    );
    setRegion(null);
    setTool("interact");
  };
  return (
    <div className="recorder">
      <div className="recording-workspace">
        <div className="recording-heading">
          <div>
            <span className="section-eyebrow">TEACH BY DOING</span>
            <h2>Your application. Your next flow.</h2>
            <p>Work through the steps. Relay connects the dots.</p>
          </div>
          <span
            className={`recording-indicator ${recording.active ? "active" : ""}`}
          >
            <Circle size={8} fill="currentColor" />
            {recording.active ? "Recording" : "Ready to capture"}
          </span>
        </div>
        <div className="recording-controls">
          <Select
            value={targetId}
            disabled={recording.active}
            onChange={(e) => {
              setTargetId(e.target.value);
              setFrame(null);
            }}
          >
            <option value="">Choose an application…</option>
            {workspace.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <div className="segmented">
            <button
              className={mode === "guided" ? "active" : ""}
              disabled={recording.active}
              onClick={() => setMode("guided")}
            >
              Guided preview
            </button>
            <button
              className={mode === "direct" ? "active" : ""}
              disabled={recording.active || !canDirect}
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
          {recording.active ? (
            <Button variant="danger" busy={busy} onClick={() => void stop()}>
              <Square size={13} fill="currentColor" /> Stop & add steps
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={busy}
              disabled={!targetId || !canInput}
              onClick={() => {
                setBusy(true);
                void api
                  .startRecording(targetId, mode)
                  .then(setRecording)
                  .catch(onError)
                  .finally(() => setBusy(false));
              }}
            >
              <Circle size={12} fill="currentColor" /> Start recording
            </Button>
          )}
        </div>
        {!workspace.desktop ? (
          <Notice>
            Recording requires the desktop app. You can build and save flows in
            this browser preview.
          </Notice>
        ) : !canInput ? (
          <Notice kind="error">
            {workspace.capabilities.reasons.join(" ") ||
              "Desktop input is unavailable. Check permissions in Settings."}
          </Notice>
        ) : null}
        {captureError ? <Notice kind="error">{captureError}</Notice> : null}
        <div className="capture-preview">
          <div className="preview-toolbar">
            <span>
              <Monitor size={14} />
              {workspace.targets.find((t) => t.id === targetId)?.name ??
                "Application preview"}
            </span>
            <div>
              <button
                className={tool === "interact" ? "active" : ""}
                title="Interact with application"
                onClick={() => {
                  setTool("interact");
                  setRegion(null);
                }}
              >
                <MousePointer2 size={15} />
              </button>
              <button
                className={tool === "region" ? "active" : ""}
                title="Select an image detector region"
                onClick={() => setTool("region")}
                disabled={!recording.active}
              >
                <Scan size={15} />
              </button>
              <button
                title="Refresh capture"
                onClick={() => void capture()}
                disabled={!workspace.desktop || !targetId}
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
                  alt={`Live capture of ${workspace.targets.find((t) => t.id === targetId)?.name ?? "target"}`}
                  onPointerDown={(e) => {
                    if (!recording.active || mode !== "guided") return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setStartPoint(point(e));
                    if (tool === "region") setRegion(null);
                  }}
                  onPointerMove={(e) => {
                    if (tool === "region" && startPoint) {
                      const p = point(e);
                      setRegion({
                        x: Math.min(p.x, startPoint.x),
                        y: Math.min(p.y, startPoint.y),
                        width: Math.abs(p.x - startPoint.x),
                        height: Math.abs(p.y - startPoint.y),
                      });
                    }
                  }}
                  onPointerUp={(e) => {
                    if (!recording.active || mode !== "guided" || !startPoint)
                      return;
                    const p = point(e);
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
                            targetId,
                            x: startPoint.x,
                            y: startPoint.y,
                            toX: p.x,
                            toY: p.y,
                            button: e.button === 2 ? "right" : "left",
                            durationMs: 500,
                          },
                        });
                      else
                        void perform({
                          kind: "click",
                          label: `Click at ${p.x}, ${p.y}`,
                          config: {
                            targetId,
                            x: p.x,
                            y: p.y,
                            button: e.button === 2 ? "right" : "left",
                          },
                        });
                    }
                    setStartPoint(null);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
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
                targetId
                  ? "Your application appears here"
                  : "Choose your starting point"
              }
              description={
                workspace.desktop
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
              {recording.active
                ? tool === "region"
                  ? "Drag to select a detector region"
                  : "Interactions control the actual application"
                : "Start recording to capture your actions"}
            </span>
          </div>
        </div>
        {region && region.width > 2 && region.height > 2 ? (
          <div className="region-actions">
            <span>
              Selected {region.width} × {region.height}px
            </span>
            <Button onClick={() => void addDetector()} busy={busy}>
              <Scan size={14} /> Add image detector
            </Button>
          </div>
        ) : null}
        {recording.active && mode === "guided" ? (
          <div className="input-controls">
            <Field label="Type into application">
              <div className="input-action">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Text to type…"
                />
                <Button
                  disabled={!text || busy}
                  onClick={() =>
                    void perform({
                      kind: "type",
                      label: "Type text",
                      config: { targetId, text },
                    })
                  }
                >
                  Type
                </Button>
              </div>
            </Field>
            <Field label="Press keys">
              <div className="input-action">
                <input value={key} onChange={(e) => setKey(e.target.value)} />
                <Button
                  disabled={!key || busy}
                  onClick={() =>
                    void perform({
                      kind: "key",
                      label: `Press ${key}`,
                      config: { targetId, key },
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
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      kind: "scroll",
                      label: "Scroll up",
                      config: { targetId, deltaY: -300, deltaX: 0 },
                    })
                  }
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      kind: "scroll",
                      label: "Scroll down",
                      config: { targetId, deltaY: 300, deltaX: 0 },
                    })
                  }
                >
                  <ArrowDown size={14} />
                </Button>
              </div>
            </Field>
          </div>
        ) : null}
      </div>
      <aside className="recording-timeline">
        <div className="inspector-title">
          <span>Captured steps</span>
          <span className="badge">{recording.actions.length}</span>
        </div>
        {recording.actions.length ? (
          <div className="captured-actions">
            {recording.actions.map((action, i) => {
              const Icon = catalog[action.kind].icon;
              return (
                <div className="captured-action" key={action.id}>
                  <span className="step-number">{i + 1}</span>
                  <span className={`node-icon ${catalog[action.kind].color}`}>
                    <Icon size={15} />
                  </span>
                  <div>
                    <strong>{action.label}</strong>
                    <small>{catalog[action.kind].group}</small>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<MousePointer2 size={26} />}
            title="One action at a time"
            description="Clicks, typing, and key presses become connected nodes as you work."
          />
        )}
        <div className="recording-note">
          <Scan size={17} />
          <p>
            Add a detector to let your flow react to what's on screen, instead
            of relying on delays.
          </p>
        </div>
      </aside>
    </div>
  );
}
