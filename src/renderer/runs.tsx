import { useState } from "react";
import {
  Activity,
  Clock3,
  Play,
  Pause,
  Square,
  StepForward,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Ban,
  ArrowUpRight,
  CalendarClock,
  Plus,
  Pencil,
  Trash2,
  GitBranch,
  List,
  ArrowDown,
} from "lucide-react";
import type {
  WorkspaceState,
  RelayAPI,
  RunRecord,
  Schedule,
} from "../shared/types";
import { uid } from "./catalog";
import {
  Button,
  IconButton,
  Modal,
  Field,
  JsonField,
  Select,
  EmptyState,
  Notice,
  formatTime,
} from "./components";
const active = (run: RunRecord) =>
  ["queued", "running", "paused"].includes(run.status);
export function Runs({
  workspace,
  api,
  onError,
  flowId,
  onOpenFlow,
}: {
  workspace: WorkspaceState;
  api: RelayAPI;
  onError: (error: unknown) => void;
  flowId?: string;
  onOpenFlow: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const runs = workspace.runs
    .filter(
      (run) =>
        (!flowId || run.flowId === flowId) &&
        (!run.parentId || run.id === selectedId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = runs.filter(
    (r) =>
      filter === "all" ||
      (filter === "active" ? active(r) : r.status === filter),
  );
  const selected =
    workspace.runs.find((r) => r.id === selectedId) ?? filtered[0];
  const control = async (action: "pause" | "resume" | "step" | "stop") => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.controlRun(selected.id, action);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="runs-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">EVERY STEP, ACCOUNTED FOR</span>
          <h1>{flowId ? "Flow runs" : "Run history"}</h1>
          <p>Follow your workflows from the first action to the last.</p>
        </div>
        <span className="summary-chip">
          <Activity size={15} />
          {workspace.runs.filter((r) => active(r) && !r.parentId).length} active
        </span>
      </div>
      <div className="run-filters">
        {[
          ["all", "All runs"],
          ["active", "Active"],
          ["succeeded", "Completed"],
          ["failed", "Failed"],
          ["skipped", "Skipped"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
          >
            {label}
            <span>
              {
                runs.filter(
                  (r) =>
                    id === "all" ||
                    (id === "active" ? active(r) : r.status === id),
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      {!filtered.length ? (
        <EmptyState
          icon={<Activity size={34} />}
          title={
            filter === "all"
              ? "Your first run is the beginning"
              : "Nothing here just yet"
          }
          description={
            filter === "all"
              ? "Run a flow to see its progress, decisions, child flows, and results in one place."
              : "Runs matching this filter will appear here."
          }
        />
      ) : (
        <div className="runs-layout">
          <div className="run-list">
            {filtered.map((run) => (
              <button
                key={run.id}
                className={`run-list-item ${selected?.id === run.id ? "selected" : ""}`}
                onClick={() => setSelectedId(run.id)}
              >
                <RunIcon status={run.status} />
                <span>
                  <strong>{run.flowName}</strong>
                  <small>
                    {formatTime(run.createdAt)} <span>·</span> v{run.revision}
                  </small>
                </span>
                <span className={`status-pill ${run.status}`}>
                  {run.status}
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="run-details">
              <div className="run-detail-heading">
                <div>
                  <span className={`status-pill ${selected.status}`}>
                    {selected.status}
                  </span>
                  <h2>{selected.flowName}</h2>
                  <p>
                    {formatTime(selected.createdAt)} <span>·</span>{" "}
                    {selected.trigger} <span>·</span> revision{" "}
                    {selected.revision}
                  </p>
                </div>
                <IconButton
                  label="Open flow"
                  onClick={() => onOpenFlow(selected.flowId)}
                >
                  <ArrowUpRight size={19} />
                </IconButton>
              </div>
              {active(selected) ? (
                <div className="run-control-bar">
                  {selected.status === "paused" ? (
                    <>
                      <Button
                        busy={busy}
                        onClick={() => void control("resume")}
                      >
                        <Play size={14} /> Resume
                      </Button>
                      <Button busy={busy} onClick={() => void control("step")}>
                        <StepForward size={14} /> Step
                      </Button>
                    </>
                  ) : (
                    <Button busy={busy} onClick={() => void control("pause")}>
                      <Pause size={14} /> Pause
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    busy={busy}
                    onClick={() => void control("stop")}
                  >
                    <Square size={13} /> Stop
                  </Button>
                </div>
              ) : null}
              {selected.error ? (
                <Notice kind="error">{selected.error}</Notice>
              ) : null}
              {selected.childIds.length ? (
                <section className="run-section">
                  <h4>
                    <GitBranch size={14} /> Child flows
                  </h4>
                  <RunTree
                    id={selected.id}
                    runs={workspace.runs}
                    onSelect={setSelectedId}
                  />
                </section>
              ) : null}
              <section className="run-section">
                <h4>
                  <List size={14} /> Execution timeline{" "}
                  <span>{selected.events.length} events</span>
                </h4>
                <div className="event-list">
                  {selected.events.map((event) => (
                    <div className={`run-event ${event.type}`} key={event.id}>
                      <span className="event-dot" />
                      <time>
                        {new Date(event.at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </time>
                      <div>
                        <p>{event.message}</p>
                        {event.data !== undefined ? (
                          <details>
                            <summary>View data</summary>
                            <pre>{JSON.stringify(event.data, null, 2)}</pre>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!selected.events.length ? (
                    <p className="muted">Waiting for the first event…</p>
                  ) : null}
                </div>
              </section>
              <section className="run-section">
                <h4>
                  <ArrowDown size={14} /> Outputs
                </h4>
                <pre className="run-output">
                  {JSON.stringify(selected.outputs, null, 2)}
                </pre>
              </section>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
function RunIcon({ status }: { status: RunRecord["status"] }) {
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "cancelled"
          ? Ban
          : status === "paused"
            ? Pause
            : status === "running"
              ? Activity
              : Clock3;
  return (
    <span className={`run-icon ${status}`}>
      <Icon size={18} />
    </span>
  );
}
function RunTree({
  id,
  runs,
  onSelect,
  depth = 0,
  seen = [],
}: {
  id: string;
  runs: RunRecord[];
  onSelect: (id: string) => void;
  depth?: number;
  seen?: string[];
}) {
  const run = runs.find((r) => r.id === id);
  if (!run || seen.includes(id) || depth > 20) return null;
  return (
    <div className="run-tree">
      {depth > 0 ? (
        <button onClick={() => onSelect(id)}>
          <ChevronRight size={13} />
          <RunIcon status={run.status} />
          <span>{run.flowName}</span>
          <span className={`status-pill ${run.status}`}>{run.status}</span>
        </button>
      ) : null}
      {run.childIds.map((childId) => (
        <RunTree
          key={childId}
          id={childId}
          runs={runs}
          onSelect={onSelect}
          depth={depth + 1}
          seen={[...seen, id]}
        />
      ))}
    </div>
  );
}
export function Schedules({
  workspace,
  api,
  refresh,
  onError,
  onSuccess,
}: {
  workspace: WorkspaceState;
  api: RelayAPI;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onSuccess: (message: string) => void;
}) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      if (!editing.name.trim() || !editing.flowId)
        throw new Error("Add a schedule name and choose a flow.");
      new Intl.DateTimeFormat(undefined, {
        timeZone: editing.timezone,
      }).format();
      if (editing.kind === "interval" && editing.intervalMinutes < 1)
        throw new Error("The interval must be at least one minute.");
      if (editing.kind === "weekly" && !editing.weekdays.length)
        throw new Error("Select at least one day.");
      await api.saveSchedule(editing);
      await refresh();
      setEditing(null);
      onSuccess(
        workspace.desktop
          ? "Schedule saved."
          : "Schedule saved locally. It will only execute in the desktop application.",
      );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="schedules-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">RIGHT ON TIME</span>
          <h1>Schedules</h1>
          <p>Set the rhythm. Let your workflows take it from there.</p>
        </div>
        <Button
          variant="primary"
          disabled={!workspace.flows.length}
          onClick={() =>
            setEditing({
              id: uid(),
              flowId: workspace.flows[0]?.id ?? "",
              name: "",
              enabled: true,
              kind: "daily",
              time: "09:00",
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              intervalMinutes: 60,
              weekdays: [1, 2, 3, 4, 5],
              inputs: {},
            })
          }
        >
          <Plus size={15} /> New schedule
        </Button>
      </div>
      <Notice>
        {workspace.desktop
          ? "Schedules run while Relay is running and your desktop is available. Missed occurrences are skipped; overlapping runs of one schedule are not duplicated."
          : "Schedules can be designed in the web preview. Execution requires the Relay desktop application to be running."}
      </Notice>
      {workspace.schedules.length ? (
        <div className="schedule-list">
          {workspace.schedules.map((schedule) => (
            <div className="schedule-card" key={schedule.id}>
              <span className="schedule-icon">
                <CalendarClock size={24} />
              </span>
              <div>
                <h3>{schedule.name}</h3>
                <p>
                  {workspace.flows.find((f) => f.id === schedule.flowId)
                    ?.name ?? "Missing flow"}{" "}
                  <span>·</span>{" "}
                  {schedule.kind === "interval"
                    ? `Every ${schedule.intervalMinutes} minutes`
                    : schedule.kind === "daily"
                      ? `Daily at ${schedule.time}`
                      : schedule.kind === "weekly"
                        ? `${schedule.weekdays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")} at ${schedule.time}`
                        : schedule.time.replace("T", " · ")}
                </p>
                <small>
                  {schedule.timezone}{" "}
                  {schedule.nextRunAt
                    ? ` · Next: ${formatTime(schedule.nextRunAt)}`
                    : ""}
                </small>
              </div>
              <label className="schedule-toggle">
                <input
                  type="checkbox"
                  aria-label={`Enable ${schedule.name}`}
                  checked={schedule.enabled}
                  onChange={(e) =>
                    void api
                      .saveSchedule({ ...schedule, enabled: e.target.checked })
                      .then(refresh)
                      .catch(onError)
                  }
                />
                <span>{schedule.enabled ? "Enabled" : "Paused"}</span>
              </label>
              <IconButton
                label={`Edit ${schedule.name}`}
                onClick={() => setEditing(structuredClone(schedule))}
              >
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label={`Delete ${schedule.name}`}
                onClick={() => {
                  if (window.confirm(`Delete schedule “${schedule.name}”?`))
                    void api
                      .deleteSchedule(schedule.id)
                      .then(refresh)
                      .catch(onError);
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<CalendarClock size={36} />}
          title="Make time for something else"
          description="Schedule a saved workflow for a specific time, every day, or at a regular interval."
        />
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name || "New schedule"}
        description="Choose a flow and when it should run."
      >
        {editing ? (
          <div className="form-stack">
            <Field label="Schedule name">
              <input
                autoFocus
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                placeholder="Weekday briefing"
              />
            </Field>
            <Field label="Workflow">
              <Select
                value={editing.flowId}
                onChange={(e) =>
                  setEditing({ ...editing, flowId: e.target.value })
                }
              >
                {workspace.flows.map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Repeat">
              <Select
                value={editing.kind}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    kind: e.target.value as Schedule["kind"],
                    time:
                      e.target.value === "once"
                        ? localDateTime(new Date(Date.now() + 3600000))
                        : "09:00",
                  })
                }
              >
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekly">Selected weekdays</option>
                <option value="interval">At an interval</option>
              </Select>
            </Field>
            {editing.kind === "interval" ? (
              <Field label="Interval (minutes)">
                <input
                  type="number"
                  min={1}
                  value={editing.intervalMinutes}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      intervalMinutes: Number(e.target.value),
                    })
                  }
                />
              </Field>
            ) : (
              <Field label={editing.kind === "once" ? "Date & time" : "Time"}>
                <input
                  type={editing.kind === "once" ? "datetime-local" : "time"}
                  value={editing.time}
                  onChange={(e) =>
                    setEditing({ ...editing, time: e.target.value })
                  }
                />
              </Field>
            )}
            {editing.kind === "weekly" ? (
              <div className="weekday-picker">
                {["S", "M", "T", "W", "T", "F", "S"].map((day, i) => (
                  <button
                    type="button"
                    aria-label={
                      [
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ][i]
                    }
                    key={i}
                    className={editing.weekdays.includes(i) ? "selected" : ""}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        weekdays: editing.weekdays.includes(i)
                          ? editing.weekdays.filter((d) => d !== i)
                          : [...editing.weekdays, i].sort(),
                      })
                    }
                  >
                    {day}
                  </button>
                ))}
              </div>
            ) : null}
            <Field label="Timezone">
              <input
                value={editing.timezone}
                onChange={(e) =>
                  setEditing({ ...editing, timezone: e.target.value })
                }
                placeholder="Australia/Sydney"
              />
            </Field>
            <JsonField
              label="Flow inputs"
              value={editing.inputs}
              onChange={(value) => {
                if (value && typeof value === "object" && !Array.isArray(value))
                  setEditing({ ...editing, inputs: value });
              }}
            />
            <div className="modal-actions">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void save()}>
                Save schedule
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function localDateTime(date: Date) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}
