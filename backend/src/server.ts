import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { config, configSchema } from "./core/config.js";
import { signToken, safeEqual, verifyToken } from "./utils/security.js";
import { SessionRepository } from "./services/sessionRepository.js";
import { SessionManager } from "./services/sessionManager.js";
import { GoalGuardService } from "./services/goalGuardService.js";
import { CodexHistoryService } from "./services/codexHistoryService.js";
import { FileService } from "./services/fileService.js";
import { AuditService } from "./services/auditService.js";
import { LoginRateLimiter } from "./services/loginRateLimiter.js";
import { HubNodeService } from "./services/hubNodeService.js";
import type { GoalGuardConfig, NodeSummary, SessionSummary, WorkspaceEntry } from "./types/models.js";

interface LocalRuntime {
  repository: SessionRepository;
  sessionManager: SessionManager;
  goalGuardService: GoalGuardService;
  codexHistoryService: CodexHistoryService;
  fileService: FileService;
}

const auditService = new AuditService(config.dataDir);
const loginRateLimiter = new LoginRateLimiter(config.loginRateLimitMaxAttempts, config.loginRateLimitWindowMs);
const localRuntime: LocalRuntime | null =
  config.runtimeMode === "hub"
    ? null
    : (() => {
        const repository = new SessionRepository();
        const sessionManager = new SessionManager(repository);
        const goalGuardService = new GoalGuardService(sessionManager, repository, config.goalGuardIntervalMs);
        return {
          repository,
          sessionManager,
          goalGuardService,
          codexHistoryService: new CodexHistoryService(),
          fileService: new FileService(config.workspaceRoots),
        };
      })();
const hubNodeService =
  config.runtimeMode === "hub" ? new HubNodeService(config.hubNodes, config.nodeRequestTimeoutMs) : null;

const app = express();
app.use(cors());
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: `${Math.ceil(config.maxUploadBytes * 1.5)}b` }));

if (
  !config.allowInsecureDefaults &&
  config.runtimeMode !== "single" &&
  (config.password === "change-me" || config.jwtSecret === "change-this-secret")
) {
  throw new Error(
    "当前运行模式禁止使用默认登录口令或默认 JWT 密钥。请修改 .env，或仅在本地调试时显式设置 TOUCHMUX_ALLOW_INSECURE_DEFAULTS=true。",
  );
}

function assertLocalRuntime(): LocalRuntime {
  if (!localRuntime) {
    throw new Error("当前运行模式不支持本地会话服务");
  }
  return localRuntime;
}

function assertHubNodeService(): HubNodeService {
  if (!hubNodeService) {
    throw new Error("当前运行模式不支持 Hub 节点代理");
  }
  return hubNodeService;
}

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

