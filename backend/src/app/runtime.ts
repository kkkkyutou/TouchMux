import { spawnSync } from "node:child_process";
import { config } from "../core/config.js";
import { AuditService } from "../services/auditService.js";
import { CodexHistoryService } from "../services/codexHistoryService.js";
import { FileService } from "../services/fileService.js";
import { GoalGuardService } from "../services/goalGuardService.js";
import { HubNodeService } from "../services/hubNodeService.js";
import { LoginRateLimiter } from "../services/loginRateLimiter.js";
import { SessionManager } from "../services/sessionManager.js";
import { SessionRepository } from "../services/sessionRepository.js";
import type { NodeSummary } from "../types/models.js";

export interface LocalRuntime {
  repository: SessionRepository;
  sessionManager: SessionManager;
  goalGuardService: GoalGuardService;
  codexHistoryService: CodexHistoryService;
  fileService: FileService;
}

export interface AppRuntime {
  auditService: AuditService;
  loginRateLimiter: LoginRateLimiter;
  localRuntime: LocalRuntime | null;
  hubNodeService: HubNodeService | null;
}

export function createAppRuntime(): AppRuntime {
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

  return {
    auditService,
    loginRateLimiter,
    localRuntime,
    hubNodeService:
      config.runtimeMode === "hub" ? new HubNodeService(config.hubNodes, config.nodeRequestTimeoutMs) : null,
  };
}

export function ensureSecureDefaults(): void {
  if (
    !config.allowInsecureDefaults &&
    config.runtimeMode !== "single" &&
    (config.password === "change-me" || config.jwtSecret === "change-this-secret")
  ) {
    throw new Error(
      "当前运行模式禁止使用默认登录口令或默认 JWT 密钥。请修改 .env，或仅在本地调试时显式设置 TOUCHMUX_ALLOW_INSECURE_DEFAULTS=true。",
    );
  }
}

export function assertLocalRuntime(localRuntime: LocalRuntime | null): LocalRuntime {
  if (!localRuntime) {
    throw new Error("当前运行模式不支持本地会话服务");
  }
  return localRuntime;
}

export function assertHubNodeService(hubNodeService: HubNodeService | null): HubNodeService {
  if (!hubNodeService) {
    throw new Error("当前运行模式不支持 Hub 节点代理");
  }
  return hubNodeService;
}

export function localNodeSummary(): NodeSummary {
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

export function buildLocalCapabilities() {
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
