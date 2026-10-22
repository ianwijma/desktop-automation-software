import type { FlowSaveResult } from "../shared/types";

/** Once SQLite commits, failure to notify the runner must not turn that save into a failed write. */
export async function syncSavedFlow(
  result: FlowSaveResult,
  synchronize: () => Promise<void>,
): Promise<FlowSaveResult> {
  if (result.status !== "saved") return result;
  try {
    await synchronize();
    return result;
  } catch {
    return {
      ...result,
      warning:
        "Flow saved, but the automation service could not refresh. Restart Relay before running it.",
    };
  }
}
