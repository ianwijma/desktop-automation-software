import { useEffect, useState } from "react";
import { Braces, Plus, X } from "lucide-react";
import type { Json } from "../shared/types";
import {
  addSchemaProperty,
  canEditSchemaProperties,
  changeSchemaType,
  primitiveType,
  removeSchemaProperty,
  renameSchemaProperty,
  schemaEditorType,
  schemaObject,
  schemaTypes,
  setSchemaDescription,
  setSchemaEnum,
  setSchemaItems,
  setSchemaRequired,
  updateSchemaProperty,
  type SchemaPrimitive,
  type SchemaType,
} from "../shared/schema-authoring";
import { Button, Field, IconButton, JsonField, Select } from "./components";
import "./schema-field.css";

export interface SchemaFieldProps {
  label: string;
  value: Json | undefined;
  onChange: (value: Json | undefined) => void;
}

export function SchemaField(props: SchemaFieldProps) {
  return <SchemaNode {...props} depth={0} schemaDocument={props.value} />;
}

function SchemaNode({
  label,
  value,
  onChange,
  depth,
  displayName,
  schemaDocument,
}: SchemaFieldProps & {
  depth: number;
  displayName?: string;
  schemaDocument: Json | undefined;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const schema = schemaObject(value);
  const type = schemaEditorType(value);
  const custom = value !== undefined && !type;
  const properties = schemaObject(schema?.properties);
  const tooLarge = Object.keys(properties ?? {}).length > 50 || depth >= 5;
  const edit = (operation: () => Json | undefined) => {
    try {
      onChange(operation());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div
      className={`schema-field ${depth ? "schema-nested" : ""}`}
      data-schema-field={label}
    >
      <div className="schema-heading">
        <span className="field-label">{displayName ?? label}</span>
        <button
          type="button"
          className="schema-link"
          aria-label={`Edit ${label} ${advanced ? "fields" : "as JSON"}`}
          onClick={() => setAdvanced(!advanced)}
        >
          <Braces size={12} /> {advanced ? "Fields" : "JSON"}
        </button>
      </div>
      <div className="schema-type-row">
        <Select
          aria-label={`Schema type for ${label}`}
          value={type ?? (custom ? "custom" : "")}
          onChange={(event) =>
            edit(() =>
              changeSchemaType(value, event.target.value as SchemaType),
            )
          }
        >
          {!type ? (
            <option value={custom ? "custom" : ""} disabled>
              {custom ? "Custom schema" : "Choose a type…"}
            </option>
          ) : null}
          {schemaTypes.map((kind) => (
            <option key={kind} value={kind}>
              {kind[0].toUpperCase() + kind.slice(1)}
            </option>
          ))}
        </Select>
        {!depth && value !== undefined ? (
          <button
            type="button"
            className="schema-link"
            aria-label={`Clear ${label}`}
            onClick={() => onChange(undefined)}
          >
            Clear
          </button>
        ) : null}
      </div>
      {schema ? (
        <Field label="Description">
          <input
            aria-label={`${label} description`}
            value={
              typeof schema.description === "string" ? schema.description : ""
            }
            placeholder="Describe the expected value"
            onChange={(event) =>
              edit(() => setSchemaDescription(value, event.target.value))
            }
          />
        </Field>
      ) : null}
      {custom ? (
        <span className="field-help">
          This custom schema is preserved. Use JSON for references, unions, or
          other schema forms. Choosing a type explicitly replaces its active
          constraints.
        </span>
      ) : null}
      {advanced || custom || tooLarge ? (
        <JsonField
          label={`JSON for ${label}`}
          value={value}
          onChange={onChange}
          help="JSON edits apply when you leave this field. Schema keywords are preserved until you change them."
        />
      ) : type === "object" ? (
        <>
          {canEditSchemaProperties(value) ? (
            <>
              {Object.entries(properties ?? {}).map(([name, child]) => (
                <PropertyEditor
                  key={name}
                  name={name}
                  label={`${label}.${name}`}
                  value={child}
                  required={
                    Array.isArray(schema?.required) &&
                    schema.required.includes(name)
                  }
                  depth={depth + 1}
                  schemaDocument={schemaDocument}
                  onRename={(next) => {
                    const result = renameSchemaProperty(
                      value,
                      name,
                      next,
                      schemaDocument,
                    );
                    onChange(result);
                  }}
                  onRequired={(required) =>
                    edit(() => setSchemaRequired(value, name, required))
                  }
                  onRemove={() =>
                    edit(() =>
                      removeSchemaProperty(value, name, schemaDocument),
                    )
                  }
                  onChange={(next) =>
                    edit(() =>
                      next === undefined
                        ? removeSchemaProperty(value, name, schemaDocument)
                        : updateSchemaProperty(value, name, next),
                    )
                  }
                />
              ))}
              {!Object.keys(properties ?? {}).length ? (
                <span className="field-help">No properties yet.</span>
              ) : null}
              <form
                className="schema-add-property"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    onChange(addSchemaProperty(value, newName));
                    setNewName("");
                    setError("");
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    );
                  }
                }}
              >
                <input
                  aria-label={`New property for ${label}`}
                  placeholder="Property name"
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    setError("");
                  }}
                />
                <IconButton type="submit" label={`Add property to ${label}`}>
                  <Plus size={14} />
                </IconButton>
              </form>
            </>
          ) : (
            <span className="field-help">
              This imported property map or required list needs the JSON editor.
            </span>
          )}
        </>
      ) : type === "array" ? (
        <SchemaNode
          label={`${label}[]`}
          displayName="Array items"
          value={schema?.items}
          depth={depth + 1}
          schemaDocument={schemaDocument}
          onChange={(next) =>
            edit(() => setSchemaItems(value, next === undefined ? {} : next))
          }
        />
      ) : type ? (
        <EnumEditor
          label={label}
          value={value}
          type={type}
          onChange={onChange}
        />
      ) : (
        <span className="field-help">
          Choose a type to build the expected output.
        </span>
      )}
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function PropertyEditor({
  name,
  label,
  value,
  required,
  depth,
  onRename,
  onRequired,
  onRemove,
  onChange,
  schemaDocument,
}: {
  name: string;
  label: string;
  value: Json;
  required: boolean;
  depth: number;
  onRename: (name: string) => void;
  onRequired: (required: boolean) => void;
  onRemove: () => void;
  onChange: (value: Json | undefined) => void;
  schemaDocument: Json | undefined;
}) {
  const [draftName, setDraftName] = useState(name);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraftName(name);
    setError("");
  }, [name]);
  const rename = () => {
    if (draftName === name) return;
    try {
      onRename(draftName);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="schema-property">
      <div className="schema-property-name">
        <input
          aria-label={`Property name for ${label}`}
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
            setError("");
          }}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              rename();
            }
          }}
        />
        <IconButton label={`Remove property ${label}`} onClick={onRemove}>
          <X size={13} />
        </IconButton>
      </div>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
      <label className="schema-required">
        <input
          type="checkbox"
          aria-label={`Required ${label}`}
          checked={required}
          onChange={(event) => onRequired(event.target.checked)}
        />{" "}
        Required
      </label>
      <SchemaNode
        label={label}
        displayName="Value schema"
        value={value}
        onChange={onChange}
        depth={depth}
        schemaDocument={schemaDocument}
      />
    </div>
  );
}

