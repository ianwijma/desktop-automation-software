import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayAPI, AIConnection } from "../shared/types";
import type { OpenRouterSearchResult } from "../shared/ai-diagnostics";
import { Button, Field, Notice } from "./components";
export function OpenRouterModelPicker({
  api,
  desktop,
  model,
  enabled,
  onSelect,
}: {
  api: RelayAPI;
  desktop: boolean;
  model: string;
  enabled: AIConnection["capabilities"];
  onSelect(id: string): void;
}) {
  const [query, setQuery] = useState(""),
    [result, setResult] = useState<OpenRouterSearchResult>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    mounted = useRef(true),
    pending = useRef<string | undefined>(undefined),
    queryRef = useRef(query),
    modelRef = useRef(model);
  modelRef.current = model;
  queryRef.current = query;
  const load = useCallback(
    async (refresh = false) => {
      const token = ++generation.current,
        requestId = refresh ? crypto.randomUUID() : undefined;
      if (requestId) {
        pending.current = requestId;
        setBusy(true);
      }
      setError("");
      try {
        const next = await api.searchOpenRouterModels(queryRef.current, {
          refresh,
          selectedModel: modelRef.current,
          ...(requestId ? { requestId } : {}),
        });
        if (mounted.current && token === generation.current) setResult(next);
      } catch {
        if (mounted.current && token === generation.current) {
          setError(
            "Model search is unavailable. Manual model IDs remain available.",
          );
          setResult((previous) =>
            previous ? { ...previous, stale: true } : previous,
          );
        }
      } finally {
        if (requestId && pending.current === requestId) {
          pending.current = undefined;
          if (mounted.current) {
            setBusy(false);
            if (token !== generation.current) void load(false);
          }
        }
      }
    },
    [api],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (pending.current)
        void api.cancelAIDiagnostic(pending.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(false);
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, model, load]);
  const selected =
      result?.selected?.id === model
        ? result.selected
        : result?.models.find((m) => m.id === model),
    stale = Boolean(
      result?.stale ||
      (result?.fetchedAt &&
        Date.now() - Date.parse(result.fetchedAt) > 86400000),
    );
  const advertised = (value: boolean | null) =>
    value === null ? "unknown" : value ? "advertised" : "not advertised";
  return (
    <section
      className="model-discovery"
      aria-label="OpenRouter model discovery"
    >
      <p className="field-help">
        Search OpenRouter’s public catalog. Manual IDs and your configured
        endpoint always remain available. Selecting a model changes only its ID.
        Custom endpoints may advertise different support.
      </p>
      <Field label="Search OpenRouter models">
        <input
          aria-label="Search OpenRouter models"
          value={query}
          onChange={(e) => {
            generation.current++;
            queryRef.current = e.target.value;
            setQuery(e.target.value);
          }}
          placeholder="Search model name or provider/model ID"
        />
      </Field>
      <div className="button-row">
        <Button
          disabled={!desktop || busy}
          onClick={() => void load(true)}
          busy={busy}
        >
          Refresh model catalog
        </Button>
        {busy ? (
          <Button
            onClick={() => {
              if (pending.current)
                void api
                  .cancelAIDiagnostic(pending.current)
                  .catch(() => setError("Could not request cancellation."));
            }}
          >
            Cancel model refresh
          </Button>
        ) : null}
      </div>
      {result?.fetchedAt ? (
        <p className="field-help">
          {stale ? "Stale cached metadata" : "Cached metadata"} ·{" "}
          {new Date(result.fetchedAt).toLocaleString()} · {result.matched}{" "}
          matches; showing up to 50
        </p>
      ) : (
        <p className="field-help">
          No catalog metadata loaded. Refresh explicitly when online, or enter a
          model ID manually.
        </p>
      )}
      {error || result?.error ? (
        <Notice kind={result?.error?.code === "cancelled" ? "info" : "error"}>
          {error || result?.error?.message}
        </Notice>
      ) : null}
      {selected ? (
        <p className="field-help">
          Selected model: text {advertised(selected.advertised.text)}, vision{" "}
          {advertised(selected.advertised.vision)}, structured output{" "}
          {advertised(selected.advertised.structured)}. This is catalog
          metadata, not verified support.
        </p>
      ) : null}
      {selected &&
      ((enabled.vision && selected.advertised.vision === false) ||
        (enabled.structured && selected.advertised.structured === false) ||
        (enabled.text && selected.advertised.text === false)) ? (
        <Notice kind="error">
          This model does not advertise all currently enabled capabilities.
          Check its support and test each operation. Selection does not change
          your switches or grant verification.
        </Notice>
      ) : null}
      <div className="model-search-results">
        {result?.models.map((m) => (
          <article key={m.id}>
            <div>
              <strong>{m.name}</strong>
              <code>{m.id}</code>
              <small>
                Text {advertised(m.advertised.text)} · Vision{" "}
                {advertised(m.advertised.vision)} · Structured{" "}
                {advertised(m.advertised.structured)}
                {m.contextLength
                  ? ` · ${m.contextLength.toLocaleString()} context tokens`
                  : ""}
              </small>
            </div>
            <Button
              aria-label={`Use model ${m.id}`}
              onClick={() => onSelect(m.id)}
            >
              {model === m.id ? "Selected" : "Use model"}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
