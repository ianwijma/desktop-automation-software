import type { RecordingInsertionPoint } from "../shared/recording";
import { Field, Select } from "./components";

export function RecordingPointSelect({
  points,
  value,
  disabled,
  onChange,
}: {
  points: RecordingInsertionPoint[];
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <Field label="Insertion point">
      <Select
        aria-label="Insertion point"
        value={points.some((point) => point.key === value) ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose an edge or output…</option>
        {points.map((point) => (
          <option key={point.key} value={point.key}>
            {point.label}
          </option>
        ))}
      </Select>
      <p className="field-help">
        {points.length
          ? "Choose the exact branch. Connected outputs keep their existing successor after the recorded steps."
          : "No reachable output is available in this workflow. You can insert into a new workflow instead."}
      </p>
    </Field>
  );
}
