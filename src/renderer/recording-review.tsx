import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Pencil,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
  Workflow,
} from "lucide-react";
import type {
  Json,
  RecordedAction,
  RecordingInsertOptions,
  RecordingInsertResult,
  RecordingState,
  RelayAPI,
  WorkspaceState,
} from "../shared/types";
import {
  recordingDestinationAnchor,
  recordingInsertionPoints,
  recordingPointKey,
} from "../shared/recording";
import { RecordingWarning } from "./recording-warning";
import { RecordingPointSelect } from "./recording-point";
import {
  NativeLocatorField,
  supportsNativeLocator,
} from "./native-locator-field";
import {
  BrowserLocatorField,
  supportsBrowserLocator,
} from "./browser-locator-field";
import { createReferenceInspector } from "../shared/value-references";
import { updateNodeConfig } from "../shared/node-authoring";
import { catalog, blankFlow, uid, type FieldSpec } from "./catalog";
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Notice,
  Select,
} from "./components";
import { ValueField } from "./value-field";

/** Transient UI state survives navigation; only acknowledged actions live on disk. */
export interface RecordingReviewCache {
  sessionId: string | undefined;
  revision: number;
  actions: RecordedAction[];
  undo: RecordedAction[][];
  redo: RecordedAction[][];
  pending: boolean;
  error: string;
  destination: "new" | "bound";
  name: string;
  insertionPoint?: string;
  pendingRequest?: Promise<RecordingState>;
}

