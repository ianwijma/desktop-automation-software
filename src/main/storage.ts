import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  AIConnection,
  AppSettings,
  FlowDefinition,
  FlowSaveOptions,
  FlowSaveResult,
  RunRecord,
  Schedule,
  TargetDescriptor,
  RecordingState,
  RecordingInsertOptions,
  RecordingInsertResult,
} from "../shared/types";
import {
  createSeedFlows,
  defaultSettings,
  defaultTargets,
} from "../shared/seed";
import { migrateFlow, prepareFlowSave } from "../shared/flow-persistence";
import {
  applyRecording,
  createRecordingFlow,
  emptyRecording,
  recoverRecording,
} from "../shared/recording";
import {
  connectionSchema,
  jsonSchema,
  scheduleSchema,
  settingsSchema,
  targetSchema,
  recordingStateSchema,
  recordingInsertSchema,
  boundedJson,
} from "../shared/validation";

const recordingEnvelopeSchema = z.object({
  version: z.literal(1),
  state: recordingStateSchema,
});
const recordingReceiptSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  revision: z.number().int().positive(),
  flowId: z.string(),
});

const STORAGE_VERSION = 2;
const TABLES = ["entities", "metadata", "credentials"];
const CREATE_TABLES =
  "CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);";
const timestamp = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Invalid history timestamp",
  );
const runSchema = z.object({
  id: z.string().min(1),
  flowId: z.string().min(1),
  flowName: z.string(),
  revision: z.number().int().positive(),
  parentId: z.string().optional(),
  rootId: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "skipped",
  ]),
  trigger: z.enum(["manual", "hotkey", "schedule", "child"]),
  inputs: z.record(z.string(), jsonSchema),
  outputs: z.record(z.string(), jsonSchema),
  createdAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  currentNodeId: z.string().optional(),
  error: z.string().optional(),
  events: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      at: timestamp,
      type: z.enum(["run", "node", "log", "error"]),
      nodeId: z.string().optional(),
      status: z.string().optional(),
      message: z.string(),
      data: jsonSchema.optional(),
    }),
  ),
  childIds: z.array(z.string()),
});

function inspectDatabase(db: DatabaseSync) {
  const version = (
    db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;
  if (![0, 1, STORAGE_VERSION].includes(version))
    throw new Error(
      `This database uses storage schema ${version}, which this version of Relay cannot open.`,
    );
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  if (tables.size && !tables.has("entities"))
    throw new Error("This is not a recognized Relay database.");
  const rows = tables.has("entities")
    ? (db.prepare("SELECT collection, id, value FROM entities").all() as {
        collection: string;
        id: string;
        value: string;
      }[])
    : [];
  const flows: { flow: FlowDefinition; changed: boolean }[] = [];
  for (const row of rows) {
    const original: unknown = JSON.parse(row.value);
    if (row.collection === "flows") {
      const migrated = migrateFlow(original);
      if (migrated.id !== row.id)
        throw new Error(`Workflow ${row.id} has an inconsistent stored ID.`);
      flows.push({
        flow: migrated,
        changed: (original as { schemaVersion: number }).schemaVersion !== 2,
      });
    } else {
      const schema =
        row.collection === "runs"
          ? runSchema
          : row.collection === "targets"
            ? targetSchema
            : row.collection === "connections"
              ? connectionSchema
              : row.collection === "schedules"
                ? scheduleSchema
                : undefined;
      if (schema && schema.parse(original).id !== row.id)
        throw new Error(
          `Stored ${row.collection} entry ${row.id} has an inconsistent ID.`,
        );
    }
  }
  const initialized = tables.has("metadata")
    ? (db
        .prepare("SELECT value FROM metadata WHERE key='initialized'")
        .get() as { value: string } | undefined)
    : undefined;
  const initialize =
    !initialized || !z.boolean().parse(JSON.parse(initialized.value));
  const settings = tables.has("metadata")
    ? (db.prepare("SELECT value FROM metadata WHERE key='settings'").get() as
        { value: string } | undefined)
    : undefined;
  const storedSettings = settings
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(settings.value))
    : {};
  settingsSchema.parse({ ...defaultSettings, ...storedSettings });
  if (tables.has("metadata")) {
    for (const [key, schema] of [
      ["recordingDraft", recordingEnvelopeSchema],
      ["recordingInsertion", recordingReceiptSchema],
    ] as const) {
      const row = db
        .prepare("SELECT value FROM metadata WHERE key=?")
        .get(key) as { value: string } | undefined;
      if (row) schema.parse(JSON.parse(row.value));
    }
  }
  return {
    flows,
    initialize,
    needsMigration:
      version < STORAGE_VERSION ||
      TABLES.some((table) => !tables.has(table)) ||
      flows.some((item) => item.changed) ||
      initialize,
  };
}

