import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { linuxAutostartEntry, setLinuxAutostart } from "../src/main/autostart";

it("escapes desktop entry arguments and rejects line injection", () => {
  expect(
    linuxAutostartEntry("/opt/Relay App/relay", '/tmp/a%"$`\\b'),
  ).toContain('Exec="/opt/Relay App/relay" "/tmp/a%%\\"\\$\\`\\\\b"');
  expect(() => linuxAutostartEntry("/tmp/app\nHidden=true")).toThrow();
});

it("toggles only Relay’s own autostart entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-autostart-"));
  try {
    await setLinuxAutostart(directory, true, "/opt/relay");
    const other = join(directory, "autostart/other.desktop");
    await writeFile(other, "other");
    expect(
      await readFile(
        join(directory, "autostart/dev.relay.desktop.desktop"),
        "utf8",
      ),
    ).toContain('Exec="/opt/relay"');
    await setLinuxAutostart(directory, false, "/opt/relay");
    await expect(
      readFile(join(directory, "autostart/dev.relay.desktop.desktop")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(other, "utf8")).toBe("other");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
