import type { EventSocketState, EventSocketStatus } from "../hooks/useEventSocket";
import type { InterfaceCatalogEntry, NodeSummary, SessionSummary } from "../types/api";

export type AppStatusIssueKind = "auth" | "gateway" | "node" | "session";

export interface AppStatusIssue {
  kind: AppStatusIssueKind;
  title: string;
  detail: string;
}

export interface TerminalDiagnosticsSummary {
  phaseLabel: string;
  pathLabel: string;
  summary: string;
  recoverySummary: string;
}

export interface InterfaceBoundarySummaryPresentation {
  title: string;
  detail: string;
  controlPlaneCount: number;
  nodeFirstReadCount: number;
  gatewayFirstWriteCount: number;
}

export function selectCurrentSession(
  sessions: SessionSummary[],
  currentSessionId: string | null,
): SessionSummary | null {
  return sessions.find((session) => session.id === currentSessionId) ?? null;
}

export function selectCurrentNode(options: {
  nodes: NodeSummary[];
  currentNodeId: string | null;
  currentSession: SessionSummary | null;
}): NodeSummary | null {
  return options.nodes.find((node) => node.id === (options.currentSession?.nodeId ?? options.currentNodeId)) ?? null;
}

export function selectSidebarNode(nodes: NodeSummary[], currentNodeId: string | null): NodeSummary | null {
  return nodes.find((node) => node.id === currentNodeId) ?? null;
}

export function describeCurrentNodeStatus(currentNode: NodeSummary | null, currentSession: SessionSummary | null): {
  title: string;
  detail: string;
} {
  if (!currentNode) {
    return {
      title: "节点未识别",
      detail: currentSession
        ? `会话 ${currentSession.title} 的节点信息尚未恢复。`
        : "当前没有可附着节点。",
    };
  }
  if (currentNode.status === "online") {
    return {
      title: `${currentNode.label} 在线`,
      detail: currentNode.directAccessReady
        ? "可直连。"
        : "在线，当前走统一入口。",
    };
  }
  return {
    title: `${currentNode.label} 离线`,
    detail: currentNode.error ?? "最近一次检查失败。",
  };
}

export function describeGlobalStatusIssue(options: {
  runtimeMode: string | null;
  eventSocketStatus: EventSocketStatus;
  eventSocketState: EventSocketState;
  currentSession: SessionSummary | null;
  currentNode: NodeSummary | null;
}): AppStatusIssue | null {
  const { runtimeMode, eventSocketStatus, eventSocketState, currentSession, currentNode } = options;
  if (eventSocketStatus !== "open" && eventSocketState.lastError) {
    return {
      kind: "gateway",
      title: runtimeMode === "hub" ? "统一入口同步异常" : "控制面同步异常",
      detail: eventSocketState.lastError,
    };
  }
  if (currentSession && !currentNode) {
    return {
      kind: "session",
      title: "会话节点缺失",
      detail: `会话 ${currentSession.title} 的节点信息尚未恢复。`,
    };
  }
  if (currentNode && currentNode.status !== "online") {
    return {
      kind: "node",
      title: "当前节点离线",
      detail: currentNode.error ?? `节点 ${currentNode.label} 最近一次检查未通过。`,
    };
  }
  if (
    currentSession
    && currentSession.runtimeContextState === "persisted_only"
    && (!currentSession.hasTmuxSession || currentSession.status === "closed")
  ) {
    return {
      kind: "session",
      title: "会话仅剩快照",
      detail:
        currentSession.runtimeContextDetail
        ?? `会话 ${currentSession.title} 目前只有旧快照，tmux 运行态未恢复。`,
    };
  }
  if (currentSession && (!currentSession.hasTmuxSession || currentSession.status === "closed")) {
    return {
      kind: "session",
      title: "会话已结束",
      detail: `会话 ${currentSession.title} 的 tmux 已结束。`,
    };
  }
  return null;
}

export function describeTerminalDiagnostics(options: {
  terminalConnectionPhase: "connecting" | "open" | "reconnecting" | "blocked";
  terminalConnectionPath: "direct" | "gateway";
  terminalReconnectAttemptCount: number;
  terminalGatewayFallbackUsed: boolean;
  terminalGatewayFallbackReason: string | null;
  terminalReconnectReason: string | null;
  terminalBlockedReason: string | null;
  terminalAttachBlockedReason: string | null;
}): TerminalDiagnosticsSummary {
  const phaseLabel =
    options.terminalConnectionPhase === "open"
      ? "连接已建立"
      : options.terminalConnectionPhase === "blocked"
        ? "连接已阻止"
        : options.terminalConnectionPhase === "reconnecting"
          ? "连接重试中"
          : "连接中";
  const pathLabel = options.terminalConnectionPath === "direct" ? "节点直连" : "统一入口";
  const summary =
    options.terminalBlockedReason
    ?? options.terminalReconnectReason
    ?? options.terminalGatewayFallbackReason
    ?? options.terminalAttachBlockedReason
    ?? (options.terminalConnectionPath === "direct"
      ? "优先走节点直连。"
      : "当前走统一入口。");
  const recoverySummary =
    options.terminalConnectionPhase === "reconnecting"
      ? `当前是第 ${options.terminalReconnectAttemptCount} 次自动重连。`
      : options.terminalConnectionPhase === "blocked" && options.terminalReconnectAttemptCount > 0
        ? `自动重连共尝试了 ${options.terminalReconnectAttemptCount} 次。`
        : "无需恢复。";
  return {
    phaseLabel,
    pathLabel,
    summary,
    recoverySummary,
  };
}

export function describeHistoryTransport(options: {
  connectionPath: "direct" | "gateway";
  gatewayFallbackUsed: boolean;
  gatewayFallbackReason: string | null;
}): string {
  return `历史：${options.connectionPath === "direct" ? "直连" : "入口"}${options.gatewayFallbackUsed ? "（回退）" : ""}${options.gatewayFallbackReason ? ` · ${options.gatewayFallbackReason}` : ""}`;
}

export function describeInterfaceBoundarySummary(options: {
  runtimeMode: string | null;
  items: InterfaceCatalogEntry[];
}): InterfaceBoundarySummaryPresentation | null {
  if (options.items.length === 0) {
    return null;
  }
  const controlPlaneCount = options.items.filter((item) => item.plane === "control").length;
  const nodeFirstReadCount = options.items.filter((item) => item.accessMode === "node_first_read").length;
  const gatewayFirstWriteCount = options.items.filter((item) => item.accessMode === "gateway_first_write").length;
  const modeLabel = options.runtimeMode ? `${options.runtimeMode} 模式` : "当前模式";
  return {
    title: `${modeLabel} 接口边界已加载`,
    detail: "控制面走统一入口，只读逐步直连。",
    controlPlaneCount,
    nodeFirstReadCount,
    gatewayFirstWriteCount,
  };
}

export function describeInterfaceAccessModeLabel(accessMode: InterfaceCatalogEntry["accessMode"] | null | undefined): string {
  switch (accessMode) {
    case "portal_only":
      return "统一入口固定";
    case "node_first_read":
      return "节点直连优先";
    case "gateway_first_write":
      return "统一入口优先";
    case "gateway_only":
      return "统一入口限定";
    default:
      return "待确认";
  }
}
