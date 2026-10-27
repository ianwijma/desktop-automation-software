export interface DiagnosticRequest {
  controller: AbortController;
  connectionId?: string;
}
export class DiagnosticRequests {
  private active = new Map<string, DiagnosticRequest>();
  start(id: string, connectionId?: string): DiagnosticRequest {
    if (this.active.has(id))
      throw new Error("This diagnostic request ID is already active.");
    if (this.active.size >= 4)
      throw new Error(
        "Four diagnostics are already active. Cancel or wait for one to finish.",
      );
    const record = {
      controller: new AbortController(),
      ...(connectionId ? { connectionId } : {}),
    };
    this.active.set(id, record);
    return record;
  }
  cancel(id: string) {
    const record = this.active.get(id);
    if (!record) return false;
    record.controller.abort();
    return true;
  }
  cancelConnection(connectionId: string) {
    const ids: string[] = [];
    for (const [id, record] of this.active)
      if (record.connectionId === connectionId) {
        record.controller.abort();
        ids.push(id);
      }
    return ids;
  }
  finish(id: string, record: DiagnosticRequest) {
    if (this.active.get(id) === record) this.active.delete(id);
  }
}
