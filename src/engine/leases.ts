export class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "CancelledError";
  }
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new CancelledError();
}

/** Atomic resource sets, with ancestor inheritance and sibling exclusion. */
export class ResourceLeases {
  private holders = new Map<string, Set<string>>();
  private waiters = new Set<() => void>();

  async acquire(
    owner: string,
    resources: readonly string[],
    ancestors: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<() => void> {
    const keys = [...new Set(resources)].sort();
    while (true) {
      throwIfAborted(signal);
      const available = keys.every((key) =>
        [...(this.holders.get(key) ?? [])].every((holder) =>
          ancestors.has(holder),
        ),
      );
      if (available) {
        for (const key of keys) {
          if (!this.holders.has(key)) this.holders.set(key, new Set());
          this.holders.get(key)!.add(owner);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          for (const key of keys) {
            this.holders.get(key)?.delete(owner);
            if (!this.holders.get(key)?.size) this.holders.delete(key);
          }
          for (const wake of [...this.waiters]) wake();
        };
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new CancelledError(),
          );
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : new CancelledError(),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
