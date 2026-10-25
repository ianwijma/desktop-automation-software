import type {
  FlowDefinition,
  FlowNode,
  RecordingInsertionAnchor,
  RecordingState,
} from "./types";
import { nodeOutputPorts } from "./node-definitions";

export const recordableKinds = [
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
  "detect",
  "focus",
  "navigate",
  "read",
  "select",
  "tab",
] as const;

export const emptyRecording = (): RecordingState => ({
  phase: "idle",
  active: false,
  revision: 0,
  mode: "guided",
  actions: [],
});

/** Recovery never enables capture, installs listeners, or replays input. */
export function recoverRecording(state: RecordingState): RecordingState {
  if (state.phase === "idle") return emptyRecording();
  return {
    ...structuredClone(state),
    phase: "review",
    active: false,
    revision: state.revision + 1,
    recovered: true,
    error:
      state.error ??
      (state.phase === "capturing"
        ? "Recording was interrupted. The last in-flight action may be incomplete; review these steps before inserting."
        : undefined),
  };
}

/** R01 only supports an explicitly selected, free ordinary next port. */
export function recordingAnchor(
  flow: FlowDefinition,
  selectedId?: string | null,
): string | undefined {
  const node = flow.nodes.find((item) => item.id === selectedId);
  if (
    !node ||
    node.kind === "end" ||
    node.kind === "condition" ||
    node.kind === "detect"
  )
    return undefined;
  return nodeOutputPorts(node.kind).includes("next") &&
    !flow.edges.some((edge) => edge.source === node.id)
    ? node.id
    : undefined;
}

/** Only reachable sources can receive a sequence; never create an orphan. */
function reachableSources(flow: FlowDefinition): Set<string> {
  const starts = flow.nodes.filter((node) => node.kind === "start");
  if (starts.length !== 1) return new Set();
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of flow.edges) {
    const source = nodes.get(edge.source);
    if (
      !source ||
      !nodes.has(edge.target) ||
      !nodeOutputPorts(source.kind).includes(edge.port ?? "next")
    )
      continue;
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const seen = new Set<string>();
  const pending = [starts[0].id];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  return seen;
}

export interface RecordingInsertionPoint {
  key: string;
  label: string;
  anchor: RecordingInsertionAnchor;
}
export const recordingPointKey = (anchor: RecordingInsertionAnchor) =>
  JSON.stringify([
    anchor.sourceNodeId,
    anchor.port,
    anchor.edgeId ?? null,
    anchor.successorNodeId ?? null,
  ]);

/** Each occupied output is one edge choice; empty outputs remain explicit choices. */
export function recordingInsertionPoints(
  flow: FlowDefinition,
): RecordingInsertionPoint[] {
  const reachable = reachableSources(flow);
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const names = new Map<string, number>();
  for (const node of flow.nodes)
    names.set(node.label, (names.get(node.label) ?? 0) + 1);
  const label = (node: FlowNode) =>
    (names.get(node.label) ?? 0) > 1
      ? `${node.label} (${node.id})`
      : node.label;
  const outgoingByPort = new Map<string, typeof flow.edges>();
  for (const edge of flow.edges) {
    const key = JSON.stringify([edge.source, edge.port ?? "next"]);
    outgoingByPort.set(key, [...(outgoingByPort.get(key) ?? []), edge]);
  }
  return flow.nodes.flatMap((node) => {
    if (!reachable.has(node.id)) return [];
    return nodeOutputPorts(node.kind).flatMap((port) => {
      const outgoing =
        outgoingByPort.get(JSON.stringify([node.id, port])) ?? [];
      if (outgoing.length > 1) return [];
      const edge = outgoing[0];
      const successor = edge && nodes.get(edge.target);
      if (
        edge &&
        (!successor ||
          successor.kind === "start" ||
          flow.edges.filter((item) => item.id === edge.id).length !== 1)
      )
        return [];
      const anchor = {
        sourceNodeId: node.id,
        port,
        ...(edge ? { edgeId: edge.id, successorNodeId: edge.target } : {}),
      };
      return [
        {
          key: recordingPointKey(anchor),
          label: `${label(node)} · ${port} → ${successor ? label(successor) : "new Finish"}`,
          anchor,
        },
      ];
    });
  });
}

/** Recheck the complete anchor snapshot, not just whether a source still exists. */
export function resolveRecordingAnchor(
  flow: FlowDefinition,
  anchor: RecordingInsertionAnchor,
): RecordingInsertionPoint {
  const point = recordingInsertionPoints(flow).find(
    (item) => item.key === recordingPointKey(anchor),
  );
  if (!point)
    throw new Error(
      "The insertion point changed or is unavailable. Select a reachable output with at most one successor. Your recording is preserved.",
    );
  return point;
}

export function recordingDestinationAnchor(
  flow: FlowDefinition,
  state: RecordingState,
): RecordingInsertionAnchor | undefined {
  if (state.destination?.anchor) return state.destination.anchor;
  // R01 drafts only reserved free ordinary next ports. Do not reinterpret them
  // as occupied edges after an upgrade.
  const legacy = recordingAnchor(flow, state.destination?.anchorNodeId);
  return legacy ? { sourceNodeId: legacy, port: "next" } : undefined;
}

