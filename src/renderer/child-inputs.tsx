import type { FlowDefinition, Json } from "../shared/types";
import type { ReferenceInspector } from "../shared/value-references";
import { ValueField } from "./value-field";

export function isRecord(
  value: Json | undefined,
): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultSummary(value: Json) {
  const text = JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

/** Defaults are a read-only contract until the author explicitly creates an override. */
export function ChildInputs({
  label,
  value,
  child,
  references,
  consumerNodeId,
  loopInputs = false,
  onChange,
}: {
  label: string;
  value: Json | undefined;
  child?: FlowDefinition;
  references: ReferenceInspector;
  consumerNodeId: string;
  loopInputs?: boolean;
  onChange: (value: Json | undefined) => void;
}) {
  const editable = value === undefined || isRecord(value);
  const overrides = isRecord(value) ? value : {};
  const defaults = child ? Object.entries(child.inputs) : [];
  return (
    <div className="child-input-mapping">
      {child ? (
        <div className="declared-inputs">
          <h5>Inputs declared by {child.name}</h5>
          {!defaults.length ? (
            <p className="field-help">
              This flow has no declared input defaults. You can add custom
              inputs below.
            </p>
          ) : null}
          {defaults.map(([key, defaultValue]) => {
            const overridden = Object.hasOwn(overrides, key);
            const suppliedByLoop =
              loopInputs && (key === "item" || key === "index");
            const containsReferences = /\$\{[^{}]+\}/.test(
              JSON.stringify(defaultValue),
            );
            const reserved = ["__proto__", "prototype", "constructor"].includes(
              key,
            );
            return (
              <div className="declared-input" key={key}>
                <div>
                  <strong>{key}</strong>
                  <span className="field-help">
                    {suppliedByLoop
                      ? "Supplied by loop"
                      : !editable
                        ? "From input object or default"
                        : overridden
                          ? "Overridden below"
                          : "Uses child default"}
                  </span>
                </div>
                <code title={JSON.stringify(defaultValue)}>
                  Default: {defaultSummary(defaultValue)}
                </code>
                <button
                  type="button"
                  className="value-source-button"
                  disabled={!editable || reserved || suppliedByLoop}
                  aria-label={`${overridden ? "Use default for" : "Override"} ${label}.${key}`}
                  onClick={() => {
                    const next = { ...overrides };
                    if (overridden) delete next[key];
                    else
                      Object.defineProperty(next, key, {
                        value: structuredClone(defaultValue),
                        enumerable: true,
                        configurable: true,
                        writable: true,
                      });
                    onChange(next);
                  }}
                >
                  {suppliedByLoop
                    ? "Managed by loop"
                    : overridden
                      ? "Use default"
                      : "Override input"}
                </button>
                {suppliedByLoop ? (
                  <p className="field-help">
                    The loop supplies this value for each child run.{" "}
                    {overridden
                      ? "The existing override is preserved but ignored when running."
                      : "This child default is not used by the loop."}
                  </p>
                ) : null}
                {containsReferences && !suppliedByLoop ? (
                  <p className="field-help">
                    This default contains reference syntax. An override
                    evaluates that syntax; leave the default in place to keep it
                    literal.
                  </p>
                ) : null}
                {reserved ? (
                  <p className="field-error">
                    This imported input name is reserved. Rename it in the child
                    flow before overriding it.
                  </p>
                ) : null}
              </div>
            );
          })}
          {!editable && defaults.length ? (
            <p className="field-help">
              This mapping must resolve to the whole input object. Switch to a
              literal object to override individual defaults.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="field-help">
          Choose an available child flow to see its declared inputs. Existing
          mappings are kept.
        </p>
      )}
      <ValueField
        label={label}
        value={value}
        references={references}
        consumerNodeId={consumerNodeId}
        literalType="object"
        allowTypeChange
        loopInputs={loopInputs}
        onChange={onChange}
        help="Only overrides are saved here. Remove a property to use the child default. A reference can supply the whole input object."
      />
      {loopInputs ? (
        <p className="field-help">
          The loop always supplies <code>item</code> and <code>index</code>.
          Mapping those names is ignored; use another input name for your own
          values.
        </p>
      ) : null}
    </div>
  );
}
