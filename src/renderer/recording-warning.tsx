import type { Json } from "../shared/types";
import { Button, Notice } from "./components";

export function RecordingWarning({
  config,
  onChange,
}: {
  config: Record<string, Json>;
  onChange(config: Record<string, Json>): void;
}) {
  if (config.requiresConfiguration !== true) return null;
  return (
    <Notice kind="error">
      <strong>Configure before running</strong>
      <p>
        {typeof config.recordingWarning === "string"
          ? config.recordingWarning
          : "This interaction needs manual configuration or a replacement step."}
      </p>
      <Button
        disabled={
          config.secret === true &&
          (typeof config.text !== "string" || !config.text)
        }
        onClick={() => onChange({ ...config, requiresConfiguration: false })}
      >
        Mark as configured
      </Button>
      <p className="field-help">
        Configure the action first, or delete it and add a supported
        replacement. This confirmation does not run the action.
      </p>
    </Notice>
  );
}