/** Undo of new-flow insertion clears the sequence while keeping the new flow. */
export function emptyRecordedFlow(
  flow: FlowDefinition,
  newId: () => string,
): FlowDefinition {
  const start = flow.nodes.find((node) => node.kind === "start")!;
  const finish = flow.nodes.find((node) => node.kind === "end")!;
  return {
    ...flow,
    nodes: [
      structuredClone(start),
      {
        ...structuredClone(finish),
        position: { x: start.position.x + 310, y: start.position.y },
      },
    ],
    edges: [{ id: newId(), source: start.id, target: finish.id, port: "next" }],
  };
}

function assertReview(state: RecordingState) {
  if (state.phase !== "review" || !state.sessionId || !state.destination)
    throw new Error("Stop and review this recording before inserting it.");
  if (!state.actions.length)
    throw new Error("Record at least one step before inserting.");
}
function recordedNodes(
  state: RecordingState,
  origin: { x: number; y: number },
  newId: () => string,
): FlowNode[] {
  return state.actions.map((action, i) => ({
    id: newId(),
    kind: action.kind,
    label: action.label,
    config: structuredClone(action.config),
    position: { x: origin.x + (i + 1) * 310, y: origin.y },
  }));
}
function links(nodes: FlowNode[], newId: () => string) {
  return nodes.slice(1).map((node, i) => ({
    id: newId(),
    source: nodes[i].id,
    target: node.id,
    port: "next",
  }));
}
export function createRecordingFlow(
  state: RecordingState,
  name?: string,
  newId: () => string = () => crypto.randomUUID(),
  now = new Date().toISOString(),
): FlowDefinition {
  assertReview(state);
  const start: FlowNode = {
    id: newId(),
    kind: "start",
    label: "Start",
    config: {},
    position: { x: 0, y: 0 },
  };
  const nodes = [start, ...recordedNodes(state, start.position, newId)];
  nodes.push({
    id: newId(),
    kind: "end",
    label: "Finish",
    config: { outputs: {} },
    position: { x: nodes.length * 310, y: 0 },
  });
  if (nodes.length > 2000)
    throw new Error(
      "The recording exceeds the workflow node limit. Remove steps before inserting.",
    );
  return {
    schemaVersion: 2,
    id: newId(),
    name:
      name?.trim() || `${state.destination!.flowName} recording`.slice(0, 160),
    description: "Created from reviewed recording steps.",
    folder: "Recordings",
    revision: 1,
    nodes,
    edges: links(nodes, newId),
    inputs: {},
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function applyRecording(
  flow: FlowDefinition,
  state: RecordingState,
  newId: () => string = () => crypto.randomUUID(),
  chosenAnchor?: RecordingInsertionAnchor,
): FlowDefinition {
  assertReview(state);
  const destination = state.destination!;
  if (
    flow.id !== destination.flowId ||
    flow.revision !== destination.flowRevision
  )
    throw new Error(
      "The destination workflow changed. Your recording is preserved; create a new workflow instead.",
    );
  const requestedAnchor =
    chosenAnchor ?? recordingDestinationAnchor(flow, state);
  if (!requestedAnchor)
    throw new Error(
      "Select an insertion point before inserting into this workflow. Your recording is preserved; a legacy anchor must still be a free next port.",
    );
  const point = resolveRecordingAnchor(flow, requestedAnchor);
  const anchor = flow.nodes.find(
    (node) => node.id === point.anchor.sourceNodeId,
  )!;
  const additions = recordedNodes(state, anchor.position, newId);
  // Occupied outputs keep their successor. Empty outputs need a Finish.
  if (!point.anchor.successorNodeId)
    additions.push({
      id: newId(),
      kind: "end",
      label: "Finish",
      config: { outputs: {} },
      position: {
        x: anchor.position.x + (additions.length + 1) * 310,
        y: anchor.position.y,
      },
    });
  // Preserve the original layout while placing added cards in available space.
  const occupied = [...flow.nodes];
  for (const node of additions) {
    while (
      occupied.some(
        (other) =>
          Math.abs(other.position.x - node.position.x) < 280 &&
          Math.abs(other.position.y - node.position.y) < 190,
      )
    )
      node.position.y += 220;
    occupied.push(node);
  }
  const firstEdge = {
    id: point.anchor.edgeId ?? newId(),
    source: anchor.id,
    target: additions[0].id,
    port: point.anchor.port,
  };
  const insertionEdges = [firstEdge, ...links(additions, newId)];
  if (point.anchor.successorNodeId)
    insertionEdges.push({
      id: newId(),
      source: additions.at(-1)!.id,
      target: point.anchor.successorNodeId,
      port: "next",
    });
  const untouchedEdges = flow.edges.filter(
    (edge) => edge.id !== point.anchor.edgeId,
  );
  if (
    flow.nodes.length + additions.length > 2000 ||
    untouchedEdges.length + insertionEdges.length > 4000
  )
    throw new Error(
      "The recording exceeds the workflow size limit. Remove steps or create a new workflow.",
    );
  return {
    ...flow,
    nodes: [...flow.nodes, ...additions],
    edges: [...untouchedEdges, ...insertionEdges],
  };
}
