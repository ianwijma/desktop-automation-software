import { useEffect, useRef, useState } from "react";
import type {
  CaptureFrame,
  Json,
  NodeKind,
  RelayAPI,
  WorkspaceState,
} from "../shared/types";
import {
  nativeControlTypes,
  nativeLocatorSchema,
  type NativeLocatorInspection,
  type NativeLocator,
} from "../shared/native-locators";
import { Button, Field, Modal, Notice, Select, JsonField } from "./components";
export function supportsNativeLocator(
  kind: NodeKind,
  config: Record<string, Json>,
  workspace: WorkspaceState,
) {
  return (
    workspace.targets.some(
      (t) => t.id === config.targetId && t.kind === "desktop",
    ) &&
    (["click", "type", "read", "select"].includes(kind) ||
      (["detect", "wait"].includes(kind) && config.detector === "element"))
  );
}
export function setNativeTargeting(
  config: Record<string, Json>,
  enabled: boolean,
): Record<string, Json> {
  const next = { ...config };
  delete next.nativeLocator;
  if (enabled) {
    for (const key of [
      "selector",
      "locator",
      "toLocator",
      "detection",
      "frameId",
      "expectedWidth",
      "expectedHeight",
      "checked",
      "modifiers",
      "button",
      "clickCount",
      "value",
    ])
      delete next[key];
    next.nativeLocator = {
      version: 1,
      backend: "uia",
      selector: { controlType: "button" },
    };
  }
  return next;
}
export function NativeLocatorField({
  kind,
  config,
  workspace,
  onChange,
  tools,
}: {
  kind: NodeKind;
  config: Record<string, Json>;
  workspace: WorkspaceState;
  onChange(config: Record<string, Json>): void;
  tools?: Pick<RelayAPI, "capture" | "inspectNativeLocator">;
}) {
  const [result, setResult] = useState<NativeLocatorInspection>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<CaptureFrame>();
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const generation = useRef(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const fingerprint = JSON.stringify([config.targetId, config.nativeLocator]);
  useEffect(() => {
    generation.current++;
    setResult(undefined);
    setError("");
    setBusy(false);
    setOpen(false);
    setFrame(undefined);
  }, [fingerprint]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const enabled = config.nativeLocator !== undefined;
  const parsed = nativeLocatorSchema.safeParse(config.nativeLocator);
  const locator = (config.nativeLocator &&
  typeof config.nativeLocator === "object" &&
  !Array.isArray(config.nativeLocator)
    ? config.nativeLocator
    : {
        version: 1,
        backend: "uia",
        selector: { controlType: "button" },
      }) as unknown as NativeLocator;
  const selector =
    locator.selector && typeof locator.selector === "object"
      ? locator.selector
      : {};
  const available = Boolean(
    workspace.desktop && workspace.capabilities.platform === "win32" && tools,
  );
  const update = (next: NativeLocator) =>
    onChange({ ...config, nativeLocator: next as unknown as Json });
  const inspect = async (
    query: Parameters<RelayAPI["inspectNativeLocator"]>[1],
  ) => {
    if (!tools) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const next = await tools.inspectNativeLocator(
        String(config.targetId),
        query,
      );
      if (generation.current === request) setResult(next);
    } catch (e) {
      if (generation.current === request) setError((e as Error).message);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  const refresh = async () => {
    if (!tools) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setResult(undefined);
    setFrame(undefined);
    try {
      const next = await tools.capture(String(config.targetId));
      if (generation.current === request) {
        setFrame(next);
        setPoint({ x: 0, y: 0 });
        setOpen(true);
      }
    } catch (e) {
      if (generation.current === request) setError((e as Error).message);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  const output = (
    <>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {result ? (
        <Notice kind={result.status === "unique" ? "info" : "error"}>
          <strong>
            {result.status === "unique"
              ? "1 native control matches"
              : result.status === "missing"
                ? "No realized native controls match"
                : `${result.count} native controls match — ambiguous`}
          </strong>
          {result.element ? (
            <>
              <p>
                {result.element.controlType} ·{" "}
                {result.element.secure
                  ? "Secure control; values hidden"
                  : result.element.name || "Unnamed"}
                {result.element.enabled ? "" : " · disabled"}
                {result.element.offscreen ? " · offscreen" : ""}
                {result.element.virtualized ? " · virtualized" : ""}
              </p>
              <p>
                Supported actions: {result.element.actions.join(", ") || "none"}
              </p>
              <Button
                disabled={result.element.secure}
                onClick={() => {
                  update(result.element!.locator);
                  setOpen(false);
                }}
              >
                Use inspected native locator
              </Button>
            </>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
  return (
    <section className="browser-locator-field" aria-label="Native locator">
      <Field label="Desktop targeting">
        <Select
          aria-label="Desktop targeting"
          value={enabled ? "uia" : "none"}
          onChange={(e) =>
            onChange(setNativeTargeting(config, e.target.value === "uia"))
          }
        >
          <option value="none">
            {["click", "type"].includes(kind)
              ? "Coordinates / focused application"
              : "Choose a native locator"}
          </option>
          <option value="uia">Windows semantic locator</option>
        </Select>
      </Field>
      {!available ? (
        <p className="field-help">
          Windows UIA is required for native inspection and semantic actions.
          macOS AX and Linux AT-SPI are planned separately.
        </p>
      ) : null}
      {enabled ? (
        <>
          <p className="field-help">
            Invoke a control, set its full value, read it, or select the matched
            item. Failed semantic actions never fall back to coordinates. Secure
            controls are blocked.
          </p>
          <Field label="Native control type">
            <Select
              aria-label="Native control type"
              value={selector.controlType ?? ""}
              onChange={(e) => {
                const next = { ...selector };
                if (e.target.value)
                  next.controlType = e.target
                    .value as (typeof nativeControlTypes)[number];
                else delete next.controlType;
                update({ ...locator, selector: next });
              }}
            >
              <option value="">Any type</option>
              {nativeControlTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          {(["automationId", "name", "className"] as const).map((key) => (
            <Field
              key={key}
              label={
                {
                  automationId: "Automation ID",
                  name: "Accessible name",
                  className: "Native class",
                }[key]
              }
            >
              <input
                aria-label={
                  {
                    automationId: "Automation ID",
                    name: "Accessible name",
                    className: "Native class",
                  }[key]
                }
                value={selector[key] ?? ""}
                onChange={(e) => {
                  const next = { ...selector };
                  if (e.target.value) next[key] = e.target.value;
                  else delete next[key];
                  update({ ...locator, selector: next });
                }}
              />
            </Field>
          ))}
          <details>
            <summary>Ancestor scopes</summary>
            <p className="field-help">
              Ordered semantic scopes, each required to match uniquely. No
              indexes, runtime IDs or object handles.
            </p>
            <JsonField
              label="Native ancestor scopes"
              value={(locator.ancestors ?? []) as unknown as Json}
              onChange={(value) =>
                update({
                  ...locator,
                  ancestors: value as NativeLocator["ancestors"],
                })
              }
            />
          </details>
          {!parsed.success ? (
            <Notice kind="error">
              Complete a valid semantic locator before testing. Unknown or
              transient properties cannot be saved as a native locator.
            </Notice>
          ) : null}
          <div className="locator-actions">
            <Button
              busy={busy}
              disabled={!available || !parsed.success}
              onClick={() => {
                if (parsed.success) void inspect({ locator: parsed.data });
              }}
            >
              Test native match
            </Button>
            <Button
              busy={busy}
              disabled={!available}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                void refresh();
              }}
            >
              Pick native control
            </Button>
          </div>
          <p className="field-help">
            Tests and preview picks are read-only. Reveal virtualized items in
            the application before inspecting them. A modal needs its own
            target.
          </p>
          {!open ? output : null}
        </>
      ) : null}
      <Modal
        open={open}
        onClose={() => {
          generation.current++;
          setBusy(false);
          setOpen(false);
          setFrame(undefined);
          setResult(undefined);
          setError("");
        }}
        returnFocusRef={triggerRef}
        title="Pick a native control"
        description="Click the preview to inspect a control. No click is sent to the application."
        wide
      >
        {frame ? (
          <>
            <button
              className="native-picker-preview"
              aria-label="Inspect control in preview"
              disabled={busy}
              onClick={(e) => {
                const r = e.currentTarget
                  .querySelector("img")!
                  .getBoundingClientRect();
                const x = Math.min(
                  frame.width - 1,
                  Math.max(0, ((e.clientX - r.left) * frame.width) / r.width),
                );
                const y = Math.min(
                  frame.height - 1,
                  Math.max(0, ((e.clientY - r.top) * frame.height) / r.height),
                );
                setPoint({ x: Math.round(x), y: Math.round(y) });
                void inspect({ point: { x, y, frameId: frame.id } });
              }}
            >
              <img
                src={frame.dataUrl}
                alt="Selected application window"
                draggable={false}
              />
            </button>
            <div className="locator-actions native-picker-controls">
              <Field label="Preview pixel X">
                <input
                  type="number"
                  min={0}
                  max={frame.width - 1}
                  value={point.x}
                  onChange={(e) =>
                    setPoint({ ...point, x: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Preview pixel Y">
                <input
                  type="number"
                  min={0}
                  max={frame.height - 1}
                  value={point.y}
                  onChange={(e) =>
                    setPoint({ ...point, y: Number(e.target.value) })
                  }
                />
              </Field>
              <Button
                busy={busy}
                onClick={() =>
                  void inspect({ point: { ...point, frameId: frame.id } })
                }
              >
                Inspect preview point
              </Button>
            </div>
          </>
        ) : null}
        <Button busy={busy} onClick={() => void refresh()}>
          Refresh native preview
        </Button>
        {output}
      </Modal>
    </section>
  );
}
