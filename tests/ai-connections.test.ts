import { describe, it, expect } from "vitest";
import {
  connectionCheckState,
  prepareConnectionSave,
  unsupportedCheck,
  type AIConnectionCheck,
} from "../src/shared/ai-connections";
import { ConnectionCheckTracker } from "../src/main/connection-checks";
import { connectionSchema } from "../src/shared/validation";
import type { AIConnection } from "../src/shared/types";
const connection: AIConnection = {
  id: "fixture",
  name: "Fixture",
  provider: "ollama",
  model: "local",
  baseUrl: "http://localhost:11434",
  capabilities: { text: true, vision: true, structured: true },
  hasKey: false,
};
const passed: AIConnectionCheck = {
  operation: "text",
  status: "passed",
  message: "Text passed",
  at: new Date().toISOString(),
  connectionRevision: 1,
  credentialRevision: 0,
};
describe("operation-specific connection evidence", () => {
  it("does not promote legacy or text results to other operation passes", () => {
    const legacy = {
      ...connection,
      lastTest: {
        ok: true,
        message: "Connected",
        at: new Date().toISOString(),
      },
    };
    expect(connectionCheckState(legacy, "text").status).toBe("untested");
    const current = { ...connection, revision: 1, checks: { text: passed } };
    expect(connectionCheckState(current, "text").status).toBe("passed");
    for (const op of [
      "decision",
      "structured",
      "image",
      "localization",
    ] as const)
      expect(connectionCheckState(current, op).status).toBe("untested");
  });
  it("invalidates model, endpoint, capability and key changes, preserving old evidence as stale", () => {
    const previous = {
      ...connection,
      revision: 1,
      credentialRevision: 0,
      checks: { text: passed },
    };
    for (const draft of [
      { ...previous, model: "another" },
      { ...previous, baseUrl: "http://other:1234" },
      {
        ...previous,
        capabilities: { ...previous.capabilities, vision: false },
      },
      { ...previous, experimentalVision: true },
    ]) {
      const saved = prepareConnectionSave(previous, draft, false);
      expect(saved.revision).toBe(2);
      expect(connectionCheckState(saved, "text").status).toBe("stale");
    }
    const changed = prepareConnectionSave(previous, previous, true);
    expect(changed.credentialRevision).toBe(1);
    expect(connectionCheckState(changed, "text").status).toBe("stale");
    expect(
      connectionCheckState(
        prepareConnectionSave(
          previous,
          { ...previous, name: "Renamed" },
          false,
        ),
        "text",
      ).status,
    ).toBe("passed");
  });
  it("ignores evidence/revision fields submitted by a draft", () => {
    const fake = {
      ...connection,
      revision: 1000,
      credentialRevision: 1000,
      checks: { text: passed },
    };
    const fresh = prepareConnectionSave(undefined, fake, false);
    expect(fresh.revision).toBe(1);
    expect(fresh.credentialRevision).toBe(0);
    expect(fresh.checks).toBeUndefined();
    expect(connectionSchema.parse(fresh)).toMatchObject({ revision: 1 });
  });
  it("allows fresh Jev decisions independently of generic structured output", () => {
    const jev = {
      ...connection,
      provider: "jev" as const,
      capabilities: { text: false, vision: false, structured: false },
    };
    expect(unsupportedCheck(jev, "decision")).toBeUndefined();
    expect(connectionCheckState(jev, "text").status).toBe("unsupported");
    expect(connectionCheckState(jev, "structured").status).toBe("unsupported");
    expect(connectionCheckState(jev, "image").status).toBe("unsupported");
  });
  it("discards superseded, edited and deleted/recreated results while preserving independent probes", () => {
    const tracker = new ConnectionCheckTracker(),
      snapshot = { ...connection, revision: 1 };
    const old = tracker.begin(snapshot, "text"),
      newer = tracker.begin(snapshot, "text"),
      image = tracker.begin(snapshot, "image");
    expect(tracker.accept(snapshot, snapshot, "text", old)).toBe(false);
    expect(tracker.accept(snapshot, snapshot, "text", newer)).toBe(true);
    expect(tracker.accept(snapshot, snapshot, "image", image)).toBe(true);
    const edited = tracker.begin(snapshot, "text");
    expect(
      tracker.accept(
        snapshot,
        { ...snapshot, model: "different" },
        "text",
        edited,
      ),
    ).toBe(false);
    const deleted = tracker.begin(snapshot, "text");
    tracker.invalidate(snapshot.id);
    expect(tracker.accept(snapshot, snapshot, "text", deleted)).toBe(false);
    const missing = tracker.begin(snapshot, "text");
    expect(tracker.accept(snapshot, undefined, "text", missing)).toBe(false);
  });
});