export function RecordingReview({
  recording,
  workspace,
  api,
  onState,
  onInsert,
  onError,
  cache,
}: {
  recording: RecordingState;
  workspace: WorkspaceState;
  api: RelayAPI;
  onState: (state: RecordingState) => void;
  onInsert: (
    sessionId: string,
    revision: number,
    options: RecordingInsertOptions,
  ) => Promise<RecordingInsertResult>;
  onError: (error: unknown) => void;
  cache: RefObject<RecordingReviewCache | null>;
}) {
  const cached = useRef(
    cache.current?.sessionId === recording.sessionId ? cache.current : null,
  ).current;
  const [actions, setActions] = useState(cached?.actions ?? recording.actions);
  const [undo, setUndo] = useState<RecordedAction[][]>(cached?.undo ?? []);
  const [redo, setRedo] = useState<RecordedAction[][]>(cached?.redo ?? []);
  const [editing, setEditing] = useState<RecordedAction | null>(null);
  const [busy, setBusy] = useState(Boolean(cached?.pendingRequest));
  const [pending, setPending] = useState(cached?.pending ?? false);
  const [error, setError] = useState(cached?.error ?? "");
  const [destination, setDestination] = useState<"new" | "bound">(
    cached?.destination ?? "new",
  );
  const [name, setName] = useState(
    cached?.name ??
      `${recording.destination?.flowName ?? "New flow"} recording`.slice(
        0,
        160,
      ),
  );
  const bound = workspace.flows.find(
    (flow) => flow.id === recording.destination?.flowId,
  );
  const points = bound ? recordingInsertionPoints(bound) : [];
  const initialAnchor = bound && recordingDestinationAnchor(bound, recording);
  const [insertionPoint, setInsertionPoint] = useState(
    cached?.insertionPoint ??
      (initialAnchor ? recordingPointKey(initialAnchor) : ""),
  );
  const revision = useRef(cached?.revision ?? recording.revision);
  const operation = useRef(Boolean(cached?.pendingRequest));
  const pendingRequest = useRef(cached?.pendingRequest);
  useEffect(() => {
    cache.current = {
      sessionId: recording.sessionId,
      revision: revision.current,
      actions,
      undo,
      redo,
      pending,
      error,
      destination,
      name,
      insertionPoint,
      pendingRequest: pendingRequest.current,
    };
  }, [
    cache,
    recording.sessionId,
    actions,
    undo,
    redo,
    pending,
    error,
    destination,
    name,
    insertionPoint,
    busy,
  ]);
  useEffect(() => {
    const request = cached?.pendingRequest;
    if (!request) return;
    let mounted = true;
    void request
      .then((saved) => {
        if (!mounted) return;
        revision.current = saved.revision;
        setActions(saved.actions);
        setPending(false);
        setError("");
        onState(saved);
      })
      .catch((cause: unknown) => {
        if (mounted)
          setError(
            `${cause instanceof Error ? cause.message : String(cause)} Your review edits are still here and have not been inserted.`,
          );
      })
      .finally(() => {
        if (mounted) {
          pendingRequest.current = undefined;
          operation.current = false;
          setBusy(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [cached, onState]);
  const boundAvailable = Boolean(
    bound && bound.revision === recording.destination?.flowRevision,
  );
  const chosenPoint = points.find((point) => point.key === insertionPoint);
  const stale = recording.revision !== revision.current;
  const persist = async (next: RecordedAction[]) => {
    if (operation.current || !recording.sessionId) return false;
    operation.current = true;
    setBusy(true);
    setActions(next);
    setPending(true);
    setError("");
    const expectedRevision = revision.current;
    const request = api.updateRecording(
      recording.sessionId,
      expectedRevision,
      next,
    );
    pendingRequest.current = request;
    try {
      const saved = await request;
      revision.current = saved.revision;
      if (
        cache.current?.sessionId === recording.sessionId &&
        cache.current.revision === expectedRevision
      )
        cache.current = {
          ...cache.current,
          revision: saved.revision,
          actions: saved.actions,
          pending: false,
          error: "",
          pendingRequest: undefined,
        };
      setActions(saved.actions);
      setPending(false);
      onState(saved);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        `${message} Your review edits are still here and have not been inserted.`,
      );
      if (
        cache.current?.sessionId === recording.sessionId &&
        cache.current.revision === expectedRevision
      )
        cache.current = {
          ...cache.current,
          error: `${message} Your review edits are still here and have not been inserted.`,
          pendingRequest: undefined,
        };
      return false;
    } finally {
      operation.current = false;
      pendingRequest.current = undefined;
      setBusy(false);
    }
  };
  const change = async (next: RecordedAction[]) => {
    setUndo((history) => [...history.slice(-49), structuredClone(actions)]);
    setRedo([]);
    return persist(next);
  };
  const undoEdit = async () => {
    if (!undo.length || busy || pending || stale || editing) return;
    const next = undo.at(-1)!;
    setUndo((history) => history.slice(0, -1));
    setRedo((history) => [...history, structuredClone(actions)]);
    await persist(next);
  };
  const redoEdit = async () => {
    if (!redo.length || busy || pending || stale || editing) return;
    const next = redo.at(-1)!;
    setRedo((history) => history.slice(0, -1));
    setUndo((history) => [...history, structuredClone(actions)]);
    await persist(next);
  };
  const reload = async () => {
    if (
      !window.confirm(
        "Reload the saved recording and discard local review edits?",
      )
    )
      return;
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      const latest = (await api.bootstrap()).recording;
      revision.current = latest.revision;
      setActions(latest.actions);
      setPending(false);
      setError("");
      setUndo([]);
      setRedo([]);
      setEditing(null);
      onState(latest);
    } catch (cause) {
      onError(cause);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const discard = async () => {
    if (
      !recording.sessionId ||
      operation.current ||
      !window.confirm(
        "Discard this recording draft? Your workflows will not change.",
      )
    )
      return;
    operation.current = true;
    setBusy(true);
    try {
      onState(
        await api.discardRecording(recording.sessionId, revision.current),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const insert = async () => {
    if (
      !recording.sessionId ||
      operation.current ||
      pending ||
      stale ||
      editing
    )
      return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await onInsert(recording.sessionId, revision.current, {
        destination,
        ...(destination === "new" ? { name: name.trim() } : {}),
        ...(destination === "bound" && chosenPoint
          ? { anchor: chosenPoint.anchor }
          : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const blocked = busy || pending || stale;
  const editBlocked = busy || stale;
  return (
    <div
      className="recording-review"
      onKeyDown={(event) => {
        if (
          !(event.ctrlKey || event.metaKey) ||
          (event.target instanceof HTMLElement &&
            event.target.matches("input,textarea,select"))
        )
          return;
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) void redoEdit();
          else void undoEdit();
        }
        if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          event.stopPropagation();
          void redoEdit();
        }
      }}
    >
      <div className="review-heading">
        <div>
          <h3>
            {actions.length} captured {actions.length === 1 ? "step" : "steps"}
          </h3>
          <p>Reviewing and editing never controls your application.</p>
        </div>
        <div className="review-history">
          <IconButton
            label="Undo recording edit"
            disabled={blocked || !undo.length || Boolean(editing)}
            onClick={() => void undoEdit()}
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            label="Redo recording edit"
            disabled={blocked || !redo.length || Boolean(editing)}
            onClick={() => void redoEdit()}
          >
            <Redo2 size={16} />
          </IconButton>
        </div>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {stale && !busy ? (
        <Notice kind="error">
          This recording changed elsewhere. Your local review is preserved.
          Reload the saved recording before making further changes.
        </Notice>
      ) : null}
      {pending || stale ? (
        <div className="review-recovery">
          <span>
            {pending ? "Unsaved review changes" : "Saved recording has changed"}
          </span>
          {pending && !stale ? (
            <Button disabled={busy} onClick={() => void persist(actions)}>
              Retry saving review
            </Button>
          ) : null}
          <Button disabled={busy} onClick={() => void reload()}>
            Reload saved recording
          </Button>
        </div>
      ) : null}
      {actions.length ? (
        <ol className="review-actions">
          {actions.map((action, index) => {
            const spec = catalog[action.kind];
            const Icon = spec.icon;
            const target = workspace.targets.find(
              (item) => item.id === action.config.targetId,
            );
            return (
              <li
                key={action.id}
                className="review-action"
                data-recorded-action={action.id}
              >
                <span className="step-number">{index + 1}</span>
                <span className={`node-icon ${spec.color}`}>
                  <Icon size={17} />
                </span>
                <button
                  className="review-action-title"
                  aria-label={`Edit step ${index + 1}`}
                  disabled={editBlocked}
                  onClick={() => setEditing(structuredClone(action))}
                >
                  <strong>{action.label}</strong>
                  {action.config.requiresConfiguration === true ? (
                    <small>Needs configuration before running</small>
                  ) : null}
                  <small>
                    {spec.label}
                    {target
                      ? ` · ${target.name}`
                      : typeof action.config.targetId === "string"
                        ? " · Missing target"
                        : ""}
                  </small>
                </button>
                <div className="review-action-tools">
                  <IconButton
                    label={`Move step ${index + 1} up`}
                    disabled={editBlocked || index === 0}
                    onClick={() => {
                      const next = [...actions];
                      [next[index - 1], next[index]] = [
                        next[index],
                        next[index - 1],
                      ];
                      void change(next);
                    }}
                  >
                    <ArrowUp size={15} />
                  </IconButton>
                  <IconButton
                    label={`Move step ${index + 1} down`}
                    disabled={editBlocked || index === actions.length - 1}
                    onClick={() => {
                      const next = [...actions];
                      [next[index], next[index + 1]] = [
                        next[index + 1],
                        next[index],
                      ];
                      void change(next);
                    }}
                  >
                    <ArrowDown size={15} />
                  </IconButton>
                  <IconButton
                    label={`Duplicate step ${index + 1}`}
                    disabled={editBlocked}
                    onClick={() => {
                      const next = [...actions];
                      next.splice(index + 1, 0, {
                        ...structuredClone(action),
                        id: uid(),
                        label: `${action.label} copy`.slice(0, 160),
                      });
                      void change(next);
                    }}
                  >
                    <Copy size={15} />
                  </IconButton>
                  <IconButton
                    label={`Delete step ${index + 1}`}
                    disabled={editBlocked}
                    onClick={() =>
                      void change(
                        actions.filter((item) => item.id !== action.id),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState
          icon={<Pencil size={28} />}
          title="No steps to insert"
          description={
            undo.length
              ? "Undo your last edit to restore a step, or discard this draft and record again."
              : "Discard this empty draft to start a new recording."
          }
        />
      )}
      <section
        className="recording-insertion"
        aria-label="Recording destination"
      >
        <div className="review-heading">
          <div>
            <h3>
              <Workflow size={16} />
              Choose the destination
            </h3>
            <p>
              Your graph changes only when you insert. Insertion does not run
              the flow.
            </p>
          </div>
        </div>
        <Field label="Insert recording into">
          <Select
            aria-label="Insert recording into"
            value={destination}
            disabled={blocked}
            onChange={(event) =>
              setDestination(event.target.value as "new" | "bound")
            }
          >
            <option value="new">A new workflow</option>
            <option value="bound" disabled={!boundAvailable}>
              {recording.destination?.flowName ?? "Bound workflow"} — choose
              edge/output{!boundAvailable ? " (unavailable)" : ""}
            </option>
          </Select>
        </Field>
        {destination === "bound" && boundAvailable ? (
          <RecordingPointSelect
            points={points}
            value={insertionPoint}
            disabled={blocked}
            onChange={setInsertionPoint}
          />
        ) : null}
        {destination === "new" ? (
          <Field label="New flow name">
            <input
              aria-label="New flow name"
              maxLength={160}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        ) : null}
        {!boundAvailable ? (
          <p className="field-help">
            {!bound
              ? "The bound workflow no longer exists. Your recorded steps can still become a new workflow."
              : "The bound workflow has changed since recording started. Create a new workflow to preserve both versions."}
          </p>
        ) : (
          <p className="field-help">
            The original workflow and its saved revision are checked again when
            you insert.
          </p>
        )}
        <div className="recording-insert-actions">
          <Button
            variant="danger"
            disabled={busy || stale}
            onClick={() => void discard()}
          >
            <Trash2 size={14} />
            Discard recording
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={
              blocked ||
              !actions.length ||
              (destination === "new"
                ? !name.trim()
                : !boundAvailable || !chosenPoint)
            }
            onClick={() => void insert()}
          >
            <Plus size={15} />
            Insert recording
          </Button>
        </div>
      </section>
      {editing ? (
        <StepEditor
          key={editing.id}
          action={editing}
          workspace={workspace}
          api={api}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (next) => {
            const saved = await change(
              actions.map((item) => (item.id === next.id ? next : item)),
            );
            if (saved) setEditing(null);
            return saved;
          }}
        />
      ) : null}
    </div>
  );
}

function StepEditor({
  action,
  workspace,
  api,
  busy,
  onSave,
  onCancel,
}: {
  action: RecordedAction;
  workspace: WorkspaceState;
  api: RelayAPI;
  busy: boolean;
  onSave: (action: RecordedAction) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(action);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(JSON.stringify(action.config, null, 2));
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const references = useMemo(() => createReferenceInspector(blankFlow()), []);
  const changed =
    JSON.stringify(draft) !== JSON.stringify(action) || Boolean(error);
  const cancel = () => {
    if (!busy && (!changed || window.confirm("Discard unsaved step changes?")))
      onCancel();
  };
  const update = (key: string, value: Json | undefined) => {
    const config = updateNodeConfig(draft.kind, draft.config, key, value);
    setDraft((current) => ({ ...current, config }));
    setJson(JSON.stringify(config, null, 2));
    setError("");
  };
  const fields: FieldSpec[] =
    draft.kind === "wait" && draft.config.detector
      ? [
          ...catalog.detect.fields,
          { key: "timeoutMs", label: "Timeout (ms)", type: "number" },
          {
            key: "pollIntervalMs",
            label: "Poll interval (ms)",
            type: "number",
          },
        ]
      : catalog[draft.kind].fields;
  const saveStep = () => {
    if (busy || error || !draft.label.trim()) return;
    setSaveError("");
    void onSave(draft).then((saved) => {
      if (!saved)
        setSaveError(
          "The step could not be saved. Your changes are preserved. Retry, or close this editor to view the recording recovery options.",
        );
    });
  };
  return (
    <Modal
      open
      onClose={cancel}
      title="Edit recorded step"
      description="These changes update the recording draft. They never send input to the application."
      wide
    >
      <div className="recorded-step-form">
        {saveError ? <Notice kind="error">{saveError}</Notice> : null}
        <fieldset disabled={busy}>
          <Field label="Step label">
            <input
              aria-label="Step label"
              value={draft.label}
              maxLength={160}
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
            />
          </Field>
          <RecordingWarning
            config={draft.config}
            onChange={(config) => {
              setDraft({ ...draft, config });
              setJson(JSON.stringify(config, null, 2));
              setError("");
            }}
          />
          <div className="recorded-step-fields">
            {fields
              .filter(
                (field) =>
                  !(
                    supportsNativeLocator(
                      draft.kind,
                      draft.config,
                      workspace,
                    ) &&
                    (field.key === "selector" ||
                      (draft.config.nativeLocator &&
                        [
                          "x",
                          "y",
                          "button",
                          "clickCount",
                          "detection",
                        ].includes(field.key)))
                  ) &&
                  (field.key !== "selector" ||
                    !supportsBrowserLocator(
                      draft.kind,
                      draft.config,
                      workspace,
                    )),
              )
              .map((field) => {
                const value = draft.config[field.key];
                if (
                  field.type === "target" ||
                  field.type === "connection" ||
                  field.type === "flow"
                ) {
                  const choices =
                    field.type === "target"
                      ? workspace.targets
                      : field.type === "connection"
                        ? workspace.connections
                        : workspace.flows;
                  return (
                    <Field key={field.key} label={field.label}>
                      <Select
                        aria-label={field.label}
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          update(field.key, event.target.value || undefined)
                        }
                      >
                        <option value="">Not set</option>
                        {typeof value === "string" &&
                        !choices.some((item) => item.id === value) ? (
                          <option value={value}>Missing · {value}</option>
                        ) : null}
                        {choices.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  );
                }
                if (
                  field.type === "select" &&
                  (value === undefined ||
                    (typeof value === "string" &&
                      field.options?.includes(value)))
                )
                  return (
                    <Field key={field.key} label={field.label}>
                      <Select
                        aria-label={field.label}
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          update(field.key, event.target.value || undefined)
                        }
                      >
                        <option value="">Not set</option>
                        {field.options?.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  );
                if (field.type === "image")
                  return (
                    <div key={field.key} className="recorded-template">
                      <span className="field-label">{field.label}</span>
                      {typeof value === "string" &&
                      value.startsWith("data:image/") ? (
                        <img src={value} alt="Recorded detector template" />
                      ) : (
                        <span className="field-help">
                          Edit the image data in advanced configuration.
                        </span>
                      )}
                    </div>
                  );
                return (
                  <ValueField
                    key={field.key}
                    label={field.label}
                    value={value}
                    onChange={(next) => update(field.key, next)}
                    references={references}
                    allowReference={false}
                    literalType={
                      typeof value === "string"
                        ? "string"
                        : field.type === "number"
                          ? "number"
                          : field.type === "boolean"
                            ? "boolean"
                            : field.type === "json"
                              ? "object"
                              : "string"
                    }
                    allowTypeChange={
                      field.type === "json" || field.type === "value"
                    }
                    multiline={field.type === "textarea"}
                    help={field.help}
                  />
                );
              })}
            {supportsNativeLocator(draft.kind, draft.config, workspace) ? (
              <NativeLocatorField
                kind={draft.kind}
                config={draft.config}
                workspace={workspace}
                tools={api}
                onChange={(config) => {
                  setDraft({ ...draft, config });
                  setJson(JSON.stringify(config, null, 2));
                  setError("");
                }}
              />
            ) : null}
            {supportsBrowserLocator(draft.kind, draft.config, workspace) ? (
              <BrowserLocatorField
                kind={draft.kind}
                config={draft.config}
                workspace={workspace}
                onChange={(config) => {
                  setDraft({ ...draft, config });
                  setJson(JSON.stringify(config, null, 2));
                  setError("");
                }}
                inspect={(targetId, locator) =>
                  api.inspectBrowserLocator(targetId, locator)
                }
                references={references}
                allowReference={false}
              />
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced
              ? "Hide advanced configuration"
              : "Edit advanced configuration"}
          </Button>
          {advanced ? (
            <Field
              label="Step configuration"
              help="Unknown properties are preserved. Enter a JSON object to edit advanced captured metadata."
            >
              <textarea
                aria-label="Step configuration"
                className="code-field"
                value={json}
                onChange={(event) => {
                  setJson(event.target.value);
                  try {
                    const config: unknown = JSON.parse(event.target.value);
                    if (
                      !config ||
                      typeof config !== "object" ||
                      Array.isArray(config)
                    )
                      throw new Error("Enter a JSON object.");
                    setDraft({
                      ...draft,
                      config: config as Record<string, Json>,
                    });
                    setError("");
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    );
                  }
                }}
              />
            </Field>
          ) : null}
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={cancel}>
            Cancel step changes
          </Button>
          <Button
            type="button"
            variant="primary"
            busy={busy}
            disabled={Boolean(error) || !draft.label.trim()}
            onClick={saveStep}
          >
            <Save size={14} />
            Save step changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
