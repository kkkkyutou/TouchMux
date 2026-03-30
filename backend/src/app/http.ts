import type { Request, Response } from "express";

export function getClientIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() ?? request.ip ?? "unknown";
  }
  return request.ip ?? "unknown";
}

export function extractToken(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return null;
}

export function readPathParam(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return "";
}

export function sendError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "服务器内部错误";
  response.status(400).json({ message });
}

export function readNodeId(request: Request): string {
  const fromBody = typeof request.body?.nodeId === "string" ? request.body.nodeId : "";
  const fromQuery = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
  const nodeId = (fromBody || fromQuery).trim();
  if (!nodeId) {
    throw new Error("缺少 nodeId");
  }
  return nodeId;
}

export function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}
