import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type NodeProps,
  type Connection,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Plus,
  Search,
  Trash2,
  Copy,
  ChevronRight,
  Circle,
  Scan,
  MoreHorizontal,
  X,
  Layers3,
  CornerDownRight,
} from "lucide-react";
import type {
  FlowDefinition,
  FlowNode,
  Json,
  NodeKind,
  WorkspaceState,
  ValidationIssue,
  RunRecord,
} from "../shared/types";
import { catalog, uid, type FieldSpec } from "./catalog";
import { ValueField } from "./value-field";
import { ChildInputs, isRecord } from "./child-inputs";
import { SchemaField } from "./schema-field";
import {
  updateNodeConfig,
  setWaitMode,
  setLoopMode,
} from "../shared/node-authoring";
import "./inspector-fields.css";
import {
  createReferenceInspector,
  nodeReference,
} from "../shared/value-references";
import {
  Button,
  IconButton,
  Field,
  JsonField,
  Modal,
  Select,
  Notice,
} from "./components";
type RelayData = {
  definition: FlowNode;
  targetName?: string;
  status?: string;
  issues: number;
  [key: string]: unknown;
};
type CanvasNode = Node<RelayData, "relay">;
const FlowCard = memo(function FlowCard({
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const n = data.definition;
  const spec = catalog[n.kind];
  const Icon = spec.icon;
  const ports = n.kind === "end" ? [] : (spec.ports ?? ["next"]);
  const summary =
    n.kind === "navigate"
      ? String(n.config.url || "Choose a URL")
      : n.kind === "wait"
        ? n.config.detector
          ? `Wait for ${n.config.detector} match`
          : `${n.config.durationMs ?? n.config.ms ?? 1000} ms delay`
        : n.kind === "loop"
          ? n.config.items !== undefined
            ? "Run a child flow for each item"
            : `Repeat ${n.config.count ?? 3} times`
          : n.kind === "group"
            ? (n.config.mode ?? "sequence") === "sequence"
              ? "Run children one at a time"
              : n.config.mode === "batches"
                ? `Fixed batches of ${n.config.concurrency ?? 3}`
                : `Rolling pool · ${n.config.concurrency ?? 3} at a time`
            : n.kind === "ai"
              ? String(n.config.prompt || "Configure your model")
              : n.kind === "start"
                ? "Ready when you are"
                : n.kind === "end"
                  ? "Workflow complete"
                  : data.targetName || spec.description;
  return (
    <div
      className={`flow-card ${selected ? "selected" : ""} ${data.status ?? ""}`}
    >
      <div className="node-topline">
        <span className={`node-icon ${spec.color}`}>
          <Icon size={17} />
        </span>
        <span className="node-kind">{spec.group}</span>
        {n.breakpoint ? (
          <span className="breakpoint" title="Breakpoint" />
        ) : null}
        {data.issues ? <span className="node-issue">!</span> : null}
        <MoreHorizontal size={15} className="node-more" />
      </div>
      <div className="node-name">{n.label}</div>
      <div className="node-summary">{summary}</div>
      <div className="node-footer">
        <span className={`node-state ${data.status ?? ""}`}>
          <Circle size={7} fill="currentColor" />
          {data.status === "running"
            ? "Running"
            : data.status === "succeeded"
              ? "Complete"
              : n.kind === "start"
                ? "Trigger"
                : spec.ports
                  ? "Decision"
                  : "Action"}
        </span>
        <span>{n.kind === "start" ? "01" : n.id.slice(0, 4)}</span>
      </div>
      {n.kind !== "start" ? (
        <Handle type="target" position={Position.Left} id="in" />
      ) : null}
      {ports.map((port, i) => (
        <div key={port}>
          <Handle
            type="source"
            position={Position.Right}
            id={port}
            style={{ top: `${ports.length === 1 ? 50 : 28 + i * 28}%` }}
          />
          {ports.length > 1 ? (
            <span className="port-label" style={{ top: `${28 + i * 28}%` }}>
              {port}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
});
const nodeTypes = { relay: FlowCard };
export function GraphEditor({
  flow,
  workspace,
  selected,
  onSelect,
  onChange,
  onAdd,
  issues,
  run,
}: {
  flow: FlowDefinition;
  workspace: WorkspaceState;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (flow: FlowDefinition) => void;
  onAdd: () => void;
  issues: ValidationIssue[];
  run?: RunRecord;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [instance, setInstance] =
    useState<ReactFlowInstance<CanvasNode> | null>(null);
  const [dragPositions, setDragPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const nodes = useMemo(
    () =>
      flow.nodes.map((n) => ({
        id: n.id,
        type: "relay" as const,
        position: dragPositions[n.id] ?? n.position,
        measured: measurements[n.id],
        data: {
          definition: n,
          targetName: workspace.targets.find((t) => t.id === n.config.targetId)
            ?.name,
          issues: issues.filter((i) => i.nodeId === n.id).length,
          status:
            run?.currentNodeId === n.id
              ? run.status === "running"
                ? "running"
                : undefined
              : run?.events.some(
                    (e) => e.nodeId === n.id && e.status === "succeeded",
                  )
                ? "succeeded"
                : undefined,
        },
        selected: n.id === selected,
      })),
    [
      flow.nodes,
      workspace.targets,
      issues,
      run,
      selected,
      dragPositions,
      measurements,
    ],
  );
  const edges = useMemo(
    () =>
      flow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.port ?? "next",
        type: "smoothstep",
        animated: run?.status === "running" && run.currentNodeId === e.target,
        style: { stroke: "var(--edge)", strokeWidth: 1.6 },
        label: undefined,
      })),
    [flow.edges, run],
  );
  const selectedNode = flow.nodes.find((node) => node.id === selected);
  useEffect(() => {
    if (!instance || !selectedNode || !wrapperRef.current) return;
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    const view = instance.getViewport();
    const x = selectedNode.position.x * view.zoom + view.x;
    const y = selectedNode.position.y * view.zoom + view.y;
    if (
      x < 35 ||
      x + 240 * view.zoom > width - 35 ||
      y < 60 ||
      y + 170 * view.zoom > height - 80
    )
      void instance.setCenter(
        selectedNode.position.x + 113,
        selectedNode.position.y + 80,
        { zoom: Math.max(0.85, view.zoom), duration: 220 },
      );
  }, [selected, instance, selectedNode?.position.x, selectedNode?.position.y]);
  const connect = useCallback(
    (c: Connection) => {
      if (c.source && c.target && c.source !== c.target)
        onChange({
          ...flow,
          edges: [
            ...flow.edges.filter(
              (e) =>
                !(
                  e.source === c.source &&
                  (e.port ?? "next") === (c.sourceHandle ?? "next")
                ),
            ),
            {
              id: uid(),
              source: c.source,
              target: c.target,
              port: c.sourceHandle ?? "next",
            },
          ],
        });
    },
    [flow, onChange],
  );
  return (
    <div className="canvas-wrap" ref={wrapperRef}>
      <ReactFlow<CanvasNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodesChange={(changes) => {
          const dimensions = changes.filter(
            (change) => change.type === "dimensions",
          );
          if (dimensions.length)
            setMeasurements((previous) => {
              let changed = false;
              const next = { ...previous };
              for (const change of dimensions) {
                if (
                  change.type === "dimensions" &&
                  change.dimensions &&
                  (previous[change.id]?.width !== change.dimensions.width ||
                    previous[change.id]?.height !== change.dimensions.height)
                ) {
                  next[change.id] = change.dimensions;
                  changed = true;
                }
              }
              return changed ? next : previous;
            });
        }}
        onConnect={connect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onNodeDrag={(_, n) =>
          setDragPositions((p) => ({ ...p, [n.id]: n.position }))
        }
        onNodeDragStop={(_, n) => {
          onChange({
            ...flow,
            nodes: flow.nodes.map((item) =>
              item.id === n.id ? { ...item, position: n.position } : item,
            ),
          });
          setDragPositions({});
        }}
        onNodesDelete={(deleted) =>
          onChange({
            ...flow,
            nodes: flow.nodes.filter(
              (n) => !deleted.some((d) => d.id === n.id),
            ),
            edges: flow.edges.filter(
              (e) =>
                !deleted.some((d) => d.id === e.source || d.id === e.target),
            ),
          })
        }
        onEdgesDelete={(deleted) =>
          onChange({
            ...flow,
            edges: flow.edges.filter(
              (e) => !deleted.some((d) => d.id === e.id),
            ),
          })
        }
        defaultViewport={{ x: 28, y: 70, zoom: 0.95 }}
        fitViewOptions={{ padding: 0.15, minZoom: 0.75, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.5}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--canvas-dot)" />
        <Controls
          showInteractive={false}
          fitViewOptions={{ padding: 0.15, minZoom: 0.75, maxZoom: 1 }}
        />
        <MiniMap
          nodeColor="#737690"
          nodeStrokeColor="#9292aa"
          nodeStrokeWidth={1}
          maskColor="var(--minimap-mask)"
          pannable
          zoomable
          position="bottom-right"
        />
      </ReactFlow>
      <div className="canvas-label">
        <span className="tiny-dot" /> WORKFLOW CANVAS{" "}
        <span>{flow.nodes.length} nodes</span>
      </div>
      <div className="canvas-add">
        <Button onClick={onAdd}>
          <Plus size={15} /> Add node <kbd>N</kbd>
        </Button>
      </div>
      <div className="canvas-hint">
        Drag to pan <span>·</span> Scroll to zoom <span>·</span> Connect a port
        to add a path
      </div>
    </div>
  );
}
export function NodePalette({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (kind: NodeKind) => void;
}) {
  const [search, setSearch] = useState("");
  const items = (
    Object.entries(catalog) as [NodeKind, (typeof catalog)[NodeKind]][]
  ).filter(([, spec]) =>
    `${spec.label} ${spec.description} ${spec.group}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Make your next move"
      description="Add a building block to your workflow."
      wide
    >
      <div className="search-input palette-search">
        <Search size={17} />
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actions, detectors, logic…"
        />
      </div>
      <div className="node-palette">
        {Array.from(new Set(items.map(([, s]) => s.group))).map((group) => (
          <section key={group}>
            <h4>{group}</h4>
            <div className="palette-grid">
              {items
                .filter(([, s]) => s.group === group)
                .map(([kind, s]) => (
                  <button
                    key={kind}
                    className="palette-item"
                    onClick={() => {
                      onAdd(kind);
                      onClose();
                    }}
                  >
                    <span className={`node-icon ${s.color}`}>
                      <s.icon size={18} />
                    </span>
                    <span>
                      <strong>{s.label}</strong>
                      <small>{s.description}</small>
                    </span>
                    <Plus size={14} />
                  </button>
                ))}
            </div>
          </section>
        ))}
        {items.length === 0 ? (
          <p className="muted">No nodes match that search.</p>
        ) : null}
      </div>
    </Modal>
  );
}
function ConfigField({
  field,
  value,
  onChange,
  workspace,
  flow,
  node,
  references,
}: {
  field: FieldSpec;
  value: Json | undefined;
  onChange: (value: Json | undefined) => void;
  workspace: WorkspaceState;
  flow: FlowDefinition;
  node: FlowNode;
  references: ReturnType<typeof createReferenceInspector>;
}) {
  if (node.kind === "ai" && field.key === "schema")
    return (
      <>
        {value !== undefined &&
        (node.config.mode === "text" || node.config.mode === undefined) ? (
          <Notice>
            An imported schema still controls the AI response in text mode.
            Remove the schema here to request plain text.
          </Notice>
        ) : null}
        <SchemaField label={field.label} value={value} onChange={onChange} />
      </>
    );
  if ((node.kind === "call" || node.kind === "loop") && field.key === "inputs")
    return (
      <ChildInputs
        label={field.label}
        value={value}
        child={workspace.flows.find(
          (candidate) => candidate.id === node.config.flowId,
        )}
        references={references}
        consumerNodeId={node.id}
        loopInputs={node.kind === "loop"}
        onChange={onChange}
      />
    );
  if (
    field.reference !== false &&
    !["target", "connection", "flow", "select", "image"].includes(
      field.type ?? "",
    )
  )
    return (
      <ValueField
        label={field.label}
        value={value}
        onChange={onChange}
        references={references}
        consumerNodeId={node.id}
        help={field.help}
        placeholder={field.placeholder}
        literalType={
          field.type === "number"
            ? "number"
            : field.type === "boolean"
              ? "boolean"
              : field.type === "json"
                ? "object"
                : "string"
        }
        allowTypeChange={field.type === "value" || field.type === "json"}
        multiline={field.type === "textarea"}
        loopInputs={node.kind === "loop" && field.key === "inputs"}
      />
    );
  // Imported expressions remain editable even when this structural field cannot offer references.
  if (
    typeof value === "string" &&
    value.includes("${") &&
    ["boolean", "select"].includes(field.type ?? "")
  )
    return (
      <Field label={field.label} help={field.help}>
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  if (field.type === "boolean")
    return (
      <label className="toggle-row">
        <span>
          <strong>{field.label}</strong>
          {field.help ? <small>{field.help}</small> : null}
        </span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  if (field.type === "image")
    return (
      <Field
        label={field.label}
        help="PNG or JPEG. You can also select a region in the recorder."
      >
        {typeof value === "string" && value.startsWith("data:image/") ? (
          <img
            className="template-preview"
            src={value}
            alt="Detector template"
          />
        ) : null}
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = () => onChange(String(reader.result));
              reader.readAsDataURL(file);
            }
          }}
        />
      </Field>
    );
  if (field.type === "json")
    return (
      <JsonField
        value={value}
        onChange={onChange}
        label={field.label}
        help={field.help}
      />
    );
  if (["target", "connection", "flow", "select"].includes(field.type ?? "")) {
    const options =
      field.type === "target"
        ? workspace.targets.map((t) => ({ id: t.id, name: t.name }))
        : field.type === "connection"
          ? workspace.connections.map((c) => ({ id: c.id, name: c.name }))
          : field.type === "flow"
            ? workspace.flows
                .filter((f) => f.id !== flow.id)
                .map((f) => ({ id: f.id, name: f.name }))
            : (field.options ?? []).map((id) => ({ id, name: id }));
    const importedImageSource =
      node.kind === "ai" &&
      field.key === "targetId" &&
      node.config.mode !== "vision" &&
      value !== undefined &&
      value !== "";
    return (
      <>
        {importedImageSource ? (
          <Notice>
            This imported image source still reserves its target. Clear it if it
            is not needed in this mode.
          </Notice>
        ) : null}
        <Field label={field.label} help={field.help}>
          <Select
            aria-label={field.label}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">
              Choose{" "}
              {field.type === "select"
                ? "an option"
                : field.type === "connection"
                  ? "a connection"
                  : field.type === "flow"
                    ? "a flow"
                    : "a target"}
              …
            </option>
            {value !== undefined &&
            value !== "" &&
            !options.some((option) => option.id === value) ? (
              <option value={String(value)}>
                Unavailable: {String(value)}
              </option>
            ) : null}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        {importedImageSource ? (
          <Button onClick={() => onChange(undefined)}>
            Clear image source
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <Field label={field.label} help={field.help}>
      {field.type === "textarea" ? (
        <textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      ) : (
        <input
          type={
            field.type === "number" &&
            !(typeof value === "string" && value.includes("${"))
              ? "number"
              : "text"
          }
          step={field.type === "number" ? "any" : undefined}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(
              field.type === "number" && !e.target.value.includes("${")
                ? Number(e.target.value)
                : e.target.value,
            )
          }
          placeholder={field.placeholder}
        />
      )}
    </Field>
  );
}
export function Inspector({
  flow,
  node,
  workspace,
  onChange,
  onDelete,
  onDuplicate,
  onTest,
  issues,
}: {
  flow: FlowDefinition;
  node?: FlowNode;
  workspace: WorkspaceState;
  onChange: (flow: FlowDefinition) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onTest: (config: Record<string, Json>) => void;
  issues: ValidationIssue[];
}) {
  const [advanced, setAdvanced] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const references = useMemo(() => createReferenceInspector(flow), [flow]);
  const copyReference = node ? nodeReference(node.id) : null;
  useEffect(() => setCopyStatus(""), [node?.id]);
  const spec = node ? catalog[node.kind] : null;
  const effectiveDetector = node
    ? (node.config.detector ?? (node.kind === "detect" ? "text" : undefined))
    : undefined;
  const update = (patch: Partial<FlowNode>) => {
    if (node)
      onChange({
        ...flow,
        nodes: flow.nodes.map((n) =>
          n.id === node.id ? { ...n, ...patch } : n,
        ),
      });
  };
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span>{node ? "Node properties" : "Flow overview"}</span>
        {node ? (
          <IconButton label="Duplicate node" onClick={onDuplicate}>
            <Copy size={14} />
          </IconButton>
        ) : (
          <span className="badge">v{flow.revision}</span>
        )}
      </div>
      <div className="inspector-content">
        {node && spec ? (
          <>
            <div className="inspector-node-heading">
              <span className={`node-icon large ${spec.color}`}>
                <spec.icon size={21} />
              </span>
              <div>
                <h3>{spec.label}</h3>
                <span>{spec.group}</span>
              </div>
            </div>
            <p className="inspector-description">{spec.description}</p>
            <Field label="Node name">
              <input
                value={node.label}
                onChange={(e) => update({ label: e.target.value })}
              />
            </Field>
            <div className="node-reference">
              <span className="field-label">Node ID</span>
              <code data-node-id>{node.id}</code>
              <button
                type="button"
                className="value-source-button"
                aria-label="Copy node reference"
                disabled={!copyReference}
                onClick={() => {
                  void Promise.resolve()
                    .then(() => navigator.clipboard.writeText(copyReference!))
                    .then(() => setCopyStatus("Reference copied."))
                    .catch(() =>
                      setCopyStatus(
                        "Could not copy. Select the node ID above to build its reference.",
                      ),
                    );
                }}
              >
                <Copy size={12} /> Copy node reference
              </button>
              {!copyReference ? (
                <span className="field-help">
                  This imported ID cannot be used in a reference. Duplicate the
                  node to give it a new ID.
                </span>
              ) : null}
              {copyStatus ? (
                <span role="status" className="field-help">
                  {copyStatus}
                </span>
              ) : null}
            </div>
            <div className="section-divider" />
            <h4 className="section-eyebrow">CONFIGURATION</h4>
            {node.kind === "wait" ? (
              <Field
                label="Wait for"
                help="A duration pauses for a fixed time. A detector continues when a match appears."
              >
                <Select
                  aria-label="Wait for"
                  value={node.config.detector ? "detector" : "duration"}
                  onChange={(event) =>
                    update({
                      config: setWaitMode(
                        node.config,
                        event.target.value as "duration" | "detector",
                      ),
                    })
                  }
                >
                  <option value="duration">Duration</option>
                  <option value="detector">Detector match</option>
                </Select>
              </Field>
            ) : null}
            {node.kind === "loop" ? (
              <Field label="Loop mode">
                <Select
                  aria-label="Loop mode"
                  value={node.config.items !== undefined ? "foreach" : "count"}
                  onChange={(event) =>
                    update({
                      config: setLoopMode(
                        node.config,
                        event.target.value as "count" | "foreach",
                      ),
                    })
                  }
                >
                  <option value="count">Repeat a count</option>
                  <option value="foreach">For each item</option>
                </Select>
              </Field>
            ) : null}
            {node.kind === "group" ? (
              <GroupChildren
                config={node.config}
                flows={workspace.flows.filter((f) => f.id !== flow.id)}
                nodeId={node.id}
                references={references}
                onChange={(config) => update({ config })}
              />
            ) : null}
            {(node.kind === "wait" && node.config.detector
              ? [
                  ...catalog.detect.fields,
                  {
                    key: "timeoutMs",
                    label: "Timeout (ms)",
                    type: "number" as const,
                  },
                  {
                    key: "pollIntervalMs",
                    label: "Check every (ms)",
                    type: "number" as const,
                  },
                ]
              : spec.fields
            )
              .filter(
                (f) =>
                  !(
                    node.kind === "group" &&
                    (["flowIds", "children"].includes(f.key) ||
                      (f.key === "concurrency" &&
                        (node.config.mode ?? "sequence") === "sequence"))
                  ),
              )
              .filter((f) => {
                if (
                  node.kind === "condition" &&
                  f.key === "right" &&
                  (node.config.operator ?? "truthy") === "truthy"
                )
                  return false;
                if (
                  node.kind === "loop" &&
                  ((f.key === "items" && node.config.items === undefined) ||
                    (f.key === "count" && node.config.items !== undefined))
                )
                  return false;
                if (
                  node.kind === "ai" &&
                  f.key === "schema" &&
                  node.config.mode !== "structured" &&
                  node.config.mode !== "vision" &&
                  node.config.schema === undefined
                )
                  return false;
                if (
                  node.kind === "ai" &&
                  f.key === "targetId" &&
                  node.config.mode !== "vision" &&
                  !node.config.targetId
                )
                  return false;
                if (
                  node.kind !== "detect" &&
                  !(node.kind === "wait" && node.config.detector)
                )
                  return true;
                const method = effectiveDetector;
                return (
                  (f.key !== "color" || method === "color") &&
                  (f.key !== "template" || method === "image") &&
                  (f.key !== "selector" || method === "element") &&
                  (f.key !== "connectionId" || method === "ai") &&
                  (f.key !== "locate" || method === "ai") &&
                  (f.key !== "prompt" || method === "text" || method === "ai")
                );
              })
              .map((field) => (
                <ConfigField
                  key={`${node.id}-${field.key}`}
                  field={field}
                  value={
                    field.key === "detector"
                      ? effectiveDetector
                      : node.kind === "condition" && field.key === "operator"
                        ? (node.config.operator ?? "truthy")
                        : field.key === "mode" && node.kind === "ai"
                          ? (node.config.mode ?? "text")
                          : field.key === "mode" && node.kind === "group"
                            ? (node.config.mode ?? "sequence")
                            : field.key === "durationMs"
                              ? (node.config.durationMs ?? node.config.ms)
                              : field.key === "pollIntervalMs"
                                ? (node.config.pollIntervalMs ??
                                  node.config.pollMs)
                                : field.key === "variable"
                                  ? (node.config.variable ?? node.config.name)
                                  : field.key === "prompt" &&
                                      effectiveDetector === "text"
                                    ? (node.config.text ?? node.config.prompt)
                                    : node.config[field.key]
                  }
                  onChange={(value) => {
                    update({
                      config: updateNodeConfig(
                        node.kind,
                        node.config,
                        field.key,
                        value,
                      ),
                    });
                  }}
                  workspace={workspace}
                  flow={flow}
                  node={node}
                  references={references}
                />
              ))}
            {spec.fields.length === 0 ? (
              <p className="muted small">
                This node needs no configuration. Connect it to your next step.
              </p>
            ) : null}
            {node.kind === "detect" ||
            (node.kind === "wait" && node.config.detector) ? (
              <Button onClick={() => onTest(node.config)}>
                <Scan size={14} /> Test detector
              </Button>
            ) : null}
            <div className="section-divider" />
            <label className="toggle-row">
              <span>
                <strong>Pause here</strong>
                <small>Break before this node runs</small>
              </span>
              <input
                type="checkbox"
                checked={node.breakpoint ?? false}
                onChange={(e) => update({ breakpoint: e.target.checked })}
              />
            </label>
            <button
              className="disclosure"
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronRight size={14} className={advanced ? "rotated" : ""} />{" "}
              Advanced configuration
            </button>
            {advanced ? (
              <JsonField
                label="Node configuration"
                value={node.config}
                onChange={(value) => {
                  if (
                    value &&
                    typeof value === "object" &&
                    !Array.isArray(value)
                  )
                    update({ config: value });
                }}
                help={
                  ["click", "move", "drag"].includes(node.kind)
                    ? 'Coordinates can reference detector outputs: "x": "${nodes.detectorId.box.x}", "y": "${nodes.detectorId.box.y}", "frameId": "${nodes.detectorId.frameId}". Use the detector node’s ID and the same target.'
                    : "References: ${inputs.name}, ${vars.value}, ${nodes.nodeId}."
                }
              />
            ) : null}
            {issues
              .filter((i) => i.nodeId === node.id)
              .map((issue, i) => (
                <Notice
                  key={i}
                  kind={issue.severity === "error" ? "error" : "info"}
                >
                  {issue.message}
                </Notice>
              ))}
            <button className="delete-node" onClick={onDelete}>
              <Trash2 size={14} /> Delete node
            </button>
          </>
        ) : (
          <>
            <div className="flow-overview-icon">
              <Layers3 size={28} />
            </div>
            <h3 className="flow-overview-name">A flow of possibilities.</h3>
            <p className="inspector-description">
              Connect actions, add a little intelligence, and let the repetitive
              things take care of themselves.
            </p>
            <Field label="Flow name">
              <input
                value={flow.name}
                onChange={(e) => onChange({ ...flow, name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <textarea
                value={flow.description}
                onChange={(e) =>
                  onChange({ ...flow, description: e.target.value })
                }
                placeholder="What will this flow take off your plate?"
              />
            </Field>
            <Field label="Folder">
              <input
                value={flow.folder}
                onChange={(e) => onChange({ ...flow, folder: e.target.value })}
              />
            </Field>
            <Field
              label="Run shortcut"
              help="A global shortcut in the desktop application."
            >
              <input
                value={flow.hotkey ?? ""}
                onChange={(e) => onChange({ ...flow, hotkey: e.target.value })}
                placeholder="CommandOrControl+Shift+1"
              />
            </Field>
            <FlowValues
              key={`${flow.id}-inputs`}
              label="Flow inputs"
              value={flow.inputs}
              references={references}
              allowReference={false}
              onChange={(value) => onChange({ ...flow, inputs: value })}
            />
            <FlowValues
              key={`${flow.id}-outputs`}
              label="Flow outputs"
              value={flow.outputs}
              references={references}
              allowReference
              onChange={(value) => onChange({ ...flow, outputs: value })}
            />
            <div className="inspector-tip">
              <CornerDownRight size={17} />
              <p>
                Select a node to make it yours. Connect the dots to define what
                happens next.
              </p>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
function WorkflowIcon() {
  return <Layers3 size={13} />;
}

function FlowValues({
  label,
  value,
  references,
  allowReference,
  onChange,
}: {
  label: string;
  value: Record<string, Json>;
  references: ReturnType<typeof createReferenceInspector>;
  allowReference: boolean;
  onChange: (value: Record<string, Json>) => void;
}) {
  const [error, setError] = useState("");
  return (
    <div className="flow-value-contract">
      <ValueField
        label={label}
        value={value}
        references={references}
        literalType="object"
        allowReference={allowReference}
        allowWholeReference={false}
        help={
          allowReference
            ? "Named results returned when the workflow finishes. Choose outputs from earlier nodes for each property."
            : "Literal default values available when this flow runs. Callers can override individual properties."
        }
        onChange={(next) => {
          if (!isRecord(next)) {
            setError(
              "The root must remain an object with named properties. This edit has not been applied.",
            );
            return;
          }
          setError("");
          onChange(next);
        }}
      />
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function GroupChildren({
  config,
  flows,
  nodeId,
  references,
  onChange,
}: {
  config: Record<string, Json>;
  flows: FlowDefinition[];
  nodeId: string;
  references: ReturnType<typeof createReferenceInspector>;
  onChange: (config: Record<string, Json>) => void;
}) {
  const children: Json[] = Array.isArray(config.children)
    ? config.children
    : Array.isArray(config.flowIds)
      ? config.flowIds.map((id) => ({ flowId: id, inputs: {} }))
      : [];
  const update = (next: typeof children) => {
    const { flowIds: _old, children: _previous, ...rest } = config;
    onChange({ ...rest, children: next });
  };
  return (
    <div className="child-flow-picker">
      <Field
        label="Child flows"
        help="Each entry is one invocation. Add a flow more than once to run it with different inputs."
      >
        <Select
          value=""
          onChange={(e) => {
            if (e.target.value)
              update([...children, { flowId: e.target.value, inputs: {} }]);
          }}
        >
          <option value="">Add a flow…</option>
          {flows.map((flow) => (
            <option key={flow.id} value={flow.id}>
              {flow.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="child-list">
        {children.map((child, index) => {
          if (!isRecord(child) || typeof child.flowId !== "string")
            return (
              <div className="child-entry" key={index}>
                <JsonField
                  label={`Child ${index + 1} (advanced)`}
                  value={child}
                  onChange={(value) =>
                    update(
                      children.map((item, i) => (i === index ? value : item)),
                    )
                  }
                  help="This imported entry needs advanced editing. Other child edits preserve it."
                />
                <IconButton
                  label={`Remove child ${index + 1}`}
                  onClick={() => update(children.filter((_, i) => i !== index))}
                >
                  <X size={12} />
                </IconButton>
              </div>
            );
          const selectedChild = flows.find((flow) => flow.id === child.flowId);
          return (
            <div className="child-entry" key={`${child.flowId}-${index}`}>
              <div className="child-row">
                <WorkflowIcon />
                <Select
                  aria-label={`Flow for child ${index + 1}`}
                  value={child.flowId}
                  onChange={(event) =>
                    update(
                      children.map((item, i) =>
                        i === index
                          ? { ...child, flowId: event.target.value }
                          : item,
                      ),
                    )
                  }
                >
                  {!selectedChild ? (
                    <option value={child.flowId}>
                      {child.flowId || "Missing child flow"}
                    </option>
                  ) : null}
                  {flows.map((flow) => (
                    <option key={flow.id} value={flow.id}>
                      {index + 1}. {flow.name}
                    </option>
                  ))}
                </Select>
                <IconButton
                  label={`Remove child ${index + 1}`}
                  onClick={() => update(children.filter((_, i) => i !== index))}
                >
                  <X size={12} />
                </IconButton>
              </div>
              <details className="child-inputs">
                <summary>
                  Inputs
                  {child.inputs &&
                  typeof child.inputs === "object" &&
                  Object.keys(child.inputs).length
                    ? ` · ${Object.keys(child.inputs).length} values`
                    : ""}
                </summary>
                <ChildInputs
                  label={`Inputs for child ${index + 1}`}
                  value={child.inputs}
                  child={selectedChild}
                  references={references}
                  consumerNodeId={nodeId}
                  onChange={(value) => {
                    update(
                      children.map((item, i) => {
                        if (i !== index) return item;
                        const next = { ...child };
                        if (value === undefined) delete next.inputs;
                        else next.inputs = value;
                        return next;
                      }),
                    );
                  }}
                />
              </details>
            </div>
          );
        })}
      </div>
      <span className="field-help">
        {children.length} child invocation{children.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}
