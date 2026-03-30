import { spawnSync } from "node:child_process";
import type { Express } from "express";
import { config } from "../core/config.js";
import type { HubNodeService } from "../services/hubNodeService.js";
import type { AuthMiddleware } from "../app/auth.js";
import { assertLocalRuntime, localNodeSummary, type LocalRuntime } from "../app/runtime.js";

interface RegisterCoreRoutesOptions {
  app: Express;
  requireAuth: AuthMiddleware;
  localRuntime: LocalRuntime | null;
  hubNodeService: HubNodeService | null;
}

export function registerCoreRoutes({
  app,
  requireAuth,
  localRuntime,
  hubNodeService,
}: RegisterCoreRoutesOptions): void {
  app.get("/api/system/health", (_request, response) => {
    response.json({
      ok: true,
      runtimeMode: config.runtimeMode,
      timestamp: Date.now(),
    });
  });

  app.get("/api/system/health/detail", requireAuth, async (_request, response) => {
    if (config.runtimeMode === "hub" && hubNodeService) {
      const nodes = await hubNodeService.getNodes();
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
      managedSessionCount: assertLocalRuntime(localRuntime).sessionManager.listSessionSummaries().length,
      securityWarnings: config.securityWarnings,
      timestamp: Date.now(),
    });
  });

  app.get("/api/nodes", requireAuth, async (_request, response) => {
    if (config.runtimeMode === "hub" && hubNodeService) {
      response.json({
        items: await hubNodeService.getNodes(),
      });
      return;
    }
    response.json({
      items: [localNodeSummary()],
    });
  });
}
