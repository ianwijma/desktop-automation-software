import { useEffect, useRef, useState } from "react";
import type {
  BrowserLocator,
  BrowserLocatorInspection,
  BrowserSelector,
  Json,
  NodeKind,
  WorkspaceState,
} from "../shared/types";
import type { ReferenceInspector } from "../shared/value-references";
import { ValueField } from "./value-field";
import { browserLocatorSchema } from "../shared/browser-locators";
import { Button, Field, Notice, Select } from "./components";

export function supportsBrowserLocator(
  kind: NodeKind,
  config: Record<string, Json>,
  workspace: WorkspaceState,
) {
  return (
    workspace.targets.some(
      (target) => target.id === config.targetId && target.kind === "browser",
    ) &&
    ([
      "click",
      "move",
      "drag",
      "scroll",
      "type",
      "key",
      "read",
      "select",
    ].includes(kind) ||
      (["detect", "wait"].includes(kind) &&
        (config.detector ?? config.method) === "element"))
  );
}

export function BrowserLocatorField({
  kind,
  config,
  workspace,
  onChange,
  inspect,
  references,
  consumerNodeId,
  allowReference = true,
}: {
  kind: NodeKind;
  config: Record<string, Json>;
  workspace: WorkspaceState;
  onChange(config: Record<string, Json>): void;
  references?: ReferenceInspector;
  consumerNodeId?: string;
  allowReference?: boolean;
  inspect?: (
    targetId: string,
    query: BrowserLocator | string,
  ) => Promise<BrowserLocatorInspection>;
}) {
  const optional = !["read", "select", "detect", "wait"].includes(kind);
  const mode =
    config.locator !== undefined
      ? "locator"
      : config.selector !== undefined || !optional
        ? "css"
        : "none";
  const parsed = browserLocatorSchema.safeParse(config.locator);
  const locator = (config.locator &&
  typeof config.locator === "object" &&
  !Array.isArray(config.locator) &&
  "selector" in config.locator
    ? config.locator
    : {
        version: 1,
        selector: { kind: "testId", attribute: "data-testid", value: "" },
      }) as unknown as BrowserLocator;
  const editable = editableLocator(locator);
  const [result, setResult] = useState<BrowserLocatorInspection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const fingerprint = JSON.stringify([
    config.targetId,
    config.selector,
    config.locator,
  ]);
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  useEffect(() => {
    epoch.current++;
    setResult(null);
    setError("");
    setBusy(false);
  }, [fingerprint]);
  const replace = (next: BrowserLocator) => {
    const updated: Record<string, Json> = {
      ...config,
      locator: next as unknown as Json,
    };
    delete updated.selector;
    delete updated.detection;
    delete updated.frameId;
    onChange(updated);
  };
  const setMode = (next: string) => {
    const updated = { ...config };
    delete updated.selector;
    delete updated.locator;
    if (next !== "none") {
      delete updated.detection;
      delete updated.frameId;
    }
    if (next === "css") updated.selector = "";
    if (next === "locator")
      updated.locator = {
        version: 1,
        selector: { kind: "testId", attribute: "data-testid", value: "" },
      };
    onChange(updated);
  };
  const query =
    mode === "locator" && parsed.success
      ? parsed.data
      : mode === "css" &&
          typeof config.selector === "string" &&
          config.selector.trim()
        ? config.selector
        : undefined;
  const hasReferences =
    query !== undefined && JSON.stringify(query).includes("${");
  const test = async () => {
    if (
      !inspect ||
      !query ||
      hasReferences ||
      typeof config.targetId !== "string"
    )
      return;
    const request = ++epoch.current,
      submitted = fingerprint;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const next = await inspect(config.targetId, query);
      if (epoch.current === request && currentFingerprint.current === submitted)
        setResult(next);
    } catch (cause) {
      if (epoch.current === request && currentFingerprint.current === submitted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  };
  return (
    <section className="browser-locator-field" aria-label="Browser locator">
      <Field label="Browser targeting">
        <Select
          aria-label="Browser targeting"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          {optional ? (
            <option value="none">
              Coordinates / focused element / detector result
            </option>
          ) : null}
          <option value="css">CSS selector</option>
          <option value="locator">Structured locator</option>
        </Select>
      </Field>
      {mode === "css" ? (
        <LocatorText
          label="Browser selector"
          value={typeof config.selector === "string" ? config.selector : ""}
          onChange={(value) => onChange({ ...config, selector: value })}
          referenceProps={{ references, consumerNodeId, allowReference }}
        />
      ) : null}
      {mode === "locator" && !editable ? (
        <Notice kind="error">
          This locator cannot be edited with these controls. Its saved
          configuration is preserved in Advanced configuration.
          <Button onClick={() => setMode("locator")}>
            Reset structured locator
          </Button>
        </Notice>
      ) : null}
      {mode === "locator" && editable ? (
        <>
          <SelectorFields
            referenceProps={{ references, consumerNodeId, allowReference }}
            selector={locator.selector}
            prefix="Locator"
            onChange={(selector) => replace({ ...locator, selector })}
          />
          {(locator.path ?? []).map((scope, index) => (
            <div className="browser-locator-scope" key={index}>
              <Field label={`Scope ${index + 1} type`}>
                <Select
                  aria-label={`Scope ${index + 1} type`}
                  value={scope.kind}
                  onChange={(event) =>
                    replace({
                      ...locator,
                      path: locator.path!.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              kind: event.target.value as "frame" | "shadow",
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="frame">Frame</option>
                  <option value="shadow">Open shadow root</option>
                </Select>
              </Field>
              <SelectorFields
                referenceProps={{ references, consumerNodeId, allowReference }}
                prefix={`Scope ${index + 1}`}
                selector={scope.selector}
                onChange={(selector) =>
                  replace({
                    ...locator,
                    path: locator.path!.map((item, i) =>
                      i === index ? { ...item, selector } : item,
                    ),
                  })
                }
              />
              <Button
                onClick={() =>
                  replace({
                    ...locator,
                    path: locator.path!.filter((_, i) => i !== index),
                  })
                }
              >
                Remove scope {index + 1}
              </Button>
            </div>
          ))}
          <div className="locator-actions">
            {(["frame", "shadow"] as const).map((scope) => (
              <Button
                key={scope}
                disabled={(locator.path?.length ?? 0) >= 12}
                onClick={() =>
                  replace({
                    ...locator,
                    path: [
                      ...(locator.path ?? []),
                      {
                        kind: scope,
                        selector: {
                          kind: "css",
                          value: scope === "frame" ? "iframe" : "",
                        },
                      },
                    ],
                  })
                }
              >
                Add {scope} scope
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {mode !== "none" ? (
        <>
          <Button
            busy={busy}
            disabled={!workspace.desktop || !inspect || !query || hasReferences}
            onClick={() => void test()}
          >
            Test match
          </Button>
          <p className="field-help">
            Inspect matching elements without clicking or typing. Exactly one
            match is required for actions.
            {hasReferences
              ? " References must be resolved before testing."
              : ""}
          </p>
          {error ? <Notice kind="error">{error}</Notice> : null}
          {result ? (
            <Notice kind={result.status === "unique" ? "info" : "error"}>
              <strong>
                {result.status === "unique"
                  ? "1 element matches"
                  : result.status === "missing"
                    ? "No elements match"
                    : `${result.count} elements match — ambiguous`}
              </strong>
              {result.element ? (
                <>
                  <p>
                    {result.element.tag} · {result.element.role || "no role"} ·{" "}
                    {result.element.name || "unnamed"}
                    {result.visible ? " · visible" : " · hidden"}
                  </p>
                  <Button onClick={() => replace(result.element!.locator)}>
                    Use inspected locator
                  </Button>
                </>
              ) : null}
            </Notice>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function editableLocator(value: unknown): value is BrowserLocator {
  const object = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));
  const selector = (value: unknown) =>
    object(value) &&
    (value.kind === "role"
      ? typeof value.role === "string" &&
        (value.name === undefined || typeof value.name === "string")
      : ["css", "label", "id", "testId"].includes(String(value.kind)) &&
        typeof value.value === "string" &&
        (value.kind !== "testId" || typeof value.attribute === "string"));
  return (
    object(value) &&
    value.version === 1 &&
    selector(value.selector) &&
    (value.path === undefined ||
      (Array.isArray(value.path) &&
        value.path.every(
          (step) =>
            object(step) &&
            ["frame", "shadow"].includes(String(step.kind)) &&
            selector(step.selector),
        )))
  );
}

function SelectorFields({
  selector,
  prefix,
  onChange,
  referenceProps,
}: {
  selector: BrowserSelector;
  prefix: string;
  onChange(selector: BrowserSelector): void;
  referenceProps: ReferenceProps;
}) {
  const value = "value" in selector ? selector.value : "";
  return (
    <>
      <Field label={`${prefix} strategy`}>
        <Select
          aria-label={`${prefix} strategy`}
          value={selector.kind}
          onChange={(event) =>
            onChange(
              event.target.value === "role"
                ? { kind: "role", role: "button", name: "" }
                : event.target.value === "testId"
                  ? { kind: "testId", attribute: "data-testid", value: "" }
                  : {
                      kind: event.target.value as "css" | "label" | "id",
                      value: "",
                    },
            )
          }
        >
          <option value="testId">Test attribute</option>
          <option value="role">Role and name</option>
          <option value="label">Associated label</option>
          <option value="id">Element ID</option>
          <option value="css">CSS selector</option>
        </Select>
      </Field>
      {selector.kind === "testId" ? (
        <Field label={`${prefix} attribute`}>
          <input
            aria-label={`${prefix} attribute`}
            value={selector.attribute}
            onChange={(event) =>
              onChange({ ...selector, attribute: event.target.value })
            }
          />
        </Field>
      ) : null}
      {selector.kind === "role" ? (
        <>
          <Field label={`${prefix} role`}>
            <input
              aria-label={`${prefix} role`}
              value={selector.role}
              onChange={(event) =>
                onChange({ ...selector, role: event.target.value })
              }
            />
          </Field>
          <Field label={`${prefix} name matching`}>
            <Select
              aria-label={`${prefix} name matching`}
              value={selector.name === undefined ? "any" : "exact"}
              onChange={(event) =>
                onChange(
                  event.target.value === "any"
                    ? { kind: "role", role: selector.role }
                    : { ...selector, name: "" },
                )
              }
            >
              <option value="exact">Exact accessible name</option>
              <option value="any">Any accessible name</option>
            </Select>
          </Field>
          {selector.name !== undefined ? (
            <LocatorText
              label={`${prefix} name`}
              value={selector.name}
              onChange={(name) => onChange({ ...selector, name })}
              referenceProps={referenceProps}
            />
          ) : null}
        </>
      ) : (
        <LocatorText
          label={`${prefix} value`}
          value={value}
          onChange={(value) => onChange({ ...selector, value })}
          referenceProps={referenceProps}
        />
      )}
    </>
  );
}

type ReferenceProps = {
  references?: ReferenceInspector;
  consumerNodeId?: string;
  allowReference?: boolean;
};
function LocatorText({
  label,
  value,
  onChange,
  referenceProps,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  referenceProps: ReferenceProps;
}) {
  return referenceProps.references ? (
    <ValueField
      label={label}
      value={value}
      onChange={(value) => onChange(typeof value === "string" ? value : "")}
      references={referenceProps.references}
      consumerNodeId={referenceProps.consumerNodeId}
      allowReference={referenceProps.allowReference}
      literalType="string"
      allowTypeChange={false}
    />
  ) : (
    <Field label={label}>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
