import { describe, expect, it, vi } from "vitest";
import { Storage } from "../src/main/storage";
import { syncSavedFlow } from "../src/main/flow-sync";

describe("committed saves and runner synchronization", () => {
  it("acknowledges the committed revision when the runner cannot refresh", async () => {
    const store = new Storage(":memory:");
    try {
      const original = store.list("flows")[0];
      const committed = store.saveFlow(
        { ...original, name: "Saved while runner failed" },
        { expectedRevision: original.revision },
      );
      const sync = vi.fn(async () => {
        throw new Error("private transport diagnostics");
      });
      const acknowledged = await syncSavedFlow(committed, sync);
      expect(acknowledged).toMatchObject({
        status: "saved",
        flow: {
          name: "Saved while runner failed",
          revision: original.revision + 1,
        },
        warning: expect.stringContaining("Flow saved"),
      });
      expect(JSON.stringify(acknowledged)).not.toContain("private transport");
      expect(store.get("flows", original.id)?.revision).toBe(
        original.revision + 1,
      );
      expect(sync).toHaveBeenCalledOnce();
      const conflict = store.saveFlow(original, {
        expectedRevision: original.revision,
      });
      sync.mockClear();
      expect(await syncSavedFlow(conflict, sync)).toEqual(conflict);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
