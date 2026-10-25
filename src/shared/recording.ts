import type { FlowDefinition, FlowNode, RecordingState } from "./types";
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
  const anchorId = recordingAnchor(flow, destination.anchorNodeId);
  if (!anchorId)
    throw new Error(
      "The selected insertion point is no longer a free next port. Your recording is preserved; create a new workflow instead.",
    );
  const anchor = flow.nodes.find((node) => node.id === anchorId)!;
  const additions = recordedNodes(state, anchor.position, newId);
  // A free tail has no successor. Give the recorded sequence its own Finish node.
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
  if (
    flow.nodes.length + additions.length > 2000 ||
    flow.edges.length + additions.length > 4000
  )
    throw new Error(
      "The recording exceeds the workflow size limit. Remove steps or create a new workflow.",
    );
  return {
    ...flow,
    nodes: [...flow.nodes, ...additions],
    edges: [...flow.edges, ...links([anchor, ...additions], newId)],
  };
}
