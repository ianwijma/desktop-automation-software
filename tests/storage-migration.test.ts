import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "../src/main/storage";
import { createSeedFlows, defaultSettings } from "../src/shared/seed";

// Hosted Windows durability checks have completed in 18–22s; keep their assertions
// and a finite file-local budget for filesystem flushes. Production timing is unchanged.
if (process.platform === "win32") vi.setConfig({ testTimeout: 45000 });

const directories: string[] = [];
const handles: { close(): void }[] = [];
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) {
    try {
      handle.close();
    } catch {
      /* A test may already have closed it. */
    }
  }
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), "relay-migration-test-"));
  directories.push(dir);
  return join(dir, "relay.sqlite");
}
function legacyFlow(id = "legacy") {
  const flow = createSeedFlows()[0];
  return {
    ...flow,
    schemaVersion: 1,
    id,
    revision: 27,
    description: "Keep legacy values and references exactly",
    inputs: { value: "${nodes.original.output}" },
    nodes: flow.nodes.map((node) => ({
      ...node,
      config: {
        ...node.config,
        preserved: {
          reference: "${inputs.value}",
          nested: [false, null, "text"],
        },
      },
    })),
  };
}
function fixture(file: string, flows: unknown[] = [legacyFlow()], wal = false) {
  const db = new DatabaseSync(file);
  handles.push(db);
  db.exec(
    "CREATE TABLE entities (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  const insert = db.prepare("INSERT INTO entities VALUES ('flows', ?, ?)");
  for (const flow of flows)
    insert.run((flow as { id: string }).id, JSON.stringify(flow));
  db.prepare("INSERT INTO metadata VALUES ('initialized', 'true')").run();
  db.prepare("INSERT INTO metadata VALUES ('settings', ?)").run(
    JSON.stringify({ ...defaultSettings, accent: "#112233" }),
  );
  db.prepare(
    "INSERT INTO credentials VALUES ('key', 'encrypted-original')",
  ).run();
  return db;
}
function open(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  handles.push(db);
  return db;
}
function rows(db: DatabaseSync) {
  return db.prepare("SELECT * FROM entities ORDER BY collection,id").all();
}
function version(db: DatabaseSync) {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}
function backups(file: string) {
  return readdirSync(dirname(file)).filter((name) => name.includes(".backup-"));
}
const activeRun = {
  id: "active",
  flowId: "legacy",
  flowName: "Legacy",
  revision: 1,
  rootId: "active",
  status: "running",
  trigger: "manual",
  inputs: {},
  outputs: {},
  createdAt: "2026-10-22T00:00:00.000Z",
  events: [],
  childIds: [],
};

describe("storage schema migration", () => {
  it.each([
    { label: "malformed settings JSON", key: "settings", value: "{" },
    { label: "non-object settings", key: "settings", value: "null" },
    {
      label: "invalid retention settings",
      key: "settings",
      value: JSON.stringify({ historyRetentionDays: -1 }),
    },
    { label: "invalid initialized marker", key: "initialized", value: "{}" },
    { label: "malformed run JSON", collection: "runs", value: "{" },
    { label: "null run", collection: "runs", value: "null" },
    {
      label: "invalid run events",
      collection: "runs",
      value: JSON.stringify({ ...activeRun, events: {} }),
    },
    {
      label: "invalid run timestamp",
      collection: "runs",
      value: JSON.stringify({ ...activeRun, finishedAt: "not-a-date" }),
    },
    {
      label: "invalid target",
      collection: "targets",
      value: JSON.stringify({ id: "active", name: "Broken", kind: "unknown" }),
    },
    {
      label: "invalid connection",
      collection: "connections",
      value: JSON.stringify({ id: "active", model: "missing-properties" }),
    },
    {
      label: "invalid schedule",
      collection: "schedules",
      value: JSON.stringify({ id: "active", kind: "unknown" }),
    },
    {
      label: "malformed unknown entity JSON",
      collection: "future-entry",
      value: "{",
    },
  ])("rejects $label before changing the database", (item) => {
    const file = path();
    const old = fixture(file);
    if (item.key)
      old
        .prepare("UPDATE metadata SET value=? WHERE key=?")
        .run(item.value, item.key);
    else
      old
        .prepare("INSERT INTO entities VALUES (?, 'active', ?)")
        .run(item.collection!, item.value);
    const oldRows = rows(old);
    old.close();
    const bytes = readFileSync(file);
    expect(() => new Storage(file)).toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(rows(open(file))).toEqual(oldRows);
    expect(version(open(file))).toBe(0);
    expect(backups(file)).toEqual([]);
  });

  it("rolls back schema changes if history recovery fails after migrating flows", () => {
    const file = path();
    const old = fixture(file);
    old
      .prepare("INSERT INTO entities VALUES ('runs', 'active', ?)")
      .run(JSON.stringify(activeRun));
    old.exec(
      "CREATE TRIGGER reject_recovery BEFORE UPDATE OF value ON entities WHEN OLD.collection='runs' BEGIN SELECT RAISE(ABORT, 'recovery fixture failure'); END;",
    );
    const oldRows = rows(old);
    old.close();
    const bytes = readFileSync(file);
    expect(() => new Storage(file)).toThrow("recovery fixture failure");
    expect(readFileSync(file)).toEqual(bytes);
    expect(rows(open(file))).toEqual(oldRows);
    expect(version(open(file))).toBe(0);
    expect(backups(file)).toHaveLength(1);
  });

  it("preserves unknown metadata without interpreting or rewriting it", () => {
    const file = path();
    const old = fixture(file);
    old
      .prepare(
        "INSERT INTO metadata VALUES ('extension-owned', 'opaque future value')",
      )
      .run();
    old.close();
    const store = new Storage(file);
    handles.push(store);
    expect(
      open(file)
        .prepare("SELECT value FROM metadata WHERE key='extension-owned'")
        .get(),
    ).toMatchObject({ value: "opaque future value" });
  });

  it("backs up legacy data and migrates envelopes without changing revisions or references", () => {
    const file = path();
    const flow = legacyFlow();
    const old = fixture(file, [flow]);
    const oldRows = rows(old);
    old.close();
    const store = new Storage(file);
    handles.push(store);
    expect(store.get("flows", flow.id)).toEqual({ ...flow, schemaVersion: 2 });
    expect(store.settings().accent).toBe("#112233");
    expect(store.credential("key")).toBe("encrypted-original");
    expect(store.migrationBackupPath).toBeTruthy();
    const backup = open(store.migrationBackupPath!);
    expect(rows(backup)).toEqual(oldRows);
    expect(version(backup)).toBe(0);
    expect(version(open(file))).toBe(2);
    if (process.platform !== "win32")
      expect(statSync(store.migrationBackupPath!).mode & 0o777).toBe(0o600);
    store.close();
    const reopened = new Storage(file);
    handles.push(reopened);
    expect(reopened.migrationBackupPath).toBeUndefined();
    expect(backups(file)).toHaveLength(1);
  });

  it("includes committed WAL pages in a consistent backup", () => {
    const file = path();
    const old = fixture(file, [legacyFlow()], true);
    old
      .prepare(
        "UPDATE entities SET value=? WHERE collection='flows' AND id='legacy'",
      )
      .run(JSON.stringify({ ...legacyFlow(), name: "Latest WAL edit" }));
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const oldRows = rows(old);
    const store = new Storage(file);
    handles.push(store);
    expect(rows(open(store.migrationBackupPath!))).toEqual(oldRows);
    expect(store.get("flows", "legacy")?.name).toBe("Latest WAL edit");
  });

  it("rolls back a failed migration while retaining its pre-migration backup", () => {
    const file = path();
    const old = fixture(file, [legacyFlow("one"), legacyFlow("two")]);
    old.exec(
      "CREATE TRIGGER reject_migration BEFORE UPDATE OF value ON entities WHEN OLD.id='two' BEGIN SELECT RAISE(ABORT, 'migration fixture failure'); END;",
    );
    const oldRows = rows(old);
    old.close();
    const bytes = readFileSync(file);
    expect(() => new Storage(file)).toThrow("migration fixture failure");
    expect(readFileSync(file)).toEqual(bytes);
    const unchanged = open(file);
    expect(rows(unchanged)).toEqual(oldRows);
    expect(version(unchanged)).toBe(0);
    expect(backups(file)).toHaveLength(1);
    expect(rows(open(join(dirname(file), backups(file)[0])))).toEqual(oldRows);
  });

  it.each(["storage", "workflow"])(
    "rejects a future %s schema before changing or initializing the database",
    (kind) => {
      const file = path();
      const old = fixture(file, [
        { ...legacyFlow(), schemaVersion: kind === "workflow" ? 9 : 1 },
      ]);
      old.exec("DELETE FROM metadata WHERE key='initialized';");
      if (kind === "storage") old.exec("PRAGMA user_version=9;");
      const oldRows = rows(old);
      old.close();
      const bytes = readFileSync(file);
      expect(() => new Storage(file)).toThrow(/schema/i);
      expect(readFileSync(file)).toEqual(bytes);
      expect(backups(file)).toEqual([]);
      const unchanged = open(file);
      expect(rows(unchanged)).toEqual(oldRows);
      expect(
        unchanged
          .prepare("SELECT value FROM metadata WHERE key='initialized'")
          .get(),
      ).toBeUndefined();
    },
  );

  it("rejects malformed legacy data before backing up or modifying any flow", () => {
    const file = path();
    const old = fixture(file, [
      legacyFlow("valid"),
      { ...legacyFlow("invalid"), nodes: "broken" },
    ]);
    const oldRows = rows(old);
    old.close();
    const bytes = readFileSync(file);
    expect(() => new Storage(file)).toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(rows(open(file))).toEqual(oldRows);
    expect(backups(file)).toEqual([]);
  });

  it("does not replace existing workflows when initialization metadata is absent", () => {
    const file = path();
    const flow = legacyFlow("welcome");
    const old = fixture(file, [flow]);
    old.exec("DELETE FROM metadata WHERE key='initialized';");
    old.close();
    const store = new Storage(file);
    handles.push(store);
    expect(store.list("flows")).toEqual([{ ...flow, schemaVersion: 2 }]);
    expect(store.settings().accent).toBe("#112233");
    expect(store.meta("initialized")).toBe(true);
  });

  it("creates current in-memory databases without a backup", () => {
    const store = new Storage(":memory:");
    handles.push(store);
    expect(store.migrationBackupPath).toBeUndefined();
    expect(store.list("flows").every((flow) => flow.schemaVersion === 2)).toBe(
      true,
    );
  });
});
