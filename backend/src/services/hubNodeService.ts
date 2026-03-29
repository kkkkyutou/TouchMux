import type {
  CreateSessionInput,
  GoalGuardConfig,
  HistoryConversationSummary,
  NodeConfigEntry,
  NodeSummary,
  SessionSummary,
  WorkspaceEntry,
} from "../types/models.js";

interface JsonMessage {
  message?: string;
}

interface NodeCapabilitiesResponse {
  runtimeMode?: "single" | "hub" | "node";
  workspaceRoots?: WorkspaceEntry[];
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

export class HubNodeService {
  constructor(
    private readonly nodes: NodeConfigEntry[],
    private readonly requestTimeoutMs: number,
  ) {}

  listConfiguredNodes(): NodeConfigEntry[] {
    return this.nodes;
  }

  getConfiguredNode(nodeId: string): NodeConfigEntry | null {
    return this.nodes.find((entry) => entry.id === nodeId) ?? null;
  }

  private getNodeOrThrow(nodeId: string): NodeConfigEntry {
    const node = this.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      throw new Error("节点不存在");
    }
    return node;
  }

  private async readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as JsonMessage;
      throw new Error(data.message ?? fallbackMessage);
    }
    return (await response.json()) as T;
  }

  private async nodeRequest<T>(
    nodeId: string,
    pathname: string,
    init: RequestInit | undefined,
    fallbackMessage: string,
  ): Promise<T> {
    const node = this.getNodeOrThrow(nodeId);
    const response = await fetch(`${trimSlash(node.baseUrl)}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "x-touchmux-node-secret": node.sharedSecret ?? "",
        ...(init?.headers ?? {}),
      },
    });
    return this.readJson<T>(response, fallbackMessage);
  }

  async getNodes(): Promise<NodeSummary[]> {
    const checks = await Promise.all(
      this.nodes.map(async (node) => {
        const startedAt = Date.now();
        try {
          const capabilities = await this.nodeRequest<NodeCapabilitiesResponse>(
            node.id,
            "/api/node/system/capabilities",
            { method: "GET" },
            "节点能力读取失败",
          );
          return {
            id: node.id,
            label: node.label,
            baseUrl: node.baseUrl,
            status: "online",
            runtimeMode: capabilities.runtimeMode ?? "unknown",
            roots: capabilities.workspaceRoots ?? [],
            error: null,
            lastCheckedAt: startedAt,
          } satisfies NodeSummary;
        } catch (error) {
          return {
            id: node.id,
            label: node.label,
            baseUrl: node.baseUrl,
            status: "offline",
            runtimeMode: "unknown",
            roots: [],
            error: error instanceof Error ? error.message : "节点不可用",
            lastCheckedAt: startedAt,
          } satisfies NodeSummary;
        }
      }),
    );
    return checks;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessionLists = await Promise.all(
      this.nodes.map(async (node) => {
        try {
          const data = await this.nodeRequest<{ items: SessionSummary[] }>(
            node.id,
            "/api/node/session/list",
            { method: "GET" },
            "节点会话列表读取失败",
          );
          return data.items.map((session) => ({
            ...session,
            nodeId: node.id,
            nodeLabel: node.label,
          }));
        } catch {
          return [];
        }
      }),
    );
    return sessionLists.flat().sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createSession(nodeId: string, payload: CreateSessionInput): Promise<SessionSummary> {
    const created = await this.nodeRequest<SessionSummary>(
      nodeId,
      "/api/node/session/create",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "节点会话创建失败",
    );
    const node = this.getNodeOrThrow(nodeId);
    return { ...created, nodeId, nodeLabel: node.label };
  }

  async closeSession(nodeId: string, sessionId: string, force: boolean): Promise<SessionSummary> {
    const summary = await this.nodeRequest<SessionSummary>(
      nodeId,
      `/api/node/session/${encodeURIComponent(sessionId)}/close`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      },
      "节点会话关闭失败",
    );
    const node = this.getNodeOrThrow(nodeId);
    return { ...summary, nodeId, nodeLabel: node.label };
  }

  async fetchHistory(nodeId: string): Promise<HistoryConversationSummary[]> {
    const data = await this.nodeRequest<{ items: HistoryConversationSummary[] }>(
      nodeId,
      "/api/node/codex/history",
      { method: "GET" },
      "节点历史会话读取失败",
    );
    return data.items;
  }

  async updateGoalGuard(nodeId: string, sessionId: string, goalConfig: GoalGuardConfig): Promise<SessionSummary> {
    const summary = await this.nodeRequest<SessionSummary>(
      nodeId,
      `/api/node/goal-guard/${encodeURIComponent(sessionId)}`,
      {
        method: "PUT",
        body: JSON.stringify(goalConfig),
      },
      "节点 Goal Guard 更新失败",
    );
    const node = this.getNodeOrThrow(nodeId);
    return { ...summary, nodeId, nodeLabel: node.label };
  }

  async overrideStop(nodeId: string, sessionId: string): Promise<SessionSummary> {
    const summary = await this.nodeRequest<SessionSummary>(
      nodeId,
      `/api/node/goal-guard/${encodeURIComponent(sessionId)}/override-stop`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      "节点强制停止失败",
    );
    const node = this.getNodeOrThrow(nodeId);
    return { ...summary, nodeId, nodeLabel: node.label };
  }

  async listDirectory(nodeId: string, rootPath: string, relativePath: string) {
    const query = new URLSearchParams({ rootPath, relativePath });
    const data = await this.nodeRequest<{ items: unknown[] }>(
      nodeId,
      `/api/node/fs/list?${query.toString()}`,
      { method: "GET" },
      "节点目录读取失败",
    );
    return data.items;
  }

  async readFile(nodeId: string, rootPath: string, relativePath: string): Promise<string> {
    const query = new URLSearchParams({ rootPath, relativePath });
    const data = await this.nodeRequest<{ content: string }>(
      nodeId,
      `/api/node/fs/file?${query.toString()}`,
      { method: "GET" },
      "节点文件读取失败",
    );
    return data.content;
  }

  async updateFile(nodeId: string, rootPath: string, relativePath: string, content: string): Promise<void> {
    await this.nodeRequest(
      nodeId,
      "/api/node/fs/file",
      {
        method: "PUT",
        body: JSON.stringify({ rootPath, relativePath, content }),
      },
      "节点文件保存失败",
    );
  }

  async createFolder(nodeId: string, rootPath: string, relativePath: string): Promise<void> {
    await this.nodeRequest(
      nodeId,
      "/api/node/fs/folder",
      {
        method: "POST",
        body: JSON.stringify({ rootPath, relativePath }),
      },
      "节点目录创建失败",
    );
  }

  async createFile(nodeId: string, rootPath: string, relativePath: string): Promise<void> {
    await this.nodeRequest(
      nodeId,
      "/api/node/fs/file",
      {
        method: "POST",
        body: JSON.stringify({ rootPath, relativePath }),
      },
      "节点文件创建失败",
    );
  }

  async renameEntry(
    nodeId: string,
    rootPath: string,
    sourceRelativePath: string,
    targetRelativePath: string,
  ): Promise<void> {
    await this.nodeRequest(
      nodeId,
      "/api/node/fs/rename",
      {
        method: "POST",
        body: JSON.stringify({ rootPath, sourceRelativePath, targetRelativePath }),
      },
      "节点文件重命名失败",
    );
  }

  async deleteEntry(nodeId: string, rootPath: string, relativePath: string): Promise<void> {
    await this.nodeRequest(
      nodeId,
      "/api/node/fs/delete",
      {
        method: "POST",
        body: JSON.stringify({ rootPath, relativePath }),
      },
      "节点文件删除失败",
    );
  }

  async uploadFile(
    nodeId: string,
    payload: { rootPath: string; directoryPath: string; fileName: string; contentBase64: string },
  ): Promise<{ relativePath: string }> {
    return this.nodeRequest<{ ok: true; relativePath: string }>(
      nodeId,
      "/api/node/fs/upload",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "节点文件上传失败",
    );
  }

  async downloadFile(nodeId: string, rootPath: string, relativePath: string): Promise<Response> {
    const node = this.getNodeOrThrow(nodeId);
    const query = new URLSearchParams({ rootPath, relativePath });
    const response = await fetch(`${trimSlash(node.baseUrl)}/api/node/fs/download?${query.toString()}`, {
      method: "GET",
      headers: {
        "x-touchmux-node-secret": node.sharedSecret ?? "",
      },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as JsonMessage;
      throw new Error(data.message ?? "节点文件下载失败");
    }
    return response;
  }
}
