import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { spawnSync } from "node:child_process";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { config, configSchema } from "./core/config.js";
import { signToken, safeEqual, verifyToken } from "./utils/security.js";
import { SessionRepository } from "./services/sessionRepository.js";
import { SessionManager } from "./services/sessionManager.js";
import { GoalGuardService } from "./services/goalGuardService.js";
import { CodexHistoryService } from "./services/codexHistoryService.js";
import { FileService } from "./services/fileService.js";
import { AuditService } from "./services/auditService.js";
import { LoginRateLimiter } from "./services/loginRateLimiter.js";
import type { GoalGuardConfig } from "./types/models.js";

const repository = new SessionRepository();
const sessionManager = new SessionManager(repository);
const goalGuardService = new GoalGuardService(sessionManager, repository, config.goalGuardIntervalMs);
const codexHistoryService = new CodexHistoryService();
const fileService = new FileService(config.workspaceRoots);
const auditService = new AuditService(config.dataDir);
const loginRateLimiter = new LoginRateLimiter(config.loginRateLimitMaxAttempts, config.loginRateLimitWindowMs);

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

function getClientIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() ?? request.ip ?? "unknown";
  }
  return request.ip ?? "unknown";
}

function extractToken(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return null;
}

function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const token = extractToken(request);
  if (!token || !verifyToken(token, config.jwtSecret)) {
    response.status(401).json({ message: "未授权" });
    return;
  }
  next();
}

function readPathParam(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return "";
}

function sendError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "服务器内部错误";
  response.status(400).json({ message });
}

app.post("/api/auth/login", (request, response) => {
  const clientIp = getClientIp(request);
  const blockRemainingMs = loginRateLimiter.getBlockRemainingMs(clientIp);
  if (blockRemainingMs > 0) {
    auditService.record({
      action: "auth.login.blocked",
      ip: clientIp,
      detail: { blockRemainingMs },
    });
    response.status(429).json({ message: `登录尝试过于频繁，请在 ${Math.ceil(blockRemainingMs / 1000)} 秒后重试` });
    return;
  }
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!safeEqual(password, config.password)) {
    const retryAfterMs = loginRateLimiter.registerFailure(clientIp);
    auditService.record({
      action: "auth.login.failed",
      ip: clientIp,
      detail: { blocked: retryAfterMs > 0, retryAfterMs },
    });
    response.status(401).json({ message: "密码错误" });
    return;
  }
  loginRateLimiter.registerSuccess(clientIp);
  auditService.record({
    action: "auth.login.succeeded",
    ip: clientIp,
  });
  response.json({
    token: signToken(config.jwtSecret),
  });
});

