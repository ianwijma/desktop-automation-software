import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Braces, Link2, Plus, Search, X } from "lucide-react";
import type { Json } from "../shared/types";
import {
  type createReferenceInspector,
  type ReferenceOption,
} from "../shared/value-references";
import { Button, IconButton, JsonField, Modal, Select } from "./components";

type LiteralType =
  "string" | "number" | "boolean" | "object" | "array" | "null";
const literalTypes: LiteralType[] = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
];
const defaultValue = (type: LiteralType): Json => {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    case "null":
      return null;
    default:
      return "";
  }
};
function valueType(
  value: Json | undefined,
  fallback: LiteralType,
): LiteralType {
  if (value === undefined) return fallback;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<LiteralType, "array" | "null">;
}
const hasReference = (value: Json | undefined): value is string =>
  typeof value === "string" && value.includes("${");

export interface ValueFieldProps {
  label: string;
  value: Json | undefined;
  onChange: (value: Json | undefined) => void;
  references: ReturnType<typeof createReferenceInspector>;
  consumerNodeId?: string;
  help?: string;
  placeholder?: string;
  literalType?: LiteralType;
  allowTypeChange?: boolean;
  /** Flow input defaults are literal data, even when a string looks like a reference. */
  allowReference?: boolean;
  /** Keep a record root literal while allowing references in its properties. */
  allowWholeReference?: boolean;
  multiline?: boolean;
  loopInputs?: boolean;
  depth?: number;
}