function requireNodeSecret(request: Request, response: Response, next: NextFunction): void {
  const provided = String(request.headers["x-touchmux-node-secret"] ?? "");
  if (!config.nodeSharedSecret || !provided || !safeEqual(provided, config.nodeSharedSecret)) {
    response.status(401).json({ message: "节点鉴权失败" });
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

function readNodeId(request: Request): string {
  const fromBody = typeof request.body?.nodeId === "string" ? request.body.nodeId : "";
  const fromQuery = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
  const nodeId = (fromBody || fromQuery).trim();
  if (!nodeId) {
    throw new Error("缺少 nodeId");
  }
  return nodeId;
}

function localNodeSummary(): NodeSummary {
  return {
    id: config.localNode.id,
    label: config.localNode.label,
    baseUrl: config.localNode.baseUrl,
    status: "online",
    runtimeMode: config.runtimeMode,
    roots: config.workspaceRoots,
    error: null,
    lastCheckedAt: Date.now(),
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function buildLocalCapabilities() {
  const tmuxProbe = spawnSync("tmux", ["-V"], { stdio: "pipe", encoding: "utf8" });
  return {
    runtimeMode: config.runtimeMode,
    nodeId: config.localNode.id,
    nodeLabel: config.localNode.label,
    platform: process.platform,
    nodeVersion: process.version,
    tmuxAvailable: tmuxProbe.status === 0,
    workspaceRoots: config.workspaceRoots,
    codexExecutable: config.codexExecutable,
    securityWarnings: config.securityWarnings,
    features: {
      goalGuard: true,
      choiceOverlay: true,
      codexHistoryImport: true,
      fileExplorer: true,
      fileUpload: true,
      fileDownload: true,
      multiNodeGateway: false,
    },
  };
}

function registerLocalRoutes(prefix: string, authMiddleware: typeof requireAuth): void {
  const runtime = assertLocalRuntime();

  app.get(`${prefix}/system/capabilities`, authMiddleware, (_request, response) => {
    response.json(buildLocalCapabilities());
  });

  app.get(`${prefix}/system/config-schema`, authMiddleware, (_request, response) => {
    response.json({
      items: configSchema,
    });
  });

  app.get(`${prefix}/session/list`, authMiddleware, (_request, response) => {
    response.json({
      items: runtime.sessionManager.listSessionSummaries(),
    });
  });

  app.post(`${prefix}/session/create`, authMiddleware, (request, response) => {
    try {
      const created = runtime.sessionManager.createSession({
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
          nodeId: config.localNode.id,
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

  app.post(`${prefix}/session/:id/close`, authMiddleware, (request, response) => {
    try {
      const summary = runtime.sessionManager.closeSession(
        readPathParam(request.params.id),
        request.body?.force === true || request.body?.manualOverride === true,
      );
      auditService.record({
        action: "session.closed",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          sessionId: summary.id,
          forced: request.body?.force === true || request.body?.manualOverride === true,
        },
      });
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get(`${prefix}/session/:id/detail`, authMiddleware, (request, response) => {
    const session = runtime.sessionManager.getSessionSummary(readPathParam(request.params.id));
    if (!session) {
      response.status(404).json({ message: "会话不存在" });
      return;
    }
    response.json(session);
  });

  app.get(`${prefix}/codex/history`, authMiddleware, (_request, response) => {
    response.json({
      items: runtime.codexHistoryService.listHistory(),
    });
  });

  app.get(`${prefix}/workspace/roots`, authMiddleware, (_request, response) => {
    response.json({
      items: runtime.fileService.listRoots(),
    });
  });

  app.get(`${prefix}/fs/list`, authMiddleware, (request, response) => {
    try {
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? ".");
      response.json({
        items: runtime.fileService.listDirectory(rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get(`${prefix}/fs/file`, authMiddleware, (request, response) => {
    try {
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? "");
      response.json({
        content: runtime.fileService.readFile(rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put(`${prefix}/fs/file`, authMiddleware, (request, response) => {
    try {
      runtime.fileService.updateFile(
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
        typeof request.body?.content === "string" ? request.body.content : "",
      );
      auditService.record({
        action: "file.updated",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          rootPath: String(request.body?.rootPath ?? ""),
          relativePath: String(request.body?.relativePath ?? ""),
        },
      });
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/fs/upload`, authMiddleware, (request, response) => {
    try {
      const rootPath = String(request.body?.rootPath ?? "");
      const directoryPath = String(request.body?.directoryPath ?? ".");
      const fileName = String(request.body?.fileName ?? "").trim();
      const contentBase64 = typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : "";
      if (!fileName) {
        throw new Error("缺少上传文件名");
      }
      if (fileName.includes("/") || fileName.includes("\\")) {
        throw new Error("上传文件名不能包含路径分隔符");
      }
      const byteLength = Buffer.from(contentBase64, "base64").byteLength;
      if (byteLength > config.maxUploadBytes) {
        throw new Error(`上传文件过大，当前限制为 ${config.maxUploadBytes} 字节`);
      }
      const relativePath = path.posix.join(directoryPath === "." ? "" : directoryPath, fileName);
      runtime.fileService.writeFileFromBase64(rootPath, relativePath, contentBase64);
      auditService.record({
        action: "file.uploaded",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          rootPath,
          relativePath,
          size: byteLength,
        },
      });
      response.status(201).json({ ok: true, relativePath });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get(`${prefix}/fs/download`, authMiddleware, (request, response) => {
    try {
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? "");
      const filePath = runtime.fileService.resolvePath(rootPath, relativePath);
      auditService.record({
        action: "file.downloaded",
        ip: getClientIp(request),
        detail: { nodeId: config.localNode.id, rootPath, relativePath },
      });
      response.download(filePath, path.basename(filePath));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/fs/folder`, authMiddleware, (request, response) => {
    try {
      runtime.fileService.createFolder(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
      auditService.record({
        action: "folder.created",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          rootPath: String(request.body?.rootPath ?? ""),
          relativePath: String(request.body?.relativePath ?? ""),
        },
      });
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/fs/file`, authMiddleware, (request, response) => {
    try {
      runtime.fileService.createFile(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
      auditService.record({
        action: "file.created",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          rootPath: String(request.body?.rootPath ?? ""),
          relativePath: String(request.body?.relativePath ?? ""),
        },
      });
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/fs/rename`, authMiddleware, (request, response) => {
    try {
      runtime.fileService.renameEntry(
        String(request.body?.rootPath ?? ""),
        String(request.body?.sourceRelativePath ?? ""),
        String(request.body?.targetRelativePath ?? ""),
      );
      auditService.record({
        action: "file.renamed",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
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

  app.post(`${prefix}/fs/delete`, authMiddleware, (request, response) => {
    try {
      runtime.fileService.deleteEntry(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
      auditService.record({
        action: "file.deleted",
        ip: getClientIp(request),
        detail: {
          nodeId: config.localNode.id,
          rootPath: String(request.body?.rootPath ?? ""),
          relativePath: String(request.body?.relativePath ?? ""),
        },
      });
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get(`${prefix}/goal-guard/:sessionId`, authMiddleware, (request, response) => {
    const session = runtime.sessionManager.getSessionSummary(readPathParam(request.params.sessionId));
    if (!session) {
      response.status(404).json({ message: "会话不存在" });
      return;
    }
    response.json({
      goalConfig: session.goalConfig,
      goalState: session.goalState,
    });
  });

  app.put(`${prefix}/goal-guard/:sessionId`, authMiddleware, (request, response) => {
    try {
      const body = request.body ?? {};
      const goalConfig: GoalGuardConfig = {
        enabled: body.enabled === true,
        goalText: typeof body.goalText === "string" ? body.goalText : "",
        successKeywords: Array.isArray(body.successKeywords)
          ? body.successKeywords.map((item: unknown) => String(item)).filter(Boolean)
          : [],
        successCommand:
          typeof body.successCommand === "string" && body.successCommand.trim() ? body.successCommand : null,
        idleTimeoutSec: Number(body.idleTimeoutSec ?? config.defaultIdleTimeoutSec),
        resumePromptTemplate:
          typeof body.resumePromptTemplate === "string" && body.resumePromptTemplate.trim()
            ? body.resumePromptTemplate
            : "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
        allowManualStopAfterSuccess: body.allowManualStopAfterSuccess !== false,
      };
      const session = runtime.sessionManager.updateGoalConfig(readPathParam(request.params.sessionId), goalConfig);
      response.json(session);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/goal-guard/:sessionId/override-stop`, authMiddleware, (request, response) => {
    try {
      const summary = runtime.sessionManager.closeSession(readPathParam(request.params.sessionId), true);
      auditService.record({
        action: "session.force_stopped",
        ip: getClientIp(request),
        detail: { nodeId: config.localNode.id, sessionId: summary.id },
      });
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });
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
    token: signToken(config.jwtSecret, config.tokenTtlSec),
  });
});

app.get("/api/system/health", async (_request, response) => {
  if (config.runtimeMode === "hub") {
    const nodes = await assertHubNodeService().getNodes();
    response.json({
      ok: true,
      runtimeMode: "hub",
      nodeVersion: process.version,
      configuredNodeCount: nodes.length,
      onlineNodeCount: nodes.filter((node) => node.status === "online").length,
      timestamp: Date.now(),
    });
    return;
  }

  const tmuxProbe = spawnSync("tmux", ["-V"], { stdio: "pipe", encoding: "utf8" });
  const codexProbe = spawnSync(config.codexExecutable, ["--help"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  response.json({
    ok: tmuxProbe.status === 0 && codexProbe.status === 0,
    runtimeMode: config.runtimeMode,
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
    managedSessionCount: assertLocalRuntime().sessionManager.listSessionSummaries().length,
    securityWarnings: config.securityWarnings,
    timestamp: Date.now(),
  });
});

app.get("/api/nodes", requireAuth, async (_request, response) => {
  if (config.runtimeMode === "hub") {
    response.json({
      items: await assertHubNodeService().getNodes(),
    });
    return;
  }
  response.json({
    items: [localNodeSummary()],
  });
});

if (config.runtimeMode === "hub") {
  app.get("/api/system/capabilities", requireAuth, async (_request, response) => {
    const nodes = await assertHubNodeService().getNodes();
    response.json({
      runtimeMode: "hub",
      nodeId: "hub",
      nodeLabel: "TouchMux Hub",
      platform: process.platform,
      nodeVersion: process.version,
      tmuxAvailable: false,
      workspaceRoots: [] as WorkspaceEntry[],
      codexExecutable: "",
      securityWarnings: config.securityWarnings,
      features: {
        goalGuard: true,
        choiceOverlay: true,
        codexHistoryImport: true,
        fileExplorer: true,
        fileUpload: true,
        fileDownload: true,
        multiNodeGateway: true,
      },
      configuredNodeCount: nodes.length,
      onlineNodeCount: nodes.filter((node) => node.status === "online").length,
    });
  });

  app.get("/api/system/config-schema", requireAuth, (_request, response) => {
    response.json({
      items: configSchema,
    });
  });

  app.get("/api/session/list", requireAuth, async (_request, response) => {
    response.json({
      items: await assertHubNodeService().listSessions(),
    });
  });

  app.post("/api/session/create", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const created = await assertHubNodeService().createSession(nodeId, {
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
        action: "hub.session.created",
        ip: getClientIp(request),
        detail: { nodeId, sessionId: created.id, cwd: created.cwd, workspaceRoot: created.workspaceRoot },
      });
      void refreshHubSnapshot().catch(() => undefined);
      response.status(201).json(created);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/session/:id/close", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const summary = await assertHubNodeService().closeSession(
        nodeId,
        readPathParam(request.params.id),
        request.body?.force === true || request.body?.manualOverride === true,
      );
      auditService.record({
        action: "hub.session.closed",
        ip: getClientIp(request),
        detail: { nodeId, sessionId: summary.id, forced: request.body?.force === true || request.body?.manualOverride === true },
      });
      void refreshHubSnapshot().catch(() => undefined);
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/session/:id/detail", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const sessions = await assertHubNodeService().listSessions();
      const session = sessions.find((item) => item.id === readPathParam(request.params.id) && item.nodeId === nodeId);
      if (!session) {
        response.status(404).json({ message: "会话不存在" });
        return;
      }
      response.json(session);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/codex/history", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      response.json({
        items: await assertHubNodeService().fetchHistory(nodeId),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/workspace/roots", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const nodes = await assertHubNodeService().getNodes();
      const node = nodes.find((entry) => entry.id === nodeId);
      response.json({
        items: node?.roots ?? [],
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/fs/list", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? ".");
      response.json({
        items: await assertHubNodeService().listDirectory(nodeId, rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/fs/file", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? "");
      response.json({
        content: await assertHubNodeService().readFile(nodeId, rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/fs/file", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      await assertHubNodeService().updateFile(
        nodeId,
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
        typeof request.body?.content === "string" ? request.body.content : "",
      );
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/upload", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const uploaded = await assertHubNodeService().uploadFile(nodeId, {
        rootPath: String(request.body?.rootPath ?? ""),
        directoryPath: String(request.body?.directoryPath ?? "."),
        fileName: String(request.body?.fileName ?? "").trim(),
        contentBase64: typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : "",
      });
      response.status(201).json({ ok: true, relativePath: uploaded.relativePath });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/fs/download", requireAuth, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const upstream = await assertHubNodeService().downloadFile(
        nodeId,
        String(request.query.rootPath ?? ""),
        String(request.query.relativePath ?? ""),
      );
      const fileNameHeader = upstream.headers.get("content-disposition");
      const contentType = upstream.headers.get("content-type");
      if (fileNameHeader) {
        response.setHeader("content-disposition", fileNameHeader);
      }
      if (contentType) {
        response.setHeader("content-type", contentType);
      }
      response.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/folder", requireAuth, async (request, response) => {
    try {
      await assertHubNodeService().createFolder(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/file", requireAuth, async (request, response) => {
    try {
      await assertHubNodeService().createFile(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/rename", requireAuth, async (request, response) => {
    try {
      await assertHubNodeService().renameEntry(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.sourceRelativePath ?? ""),
        String(request.body?.targetRelativePath ?? ""),
      );
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/delete", requireAuth, async (request, response) => {
    try {
      await assertHubNodeService().deleteEntry(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/goal-guard/:sessionId", requireAuth, async (request, response) => {
    try {
      const body = request.body ?? {};
      const goalConfig: GoalGuardConfig = {
        enabled: body.enabled === true,
        goalText: typeof body.goalText === "string" ? body.goalText : "",
        successKeywords: Array.isArray(body.successKeywords)
          ? body.successKeywords.map((item: unknown) => String(item)).filter(Boolean)
          : [],
        successCommand:
          typeof body.successCommand === "string" && body.successCommand.trim() ? body.successCommand : null,
        idleTimeoutSec: Number(body.idleTimeoutSec ?? config.defaultIdleTimeoutSec),
        resumePromptTemplate:
          typeof body.resumePromptTemplate === "string" && body.resumePromptTemplate.trim()
            ? body.resumePromptTemplate
            : "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
        allowManualStopAfterSuccess: body.allowManualStopAfterSuccess !== false,
      };
      const session = await assertHubNodeService().updateGoalGuard(
        readNodeId(request),
        readPathParam(request.params.sessionId),
        goalConfig,
      );
      response.json(session);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/goal-guard/:sessionId/override-stop", requireAuth, async (request, response) => {
    try {
      const summary = await assertHubNodeService().overrideStop(
        readNodeId(request),
        readPathParam(request.params.sessionId),
      );
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });
} else {
  registerLocalRoutes("/api", requireAuth);
}

if (config.runtimeMode !== "hub") {
  registerLocalRoutes("/api/node", requireNodeSecret);
}

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
  console.log(`TouchMux ${config.runtimeMode} listening on http://${config.host}:${config.port}`);
  for (const warning of config.securityWarnings) {
    console.warn(`[security-warning] ${warning}`);
  }
});

const terminalWss = new WebSocketServer({ noServer: true });
const eventWss = new WebSocketServer({ noServer: true });
const nodeTerminalWss = new WebSocketServer({ noServer: true });

if (localRuntime) {
  localRuntime.sessionManager.on("session-updated", (summary) => {
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
}

let hubSnapshotPayload = JSON.stringify({
  type: "snapshot",
  payload: [] as SessionSummary[],
});

async function refreshHubSnapshot(): Promise<void> {
  if (!hubNodeService) {
    return;
  }
  const snapshot = await hubNodeService.listSessions();
  const payload = JSON.stringify({
    type: "snapshot",
    payload: snapshot,
  });
  if (payload === hubSnapshotPayload) {
    return;
  }
  hubSnapshotPayload = payload;
  for (const client of eventWss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(hubSnapshotPayload);
    }
  }
}

if (config.runtimeMode === "hub") {
  void refreshHubSnapshot().catch(() => undefined);
  setInterval(() => {
    void refreshHubSnapshot().catch(() => undefined);
  }, 2500);
}

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);

    if (url.pathname === "/ws/node/terminal") {
      if (!config.nodeSharedSecret) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      const provided = String(request.headers["x-touchmux-node-secret"] ?? "");
      if (!provided || !safeEqual(provided, config.nodeSharedSecret)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      nodeTerminalWss.handleUpgrade(request, socket, head, (ws) => {
        nodeTerminalWss.emit("connection", ws, request, url);
      });
      return;
    }

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
  if (config.runtimeMode === "hub") {
    ws.send(hubSnapshotPayload);
    return;
  }
  ws.send(
    JSON.stringify({
      type: "snapshot",
      payload: assertLocalRuntime().sessionManager.listSessionSummaries(),
    }),
  );
});

function handleLocalTerminalConnection(ws: WebSocket, url: URL): void {
  const runtime = assertLocalRuntime();
  const sessionId = url.searchParams.get("sessionId");
  const cols = Number(url.searchParams.get("cols") ?? 120);
  const rows = Number(url.searchParams.get("rows") ?? 32);
  if (!sessionId) {
    ws.close(1008, "missing sessionId");
    return;
  }
  let ptyProcess;
  try {
    ptyProcess = runtime.sessionManager.attachToSession(
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
        runtime.sessionManager.writeTerminal(ptyProcess, message.payload);
      }
      if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
        runtime.sessionManager.resizeTerminal(ptyProcess, message.cols, message.rows);
      }
    } catch {
      return;
    }
  });

  ws.on("close", () => {
    ptyProcess.kill();
  });
}

function handleHubTerminalConnection(ws: WebSocket, url: URL): void {
  const nodeId = url.searchParams.get("nodeId");
  const sessionId = url.searchParams.get("sessionId");
  const cols = Number(url.searchParams.get("cols") ?? 120);
  const rows = Number(url.searchParams.get("rows") ?? 32);
  if (!nodeId || !sessionId) {
    ws.send(JSON.stringify({ type: "error", payload: "缺少 nodeId 或 sessionId" }));
    ws.close();
    return;
  }

  const node = assertHubNodeService().getConfiguredNode(nodeId);
  if (!node) {
    ws.send(JSON.stringify({ type: "error", payload: "节点不存在" }));
    ws.close();
    return;
  }

  const upstreamUrl = new URL(trimSlash(node.baseUrl));
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.pathname = path.posix.join(upstreamUrl.pathname, "/ws/node/terminal");
  upstreamUrl.search = new URLSearchParams({
    sessionId,
    cols: String(cols),
    rows: String(rows),
  }).toString();

  const upstream = new WebSocket(upstreamUrl.toString(), {
    headers: {
      "x-touchmux-node-secret": node.sharedSecret ?? "",
    },
  });
  const pendingMessages: string[] = [];
  const flushPendingMessages = () => {
    while (pendingMessages.length > 0 && upstream.readyState === upstream.OPEN) {
      const next = pendingMessages.shift();
      if (typeof next === "string") {
        upstream.send(next);
      }
    }
  };

  upstream.on("message", (buffer) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(buffer.toString());
    }
  });

  upstream.on("open", () => {
    setTimeout(flushPendingMessages, 150);
  });

  upstream.on("close", () => {
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });

  upstream.on("error", () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", payload: "节点终端连接失败" }));
      ws.close();
    }
  });

  ws.on("message", (buffer) => {
    const payload = buffer.toString();
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(payload);
      return;
    }
    pendingMessages.push(payload);
  });

  ws.on("close", () => {
    upstream.close();
  });
}

terminalWss.on("connection", (ws: WebSocket, _request: Request, url?: URL) => {
  if (!url) {
    ws.close(1008, "missing url context");
    return;
  }
  if (config.runtimeMode === "hub") {
    handleHubTerminalConnection(ws, url);
    return;
  }
  handleLocalTerminalConnection(ws, url);
});

nodeTerminalWss.on("connection", (ws: WebSocket, _request: Request, url?: URL) => {
  if (!url) {
    ws.close(1008, "missing url context");
    return;
  }
  handleLocalTerminalConnection(ws, url);
});

if (localRuntime) {
  localRuntime.goalGuardService.start();
}