function nextEnumValue(
  type: SchemaType,
  entries: SchemaPrimitive[],
): SchemaPrimitive {
  if (type === "null") return null;
  if (type === "boolean") return entries.includes(false) ? true : false;
  if (type === "number" || type === "integer") {
    let number = 0;
    while (entries.includes(number)) number++;
    return number;
  }
  let value = "",
    index = 1;
  while (entries.includes(value)) value = `value ${index++}`;
  return value;
}
function EnumEditor({
  label,
  value,
  type,
  onChange,
}: SchemaFieldProps & { type: SchemaType }) {
  const [error, setError] = useState("");
  const schema = schemaObject(value)!;
  const raw = schema.enum;
  if (
    raw !== undefined &&
    (!Array.isArray(raw) || !raw.every((item) => primitiveType(item)))
  )
    return (
      <span className="field-help">
        This imported enum contains complex values. Edit it as JSON; other edits
        preserve it.
      </span>
    );
  const entries = (raw ?? []) as SchemaPrimitive[];
  const enabled = raw !== undefined;
  const update = (values: SchemaPrimitive[] | undefined) => {
    try {
      onChange(setSchemaEnum(value, values));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const full =
    (type === "null" && entries.includes(null)) ||
    (type === "boolean" && entries.includes(true) && entries.includes(false));
  return (
    <div className="schema-enum">
      <label className="schema-required">
        <input
          type="checkbox"
          aria-label={`Limit ${label} to allowed values`}
          checked={enabled}
          onChange={(event) =>
            update(event.target.checked ? [nextEnumValue(type, [])] : undefined)
          }
        />{" "}
        Allowed values only
      </label>
      {enabled ? (
        <>
          {entries.map((entry, index) => (
            <div className="schema-enum-row" key={index}>
              <EnumValue
                label={`Allowed value ${index + 1} for ${label}`}
                value={entry}
                integer={type === "integer"}
                onChange={(next) =>
                  update(
                    entries.map((previous, i) =>
                      i === index ? next : previous,
                    ),
                  )
                }
              />
              <IconButton
                label={`Remove allowed value ${index + 1} for ${label}`}
                onClick={() => update(entries.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <Button
            type="button"
            className="schema-add-enum"
            disabled={full}
            aria-label={`Add allowed value to ${label}`}
            onClick={() => update([...entries, nextEnumValue(type, entries)])}
          >
            <Plus size={12} /> Add value
          </Button>
        </>
      ) : null}
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function EnumValue({
  label,
  value,
  integer,
  onChange,
}: {
  label: string;
  value: SchemaPrimitive;
  integer: boolean;
  onChange: (value: SchemaPrimitive) => void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => {
    setText(String(value));
    setError("");
  }, [value]);
  if (value === null)
    return (
      <span className="schema-null" aria-label={label}>
        null
      </span>
    );
  if (typeof value === "boolean")
    return (
      <Select
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(event.target.value === "true")}
      >
        <option value="false">False</option>
        <option value="true">True</option>
      </Select>
    );
  if (typeof value === "string")
    return (
      <input
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onChange(text)}
      />
    );
  return (
    <div className="schema-enum-number">
      <input
        aria-label={label}
        inputMode="decimal"
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setText(event.target.value);
          setError("");
        }}
        onBlur={() => {
          const number = Number(text);
          if (
            !text.trim() ||
            !Number.isFinite(number) ||
            (integer && !Number.isInteger(number))
          )
            setError(
              `Enter ${integer ? "an integer" : "a number"}. This edit has not been applied.`,
            );
          else {
            onChange(number);
            setError("");
          }
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
