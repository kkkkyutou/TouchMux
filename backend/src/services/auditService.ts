import fs from "node:fs";
import path from "node:path";

interface AuditEvent {
  action: string;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export class AuditService {
  private readonly auditLogPath: string;

  constructor(dataDir: string) {
    this.auditLogPath = path.join(dataDir, "audit.jsonl");
  }

  record(event: AuditEvent): void {
    const payload = {
      at: new Date().toISOString(),
      action: event.action,
      ip: event.ip ?? null,
      detail: event.detail ?? {},
    };
    fs.appendFileSync(this.auditLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  }
}
