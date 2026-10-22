import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AIConnection,
  AppSettings,
  FlowDefinition,
  RunRecord,
  Schedule,
  TargetDescriptor,
} from "../shared/types";
import {
  createSeedFlows,
  defaultSettings,
  defaultTargets,
} from "../shared/seed";

type Collections = {
  flows: FlowDefinition;
  targets: TargetDescriptor;
  connections: AIConnection;
  runs: RunRecord;
  schedules: Schedule;
};
export class Storage {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    if (!this.meta("initialized")) {
      this.transaction(() => {
        createSeedFlows().forEach((f) => this.put("flows", f));
        defaultTargets.forEach((t) => this.put("targets", t));
        this.setMeta("settings", defaultSettings);
        this.setMeta("initialized", true);
      });
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
    this.pruneHistory(this.settings().historyRetentionDays);
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
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pruneHistory(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    const trees = new Map<string, RunRecord[]>();
    for (const run of this.list("runs")) {
      const tree = trees.get(run.rootId) ?? [];
      tree.push(run);
      trees.set(run.rootId, tree);
    }
    this.transaction(() => {
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
    });
  }
  close() {
    this.db.close();
  }
}
