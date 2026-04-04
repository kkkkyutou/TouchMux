import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexAppServerNotificationCache } from "./codexAppServerNotificationCache.js";

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

export interface CodexAppServerInitializeParams {
  clientInfo: {
    name: string;
    version: string;
    title?: string;
  };
  capabilities: {
    experimentalApi: boolean;
  } | null;
}

export interface CodexAppServerProbeResult {
  ok: boolean;
  userAgent: string | null;
  notifications: string[];
}

export interface CodexAppServerThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  model?: string | null;
  modelProvider?: string | null;
  ephemeral?: boolean | null;
}

export interface CodexAppServerThreadStartResult {
  threadId: string;
  model: string | null;
  cwd: string | null;
}

export interface CodexAppServerThreadReadResult {
  threadId: string;
  cwd: string | null;
  turns?: unknown[];
  rawThread?: Record<string, unknown>;
}

export interface CodexAppServerTurnStartParams {
  threadId: string;
  input: Array<{
    type: "text";
    text: string;
  }>;
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
  sandboxPolicy?:
    | { type: "readOnly" }
    | { type: "workspaceWrite"; writableRoots?: string[]; networkAccess?: boolean; excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean }
    | { type: "dangerFullAccess" }
    | null;
  model?: string | null;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  summary?: "auto" | "none" | "brief" | "detailed" | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
}

export interface CodexAppServerTurnStartResult {
  turnId: string;
  status: string | null;
}

export interface CodexAppServerNotificationRecord {
  method: string;
  params: unknown;
  receivedAt: number;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export class CodexAppServerProbeClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: CodexAppServerNotificationRecord[] = [];

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }
    this.process = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      this.handleStdout(chunk);
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", () => {
      // ignore stderr in probe; initialize() will fail on protocol/runtime errors
    });
    this.process.on("exit", (code, signal) => {
      const reason = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.rejectAll(new Error(reason));
      this.process = null;
      this.buffer = "";
    });
  }

  async initialize(params: CodexAppServerInitializeParams): Promise<CodexAppServerProbeResult> {
    await this.connect();
    const result = (await this.sendRequest("initialize", params, 10_000)) as Record<string, unknown>;
    this.sendNotification("initialized");
    return {
      ok: true,
      userAgent: typeof result.userAgent === "string" ? result.userAgent : null,
      notifications: this.notifications.map((entry) => entry.method),
    };
  }

  async startThread(params: CodexAppServerThreadStartParams): Promise<CodexAppServerThreadStartResult> {
    await this.connect();
    const result = (await this.sendRequest("thread/start", params, 20_000)) as Record<string, unknown>;
    const thread = asRecord(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error("Codex app-server thread/start did not return thread.id");
    }
    return {
      threadId,
      model: typeof result.model === "string" ? result.model : null,
      cwd: typeof result.cwd === "string" ? result.cwd : null,
    };
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.connect();
    await this.sendRequest("thread/archive", { threadId }, 10_000);
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexAppServerThreadReadResult> {
    await this.connect();
    const result = (await this.sendRequest("thread/read", { threadId, includeTurns }, 10_000)) as Record<string, unknown>;
    const thread = asRecord(result.thread);
    const resolvedThreadId = typeof thread?.id === "string" ? thread.id : null;
    if (!resolvedThreadId) {
      throw new Error("Codex app-server thread/read did not return thread.id");
    }
    return {
      threadId: resolvedThreadId,
      cwd: typeof thread?.cwd === "string" ? thread.cwd : null,
      turns: Array.isArray(thread?.turns) ? thread.turns : undefined,
      rawThread: thread ?? undefined,
    };
  }

  async startTurn(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResult> {
    await this.connect();
    const result = (await this.sendRequest("turn/start", params, 30_000)) as Record<string, unknown>;
    const turn = asRecord(result.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId) {
      throw new Error("Codex app-server turn/start did not return turn.id");
    }
    return {
      turnId,
      status: typeof turn?.status === "string" ? turn.status : null,
    };
  }

  listNotifications(): CodexAppServerNotificationRecord[] {
    return [...this.notifications];
  }

  async waitForNotification(
    matcher: (notification: CodexAppServerNotificationRecord) => boolean,
    timeoutMs = 30_000,
  ): Promise<CodexAppServerNotificationRecord> {
    const startedAt = Date.now();
    let offset = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const current = this.notifications.slice(offset);
      for (const notification of current) {
        if (matcher(notification)) {
          return notification;
        }
      }
      offset = this.notifications.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Codex app-server notification after ${timeoutMs}ms`);
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error("Codex app-server disconnected"));
    }
    this.pending.clear();
    if (!child) {
      return;
    }
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 1000).unref();
    });
  }

  private async sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.process) {
      throw new Error("Codex app-server 未连接");
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      id,
      method,
      params,
    };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      this.writePayload(payload);
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = { method, params };
    this.writePayload(payload);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch (error) {
      this.rejectAll(new Error(`Failed to parse JSON from Codex app-server: ${String(error)}`));
      return;
    }
    if (!parsed) {
      return;
    }
    if (typeof parsed.method === "string" && !("id" in parsed)) {
      const notification = {
        method: parsed.method,
        params: "params" in parsed ? parsed.params : undefined,
        receivedAt: Date.now(),
      };
      this.notifications.push(notification);
      codexAppServerNotificationCache.ingest(notification);
      return;
    }
    if (!("id" in parsed)) {
      return;
    }
    const response = parsed as unknown as JsonRpcResponse;
    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification): void {
    this.process?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}