/** A reference is stored as its original string. Literal JSON never passes through String(). */
export function ValueField({
  label,
  value,
  onChange,
  references,
  consumerNodeId,
  help,
  placeholder,
  literalType = "string",
  allowTypeChange = false,
  allowReference = true,
  allowWholeReference = true,
  multiline = false,
  loopInputs = false,
  depth = 0,
}: ValueFieldProps) {
  const id = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [newProperty, setNewProperty] = useState("");
  const [propertyError, setPropertyError] = useState("");
  const sourceButton = useRef<HTMLButtonElement>(null);
  const canReference = allowReference && allowWholeReference;
  const expression = canReference && hasReference(value);
  const lastLiteral = useRef<Json | undefined>(expression ? undefined : value);
  useEffect(() => {
    if (!expression) lastLiteral.current = value;
  }, [value, expression]);
  const options = useMemo(
    () =>
      canReference
        ? references.referenceOptions(consumerNodeId, { loopInputs })
        : [],
    [references, consumerNodeId, loopInputs, canReference],
  );
  const description = canReference
    ? references.describeReference(value, consumerNodeId, {
        loopInputs,
      })
    : null;
  const warnings = useMemo(() => {
    if (!canReference || !hasReference(value)) return [];
    return Array.from(
      new Set(
        (value.match(/\$\{[^{}]+\}/g) ?? [])
          .map(
            (reference) =>
              references.describeReference(reference, consumerNodeId, {
                loopInputs,
              })?.warning,
          )
          .filter((warning): warning is string => Boolean(warning)),
      ),
    );
  }, [value, references, consumerNodeId, loopInputs, canReference]);
  const type =
    !allowTypeChange && literalType === "number"
      ? "number"
      : valueType(value, literalType);
  const structured = !expression && (type === "object" || type === "array");
  const tooLarge =
    structured &&
    value != null &&
    typeof value === "object" &&
    Object.keys(value).length > 50;
  const childProps = {
    references,
    consumerNodeId,
    loopInputs,
    allowTypeChange: true,
    allowReference,
    depth: depth + 1,
  };
  const updateObject = (key: string, next: Json | undefined) => {
    const updated = {
      ...(value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {}),
    };
    if (next === undefined) delete updated[key];
    else
      Object.defineProperty(updated, key, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    onChange(updated);
  };
  return (
    <div
      className={`value-field ${depth ? "nested-value" : ""}`}
      data-value-field={label}
    >
      <div className="value-field-heading">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {canReference ? (
          <button
            ref={sourceButton}
            type="button"
            className="value-source-button"
            aria-label={`Use value from for ${label}`}
            onClick={() => setPickerOpen(true)}
          >
            <Link2 size={12} /> Use value from…
          </button>
        ) : null}
      </div>
      {expression ? (
        <>
          {description ? (
            <div className="reference-summary">
              <Link2 size={12} />
              <span>{description.label}</span>
              <span className="reference-type">{description.type}</span>
            </div>
          ) : null}
          {multiline || (typeof value === "string" && value.includes("\n")) ? (
            <textarea
              id={id}
              value={value}
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              id={id}
              value={value}
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          <button
            type="button"
            className="value-literal-button"
            aria-label={`Use literal for ${label}`}
            onClick={() =>
              onChange(
                lastLiteral.current === undefined
                  ? defaultValue(literalType)
                  : lastLiteral.current,
              )
            }
          >
            Use literal value
          </button>
          {allowTypeChange ? (
            <button
              type="button"
              className="value-literal-button"
              aria-label={`Clear value for ${label}`}
              onClick={() => onChange(undefined)}
            >
              Clear value
            </button>
          ) : null}
        </>
      ) : (
        <>
          {allowTypeChange ? (
            <div className="value-type-row">
              <Select
                aria-label={`Value type for ${label}`}
                value={type}
                onChange={(e) => {
                  setAdvanced(false);
                  onChange(defaultValue(e.target.value as LiteralType));
                }}
              >
                {literalTypes.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === "string"
                      ? "Text"
                      : kind[0].toUpperCase() + kind.slice(1)}
                  </option>
                ))}
              </Select>
              {value !== undefined ? (
                <button
                  type="button"
                  className="value-literal-button"
                  aria-label={`Clear value for ${label}`}
                  onClick={() => onChange(undefined)}
                >
                  Clear
                </button>
              ) : (
                <span className="field-help">Not set</span>
              )}
            </div>
          ) : null}
          {structured ? (
            <div className="structured-value" role="group" aria-label={label}>
              {depth >= 4 || tooLarge || advanced ? (
                <JsonField
                  label={`JSON for ${label}`}
                  value={value}
                  onChange={onChange}
                  help={
                    depth >= 4 || tooLarge
                      ? "Edit this larger value as JSON. References inside it stay as strings."
                      : undefined
                  }
                />
              ) : type === "array" ? (
                <>
                  {(Array.isArray(value) ? value : []).map(
                    (item, index, items) => (
                      <div className="structured-entry" key={index}>
                        <ValueField
                          {...childProps}
                          label={`${label}[${index}]`}
                          value={item}
                          onChange={(next) =>
                            onChange(
                              next === undefined
                                ? items.filter((_, i) => i !== index)
                                : items.map((existing, i) =>
                                    i === index ? next : existing,
                                  ),
                            )
                          }
                        />
                        <IconButton
                          label={`Remove ${label}[${index}]`}
                          onClick={() =>
                            onChange(items.filter((_, i) => i !== index))
                          }
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    ),
                  )}
                  {!Array.isArray(value) || !value.length ? (
                    <span className="field-help">Empty array</span>
                  ) : null}
                  <Button
                    className="structured-add"
                    aria-label={`Add item to ${label}`}
                    onClick={() =>
                      onChange([...(Array.isArray(value) ? value : []), ""])
                    }
                  >
                    <Plus size={12} /> Add item
                  </Button>
                </>
              ) : (
                <>
                  {Object.entries(
                    value && typeof value === "object" ? value : {},
                  ).map(([key, item]) => (
                    <div className="structured-entry" key={key}>
                      <ValueField
                        {...childProps}
                        label={`${label}.${key}`}
                        value={item}
                        onChange={(next) => updateObject(key, next)}
                      />
                      <IconButton
                        label={`Remove ${label}.${key}`}
                        onClick={() => updateObject(key, undefined)}
                      >
                        <X size={12} />
                      </IconButton>
                    </div>
                  ))}
                  <form
                    className="structured-new-property"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!newProperty.trim()) {
                        setPropertyError("Enter a property name.");
                        return;
                      }
                      if (
                        ["__proto__", "prototype", "constructor"].includes(
                          newProperty,
                        )
                      ) {
                        setPropertyError(
                          "That property name is reserved. Choose another name.",
                        );
                        return;
                      }
                      if (
                        value &&
                        typeof value === "object" &&
                        Object.hasOwn(value, newProperty)
                      ) {
                        setPropertyError("That property already exists.");
                        return;
                      }
                      updateObject(newProperty, "");
                      setNewProperty("");
                      setPropertyError("");
                    }}
                  >
                    <input
                      aria-label={`New property for ${label}`}
                      placeholder="Property name"
                      value={newProperty}
                      onChange={(e) => {
                        setNewProperty(e.target.value);
                        setPropertyError("");
                      }}
                    />
                    <IconButton
                      label={`Add property to ${label}`}
                      type="submit"
                    >
                      <Plus size={14} />
                    </IconButton>
                  </form>
                  {propertyError ? (
                    <span className="field-error" role="alert">
                      {propertyError}
                    </span>
                  ) : null}
                </>
              )}
              {depth < 4 && !tooLarge ? (
                <button
                  type="button"
                  className="value-literal-button"
                  aria-label={`Edit ${label} ${advanced ? "fields" : "as JSON"}`}
                  onClick={() => setAdvanced(!advanced)}
                >
                  <Braces size={12} />{" "}
                  {advanced ? "Edit fields" : "Edit as JSON"}
                </button>
              ) : null}
            </div>
          ) : type === "boolean" ? (
            <div className="value-boolean">
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(e) => onChange(e.target.checked)}
              />
              <span>{value === true ? "True" : "False"}</span>
            </div>
          ) : type === "null" ? (
            <div id={id} className="value-null" role="note">
              null <span>No value</span>
            </div>
          ) : type === "number" ? (
            <NumberValue
              id={id}
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              allowReference={canReference}
            />
          ) : multiline && type === "string" ? (
            <textarea
              id={id}
              value={typeof value === "string" ? value : ""}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              id={id}
              value={typeof value === "string" ? value : ""}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </>
      )}
      {help ? <span className="field-help">{help}</span> : null}
      {warnings.map((warning) => (
        <span
          className="reference-warning"
          role="status"
          data-reference-warning
          key={warning}
        >
          {warning}
        </span>
      ))}
      <ReferencePicker
        open={pickerOpen}
        options={options}
        returnFocusRef={sourceButton}
        onClose={() => setPickerOpen(false)}
        onSelect={(option) => {
          onChange(option.reference);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

function NumberValue({
  id,
  value,
  onChange,
  placeholder,
  allowReference,
}: {
  id: string;
  value: Json | undefined;
  onChange: (value: Json | undefined) => void;
  placeholder?: string;
  allowReference: boolean;
}) {
  const serialized =
    typeof value === "number" || typeof value === "string" ? String(value) : "";
  const [text, setText] = useState(serialized);
  const [error, setError] = useState("");
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  return (
    <>
      <input
        id={id}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setError("");
          if (allowReference && next.includes("${")) onChange(next);
          else if (next.trim() !== "" && Number.isFinite(Number(next)))
            onChange(Number(next));
        }}
        onBlur={() => {
          if (!text.trim()) onChange(undefined);
          else if (
            !Number.isFinite(Number(text)) &&
            !(allowReference && text.includes("${"))
          )
            setError("Enter a number. This edit has not been applied.");
        }}
      />
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function ReferencePicker({
  open,
  options,
  onClose,
  onSelect,
  returnFocusRef,
}: {
  open: boolean;
  options: ReferenceOption[];
  onClose: () => void;
  onSelect: (option: ReferenceOption) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  if (!open) return null;
  const filtered = options.filter((option) =>
    `${option.label} ${option.reference} ${option.group} ${option.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visible = filtered.slice(0, 100);
  return (
    <Modal
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Use value from…"
      description="Choose a value available to this node. References keep working when you rename a node."
    >
      <div className="reference-search">
        <Search size={16} />
        <input
          aria-label="Search values"
          autoFocus
          placeholder="Search inputs, variables, and outputs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              results.current
                ?.querySelector<HTMLButtonElement>("button")
                ?.focus();
            }
          }}
        />
      </div>
      <div
        className="reference-results"
        ref={results}
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          const buttons = Array.from(
            results.current?.querySelectorAll<HTMLButtonElement>("button") ??
              [],
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (current < 0 || !buttons.length) return;
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : Math.min(
                    buttons.length - 1,
                    Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)),
                  );
          buttons[next]?.focus();
        }}
      >
        {Array.from(new Set(visible.map((option) => option.group))).map(
          (group) => (
            <section key={group}>
              <h4>{group}</h4>
              {visible
                .filter((option) => option.group === group)
                .map((option) => (
                  <button
                    type="button"
                    className="reference-option"
                    key={`${option.group}-${option.reference}`}
                    data-reference={option.reference}
                    aria-label={`Use ${option.label}`}
                    onClick={() => onSelect(option)}
                  >
                    <span className="reference-option-title">
                      <strong>{option.label}</strong>
                      <span className="reference-type">{option.type}</span>
                    </span>
                    <code>{option.reference}</code>
                    {option.description ? (
                      <small>{option.description}</small>
                    ) : null}
                    {option.warning ? (
                      <span className="reference-warning">
                        {option.warning}
                      </span>
                    ) : null}
                  </button>
                ))}
            </section>
          ),
        )}
        {!filtered.length ? (
          <p className="reference-empty">
            {query
              ? "No values match your search."
              : "No values are available yet. Add flow inputs or connect a node before this one."}
          </p>
        ) : null}
      </div>
      {filtered.length > visible.length ? (
        <p className="field-help">
          Showing {visible.length} of {filtered.length} values. Search to narrow
          results.
        </p>
      ) : null}
      <p className="field-help">
        Use Tab or ↑ / ↓ to choose a value, then Enter. Escape closes the
        picker.
      </p>
    </Modal>
  );
}
