import type {
  FileEntry,
  GoalGuardConfig,
  HistoryConversationSummary,
  NodeSummary,
  SessionSummary,
  WorkspaceEntry,
} from "../types/api";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function notifyUnauthorized(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent("touchmux:unauthorized"));
}

function buildApiError(status: number, fallbackMessage: string, message?: string): ApiError {
  if (status === 401) {
    notifyUnauthorized();
  }
  return new ApiError(message ?? fallbackMessage, status);
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw buildApiError(response.status, "请求失败", data.message);
  }
  return (await response.json()) as T;
}

export async function login(password: string): Promise<string> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw buildApiError(response.status, "登录失败", data.message);
  }
  const data = (await response.json()) as { token: string };
  return data.token;
}

export async function fetchSessions(token: string): Promise<SessionSummary[]> {
  const data = await request<{ items: SessionSummary[] }>("/api/session/list", token);
  return data.items;
}

export async function fetchNodes(token: string): Promise<NodeSummary[]> {
  const data = await request<{ items: NodeSummary[] }>("/api/nodes", token);
  return data.items;
}

export async function createSession(
  token: string,
  payload: {
    nodeId: string;
    title: string;
    workspaceRoot: string;
    cwd: string;
    mode: "new" | "resume" | "fork";
    prompt?: string;
    sourceCodexSessionId?: string;
  },
): Promise<SessionSummary> {
  return request<SessionSummary>("/api/session/create", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function closeSession(
  token: string,
  sessionId: string,
  nodeId: string,
  force = false,
): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/session/${sessionId}/close`, token, {
    method: "POST",
    body: JSON.stringify({ nodeId, force }),
  });
}

export async function fetchHistory(token: string, nodeId?: string): Promise<HistoryConversationSummary[]> {
  const query = nodeId ? `?${new URLSearchParams({ nodeId }).toString()}` : "";
  const data = await request<{ items: HistoryConversationSummary[] }>(`/api/codex/history${query}`, token);
  return data.items;
}

export async function fetchRoots(token: string, nodeId?: string): Promise<WorkspaceEntry[]> {
  const query = nodeId ? `?${new URLSearchParams({ nodeId }).toString()}` : "";
  const data = await request<{ items: WorkspaceEntry[] }>(`/api/workspace/roots${query}`, token);
  return data.items;
}

export async function listDirectory(
  token: string,
  nodeId: string,
  rootPath: string,
  relativePath: string,
): Promise<FileEntry[]> {
  const query = new URLSearchParams({ nodeId, rootPath, relativePath });
  const data = await request<{ items: FileEntry[] }>(`/api/fs/list?${query.toString()}`, token);
  return data.items;
}

export async function readFile(token: string, nodeId: string, rootPath: string, relativePath: string): Promise<string> {
  const query = new URLSearchParams({ nodeId, rootPath, relativePath });
  const data = await request<{ content: string }>(`/api/fs/file?${query.toString()}`, token);
  return data.content;
}

export async function downloadFile(token: string, nodeId: string, rootPath: string, relativePath: string): Promise<Blob> {
  const query = new URLSearchParams({ nodeId, rootPath, relativePath });
  const response = await fetch(`/api/fs/download?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw buildApiError(response.status, "文件下载失败", data.message);
  }
  return response.blob();
}

export async function updateFile(
  token: string,
  nodeId: string,
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await request("/api/fs/file", token, {
    method: "PUT",
    body: JSON.stringify({ nodeId, rootPath, relativePath, content }),
  });
}

export async function createFolder(token: string, nodeId: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/folder", token, {
    method: "POST",
    body: JSON.stringify({ nodeId, rootPath, relativePath }),
  });
}

export async function createFile(token: string, nodeId: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/file", token, {
    method: "POST",
    body: JSON.stringify({ nodeId, rootPath, relativePath }),
  });
}

export async function uploadFile(
  token: string,
  payload: {
    nodeId: string;
    rootPath: string;
    directoryPath: string;
    fileName: string;
    contentBase64: string;
  },
): Promise<{ relativePath: string }> {
  return request<{ ok: true; relativePath: string }>("/api/fs/upload", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function renameEntry(
  token: string,
  nodeId: string,
  rootPath: string,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> {
  await request("/api/fs/rename", token, {
    method: "POST",
    body: JSON.stringify({ nodeId, rootPath, sourceRelativePath, targetRelativePath }),
  });
}

export async function deleteEntry(token: string, nodeId: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/delete", token, {
    method: "POST",
    body: JSON.stringify({ nodeId, rootPath, relativePath }),
  });
}

export async function updateGoalGuard(
  token: string,
  nodeId: string,
  sessionId: string,
  goalConfig: GoalGuardConfig,
): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/goal-guard/${sessionId}`, token, {
    method: "PUT",
    body: JSON.stringify({ nodeId, ...goalConfig }),
  });
}

export async function overrideStop(token: string, sessionId: string, nodeId: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/goal-guard/${sessionId}/override-stop`, token, {
    method: "POST",
    body: JSON.stringify({ nodeId }),
  });
}

export async function fetchCapabilities(token: string): Promise<{
  runtimeMode: string;
  nodeId: string;
  nodeLabel: string;
  platform: string;
  nodeVersion: string;
  tmuxAvailable: boolean;
  codexExecutable: string;
  workspaceRoots: WorkspaceEntry[];
  securityWarnings: string[];
  features: Record<string, boolean>;
}> {
  return request("/api/system/capabilities", token);
}

export async function fetchConfigSchema(token: string): Promise<
  Array<{
    key: string;
    required: boolean;
    defaultValue: string | number | boolean | null;
    example: string;
    description: string;
  }>
> {
  const data = await request<{
    items: Array<{
      key: string;
      required: boolean;
      defaultValue: string | number | boolean | null;
      example: string;
      description: string;
    }>;
  }>("/api/system/config-schema", token);
  return data.items;
}
