import type { NodeSummary } from "../types/api";

export type AccessMode = "gateway" | "direct_preferred";
export type ConnectionPath = "direct" | "gateway";

export interface TerminalAccessDecision {
  mode: AccessMode;
  directAllowed: boolean;
  directWsBaseUrl: string | null;
  reason: string;
}

export function resolvePreferredNodeHttpBaseUrl(node: NodeSummary): string | null {
  return node.directAccessReady ? node.directHttpBaseUrl : null;
}

export function resolvePreferredNodeWsBaseUrl(node: NodeSummary): string | null {
  return node.directAccessReady ? node.directWsBaseUrl : null;
}

export interface NodeRequestTarget {
  apiBaseUrl: string | null;
  wsBaseUrl: string | null;
}

export interface AppTransportModel {
  controlPlane: {
    eventStreamLabel: string;
    sessionManagementLabel: string;
    nodeDirectoryLabel: string;
  };
  terminal: {
    accessDecision: TerminalAccessDecision;
  };
  targets: {
    currentNodeGateway: NodeRequestTarget;
    goalGuardGateway: NodeRequestTarget;
    sessionManagementGateway: NodeRequestTarget;
    eventStreamGateway: NodeRequestTarget;
    fileRead: NodeRequestTarget;
    goalGuardRead: NodeRequestTarget;
  };
}

interface ApiRequestTargetLike {
  apiBaseUrl?: string | null;
}

export interface DirectReadStateSetter {
  setPath: (path: ConnectionPath) => void;
  setFallbackUsed: (used: boolean) => void;
  setFallbackReason: (reason: string | null) => void;
}

export const CONTROL_PLANE_TRANSPORT_LABELS = {
  eventStream: "事件流：控制面聚合，固定统一入口",
  sessionManagement: "会话管理：控制面聚合，固定统一入口",
  nodeDirectory: "节点目录与会话列表：由 Hub 聚合，不参与节点直连",
} as const;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function normalizeApiBaseUrl(target?: ApiRequestTargetLike | null): string | null {
  return target?.apiBaseUrl?.trim() || null;
}

export function canPreferDirectApiTarget(
  mode: AccessMode,
  directTarget?: ApiRequestTargetLike | null,
  gatewayTarget?: ApiRequestTargetLike | null,
): boolean {
  const directApiBaseUrl = normalizeApiBaseUrl(directTarget);
  const gatewayApiBaseUrl = normalizeApiBaseUrl(gatewayTarget);
  return mode === "direct_preferred" && Boolean(directApiBaseUrl) && directApiBaseUrl !== gatewayApiBaseUrl;
}

export function formatConnectionPathLabel(path: ConnectionPath): string {
  return path === "direct" ? "节点直连" : "统一入口";
}

export async function executeNodeFirstRead<T>(options: {
  mode: AccessMode;
  directTarget?: ApiRequestTargetLike | null;
  gatewayTarget?: ApiRequestTargetLike | null;
  readDirect: () => Promise<T>;
  readGateway: () => Promise<T>;
  classifyFallbackReason: (error: unknown) => string;
  state: DirectReadStateSetter;
}): Promise<T> {
  const canTryDirect = canPreferDirectApiTarget(options.mode, options.directTarget, options.gatewayTarget);
  if (!canTryDirect) {
    const result = await options.readGateway();
    options.state.setPath("gateway");
    options.state.setFallbackUsed(false);
    options.state.setFallbackReason(null);
    return result;
  }
  try {
    const result = await options.readDirect();
    options.state.setPath("direct");
    options.state.setFallbackUsed(false);
    options.state.setFallbackReason(null);
    return result;
  } catch (directError) {
    const fallbackReason = options.classifyFallbackReason(directError);
    const result = await options.readGateway();
    options.state.setPath("gateway");
    options.state.setFallbackUsed(true);
    options.state.setFallbackReason(fallbackReason);
    return result;
  }
}

export function resolveAppTransportModel(options: {
  currentNode: NodeSummary | null;
  sidebarNode: NodeSummary | null;
  fileAccessMode: AccessMode;
  terminalAccessMode: AccessMode;
  gatewayWsBaseUrl: string;
}): AppTransportModel {
  const currentNodeGateway = resolveNodeRequestTarget(options.currentNode, "gateway");
  const sessionManagementGateway = resolveNodeRequestTarget(options.sidebarNode, "gateway");
  const fileRead = resolveNodeRequestTarget(options.currentNode, options.fileAccessMode);
  return {
    controlPlane: {
      eventStreamLabel: CONTROL_PLANE_TRANSPORT_LABELS.eventStream,
      sessionManagementLabel: CONTROL_PLANE_TRANSPORT_LABELS.sessionManagement,
      nodeDirectoryLabel: CONTROL_PLANE_TRANSPORT_LABELS.nodeDirectory,
    },
    terminal: {
      accessDecision: resolveTerminalAccessDecision(
        options.currentNode,
        options.terminalAccessMode,
        options.gatewayWsBaseUrl,
      ),
    },
    targets: {
      currentNodeGateway,
      goalGuardGateway: currentNodeGateway,
      sessionManagementGateway,
      eventStreamGateway: sessionManagementGateway,
      fileRead,
      goalGuardRead: fileRead,
    },
  };
}

export function resolveTerminalAccessDecision(
  node: NodeSummary | null,
  mode: AccessMode,
  gatewayWsBaseUrl: string,
): TerminalAccessDecision {
  if (mode === "gateway") {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "当前已手动固定为统一入口。",
    };
  }
  if (!node) {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "当前未选中可用节点。",
    };
  }
  if (node.status !== "online") {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "当前节点离线，禁止尝试直连。",
    };
  }
  if (!node.directAccessReady) {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "节点尚未声明直连已就绪。",
    };
  }
  if (!node.directWsBaseUrl) {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "节点缺少直连 WebSocket 地址。",
    };
  }
  if (trimTrailingSlash(node.directWsBaseUrl) === trimTrailingSlash(gatewayWsBaseUrl)) {
    return {
      mode,
      directAllowed: false,
      directWsBaseUrl: null,
      reason: "节点直连地址与统一入口相同，无需切换。",
    };
  }
  return {
    mode,
    directAllowed: true,
    directWsBaseUrl: node.directWsBaseUrl,
    reason: "满足终端直连准入条件，将先尝试节点直连。",
  };
}

export function resolveNodeRequestTarget(
  node: NodeSummary | null,
  mode: AccessMode = "gateway",
): NodeRequestTarget {
  if (!node || mode === "gateway") {
    return {
      apiBaseUrl: null,
      wsBaseUrl: null,
    };
  }
  return {
    apiBaseUrl: resolvePreferredNodeHttpBaseUrl(node),
    wsBaseUrl: resolvePreferredNodeWsBaseUrl(node),
  };
}
