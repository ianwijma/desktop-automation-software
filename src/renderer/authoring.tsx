import { useCallback, useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  ScanLine,
  Send,
  Square,
  Sparkles,
  Trash2,
  RotateCcw,
} from "lucide-react";
import type { RelayAPI, WorkspaceState } from "../shared/types";
import type { AuthoringAttachment } from "../shared/chat-attachments";
import { attachmentLimits } from "../shared/chat-attachments";
import type {
  FlowProposalResult,
  ProposalProgress,
} from "../shared/chat-authoring";
import { Button, Field, IconButton, Notice, Select, Modal } from "./components";
import "./authoring.css";

interface Turn {
  id: string;
  goal: string;
  imageCount: number;
  result: FlowProposalResult;
}
function ImageCard({
  image,
  api,
  pending,
  onRemove,
  onReuse,
}: {
  image: AuthoringAttachment;
  api: RelayAPI;
  pending: boolean;
  onRemove(): void;
  onReuse(): void;
}) {
  const [viewing, setViewing] = useState(false),
    [actualSize, setActualSize] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      url = "";
    setPreview("");
    setError("");
    void api
      .previewAuthoringImage({
        sessionId: image.sessionId,
        attachmentId: image.id,
      })
      .then((result) => {
        if (!active) return;
        url = URL.createObjectURL(
          new Blob([new Uint8Array(result.bytes).buffer], {
            type: result.mimeType,
          }),
        );
        setPreview(url);
      })
      .catch(() => {
        if (active)
          setError("Preview unavailable. Remove this image and add it again.");
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, image.id, image.sessionId]);
  return (
    <article className="authoring-image" aria-label={image.name}>
      {preview ? (
        <button
          ref={previewButton}
          className="authoring-preview"
          aria-label={"Preview " + image.name}
          onClick={() => {
            setActualSize(false);
            setViewing(true);
          }}
        >
          <img src={preview} alt={image.name} />
        </button>
      ) : (
        <span className="image-placeholder">
          {error || "Preparing preview…"}
        </span>
      )}
      <div>
        <strong title={image.name}>{image.name}</strong>
        <small>
          {image.width} × {image.height} · {Math.ceil(image.byteLength / 1024)}{" "}
          KiB
        </small>
      </div>
      <div className="authoring-image-actions">
        {image.state === "sent" ? (
          <Button disabled={pending} onClick={onReuse}>
            <RotateCcw size={13} />
            Reuse
          </Button>
        ) : (
          <small>Local until Send</small>
        )}
        <IconButton
          label={"Remove " + image.name}
          disabled={pending}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      <Modal
        open={viewing}
        onClose={() => setViewing(false)}
        title="Prepared image"
        wide
        returnFocusRef={previewButton}
        description={
          image.name +
          " · " +
          image.width +
          " × " +
          image.height +
          " · metadata removed"
        }
      >
        <Button onClick={() => setActualSize(!actualSize)}>
          {actualSize ? "Fit preview" : "Actual pixels"}
        </Button>
        <div className={"authoring-full-image" + (actualSize ? " actual" : "")}>
          <img src={preview} alt={"Prepared " + image.name} />
        </div>
      </Modal>
    </article>
  );
}
export function Authoring({
  api,
  workspace,
  visible,
  onSettings,
}: {
  api: RelayAPI;
  workspace: WorkspaceState;
  visible: boolean;
  onSettings(): void;
}) {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [connectionId, setConnectionId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [nodeModel, setNodeModel] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AuthoringAttachment[]>([]);
  const [sentExpanded, setSentExpanded] = useState(false);
  const [sentPage, setSentPage] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [progress, setProgress] = useState<ProposalProgress["phase"] | "">("");
  const [requestId, setRequestId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const currentSession = useRef(sessionId),
    activeRequest = useRef(""),
    operation = useRef(false);
  currentSession.current = sessionId;
  const draftImages = images.filter((i) => i.state === "draft");
  const sentImages = images.filter((i) => i.state === "sent");
  const historyPage = Math.min(
    sentPage,
    Math.max(0, Math.ceil(sentImages.length / 6) - 1),
  );
  const historyImages = sentImages.slice(historyPage * 6, historyPage * 6 + 6);
  const model = workspace.connections.find((c) => c.id === connectionId);
  const suitable = Boolean(
    model &&
    model.provider !== "jev" &&
    model.capabilities.text &&
    model.capabilities.structured,
  );
  const canSend =
    workspace.desktop &&
    suitable &&
    (!draftImages.length || model?.capabilities.vision) &&
    Boolean(prompt.trim() || draftImages.length);
  const busy = Boolean(working || requestId);
  const loadImages = useCallback(
    async (session: string) => {
      const next = await api.listAuthoringImages(session);
      if (currentSession.current === session) setImages(next);
    },
    [api],
  );
  useEffect(() => {
    return () => {
      if (activeRequest.current)
        void api
          .cancelFlowProposal(sessionId, activeRequest.current)
          .catch(() => {});
      void api.closeAuthoringSession(sessionId).catch(() => {});
    };
  }, [api, sessionId]);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (
          event.type === "authoring-progress" &&
          event.progress.sessionId === currentSession.current &&
          event.progress.requestId === activeRequest.current
        )
          setProgress(event.progress.phase);
      }),
    [api],
  );
  const localOperation = async (
    label: string,
    action: (session: string) => Promise<unknown>,
  ) => {
    if (operation.current || activeRequest.current || !workspace.desktop)
      return;
    const session = sessionId;
    operation.current = true;
    setWorking(label);
    setError("");
    try {
      await action(session);
    } catch (e) {
      if (currentSession.current === session)
        setError(
          e instanceof Error ? e.message : "The image could not be prepared.",
        );
    } finally {
      if (currentSession.current === session) {
        await loadImages(session).catch(() =>
          setError("Images could not refresh. Clear the session or try again."),
        );
        setWorking("");
      }
      operation.current = false;
    }
  };
  const addFiles = async (files: File[], source: "file" | "paste" | "drop") => {
    if (!files.length) return;
    if (files.length + draftImages.length > attachmentLimits.perTurn) {
      setError(
        "A turn allows four images. Remove an image before adding more.",
      );
      return;
    }
    if (files.some((f) => !f.size || f.size > attachmentLimits.sourceBytes)) {
      setError("Images must be at most 8 MiB each.");
      return;
    }
    await localOperation("Preparing images…", async (session) => {
      for (const file of files) {
        if (currentSession.current !== session) return;
        await api.importAuthoringImage({
          sessionId: session,
          name: (file.name || "Pasted image").slice(0, 160),
          source,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
    });
  };
  const send = async () => {
    if (operation.current || activeRequest.current || !canSend) return;
    const session = sessionId,
      id = crypto.randomUUID(),
      goal = prompt,
      imageCount = draftImages.length;
    activeRequest.current = id;
    setRequestId(id);
    setError("");
    setProgress("preparing");
    try {
      const result = await api.requestFlowProposal({
        sessionId: session,
        requestId: id,
        connectionId,
        prompt: goal,
        attachmentIds: draftImages.map((i) => i.id),
        targetIds: targetId ? [targetId] : [],
        connectionIds: nodeModel ? [connectionId] : [],
        childFlowIds: [],
      });
      if (currentSession.current !== session || activeRequest.current !== id)
        return;
      setTurns((previous) => [
        ...previous.slice(-9),
        { id, goal, imageCount, result },
      ]);
      if (result.status === "proposal" || result.status === "clarification")
        setPrompt("");
    } catch (e) {
      if (currentSession.current === session && activeRequest.current === id)
        setError(
          e instanceof Error ? e.message : "The proposal request failed.",
        );
    } finally {
      if (currentSession.current === session && activeRequest.current === id) {
        await loadImages(session).catch(() =>
          setError("Images could not refresh. Clear the session or try again."),
        );
        activeRequest.current = "";
        setRequestId("");
        setProgress("");
      }
    }
  };
  return (
    <section
      className="authoring-page"
      hidden={!visible}
      aria-label="Flow assistant"
    >
      <header className="authoring-heading">
        <div>
          <span className="section-eyebrow">BUILD WITH CONTEXT</span>
          <h1>
            <Sparkles size={23} />
            Flow assistant
          </h1>
          <p>Describe the workflow. Add images to show what you mean.</p>
        </div>
        <Button
          disabled={busy}
          onClick={() => {
            setSessionId(crypto.randomUUID());
            setImages([]);
            setTurns([]);
            setPrompt("");
            setError("");
            setTargetId("");
          }}
        >
          <Trash2 size={14} />
          Clear session
        </Button>
      </header>
      {!workspace.desktop ? (
        <Notice>
          Open the desktop app to attach images, capture windows and generate
          proposals.
        </Notice>
      ) : null}
      <div className="authoring-layout">
        <div className="authoring-conversation">
          {!turns.length ? (
            <div className="authoring-intro">
              <Sparkles size={32} />
              <h2>Start with the task you repeat.</h2>
              <p>
                For example: “Wait for the export to finish, then save the
                result.”
              </p>
              <p>
                Images stay on this device until you choose Send. Your selected
                model receives only this turn’s images and selected context.
              </p>
            </div>
          ) : null}
          <div
            className="authoring-turns"
            aria-label="Current conversation"
            aria-live="polite"
          >
            {turns.map((turn) => (
              <article className="authoring-turn" key={turn.id}>
                <div className="authoring-user">
                  <strong>You</strong>
                  <p>{turn.goal || "Image only"}</p>
                  {turn.imageCount ? (
                    <small>
                      {turn.imageCount} image{turn.imageCount === 1 ? "" : "s"}{" "}
                      explicitly included
                    </small>
                  ) : null}
                </div>
                <div className="authoring-response">
                  <strong>Relay</strong>
                  {turn.result.status === "proposal" ? (
                    <>
                      <p>{turn.result.proposal.explanation}</p>
                      <div className="authoring-proposal">
                        <span className="section-eyebrow">
                          UNSAVED PROPOSAL
                        </span>
                        <h3>{turn.result.proposal.flow.name}</h3>
                        <p>
                          {turn.result.proposal.flow.nodes.length} nodes ·{" "}
                          {turn.result.proposal.flow.edges.length} connections ·{" "}
                          {turn.result.proposal.bindings.length} resources to
                          bind
                        </p>
                        <ol>
                          {turn.result.proposal.flow.nodes.map((node) => (
                            <li key={node.id}>{node.label || node.kind}</li>
                          ))}
                        </ol>
                        <small>
                          Review and Apply controls are being added. This
                          proposal has not changed your workflows.
                        </small>
                      </div>
                    </>
                  ) : turn.result.status === "clarification" ? (
                    <>
                      <p>{turn.result.explanation}</p>
                      <ul>
                        {turn.result.questions.map((question, i) => (
                          <li key={i}>{question}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>{turn.result.message}</p>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div
            className="authoring-composer"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files"))
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy)
                void addFiles(Array.from(event.dataTransfer.files), "drop");
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                if (!busy) void addFiles(files, "paste");
              }
            }}
          >
            {draftImages.length ? (
              <div
                className="authoring-images"
                aria-label="Images for next Send"
              >
                {draftImages.map((image) => (
                  <ImageCard
                    key={image.id}
                    image={image}
                    api={api}
                    pending={busy}
                    onRemove={() =>
                      void localOperation("Removing image…", (session) =>
                        api.deleteAuthoringImage({
                          sessionId: session,
                          attachmentId: image.id,
                        }),
                      )
                    }
                    onReuse={() => {}}
                  />
                ))}
              </div>
            ) : null}
            <label htmlFor="authoring-goal" className="field-label">
              What would you like to automate?
            </label>
            <textarea
              id="authoring-goal"
              maxLength={8000}
              rows={4}
              disabled={!workspace.desktop || busy}
              placeholder="Describe your goal, or paste an image here…"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="authoring-composer-actions">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                aria-label="Choose authoring images"
                disabled={!workspace.desktop || busy}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addFiles(files, "file");
                }}
              />
              <Button
                disabled={!workspace.desktop || busy || draftImages.length >= 4}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus size={15} />
                Add images
              </Button>
              <span>{draftImages.length}/4 images</span>
              <span className="authoring-action-spacer" />
              {requestId ? (
                <Button
                  onClick={() => {
                    setProgress("cancelled");
                    void api
                      .cancelFlowProposal(sessionId, requestId)
                      .catch(() => setError("Cancellation failed. Try again."));
                  }}
                >
                  <Square size={13} />
                  Cancel request
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!canSend || busy}
                  onClick={() => void send()}
                >
                  <Send size={15} />
                  Send
                </Button>
              )}
            </div>
            <div role="status" className="authoring-status">
              {working ||
                (requestId
                  ? progress === "cancelled"
                    ? "Cancelling…"
                    : "Creating proposal…"
                  : "Static PNG, JPEG or WebP · 8 MiB / 40 MP source limit · drop or paste here")}
            </div>
            {draftImages.length && model && !model.capabilities.vision ? (
              <Notice kind="error">
                This model does not support images. Choose a vision-enabled
                authoring model or remove the images.
              </Notice>
            ) : null}
            {error ? <Notice kind="error">{error}</Notice> : null}
          </div>
          <p className="authoring-footnote">
            This session is temporary. Clear session removes its images and
            messages. Nothing runs or saves automatically.
          </p>
        </div>
        <aside className="authoring-context">
          <h2>Selected context</h2>
          <Field
            label="Authoring model"
            help="One request per Send using your configured model."
          >
            <Select
              aria-label="Authoring model"
              value={connectionId}
              disabled={busy || !workspace.desktop}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">Choose a model…</option>
              {workspace.connections
                .filter(
                  (c) =>
                    c.provider !== "jev" &&
                    c.capabilities.text &&
                    c.capabilities.structured,
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.model}
                  </option>
                ))}
            </Select>
          </Field>
          {!workspace.connections.some(
            (c) =>
              c.provider !== "jev" &&
              c.capabilities.text &&
              c.capabilities.structured,
          ) ? (
            <Button onClick={onSettings}>Configure AI connections</Button>
          ) : null}
          <label className="authoring-check">
            <input
              type="checkbox"
              checked={nodeModel}
              disabled={busy || !connectionId}
              onChange={(e) => setNodeModel(e.target.checked)}
            />
            Offer this connection to generated AI nodes
          </label>
          <Field
            label="Application context"
            help="Only this target’s description is shared; executable launch commands stay local."
          >
            <Select
              aria-label="Application context"
              value={targetId}
              disabled={busy || !workspace.desktop}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">No target selected</option>
              {workspace.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={
              !workspace.desktop ||
              busy ||
              draftImages.length >= 4 ||
              !workspace.targets.some(
                (t) => t.id === targetId && t.kind === "desktop",
              )
            }
            onClick={() =>
              void localOperation("Capturing chosen window…", (session) =>
                api.captureAuthoringImage({ sessionId: session, targetId }),
              )
            }
          >
            <ScanLine size={16} />
            Capture selected window once
          </Button>
          <p className="field-help">
            Capture uses a configured desktop target and may ask for system
            permission. It adds one local image. Review it before Send.
          </p>
          <div className="authoring-limits">
            <strong>Prepared for your model</strong>
            <p>
              Orientation corrected. Metadata removed. At most 2,048 pixels on
              the longest side and 2 MiB per image.
            </p>
          </div>
          {sentImages.length ? (
            <details
              className="authoring-sent"
              onToggle={(event) => setSentExpanded(event.currentTarget.open)}
            >
              <summary>Images from earlier turns ({sentImages.length})</summary>
              <p className="field-help">
                These images are excluded until you choose Reuse.
              </p>
              <div className="authoring-images">
                {sentExpanded
                  ? historyImages.map((image) => (
                      <ImageCard
                        key={image.id}
                        image={image}
                        api={api}
                        pending={busy || draftImages.length >= 4}
                        onRemove={() =>
                          void localOperation("Removing image…", (session) =>
                            api.deleteAuthoringImage({
                              sessionId: session,
                              attachmentId: image.id,
                            }),
                          )
                        }
                        onReuse={() =>
                          void localOperation(
                            "Reusing prepared image…",
                            (session) =>
                              api.reuseAuthoringImage({
                                sessionId: session,
                                attachmentId: image.id,
                              }),
                          )
                        }
                      />
                    ))
                  : null}
              </div>
              {sentExpanded && sentImages.length > 6 ? (
                <div className="authoring-history-pages">
                  <Button
                    disabled={historyPage === 0}
                    onClick={() => setSentPage(historyPage - 1)}
                  >
                    Previous images
                  </Button>
                  <small>
                    {historyPage + 1}/{Math.ceil(sentImages.length / 6)}
                  </small>
                  <Button
                    disabled={(historyPage + 1) * 6 >= sentImages.length}
                    onClick={() => setSentPage(historyPage + 1)}
                  >
                    Next images
                  </Button>
                </div>
              ) : null}
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