function backupDatabase(source: DatabaseSync, path: string): string {
  const backupPath = `${path}.backup-${Date.now()}-${randomUUID()}.sqlite`;
  // VACUUM INTO accepts an empty file and produces a self-contained snapshot,
  // including committed pages still in the source WAL.
  closeSync(openSync(backupPath, "wx", 0o600));
  try {
    source.prepare("VACUUM INTO ?").run(backupPath);
    const handle = openSync(backupPath, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return backupPath;
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  }
}

type Collections = {
  flows: FlowDefinition;
  targets: TargetDescriptor;
  connections: AIConnection;
  runs: RunRecord;
  schedules: Schedule;
};
export class Storage {
  private db: DatabaseSync;
  private backupPath?: string;
  get migrationBackupPath(): string | undefined {
    return this.backupPath;
  }
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    let source: DatabaseSync | undefined;
    let opened: DatabaseSync | undefined;
    try {
      if (path !== ":memory:" && existsSync(path) && statSync(path).size > 0) {
        source = new DatabaseSync(path, { readOnly: true });
        // Reject unknown versions before any writable connection, schema setup,
        // run recovery, or journal-mode changes can modify an existing database.
        inspectDatabase(source);
      }
      this.db = opened = new DatabaseSync(path);
      this.db.exec("PRAGMA foreign_keys=ON;");
      // Keep an existing database's journal mode: changing it after COMMIT can
      // fail independently and would report a failed startup after migration.
      if (!source) this.db.exec("PRAGMA journal_mode=WAL;");
      this.transaction(() => {
        const state = inspectDatabase(this.db);
        if (state.needsMigration) {
          // BEGIN IMMEDIATE prevents another writer from changing the source
          // between this snapshot and the migration commit.
          if (source) this.backupPath = backupDatabase(source, path);
          this.db.exec(CREATE_TABLES);
          for (const item of state.flows)
            if (item.changed) this.put("flows", item.flow);
          if (state.initialize) {
            if (!state.flows.length)
              createSeedFlows().forEach((flow) =>
                this.put("flows", migrateFlow(flow)),
              );
            for (const target of defaultTargets)
              if (!this.get("targets", target.id)) this.put("targets", target);
            if (!this.meta("settings"))
              this.setMeta("settings", defaultSettings);
            this.setMeta("initialized", true);
          }
          this.db.exec(`PRAGMA user_version=${STORAGE_VERSION}`);
        }
        for (const run of this.list("runs")) {
          if (["running", "paused", "queued"].includes(run.status))
            this.put("runs", {
              ...run,
              status: "interrupted",
              error:
                "The application stopped before this run completed. Review it before running again.",
              finishedAt: new Date().toISOString(),
            });
        }
        this.pruneHistoryRows(this.settings().historyRetentionDays);
        const draft = this.recording();
        if (draft.phase !== "idle")
          this.setMeta("recordingDraft", {
            version: 1,
            state: recoverRecording(draft),
          });
      });
    } catch (error) {
      opened?.close();
      throw error;
    } finally {
      source?.close();
    }
  }
  saveFlow(flow: FlowDefinition, options: FlowSaveOptions): FlowSaveResult {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const result = prepareFlowSave(
        {
          ...flow,
          createdAt: options.expectedRevision === null ? now : flow.createdAt,
          updatedAt: now,
        },
        this.get("flows", flow.id),
        options.expectedRevision,
      );
      if (result.status === "saved") this.put("flows", result.flow);
      return result;
    });
  }
  recording(): RecordingState {
    const envelope = this.meta<unknown>("recordingDraft");
    return envelope === undefined
      ? emptyRecording()
      : recordingEnvelopeSchema.parse(envelope).state;
  }
  /** The utility process awaits this durable write before acknowledging edits. */
  saveRecording(candidate: RecordingState): RecordingState {
    boundedJson(candidate);
    const state = recordingStateSchema.parse(candidate);
    return this.transaction(() => {
      const current = this.recording();
      const receipt =
        this.meta<z.infer<typeof recordingReceiptSchema>>("recordingInsertion");
      if (state.sessionId && receipt?.sessionId === state.sessionId)
        throw new Error(
          "This recording has already been inserted. Refresh the workspace to open its workflow.",
        );
      if (state.phase !== "idle" && current.phase !== "idle") {
        if (state.sessionId !== current.sessionId)
          throw new Error(
            "Review or discard the existing recording before starting another.",
          );
        if (
          state.revision < current.revision ||
          (state.revision === current.revision &&
            JSON.stringify(state) !== JSON.stringify(current))
        )
          throw new Error(
            "The recording changed. Reload its current draft before editing.",
          );
        if (
          JSON.stringify(state.destination) !==
          JSON.stringify(current.destination)
        )
          throw new Error(
            "The recording destination cannot change during a session.",
          );
      }
      this.setMeta("recordingDraft", { version: 1, state });
      return state;
    });
  }
  /** Saving the graph, consuming the draft, and the retry receipt commit together. */
  insertRecording(
    candidate: RecordingState,
    options: RecordingInsertOptions,
  ): RecordingInsertResult {
    boundedJson(candidate);
    const state = recordingStateSchema.parse(candidate);
    const choice = recordingInsertSchema.parse(options);
    return this.transaction(() => {
      const receipt =
        this.meta<z.infer<typeof recordingReceiptSchema>>("recordingInsertion");
      if (
        receipt &&
        receipt.sessionId === state.sessionId &&
        receipt.revision === state.revision
      ) {
        const flow = this.get("flows", receipt.flowId);
        if (!flow)
          throw new Error(
            "This recording was already inserted, but its workflow has since been deleted.",
          );
        return { flow, recording: emptyRecording() };
      }
      const current = this.recording();
      if (
        current.phase !== "review" ||
        state.phase !== "review" ||
        current.sessionId !== state.sessionId ||
        current.revision !== state.revision ||
        JSON.stringify(state) !== JSON.stringify(current)
      )
        throw new Error(
          "The recording changed. Review the current draft before inserting.",
        );
      const existing =
        choice.destination === "bound"
          ? this.get("flows", state.destination!.flowId)
          : undefined;
      if (choice.destination === "bound" && !existing)
        throw new Error(
          "The destination workflow was deleted. Create a new workflow from this recording instead.",
        );
      const authored = existing
        ? applyRecording(existing, state, randomUUID)
        : createRecordingFlow(state, choice.name, randomUUID);
      const prepared = prepareFlowSave(
        authored,
        existing,
        existing?.revision ?? null,
      );
      if (prepared.status !== "saved") throw new Error(prepared.reason);
      const flow = { ...prepared.flow, updatedAt: new Date().toISOString() };
      this.put("flows", flow);
      const recording = emptyRecording();
      this.setMeta("recordingDraft", { version: 1, state: recording });
      this.setMeta("recordingInsertion", {
        version: 1,
        sessionId: state.sessionId,
        revision: state.revision,
        flowId: flow.id,
      });
      return { flow, recording };
    });
  }
  list<K extends keyof Collections>(collection: K): Collections[K][] {
    return (
      this.db
        .prepare("SELECT value FROM entities WHERE collection=? ORDER BY rowid")
        .all(collection) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  get<K extends keyof Collections>(
    collection: K,
    id: string,
  ): Collections[K] | undefined {
    const row = this.db
      .prepare("SELECT value FROM entities WHERE collection=? AND id=?")
      .get(collection, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  put<K extends keyof Collections>(
    collection: K,
    value: Collections[K],
  ): Collections[K] {
    this.db
      .prepare(
        "INSERT INTO entities(collection,id,value) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value",
      )
      .run(collection, value.id, JSON.stringify(value));
    return value;
  }
  delete(collection: keyof Collections, id: string) {
    this.db
      .prepare("DELETE FROM entities WHERE collection=? AND id=?")
      .run(collection, id);
  }
  meta<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  settings(): AppSettings {
    return { ...defaultSettings, ...this.meta<AppSettings>("settings") };
  }
  credential(id: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM credentials WHERE id=?").get(id) as
        { value: string } | undefined
    )?.value;
  }
  setCredential(id: string, encrypted: string) {
    this.db
      .prepare(
        "INSERT INTO credentials(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, encrypted);
  }
  deleteCredential(id: string) {
    this.db.prepare("DELETE FROM credentials WHERE id=?").run(id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite already rolled back.
      }
      throw error;
    }
  }
  pruneHistory(days: number) {
    this.transaction(() => this.pruneHistoryRows(days));
  }
  private pruneHistoryRows(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    const trees = new Map<string, RunRecord[]>();
    for (const run of this.list("runs")) {
      const tree = trees.get(run.rootId) ?? [];
      tree.push(run);
      trees.set(run.rootId, tree);
    }
    for (const tree of trees.values()) {
      if (
        tree.every(
          (run) =>
            run.finishedAt &&
            Date.parse(run.finishedAt) < cutoff &&
            !["running", "paused", "queued"].includes(run.status),
        )
      ) {
        for (const run of tree) this.delete("runs", run.id);
      }
    }
  }
  close() {
    this.db.close();
  }
}
