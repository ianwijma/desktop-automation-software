import type {
  AIConnection,
  AppEvent,
  AppSettings,
  FlowDefinition,
  Schedule,
  TargetDescriptor,
} from "../shared/types";
export interface RunnerWorkspace {
  generation: number;
  flows: FlowDefinition[];
  targets: TargetDescriptor[];
  connections: AIConnection[];
  schedules: Schedule[];
  settings: AppSettings;
  keys: Record<string, string>;
}
export interface RunnerInit {
  dataDir: string;
  binaryPath: string;
  workspace: RunnerWorkspace;
}
export type RunnerMessage = { id: string; method: string; args: unknown[] };
export type RunnerResponse =
  | { id: string; result?: unknown; error?: string }
  | { event: AppEvent }
  | {
      scheduleUpdates: Pick<
        Schedule,
        "id" | "enabled" | "lastRunAt" | "nextRunAt"
      >[];
      generation: number;
    };
