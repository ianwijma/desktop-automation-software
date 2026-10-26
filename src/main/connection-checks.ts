import type { AIConnection } from "../shared/types";
import {
  sameConnectionRevision,
  type AICheckOperation,
} from "../shared/ai-connections";
// Runtime tokens also prevent delete/recreate and superseded-probe races where revisions coincide.
export class ConnectionCheckTracker {
  private pending = new Map<string, Map<AICheckOperation, symbol>>();
  begin(connection: AIConnection, operation: AICheckOperation) {
    const token = Symbol(),
      operations =
        this.pending.get(connection.id) ?? new Map<AICheckOperation, symbol>();
    operations.set(operation, token);
    this.pending.set(connection.id, operations);
    return token;
  }
  invalidate(id: string) {
    this.pending.delete(id);
  }
  accept(
    snapshot: AIConnection,
    current: AIConnection | undefined,
    operation: AICheckOperation,
    token: symbol,
  ) {
    const operations = this.pending.get(snapshot.id);
    if (operations?.get(operation) !== token) return false;
    operations.delete(operation);
    if (!operations.size) this.pending.delete(snapshot.id);
    return Boolean(current && sameConnectionRevision(snapshot, current));
  }
}