app.get("/api/system/health", (_request, response) => {
  const tmuxProbe = spawnSync("tmux", ["-V"], { stdio: "pipe", encoding: "utf8" });
  const codexProbe = spawnSync(config.codexExecutable, ["--help"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  response.json({
    ok: tmuxProbe.status === 0 && codexProbe.status === 0,
    platform: process.platform,
    nodeVersion: process.version,
    dependencies: {
      tmux: {
        ok: tmuxProbe.status === 0,
        detail: tmuxProbe.stdout.trim() || tmuxProbe.stderr.trim(),
      },
      codex: {
        ok: codexProbe.status === 0,
        detail: codexProbe.stdout.split("\n")[0]?.trim() || codexProbe.stderr.trim(),
      },
    },
    managedSessionCount: sessionManager.listSessionSummaries().length,
    securityWarnings: config.securityWarnings,
    timestamp: Date.now(),
  });
});

app.get("/api/system/capabilities", requireAuth, (_request, response) => {
  const tmuxProbe = spawnSync("tmux", ["-V"], { stdio: "pipe", encoding: "utf8" });
  response.json({
    platform: process.platform,
    nodeVersion: process.version,
    tmuxAvailable: tmuxProbe.status === 0,
    workspaceRoots: fileService.listRoots(),
    codexExecutable: config.codexExecutable,
    securityWarnings: config.securityWarnings,
    features: {
      goalGuard: true,
      choiceOverlay: true,
      codexHistoryImport: true,
      fileExplorer: true,
      fileUpload: true,
      fileDownload: true,
    },
  });
});

app.get("/api/system/config-schema", requireAuth, (_request, response) => {
  response.json({
    items: configSchema,
  });
});

app.get("/api/session/list", requireAuth, (_request, response) => {
  response.json({
    items: sessionManager.listSessionSummaries(),
  });
});

app.post("/api/session/create", requireAuth, (request, response) => {
  try {
    const created = sessionManager.createSession({
      title: String(request.body?.title ?? "").trim() || "新建会话",
      workspaceRoot: String(request.body?.workspaceRoot ?? ""),
      cwd: String(request.body?.cwd ?? "."),
      mode: request.body?.mode ?? "new",
      prompt: typeof request.body?.prompt === "string" ? request.body.prompt : undefined,
      sourceCodexSessionId:
        typeof request.body?.sourceCodexSessionId === "string"
          ? request.body.sourceCodexSessionId
          : undefined,
    });
    auditService.record({
      action: "session.created",
      ip: getClientIp(request),
      detail: {
        sessionId: created.id,
        workspaceRoot: created.workspaceRoot,
        cwd: created.cwd,
        mode: created.mode,
      },
    });
    response.status(201).json(created);
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/session/:id/close", requireAuth, (request, response) => {
  try {
    const summary = sessionManager.closeSession(
      readPathParam(request.params.id),
      request.body?.force === true || request.body?.manualOverride === true,
    );
    auditService.record({
      action: "session.closed",
      ip: getClientIp(request),
      detail: {
        sessionId: summary.id,
        forced: request.body?.force === true || request.body?.manualOverride === true,
      },
    });
    response.json(summary);
  } catch (error) {
    sendError(response, error);
  }
});

app.get("/api/session/:id/detail", requireAuth, (request, response) => {
  const session = sessionManager.getSessionSummary(readPathParam(request.params.id));
  if (!session) {
    response.status(404).json({ message: "会话不存在" });
    return;
  }
  response.json(session);
});

app.get("/api/codex/history", requireAuth, (_request, response) => {
  response.json({
    items: codexHistoryService.listHistory(),
  });
});

app.get("/api/workspace/roots", requireAuth, (_request, response) => {
  response.json({
    items: fileService.listRoots(),
  });
});

app.get("/api/fs/list", requireAuth, (request, response) => {
  try {
    const rootPath = String(request.query.rootPath ?? "");
    const relativePath = String(request.query.relativePath ?? ".");
    response.json({
      items: fileService.listDirectory(rootPath, relativePath),
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.get("/api/fs/file", requireAuth, (request, response) => {
  try {
    const rootPath = String(request.query.rootPath ?? "");
    const relativePath = String(request.query.relativePath ?? "");
    response.json({
      content: fileService.readFile(rootPath, relativePath),
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.put("/api/fs/file", requireAuth, (request, response) => {
  try {
    fileService.updateFile(
      String(request.body?.rootPath ?? ""),
      String(request.body?.relativePath ?? ""),
      typeof request.body?.content === "string" ? request.body.content : "",
    );
    auditService.record({
      action: "file.updated",
      ip: getClientIp(request),
      detail: {
        rootPath: String(request.body?.rootPath ?? ""),
        relativePath: String(request.body?.relativePath ?? ""),
      },
    });
    response.json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/fs/upload", requireAuth, (request, response) => {
  try {
    const rootPath = String(request.body?.rootPath ?? "");
    const directoryPath = String(request.body?.directoryPath ?? ".");
    const fileName = String(request.body?.fileName ?? "").trim();
    const contentBase64 = typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : "";
    if (!fileName) {
      throw new Error("缺少上传文件名");
    }
    const relativePath = path.posix.join(directoryPath === "." ? "" : directoryPath, fileName);
    fileService.writeFileFromBase64(rootPath, relativePath, contentBase64);
    auditService.record({
      action: "file.uploaded",
      ip: getClientIp(request),
      detail: { rootPath, relativePath, size: Buffer.from(contentBase64, "base64").byteLength },
    });
    response.status(201).json({ ok: true, relativePath });
  } catch (error) {
    sendError(response, error);
  }
});

app.get("/api/fs/download", requireAuth, (request, response) => {
  try {
    const rootPath = String(request.query.rootPath ?? "");
    const relativePath = String(request.query.relativePath ?? "");
    const filePath = fileService.resolvePath(rootPath, relativePath);
    auditService.record({
      action: "file.downloaded",
      ip: getClientIp(request),
      detail: { rootPath, relativePath },
    });
    response.download(filePath, path.basename(filePath));
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/fs/folder", requireAuth, (request, response) => {
  try {
    fileService.createFolder(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
    auditService.record({
      action: "folder.created",
      ip: getClientIp(request),
      detail: {
        rootPath: String(request.body?.rootPath ?? ""),
        relativePath: String(request.body?.relativePath ?? ""),
      },
    });
    response.status(201).json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/fs/file", requireAuth, (request, response) => {
  try {
    fileService.createFile(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
    auditService.record({
      action: "file.created",
      ip: getClientIp(request),
      detail: {
        rootPath: String(request.body?.rootPath ?? ""),
        relativePath: String(request.body?.relativePath ?? ""),
      },
    });
    response.status(201).json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/fs/rename", requireAuth, (request, response) => {
  try {
    fileService.renameEntry(
      String(request.body?.rootPath ?? ""),
      String(request.body?.sourceRelativePath ?? ""),
      String(request.body?.targetRelativePath ?? ""),
    );
    auditService.record({
      action: "file.renamed",
      ip: getClientIp(request),
      detail: {
        rootPath: String(request.body?.rootPath ?? ""),
        sourceRelativePath: String(request.body?.sourceRelativePath ?? ""),
        targetRelativePath: String(request.body?.targetRelativePath ?? ""),
      },
    });
    response.json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/fs/delete", requireAuth, (request, response) => {
  try {
    fileService.deleteEntry(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
    auditService.record({
      action: "file.deleted",
      ip: getClientIp(request),
      detail: {
        rootPath: String(request.body?.rootPath ?? ""),
        relativePath: String(request.body?.relativePath ?? ""),
      },
    });
    response.json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.get("/api/goal-guard/:sessionId", requireAuth, (request, response) => {
  const session = sessionManager.getSessionSummary(readPathParam(request.params.sessionId));
  if (!session) {
    response.status(404).json({ message: "会话不存在" });
    return;
  }
  response.json({
    goalConfig: session.goalConfig,
    goalState: session.goalState,
  });
});

app.put("/api/goal-guard/:sessionId", requireAuth, (request, response) => {
  try {
    const body = request.body ?? {};
    const goalConfig: GoalGuardConfig = {
      enabled: body.enabled === true,
      goalText: typeof body.goalText === "string" ? body.goalText : "",
      successKeywords: Array.isArray(body.successKeywords)
        ? body.successKeywords.map((item: unknown) => String(item)).filter(Boolean)
        : [],
      successCommand: typeof body.successCommand === "string" && body.successCommand.trim()
        ? body.successCommand
        : null,
      idleTimeoutSec: Number(body.idleTimeoutSec ?? config.defaultIdleTimeoutSec),
      resumePromptTemplate:
        typeof body.resumePromptTemplate === "string" && body.resumePromptTemplate.trim()
          ? body.resumePromptTemplate
          : "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
      allowManualStopAfterSuccess: body.allowManualStopAfterSuccess !== false,
    };
    const session = sessionManager.updateGoalConfig(readPathParam(request.params.sessionId), goalConfig);
    response.json(session);
  } catch (error) {
    sendError(response, error);
  }
});

app.post("/api/goal-guard/:sessionId/override-stop", requireAuth, (request, response) => {
  try {
    const summary = sessionManager.closeSession(readPathParam(request.params.sessionId), true);
    auditService.record({
      action: "session.force_stopped",
      ip: getClientIp(request),
      detail: { sessionId: summary.id },
    });
    response.json(summary);
  } catch (error) {
    sendError(response, error);
  }
});

const frontendDist = path.resolve(fileURLToPath(new URL("../../frontend/dist", import.meta.url)));
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^\/(?!api).*/, (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }
    response.sendFile(path.join(frontendDist, "index.html"));
  });
}

const server = app.listen(config.port, config.host, () => {
  console.log(`TouchMux backend listening on http://${config.host}:${config.port}`);
  for (const warning of config.securityWarnings) {
    console.warn(`[security-warning] ${warning}`);
  }
});

const terminalWss = new WebSocketServer({ noServer: true });
const eventWss = new WebSocketServer({ noServer: true });

sessionManager.on("session-updated", (summary) => {
  const payload = JSON.stringify({
    type: "session-updated",
    payload: summary,
  });
  for (const client of eventWss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token || !verifyToken(token, config.jwtSecret)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/events") {
      eventWss.handleUpgrade(request, socket, head, (ws) => {
        eventWss.emit("connection", ws, request);
      });
      return;
    }
    if (url.pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws, request, url);
      });
      return;
    }
    socket.destroy();
  } catch {
    socket.destroy();
  }
});

eventWss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "snapshot",
      payload: sessionManager.listSessionSummaries(),
    }),
  );
});

function handleTerminalConnection(ws: WebSocket, url: URL): void {
  const sessionId = url.searchParams.get("sessionId");
  const cols = Number(url.searchParams.get("cols") ?? 120);
  const rows = Number(url.searchParams.get("rows") ?? 32);
  if (!sessionId) {
    ws.close(1008, "missing sessionId");
    return;
  }
  let ptyProcess;
  try {
    ptyProcess = sessionManager.attachToSession(
      sessionId,
      cols,
      rows,
      (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "data", payload: chunk }));
        }
      },
      () => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "exit" }));
          ws.close();
        }
      },
    );
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        payload: error instanceof Error ? error.message : "终端附着失败",
      }),
    );
    ws.close();
    return;
  }

  ws.on("message", (buffer: RawData) => {
    try {
      const message = JSON.parse(buffer.toString()) as {
        type: "input" | "resize";
        payload?: string;
        cols?: number;
        rows?: number;
      };
      if (message.type === "input" && typeof message.payload === "string") {
        sessionManager.writeTerminal(ptyProcess, message.payload);
      }
      if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
        sessionManager.resizeTerminal(ptyProcess, message.cols, message.rows);
      }
    } catch {
      return;
    }
  });

  ws.on("close", () => {
    ptyProcess.kill();
  });
}

terminalWss.on("connection", (ws: WebSocket, _request: Request, url?: URL) => {
  if (!url) {
    ws.close(1008, "missing url context");
    return;
  }
  handleTerminalConnection(ws, url);
});

goalGuardService.start();
