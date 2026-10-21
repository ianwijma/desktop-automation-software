import { useEffect, useState } from "react";
import {
  Plus,
  PlugZap,
  Monitor,
  Palette,
  ShieldCheck,
  Trash2,
  Pencil,
  Check,
  Sun,
  Moon,
  Laptop,
  KeyRound,
  Cpu,
  Globe,
  RefreshCw,
} from "lucide-react";
import type {
  WorkspaceState,
  RelayAPI,
  AppSettings,
  AIConnection,
  TargetDescriptor,
  Json,
  ProviderKind,
} from "../shared/types";
import { accents, uid } from "./catalog";
import {
  Button,
  IconButton,
  Modal,
  Field,
  JsonField,
  Select,
  EmptyState,
  Notice,
} from "./components";
type Props = {
  workspace: WorkspaceState;
  api: RelayAPI;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onSuccess: (message: string) => void;
};
export function Settings({
  workspace,
  api,
  refresh,
  onError,
  onSuccess,
}: Props) {
  const [tab, setTab] = useState("appearance");
  const [systemDraft, setSystemDraft] = useState(workspace.settings);
  useEffect(() => setSystemDraft(workspace.settings), [workspace.settings]);
  const update = async (patch: Partial<AppSettings>) => {
    try {
      await api.saveSettings({ ...workspace.settings, ...patch });
      await refresh();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">MAKE IT YOURS</span>
          <h1>Settings</h1>
          <p>Your workspace, connected your way.</p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            ["appearance", "Appearance", Palette],
            ["connections", "AI connections", PlugZap],
            ["targets", "Applications", Monitor],
            ["permissions", "Permissions & system", ShieldCheck],
          ].map(([id, label, Icon]) => (
            <button
              key={String(id)}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(String(id))}
            >
              {typeof Icon !== "string" ? <Icon size={17} /> : null}
              {String(label)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "appearance" ? (
            <>
              <SectionTitle
                title="A space that feels like you"
                description="Choose a theme and an accent. Every detail follows along."
              />
              <h4 className="setting-label">THEME</h4>
              <div className="theme-grid">
                {(["dark", "light", "system"] as const).map((theme) => (
                  <button
                    key={theme}
                    className={`theme-option ${workspace.settings.theme === theme ? "selected" : ""}`}
                    onClick={() => void update({ theme })}
                  >
                    <div className={`theme-preview ${theme}`}>
                      <span />
                      <span />
                      <span />
                    </div>
                    <span>
                      {theme === "dark" ? (
                        <Moon size={15} />
                      ) : theme === "light" ? (
                        <Sun size={15} />
                      ) : (
                        <Laptop size={15} />
                      )}{" "}
                      {theme[0].toUpperCase() + theme.slice(1)}{" "}
                      {workspace.settings.theme === theme ? (
                        <Check size={15} />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              <h4 className="setting-label">ACCENT COLOR</h4>
              <p className="muted">
                A small change with a whole different feeling.
              </p>
              <div className="accent-grid">
                {accents.map(([name, color]) => (
                  <button
                    key={name}
                    className={
                      workspace.settings.accent.toLowerCase() === color
                        ? "selected"
                        : ""
                    }
                    onClick={() => void update({ accent: color })}
                    aria-label={`${name} accent`}
                    title={name}
                  >
                    <span style={{ background: color }}>
                      {workspace.settings.accent.toLowerCase() === color ? (
                        <Check size={17} />
                      ) : null}
                    </span>
                    <small>{name}</small>
                  </button>
                ))}
              </div>
              <div className="custom-color">
                <label>
                  Or find your own{" "}
                  <input
                    type="color"
                    value={workspace.settings.accent}
                    onChange={(e) => void update({ accent: e.target.value })}
                  />
                </label>
                <code>{workspace.settings.accent.toUpperCase()}</code>
              </div>
              <div className="appearance-preview">
                <span className="section-eyebrow">A LITTLE PREVIEW</span>
                <div>
                  <span className="preview-selected">
                    <Check size={16} /> Everything in its place
                  </span>
                  <span className="button primary">
                    <Plus size={14} /> Your next idea
                  </span>
                </div>
              </div>
            </>
          ) : tab === "connections" ? (
            <Connections
              workspace={workspace}
              api={api}
              refresh={refresh}
              onError={onError}
              onSuccess={onSuccess}
            />
          ) : tab === "targets" ? (
            <Targets
              workspace={workspace}
              api={api}
              refresh={refresh}
              onError={onError}
              onSuccess={onSuccess}
            />
          ) : (
            <>
              <SectionTitle
                title="Ready for the real world"
                description="Desktop automation needs permission to see and interact with your applications."
              />
              <div className="capability-grid">
                {[
                  ["Window capture", workspace.capabilities.capture],
                  ["Desktop input", workspace.capabilities.input],
                  ["Accessibility", workspace.capabilities.accessibility],
                  ["Direct recording", workspace.capabilities.directRecording],
                  ["Global shortcuts", workspace.capabilities.globalShortcuts],
                ].map(([name, value]) => (
                  <div key={String(name)}>
                    <span>{String(name)}</span>
                    <span
                      className={`status-pill ${value ? "succeeded" : "interrupted"}`}
                    >
                      {value ? "Available" : "Unavailable"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="muted small">
                {workspace.capabilities.platform} ·{" "}
                {workspace.capabilities.session}
              </p>
              {workspace.capabilities.reasons.map((reason, i) => (
                <Notice key={i}>{reason}</Notice>
              ))}
              <Button
                onClick={() =>
                  void api.getCapabilities().then(refresh).catch(onError)
                }
              >
                <RefreshCw size={14} /> Check permissions again
              </Button>
              <div className="section-divider" />
              <h3>Background & safety</h3>
              <label className="toggle-row">
                <span>
                  <strong>Launch at login</strong>
                  <small>Keep schedules available when you sign in</small>
                </span>
                <input
                  type="checkbox"
                  checked={workspace.settings.launchAtLogin}
                  onChange={(e) =>
                    void update({ launchAtLogin: e.target.checked })
                  }
                />
              </label>
              <label className="toggle-row">
                <span>
                  <strong>Keep running in the background</strong>
                  <small>Closing the window keeps Relay in your tray</small>
                </span>
                <input
                  type="checkbox"
                  checked={workspace.settings.minimizeToTray}
                  onChange={(e) =>
                    void update({ minimizeToTray: e.target.checked })
                  }
                />
              </label>
              <Field label="Emergency stop shortcut">
                <input
                  value={systemDraft.stopHotkey}
                  onChange={(e) =>
                    setSystemDraft({
                      ...systemDraft,
                      stopHotkey: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Pause shortcut">
                <input
                  value={systemDraft.pauseHotkey}
                  onChange={(e) =>
                    setSystemDraft({
                      ...systemDraft,
                      pauseHotkey: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="History retention (days)">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={systemDraft.historyRetentionDays}
                  onChange={(e) =>
                    setSystemDraft({
                      ...systemDraft,
                      historyRetentionDays: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Button
                variant="primary"
                disabled={
                  systemDraft.stopHotkey === workspace.settings.stopHotkey &&
                  systemDraft.pauseHotkey === workspace.settings.pauseHotkey &&
                  systemDraft.historyRetentionDays ===
                    workspace.settings.historyRetentionDays
                }
                onClick={() =>
                  void update({
                    stopHotkey: systemDraft.stopHotkey,
                    pauseHotkey: systemDraft.pauseHotkey,
                    historyRetentionDays: systemDraft.historyRetentionDays,
                  }).then((saved) => {
                    if (saved) onSuccess("System preferences saved.");
                  })
                }
              >
                Save system preferences
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
function SectionTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
const providers: Record<
  ProviderKind,
  { name: string; baseUrl: string; model: string }
> = {
  openai: {
    name: "OpenAI compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "",
  },
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "",
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "",
  },
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434", model: "" },
  lmstudio: {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "",
  },
  jev: {
    name: "Jev",
    baseUrl: "https://api.typesafe.ai/v1",
    model: "jev-1.14.0",
  },
};
function Connections({ workspace, api, refresh, onError, onSuccess }: Props) {
  const [editing, setEditing] = useState<AIConnection | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      if (
        !editing.name.trim() ||
        !editing.baseUrl.trim() ||
        !editing.model.trim()
      )
        throw new Error(
          "Add a name, endpoint, and model to save this connection.",
        );
      new URL(editing.baseUrl);
      await api.saveConnection(editing, key || undefined);
      await refresh();
      setEditing(null);
      setKey("");
      onSuccess("Connection saved.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-title with-action">
        <div>
          <h2>Your models. Your choice.</h2>
          <p>Connect a cloud provider or a local model server.</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setKey("");
            setEditing({
              id: uid(),
              name: "",
              provider: "openai",
              baseUrl: providers.openai.baseUrl,
              model: "",
              capabilities: { text: true, vision: false, structured: false },
              hasKey: false,
            });
          }}
        >
          <Plus size={14} /> Add connection
        </Button>
      </div>
      {workspace.connections.length ? (
        <div className="connection-list">
          {workspace.connections.map((connection) => (
            <div className="connection-card" key={connection.id}>
              <span className="connection-logo">
                {connection.provider === "ollama" ||
                connection.provider === "lmstudio" ? (
                  <Cpu size={23} />
                ) : (
                  <Sparkle />
                )}
              </span>
              <div className="connection-info">
                <h3>
                  {connection.name}
                  <span className="badge">
                    {connection.provider === "ollama" ||
                    connection.provider === "lmstudio"
                      ? "Local"
                      : "BYO key"}
                  </span>
                </h3>
                <p>
                  {connection.model} <span>·</span>{" "}
                  {providers[connection.provider]?.name ?? connection.provider}
                </p>
                <div className="capability-badges">
                  {connection.capabilities.text ? <span>Text</span> : null}
                  {connection.capabilities.vision ? <span>Vision</span> : null}
                  {connection.capabilities.structured ? (
                    <span>Structured output</span>
                  ) : null}
                </div>
                {connection.lastTest ? (
                  <small
                    className={
                      connection.lastTest.ok ? "success-text" : "error-text"
                    }
                  >
                    {connection.lastTest.message}
                  </small>
                ) : null}
              </div>
              <div className="card-actions">
                <Button
                  busy={testing === connection.id}
                  onClick={() => {
                    setTesting(connection.id);
                    void api
                      .testConnection(connection.id)
                      .then(async (result) => {
                        await refresh();
                        if (result.ok) onSuccess(result.message);
                        else onError(result.message);
                      })
                      .catch(onError)
                      .finally(() => setTesting(null));
                  }}
                >
                  Test
                </Button>
                <IconButton
                  label={`Edit ${connection.name}`}
                  onClick={() => {
                    setKey("");
                    setEditing(structuredClone(connection));
                  }}
                >
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label={`Delete ${connection.name}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete connection “${connection.name}”? Nodes using it will need another connection.`,
                      )
                    )
                      void api
                        .deleteConnection(connection.id)
                        .then(refresh)
                        .catch(onError);
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<PlugZap size={32} />}
          title="Bring your own intelligence"
          description="Your keys stay on this device. Add OpenAI, Anthropic, Gemini, Jev, or connect an Ollama or LM Studio server."
        />
      )}
      <Notice>
        Flows reference connections by name. API keys are never included when
        you export a flow. Local models run on the server you configure.
      </Notice>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name || "Add AI connection"}
        description="Relay uses your credentials and your selected model."
      >
        {editing ? (
          <div className="form-stack">
            <Field label="Connection name">
              <input
                autoFocus
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                placeholder="My local vision model"
              />
            </Field>
            <Field label="Provider">
              <Select
                value={editing.provider}
                onChange={(e) => {
                  const provider = e.target.value as ProviderKind;
                  setEditing({
                    ...editing,
                    provider,
                    baseUrl: providers[provider].baseUrl,
                    model: providers[provider].model,
                  });
                }}
              >
                {Object.entries(providers).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Endpoint">
              <input
                value={editing.baseUrl}
                onChange={(e) =>
                  setEditing({ ...editing, baseUrl: e.target.value })
                }
                placeholder="https://your-provider.example/v1"
              />
            </Field>
            <Field label="Model ID">
              <input
                value={editing.model}
                onChange={(e) =>
                  setEditing({ ...editing, model: e.target.value })
                }
                placeholder="The model name provided by your server"
              />
            </Field>
            <Field
              label={editing.hasKey ? "Replace API key (optional)" : "API key"}
              help={
                !workspace.desktop
                  ? "Keys cannot be stored in the web preview. Add them in the desktop app."
                  : "Stored locally using the operating system credential protection when available."
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={!workspace.desktop}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  editing.hasKey
                    ? "•••••••• · already configured"
                    : "Optional for local servers"
                }
              />
            </Field>
            <h4 className="setting-label">MODEL CAPABILITIES</h4>
            <div className="checkbox-row">
              {(["text", "vision", "structured"] as const).map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={editing.capabilities[capability]}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        capabilities: {
                          ...editing.capabilities,
                          [capability]: e.target.checked,
                        },
                      })
                    }
                  />
                  {capability === "structured"
                    ? "Structured output"
                    : capability[0].toUpperCase() + capability.slice(1)}
                </label>
              ))}
            </div>
            {editing.provider === "jev" ? (
              <label className="toggle-row">
                <span>
                  <strong>Enable experimental vision</strong>
                  <small>Use Jev image decisions and localization</small>
                </span>
                <input
                  type="checkbox"
                  checked={editing.experimentalVision ?? false}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      experimentalVision: e.target.checked,
                      capabilities: {
                        ...editing.capabilities,
                        vision: e.target.checked,
                      },
                    })
                  }
                />
              </label>
            ) : null}
            {editing.provider === "jev" ? (
              <Notice>
                Vision compatibility depends on the selected Jev model and
                endpoint. Test the connection before using it in a workflow.
              </Notice>
            ) : null}
            <div className="modal-actions">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void save()}>
                Save connection
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
function Sparkle() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7L12 2Z" />
    </svg>
  );
}
function Targets({ workspace, api, refresh, onError, onSuccess }: Props) {
  const [editing, setEditing] = useState<TargetDescriptor | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      if (!editing.name.trim()) throw new Error("Give the application a name.");
      await api.saveTarget(editing);
      await refresh();
      setEditing(null);
      onSuccess("Application saved.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-title with-action">
        <div>
          <h2>Connect your workspace</h2>
          <p>Define the applications and browsers your flows control.</p>
        </div>
        <Button
          variant="primary"
          onClick={() =>
            setEditing({ id: uid(), name: "", kind: "desktop", launch: {} })
          }
        >
          <Plus size={14} /> Add application
        </Button>
      </div>
      <div className="target-grid">
        {workspace.targets.map((target) => (
          <div className="target-card" key={target.id}>
            <span
              className={`node-icon large ${target.kind === "browser" ? "cyan" : "blue"}`}
            >
              {target.kind === "browser" ? (
                <Globe size={22} />
              ) : (
                <Monitor size={22} />
              )}
            </span>
            <div>
              <h3>{target.name}</h3>
              <p>
                {target.kind === "browser"
                  ? target.browserMode === "extension"
                    ? "Existing browser · companion extension"
                    : `Managed browser · ${target.profile || "default profile"}`
                  : target.windowTitle ||
                    target.application ||
                    "Desktop application"}
              </p>
              <small>{target.url || target.id.slice(0, 8)}</small>
            </div>
            <div className="card-actions">
              <IconButton
                label={`Edit ${target.name}`}
                onClick={() => setEditing(structuredClone(target))}
              >
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label={`Delete ${target.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove “${target.name}”? This does not close or uninstall the application.`,
                    )
                  )
                    void api
                      .deleteTarget(target.id)
                      .then(refresh)
                      .catch(onError);
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
      {!workspace.targets.length ? (
        <EmptyState
          icon={<Monitor size={32} />}
          title="A place to start"
          description="Add a desktop application or a browser profile, then use it in any flow."
        />
      ) : null}
      <BrowserPairing api={api} desktop={workspace.desktop} onError={onError} />
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.name || "Add application"}
        description="A reusable target for your automation steps."
      >
        {editing ? (
          <div className="form-stack">
            <Field label="Name">
              <input
                autoFocus
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                placeholder="Work browser"
              />
            </Field>
            <Field label="Target type">
              <Select
                value={editing.kind}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    kind: e.target.value as "desktop" | "browser",
                    ...(e.target.value === "browser"
                      ? { browserMode: "managed" }
                      : {}),
                  })
                }
              >
                <option value="desktop">Desktop application</option>
                <option value="browser">Browser</option>
              </Select>
            </Field>
            {editing.kind === "browser" ? (
              <>
                <Field label="Browser connection">
                  <Select
                    value={editing.browserMode ?? "managed"}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        browserMode: e.target.value as "managed" | "extension",
                      })
                    }
                  >
                    <option value="managed">Managed browser profile</option>
                    <option value="extension">
                      Existing browser with extension
                    </option>
                  </Select>
                </Field>
                {editing.browserMode === "extension" ? (
                  <Notice>
                    Install the Relay companion extension in your existing
                    browser. Its permissions and login session will be used for
                    this target.
                  </Notice>
                ) : (
                  <Field
                    label="Profile name"
                    help="Different profiles have isolated cookies and can run independently."
                  >
                    <input
                      value={editing.profile ?? ""}
                      onChange={(e) =>
                        setEditing({ ...editing, profile: e.target.value })
                      }
                      placeholder="work"
                    />
                  </Field>
                )}
                <Field label="Starting URL">
                  <input
                    value={editing.url ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, url: e.target.value })
                    }
                    placeholder="https://example.com"
                  />
                </Field>
              </>
            ) : (
              <>
                {workspace.capabilities.windows.length ? (
                  <Field label="Choose an open window">
                    <Select
                      value=""
                      onChange={(e) => {
                        const win = workspace.capabilities.windows.find(
                          (w) => w.id === e.target.value,
                        );
                        if (win)
                          setEditing({
                            ...editing,
                            windowTitle: win.title,
                            application: win.application,
                          });
                      }}
                    >
                      <option value="">Select a window…</option>
                      {workspace.capabilities.windows.map((win) => (
                        <option key={win.id} value={win.id}>
                          {win.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label="Window title match">
                  <input
                    value={editing.windowTitle ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, windowTitle: e.target.value })
                    }
                    placeholder="Part of the window title"
                  />
                </Field>
                <Field label="Application name">
                  <input
                    value={editing.application ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, application: e.target.value })
                    }
                    placeholder="e.g. Text Editor"
                  />
                </Field>
                <JsonField
                  label="Launch commands by platform"
                  value={(editing.launch ?? {}) as Json}
                  onChange={(value) => {
                    if (
                      value &&
                      typeof value === "object" &&
                      !Array.isArray(value)
                    )
                      setEditing({
                        ...editing,
                        launch: value as TargetDescriptor["launch"],
                      });
                  }}
                  help={
                    'Example: {"linux":{"command":"gedit","args":[]}}. Platforms: linux, win32, darwin.'
                  }
                />
              </>
            )}
            <div className="modal-actions">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void save()}>
                Save application
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function BrowserPairing({
  api,
  desktop,
  onError,
}: {
  api: RelayAPI;
  desktop: boolean;
  onError: (error: unknown) => void;
}) {
  const [details, setDetails] = useState<{
    port: number;
    token: string;
    connected: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="browser-pairing">
      <div className="section-title">
        <h3>Use a browser you already know</h3>
        <p>
          Pair the Relay companion extension to automate your existing tabs and
          login sessions.
        </p>
      </div>
      {details ? (
        <>
          <Notice kind={details.connected ? "success" : "info"}>
            {details.connected
              ? "Your companion extension is connected."
              : "Waiting for the companion extension to connect."}
          </Notice>
          <Field label="Local bridge port">
            <input
              readOnly
              value={details.port}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Field
            label="Pairing token"
            help="Enter this token in the extension settings. Treat it as a local access credential."
          >
            <input
              readOnly
              value={details.token}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
            />
          </Field>
          <p className="muted small">
            Load the extension folder from your Relay installation using your
            browser’s developer extension tools, click its toolbar icon, and
            enter this port and token.
          </p>
        </>
      ) : null}
      <Button
        disabled={!desktop}
        busy={busy}
        onClick={() => {
          setBusy(true);
          void api
            .browserBridge()
            .then(setDetails)
            .catch(onError)
            .finally(() => setBusy(false));
        }}
      >
        <KeyRound size={14} />
        {details ? "Refresh pairing status" : "Reveal pairing details"}
      </Button>
      {details ? (
        <Button variant="ghost" onClick={() => setDetails(null)}>
          Hide details
        </Button>
      ) : null}
    </section>
  );
}
