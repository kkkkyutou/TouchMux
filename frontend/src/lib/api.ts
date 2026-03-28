import type {
  FileEntry,
  GoalGuardConfig,
  HistoryConversationSummary,
  SessionSummary,
  WorkspaceEntry,
} from "../types/api";

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
    throw new Error(data.message ?? "请求失败");
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
    throw new Error(data.message ?? "登录失败");
  }
  const data = (await response.json()) as { token: string };
  return data.token;
}

export async function fetchSessions(token: string): Promise<SessionSummary[]> {
  const data = await request<{ items: SessionSummary[] }>("/api/session/list", token);
  return data.items;
}

export async function createSession(
  token: string,
  payload: {
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

export async function closeSession(token: string, sessionId: string, force = false): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/session/${sessionId}/close`, token, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

export async function fetchHistory(token: string): Promise<HistoryConversationSummary[]> {
  const data = await request<{ items: HistoryConversationSummary[] }>("/api/codex/history", token);
  return data.items;
}

export async function fetchRoots(token: string): Promise<WorkspaceEntry[]> {
  const data = await request<{ items: WorkspaceEntry[] }>("/api/workspace/roots", token);
  return data.items;
}

export async function listDirectory(
  token: string,
  rootPath: string,
  relativePath: string,
): Promise<FileEntry[]> {
  const query = new URLSearchParams({ rootPath, relativePath });
  const data = await request<{ items: FileEntry[] }>(`/api/fs/list?${query.toString()}`, token);
  return data.items;
}

export async function readFile(token: string, rootPath: string, relativePath: string): Promise<string> {
  const query = new URLSearchParams({ rootPath, relativePath });
  const data = await request<{ content: string }>(`/api/fs/file?${query.toString()}`, token);
  return data.content;
}

export async function downloadFile(token: string, rootPath: string, relativePath: string): Promise<Blob> {
  const query = new URLSearchParams({ rootPath, relativePath });
  const response = await fetch(`/api/fs/download?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? "文件下载失败");
  }
  return response.blob();
}

export async function updateFile(
  token: string,
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await request("/api/fs/file", token, {
    method: "PUT",
    body: JSON.stringify({ rootPath, relativePath, content }),
  });
}

export async function createFolder(token: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/folder", token, {
    method: "POST",
    body: JSON.stringify({ rootPath, relativePath }),
  });
}

export async function createFile(token: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/file", token, {
    method: "POST",
    body: JSON.stringify({ rootPath, relativePath }),
  });
}

export async function uploadFile(
  token: string,
  payload: {
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
  rootPath: string,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> {
  await request("/api/fs/rename", token, {
    method: "POST",
    body: JSON.stringify({ rootPath, sourceRelativePath, targetRelativePath }),
  });
}

export async function deleteEntry(token: string, rootPath: string, relativePath: string): Promise<void> {
  await request("/api/fs/delete", token, {
    method: "POST",
    body: JSON.stringify({ rootPath, relativePath }),
  });
}

export async function updateGoalGuard(
  token: string,
  sessionId: string,
  goalConfig: GoalGuardConfig,
): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/goal-guard/${sessionId}`, token, {
    method: "PUT",
    body: JSON.stringify(goalConfig),
  });
}

export async function overrideStop(token: string, sessionId: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/goal-guard/${sessionId}/override-stop`, token, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCapabilities(token: string): Promise<{
  platform: string;
  nodeVersion: string;
  tmuxAvailable: boolean;
  codexExecutable: string;
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
