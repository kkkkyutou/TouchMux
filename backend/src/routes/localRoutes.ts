import path from "node:path";
import type { Express } from "express";
import { config, configSchema } from "../core/config.js";
import type { AuditService } from "../services/auditService.js";
import type { GoalGuardConfig } from "../types/models.js";
import { buildGoalGuardConfig } from "../app/goalGuard.js";
import { getClientIp, readPathParam, sendError } from "../app/http.js";
import type { AuthMiddleware } from "../app/auth.js";
import type { LocalRuntime } from "../app/runtime.js";
import { buildLocalCapabilities } from "../app/runtime.js";

interface RegisterLocalRoutesOptions {
  app: Express;
  prefix: string;
  authMiddleware: AuthMiddleware;
  localRuntime: LocalRuntime;
  auditService: AuditService;
}

export function registerLocalRoutes({
  app,
  prefix,
  authMiddleware,
  localRuntime,
  auditService,
}: RegisterLocalRoutesOptions): void {
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
      items: localRuntime.sessionManager.listSessionSummaries(),
    });
  });

  app.post(`${prefix}/session/create`, authMiddleware, (request, response) => {
    try {
      const created = localRuntime.sessionManager.createSession({
        title: String(request.body?.title ?? "").trim() || "新建会话",
        workspaceRoot: String(request.body?.workspaceRoot ?? ""),
        cwd: String(request.body?.cwd ?? "."),
        mode: request.body?.mode ?? "new",
        prompt: typeof request.body?.prompt === "string" ? request.body.prompt : undefined,
        sourceCodexSessionId:
          typeof request.body?.sourceCodexSessionId === "string" ? request.body.sourceCodexSessionId : undefined,
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
      const summary = localRuntime.sessionManager.closeSession(
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
    const session = localRuntime.sessionManager.getSessionSummary(readPathParam(request.params.id));
    if (!session) {
      response.status(404).json({ message: "会话不存在" });
      return;
    }
    response.json(session);
  });

  app.get(`${prefix}/codex/history`, authMiddleware, (_request, response) => {
    response.json({
      items: localRuntime.codexHistoryService.listHistory(),
    });
  });

  app.get(`${prefix}/workspace/roots`, authMiddleware, (_request, response) => {
    response.json({
      items: localRuntime.fileService.listRoots(),
    });
  });

  app.get(`${prefix}/fs/list`, authMiddleware, (request, response) => {
    try {
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? ".");
      response.json({
        items: localRuntime.fileService.listDirectory(rootPath, relativePath),
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
        content: localRuntime.fileService.readFile(rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put(`${prefix}/fs/file`, authMiddleware, (request, response) => {
    try {
      localRuntime.fileService.updateFile(
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
      localRuntime.fileService.writeFileFromBase64(rootPath, relativePath, contentBase64);
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
      const filePath = localRuntime.fileService.resolvePath(rootPath, relativePath);
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
      localRuntime.fileService.createFolder(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
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
      localRuntime.fileService.createFile(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
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
      localRuntime.fileService.renameEntry(
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
      localRuntime.fileService.deleteEntry(String(request.body?.rootPath ?? ""), String(request.body?.relativePath ?? ""));
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
    const session = localRuntime.sessionManager.getSessionSummary(readPathParam(request.params.sessionId));
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
      const goalConfig: GoalGuardConfig = buildGoalGuardConfig(request.body);
      const session = localRuntime.sessionManager.updateGoalConfig(readPathParam(request.params.sessionId), goalConfig);
      response.json(session);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(`${prefix}/goal-guard/:sessionId/override-stop`, authMiddleware, (request, response) => {
    try {
      const summary = localRuntime.sessionManager.closeSession(readPathParam(request.params.sessionId), true);
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
