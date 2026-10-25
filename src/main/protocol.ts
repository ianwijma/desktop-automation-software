import type {
  AIConnection,
  AppEvent,
  AppSettings,
  FlowDefinition,
  Schedule,
  TargetDescriptor,
  RecordingState,
  RecordingInsertOptions,
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
  recording: RecordingState;
}
export type RunnerMessage = { id: string; method: string; args: unknown[] };
export type RunnerResponse =
  | {
      recordingRequest: {
        id: string;
        operation: "save" | "insert";
        state: RecordingState;
        options?: RecordingInsertOptions;
      };
    }
  | { id: string; result?: unknown; error?: string }
  | { event: AppEvent }
  | {
      scheduleUpdates: Pick<
        Schedule,
        "id" | "enabled" | "lastRunAt" | "nextRunAt"
      >[];
      generation: number;
    };
