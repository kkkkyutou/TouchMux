import type { Express } from "express";
import { config, configSchema } from "../core/config.js";
import type { AuditService } from "../services/auditService.js";
import type { HubNodeService } from "../services/hubNodeService.js";
import type { GoalGuardConfig, WorkspaceEntry } from "../types/models.js";
import type { AuthMiddleware } from "../app/auth.js";
import { buildGoalGuardConfig } from "../app/goalGuard.js";
import { getClientIp, readNodeId, readPathParam, sendError } from "../app/http.js";

interface RegisterHubRoutesOptions {
  app: Express;
  authMiddleware: AuthMiddleware;
  hubNodeService: HubNodeService;
  auditService: AuditService;
  onSessionsChanged: () => Promise<void> | void;
}

export function registerHubRoutes({
  app,
  authMiddleware,
  hubNodeService,
  auditService,
  onSessionsChanged,
}: RegisterHubRoutesOptions): void {
  const triggerSnapshotRefresh = () => {
    Promise.resolve(onSessionsChanged()).catch(() => undefined);
  };

  app.get("/api/system/capabilities", authMiddleware, async (_request, response) => {
    const nodes = await hubNodeService.getNodes();
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
        choiceOverlay: false,
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

  app.get("/api/system/config-schema", authMiddleware, (_request, response) => {
    response.json({
      items: configSchema,
    });
  });

  app.get("/api/session/list", authMiddleware, async (_request, response) => {
    response.json({
      items: await hubNodeService.listSessions(),
    });
  });

  app.post("/api/session/create", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const created = await hubNodeService.createSession(nodeId, {
        title: String(request.body?.title ?? "").trim() || "新建会话",
        workspaceRoot: String(request.body?.workspaceRoot ?? ""),
        cwd: String(request.body?.cwd ?? "."),
        mode: request.body?.mode ?? "new",
        prompt: typeof request.body?.prompt === "string" ? request.body.prompt : undefined,
        sourceCodexSessionId:
          typeof request.body?.sourceCodexSessionId === "string" ? request.body.sourceCodexSessionId : undefined,
      });
      auditService.record({
        action: "hub.session.created",
        ip: getClientIp(request),
        detail: { nodeId, sessionId: created.id, cwd: created.cwd, workspaceRoot: created.workspaceRoot },
      });
      triggerSnapshotRefresh();
      response.status(201).json(created);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/session/:id/close", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const summary = await hubNodeService.closeSession(
        nodeId,
        readPathParam(request.params.id),
        request.body?.force === true || request.body?.manualOverride === true,
      );
      auditService.record({
        action: "hub.session.closed",
        ip: getClientIp(request),
        detail: { nodeId, sessionId: summary.id, forced: request.body?.force === true || request.body?.manualOverride === true },
      });
      triggerSnapshotRefresh();
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/session/:id/detail", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const sessions = await hubNodeService.listSessions();
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

  app.post("/api/session/:id/rename", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const summary = await hubNodeService.renameSession(
        nodeId,
        readPathParam(request.params.id),
        String(request.body?.title ?? ""),
      );
      triggerSnapshotRefresh();
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/codex/history", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      response.json({
        items: await hubNodeService.fetchHistory(nodeId),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/workspace/roots", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const nodes = await hubNodeService.getNodes();
      const node = nodes.find((entry) => entry.id === nodeId);
      response.json({
        items: node?.roots ?? [],
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/fs/list", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? ".");
      response.json({
        items: await hubNodeService.listDirectory(nodeId, rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/fs/file", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const rootPath = String(request.query.rootPath ?? "");
      const relativePath = String(request.query.relativePath ?? "");
      response.json({
        content: await hubNodeService.readFile(nodeId, rootPath, relativePath),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/fs/file", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      await hubNodeService.updateFile(
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

  app.post("/api/fs/upload", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const uploaded = await hubNodeService.uploadFile(nodeId, {
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

  app.get("/api/fs/download", authMiddleware, async (request, response) => {
    try {
      const nodeId = readNodeId(request);
      const upstream = await hubNodeService.downloadFile(
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

  app.post("/api/fs/folder", authMiddleware, async (request, response) => {
    try {
      await hubNodeService.createFolder(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/file", authMiddleware, async (request, response) => {
    try {
      await hubNodeService.createFile(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.status(201).json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/fs/rename", authMiddleware, async (request, response) => {
    try {
      await hubNodeService.renameEntry(
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

  app.post("/api/fs/delete", authMiddleware, async (request, response) => {
    try {
      await hubNodeService.deleteEntry(
        readNodeId(request),
        String(request.body?.rootPath ?? ""),
        String(request.body?.relativePath ?? ""),
      );
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/goal-guard/:sessionId", authMiddleware, async (request, response) => {
    try {
      const goalConfig: GoalGuardConfig = buildGoalGuardConfig(request.body);
      const session = await hubNodeService.updateGoalGuard(
        readNodeId(request),
        readPathParam(request.params.sessionId),
        goalConfig,
      );
      response.json(session);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/goal-guard/templates", authMiddleware, async (request, response) => {
    try {
      const items = await hubNodeService.listGoalGuardTemplates(readNodeId(request));
      response.json({ items });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/goal-guard/templates", authMiddleware, async (request, response) => {
    try {
      const template = await hubNodeService.saveGoalGuardTemplate(readNodeId(request), {
        id: typeof request.body?.id === "string" ? request.body.id : null,
        name: String(request.body?.name ?? ""),
        content: String(request.body?.content ?? ""),
      });
      response.status(201).json(template);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/goal-guard/templates/:templateId", authMiddleware, async (request, response) => {
    try {
      await hubNodeService.deleteGoalGuardTemplate(readNodeId(request), readPathParam(request.params.templateId));
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/goal-guard/templates/:templateId/default", authMiddleware, async (request, response) => {
    try {
      const template = await hubNodeService.setDefaultGoalGuardTemplate(
        readNodeId(request),
        readPathParam(request.params.templateId),
      );
      response.json(template);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/goal-guard/:sessionId/override-stop", authMiddleware, async (request, response) => {
    try {
      const summary = await hubNodeService.overrideStop(
        readNodeId(request),
        readPathParam(request.params.sessionId),
      );
      response.json(summary);
    } catch (error) {
      sendError(response, error);
    }
  });
}
