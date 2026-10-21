import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function desktopArgument(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new Error(
      "The application path cannot be used for automatic startup.",
    );
  return `"${value.replace(/%/g, "%%").replace(/[\\"`$]/g, "\\$&")}"`;
}

export function linuxAutostartEntry(
  executable: string,
  appPath?: string,
): string {
  const command = [executable, ...(appPath ? [appPath] : [])]
    .map(desktopArgument)
    .join(" ");
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Relay\nComment=Desktop automation workflows\nExec=${command}\nTerminal=false\nCategories=Utility;\nX-GNOME-Autostart-enabled=true\n`;
}

export async function setLinuxAutostart(
  configDir: string,
  enabled: boolean,
  executable: string,
  appPath?: string,
): Promise<void> {
  const directory = join(configDir, "autostart");
  const path = join(directory, "dev.relay.desktop.desktop");
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  const contents = linuxAutostartEntry(executable, appPath);
  await mkdir(directory, { recursive: true });
  await writeFile(path, contents, { mode: 0o600 });
}
