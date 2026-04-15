import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createFolder, listDirectory, type RequestTargetOptions } from "../lib/api";
import type { FileEntry, HistoryConversationSummary, NodeSummary, SessionMode, SessionSummary } from "../types/api";

interface SessionSidebarProps {
  token: string;
  nodes: NodeSummary[];
  sessions: SessionSummary[];
  historyItems: HistoryConversationSummary[];
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseDrawer: () => void;
  onCreateSession: (payload: {
    nodeId: string;
    title: string;
    workspaceRoot: string;
    cwd: string;
    mode: SessionMode;
    prompt?: string;
    sourceCodexSessionId?: string;
  }) => Promise<void>;
  onCloseSession: (sessionId: string, nodeId: string) => Promise<void>;
  onForceCloseSession: (sessionId: string, nodeId: string) => Promise<void>;
  requestOptions?: RequestTargetOptions;
  historyTransportLabel?: string;
  interfaceBoundarySummary?: {
    runtimeMode: string | null;
    totalCount: number;
    controlPlaneCount: number;
    nodeFirstReadCount: number;
    gatewayFirstWriteCount: number;
  };
}

interface DragGhostState {
  sessionId: string;
  title: string;
  statusLabel: string;
  statusTone: "neutral" | "active" | "success" | "danger";
  runtimeLabel: string;
  runtimeTone: "neutral" | "active" | "success" | "danger";
  statusDetail: string;
  runtimeDetail: string;
  pathLabel: string;
  left: number;
  top: number;
  width: number;
  height: number;
  startTop: number;
  dropping: boolean;
}

const SESSION_ORDER_STORAGE_KEY = "touchmux-session-order-v1";

function formatNodeCheckedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function loadStoredRecord(key: string): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([recordKey, value]) => [
        recordKey,
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

function persistStoredRecord(key: string, value: Record<string, string[]>): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function reorderIds(
  order: string[],
  draggedId: string,
  targetId: string,
  placement: "before" | "after",
): string[] {
  if (draggedId === targetId) {
    return order;
  }
  const base = order.filter((id) => id !== draggedId);
  const targetIndex = base.indexOf(targetId);
  if (targetIndex === -1) {
    return [...base, draggedId];
  }
  const next = [...base];
  next.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, draggedId);
  return next;
}

function sameIdOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function buildPreviewTargetFromInsertIndex(
  baseOrder: string[],
  insertIndex: number,
): { targetId: string; placement: "before" | "after" } | null {
  if (baseOrder.length === 0) {
    return null;
  }
  if (insertIndex >= baseOrder.length) {
    return {
      targetId: baseOrder[baseOrder.length - 1],
      placement: "after",
    };
  }
  return {
    targetId: baseOrder[insertIndex],
    placement: "before",
  };
}

function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function guardStateSummary(session: SessionSummary): { label: string; tone: "neutral" | "active" | "success" | "danger"; detail: string } {
  if (!session.hasTmuxSession || session.status === "closed") {
    return {
      label: "已关闭",
      tone: "neutral",
      detail: "tmux 会话已结束。",
    };
  }
  switch (session.guardDecisionState) {
    case "disabled":
      return {
        label: "空闲",
        tone: "neutral",
        detail: "Goal Guard 未启动，当前只是普通终端。",
      };
    case "waiting_for_idle":
      return {
        label: "守卫待机",
        tone: "active",
        detail: session.guardDecisionReason ?? "守卫已启动，正在等待新的有效进展信号。",
      };
    case "observing_output":
      return {
        label: "守卫观察中",
        tone: "active",
        detail: session.guardDecisionReason ?? "检测到 checkpoint 之后的新输出。",
      };
    case "observing_codex_turn":
      return {
        label: "Codex 执行中",
        tone: "active",
        detail: session.guardDecisionReason ?? "守卫已确认当前 Codex turn 仍在运行。",
      };
    case "verifying":
      return {
        label: "守卫验收中",
        tone: "active",
        detail: session.guardDecisionReason ?? "检测到候选完成信号，正在执行 verifier。",
      };
    case "resuming":
      return {
        label: "守卫续跑中",
        tone: "active",
        detail: session.guardDecisionReason ?? "守卫正在推动任务继续执行。",
      };
    case "satisfied":
      return {
        label: "目标已达成",
        tone: "success",
        detail: session.guardDecisionReason ?? "成功证据已确认。",
      };
    case "verification_failed":
      return {
        label: "验收未过",
        tone: "danger",
        detail: session.guardDecisionReason ?? "候选完成信号未通过校验。",
      };
    case "blocked_by_missing_verifier":
      return {
        label: "守卫等待中",
        tone: "neutral",
        detail: session.guardDecisionReason ?? "当前没有严格 verifier，候选信号不会阻塞后续续跑。",
      };
    case "blocked_by_fatal_error":
      return {
        label: "阻塞错误",
        tone: "danger",
        detail: session.guardDecisionReason ?? "检测到明确阻塞错误，守卫不会继续自动续跑。",
      };
    case "manually_overridden":
      return {
        label: "手动停止",
        tone: "neutral",
        detail: session.guardDecisionReason ?? "会话已被手动停止。",
      };
    default:
      return {
        label: session.status === "running" ? "运行中" : "空闲",
        tone: "neutral",
        detail: session.guardDecisionReason ?? "当前状态未分类。",
      };
  }
}

function runtimeContextSummary(session: SessionSummary): {
  label: string;
  tone: "neutral" | "active" | "success" | "danger";
  detail: string;
} {
  if (session.runtimeContextState === "live") {
    return {
      label: "实时上下文",
      tone: "success",
      detail: session.runtimeContextDetail ?? "当前状态来自本次进程内的实时维护。",
    };
  }
  if (session.runtimeContextState === "tmux_resynced") {
    return {
      label: "tmux 重同步",
      tone: "active",
      detail: session.runtimeContextDetail ?? "当前状态在启动后已重新和 tmux pane 对齐。",
    };
  }
  return {
    label: "持久化残留",
    tone: "danger",
    detail: session.runtimeContextDetail ?? "当前状态仍主要依赖上次持久化快照。",
  };
}

function formatDirectoryLabel(rootLabel: string, relativePath: string): string {
  const prefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  return relativePath === "." ? `${prefix}/` : `${prefix}/${relativePath}`;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized || normalized === "." || normalized === "/") {
    return ".";
  }
  return normalized.replace(/^\.?\//, "").replace(/\/$/, "") || ".";
}

function parentRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (normalized === ".") {
    return ".";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return ".";
  }
  return segments.slice(0, -1).join("/");
}

function parsePathInput(input: string, workspaceRoot: string, rootLabel: string): string {
  const trimmed = input.trim();
  const displayPrefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  if (!trimmed || trimmed === displayPrefix || trimmed === `${displayPrefix}/`) {
    return ".";
  }
  if (displayPrefix === "~" && (trimmed === "~" || trimmed === "~/")) {
    return ".";
  }
  if (displayPrefix === "~" && trimmed.startsWith("~/")) {
    return normalizeRelativePath(trimmed.slice(2));
  }
  if (trimmed.startsWith(`${displayPrefix}/`)) {
    return normalizeRelativePath(trimmed.slice(displayPrefix.length + 1));
  }
  if (trimmed === workspaceRoot || trimmed === `${workspaceRoot}/`) {
    return ".";
  }
  if (trimmed.startsWith(`${workspaceRoot}/`)) {
    return normalizeRelativePath(trimmed.slice(workspaceRoot.length + 1));
  }
  if (trimmed.startsWith("/")) {
    throw new Error("输入路径超出当前允许根目录");
  }
  return normalizeRelativePath(trimmed);
}

function parsePathDraftForSuggestions(
  input: string,
  workspaceRoot: string,
  rootLabel: string,
): { basePath: string; partialName: string } | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  const displayPrefix = rootLabel.startsWith("Home") ? "~" : rootLabel;
  let relativeDraft = trimmed;

  if (!relativeDraft || relativeDraft === displayPrefix || relativeDraft === `${displayPrefix}/`) {
    return { basePath: ".", partialName: "" };
  }
  if (displayPrefix === "~" && (relativeDraft === "~" || relativeDraft === "~/")) {
    return { basePath: ".", partialName: "" };
  }
  if (displayPrefix === "~" && relativeDraft.startsWith("~/")) {
    relativeDraft = relativeDraft.slice(2);
  } else if (relativeDraft.startsWith(`${displayPrefix}/`)) {
    relativeDraft = relativeDraft.slice(displayPrefix.length + 1);
  } else if (relativeDraft === workspaceRoot || relativeDraft === `${workspaceRoot}/`) {
    return { basePath: ".", partialName: "" };
  } else if (relativeDraft.startsWith(`${workspaceRoot}/`)) {
    relativeDraft = relativeDraft.slice(workspaceRoot.length + 1);
  } else if (relativeDraft.startsWith("/")) {
    return null;
  }

  const compact = relativeDraft.replace(/\/+/g, "/");
  if (!compact) {
    return { basePath: ".", partialName: "" };
  }
  const normalized = compact.replace(/^\.?\//, "");
  if (!normalized) {
    return { basePath: ".", partialName: "" };
  }
  if (normalized.endsWith("/")) {
    return {
      basePath: normalizeRelativePath(normalized),
      partialName: "",
    };
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex === -1) {
    return { basePath: ".", partialName: normalized };
  }
  return {
    basePath: normalizeRelativePath(normalized.slice(0, slashIndex)),
    partialName: normalized.slice(slashIndex + 1),
  };
}

function trimPreview(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

function renderSessionCardSummary(content: {
  statusLabel: string;
  statusTone: "neutral" | "active" | "success" | "danger";
  runtimeLabel: string;
  runtimeTone: "neutral" | "active" | "success" | "danger";
  title: string;
  pathLabel: string;
}) {
  return (
    <div className="session-card-main compact">
      <div className="session-card-topline">
        <span className={`status-pill status-pill-${content.statusTone}`}>{content.statusLabel}</span>
        <span className={`status-pill status-pill-${content.runtimeTone}`}>{content.runtimeLabel}</span>
      </div>
      <strong className="session-card-title">{content.title}</strong>
      <div className="session-meta session-path">{content.pathLabel}</div>
    </div>
  );
}

function renderSessionCardActions(options?: { ghost?: boolean }) {
  return (
    <div className={`session-actions ${options?.ghost ? "ghost-session-actions" : ""}`}>
      <button
        type="button"
        className="ghost-button"
        tabIndex={-1}
        aria-hidden={options?.ghost ? "true" : undefined}
      >
        显示
      </button>
      <button
        type="button"
        className="ghost-button danger"
        tabIndex={-1}
        aria-hidden={options?.ghost ? "true" : undefined}
      >
        删除
      </button>
    </div>
  );
}

export function SessionSidebar({
  token,
  nodes,
  sessions,
  historyItems,
  currentNodeId,
  onSelectNode,
  currentSessionId,
  onSelectSession,
  onCloseDrawer,
  onCreateSession,
  onCloseSession,
  onForceCloseSession,
  requestOptions,
  historyTransportLabel,
  interfaceBoundarySummary,
}: SessionSidebarProps) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("new");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [directoryPath, setDirectoryPath] = useState(".");
  const [childDirectories, setChildDirectories] = useState<FileEntry[]>([]);
  const [pathDraft, setPathDraft] = useState("");
  const [pathSuggestions, setPathSuggestions] = useState<FileEntry[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [sessionOrderByNode, setSessionOrderByNode] = useState<Record<string, string[]>>(() => loadStoredRecord(SESSION_ORDER_STORAGE_KEY));
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragPreviewTarget, setDragPreviewTarget] = useState<{ targetId: string; placement: "before" | "after" } | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const activeDragSessionIdRef = useRef<string | null>(null);
  const suppressNextClickRef = useRef(false);
  const dragEngagedRef = useRef(false);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const previousCardTopsRef = useRef(new Map<string, number>());
  const dragPointerIdRef = useRef<number | null>(null);
  const dragPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartClientYRef = useRef(0);
  const dragCurrentTranslateYRef = useRef(0);
  const dragCardHeightRef = useRef(0);
  const dragCommittedOrderRef = useRef<string[]>([]);
  const dragBaseTopMapRef = useRef(new Map<string, number>());
  const dragBaseHeightMapRef = useRef(new Map<string, number>());
  const previousOrderedSessionIdsRef = useRef<string[]>([]);
  const ghostDropStartedRef = useRef(false);
  const ghostClearTimerRef = useRef<number | null>(null);
  const skipNextOrderFlipRef = useRef(false);
  const sidebarRootRef = useRef<HTMLDivElement | null>(null);

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);
  const selectedHistoryItem = useMemo(
    () => historyItems.find((item) => item.sessionId === sourceId) ?? null,
    [historyItems, sourceId],
  );
  const effectiveNodeId = useMemo(() => {
    if (currentNodeId && sessions.some((session) => session.hasTmuxSession && session.nodeId === currentNodeId)) {
      return currentNodeId;
    }
    return sessions.find((session) => session.hasTmuxSession && session.status !== "closed")?.nodeId ?? currentNodeId;
  }, [currentNodeId, sessions]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === effectiveNodeId) ?? null,
    [effectiveNodeId, nodes],
  );
  const roots = selectedNode?.roots ?? [];
  const liveSessions = useMemo(
    () => sessions.filter((session) => session.hasTmuxSession && session.nodeId === effectiveNodeId),
    [effectiveNodeId, sessions],
  );
  const nodeStorageKey = effectiveNodeId ?? "__none__";
  const manualOrder = sessionOrderByNode[nodeStorageKey] ?? [];
  const orderedLiveSessions = useMemo(() => {
    const sessionMap = new Map(liveSessions.map((session) => [session.id, session]));
    const ordered = manualOrder
      .map((id) => sessionMap.get(id))
      .filter((session): session is SessionSummary => Boolean(session));
    const missing = liveSessions.filter((session) => !manualOrder.includes(session.id));
    return [...ordered, ...missing];
  }, [liveSessions, manualOrder]);
  const rootLabelMap = useMemo(
    () => new Map(roots.map((root) => [root.rootPath, root.label])),
    [roots],
  );
  const selectedRootLabel = useMemo(
    () => roots.find((root) => root.rootPath === workspaceRoot)?.label ?? "当前根目录",
    [roots, workspaceRoot],
  );
  const cwd = directoryPath;
  const selectedDirectoryLabel = formatDirectoryLabel(selectedRootLabel, cwd);
  const orderedSessionIds = useMemo(() => orderedLiveSessions.map((session) => session.id), [orderedLiveSessions]);
  const renderedSessionIds = useMemo(() => {
    if (!draggingSessionId) {
      return orderedSessionIds;
    }
    const sourceOrder = dragCommittedOrderRef.current.length > 0 ? dragCommittedOrderRef.current : orderedSessionIds;
    if (!dragPreviewTarget) {
      return sourceOrder;
    }
    return reorderIds(sourceOrder, draggingSessionId, dragPreviewTarget.targetId, dragPreviewTarget.placement);
  }, [dragPreviewTarget, draggingSessionId, orderedSessionIds]);
  const renderedLiveSessions = useMemo(() => {
    const sessionMap = new Map(orderedLiveSessions.map((session) => [session.id, session]));
    return renderedSessionIds
      .map((sessionId) => sessionMap.get(sessionId))
      .filter((session): session is SessionSummary => Boolean(session));
  }, [orderedLiveSessions, renderedSessionIds]);
  const sessionCardMetaMap = useMemo(
    () =>
      new Map(
        orderedLiveSessions.map((session) => {
          const summary = guardStateSummary(session);
          const runtimeSummary = runtimeContextSummary(session);
          return [
            session.id,
            {
              title: session.title,
              statusLabel: summary.label,
              statusTone: summary.tone,
              statusDetail: summary.detail,
              runtimeLabel: runtimeSummary.label,
              runtimeTone: runtimeSummary.tone,
              runtimeDetail: runtimeSummary.detail,
              pathLabel: formatDirectoryLabel(rootLabelMap.get(session.workspaceRoot) ?? "当前根目录", session.cwd),
            },
          ];
        }),
      ),
    [orderedLiveSessions, rootLabelMap],
  );

  useEffect(() => {
    if (roots.length === 0) {
      setWorkspaceRoot("");
      return;
    }
    if (!workspaceRoot || !roots.some((root) => root.rootPath === workspaceRoot)) {
      setWorkspaceRoot(roots[0].rootPath);
    }
  }, [roots, workspaceRoot]);

  useEffect(() => {
    setDirectoryPath(".");
    setPathDraft(formatDirectoryLabel(selectedRootLabel, "."));
    setSourceId("");
  }, [workspaceRoot, selectedRootLabel]);

  useEffect(() => {
    setPathDraft(selectedDirectoryLabel);
  }, [selectedDirectoryLabel]);

  useEffect(() => {
    const visibleIds = liveSessions.map((session) => session.id);
    setSessionOrderByNode((current) => {
      const previous = current[nodeStorageKey] ?? [];
      const retained = previous.filter((id) => visibleIds.includes(id));
      const additions = visibleIds.filter((id) => !retained.includes(id));
      const nextForNode = [...retained, ...additions];
      if (
        nextForNode.length === previous.length
        && nextForNode.every((id, index) => id === previous[index])
      ) {
        return current;
      }
      const next = { ...current, [nodeStorageKey]: nextForNode };
      persistStoredRecord(SESSION_ORDER_STORAGE_KEY, next);
      return next;
    });
  }, [liveSessions, nodeStorageKey]);

  useEffect(() => {
    if (!draggingSessionId) {
      return;
    }
    const root = sidebarRootRef.current;
    const scrollParent = findScrollParent(root);
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousTouchAction = document.body.style.touchAction;
    const previousBodyOverflow = document.body.style.overflow;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    const previousUserSelect = document.body.style.userSelect;
    const previousWebkitUserSelect = document.body.style.webkitUserSelect;
    document.documentElement.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    if (scrollParent) {
      scrollParent.style.overscrollBehavior = "none";
      scrollParent.style.touchAction = "none";
    }
    const applyDraggedCardTransform = (translateY: number) => {
      const draggedId = activeDragSessionIdRef.current;
      if (!draggedId) {
        return;
      }
      dragCurrentTranslateYRef.current = translateY - 6;
      setDragGhost((current) =>
        current && current.sessionId === draggedId && !current.dropping
          ? { ...current, top: current.startTop + dragCurrentTranslateYRef.current }
          : current,
      );
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragPointerIdRef.current !== null && event.pointerId !== dragPointerIdRef.current) {
        return;
      }
      event.preventDefault();
      dragEngagedRef.current = true;
      const rawTranslateY = event.clientY - dragStartClientYRef.current;
      applyDraggedCardTransform(rawTranslateY);
      const draggedId = activeDragSessionIdRef.current;
      if (!draggedId) {
        return;
      }
      const sourceOrder = dragCommittedOrderRef.current.length > 0 ? dragCommittedOrderRef.current : orderedSessionIds;
      const baseOrder = sourceOrder.filter((sessionId) => sessionId !== draggedId);
      const draggedBaseTop = dragBaseTopMapRef.current.get(draggedId);
      const draggedHeight = dragCardHeightRef.current || dragBaseHeightMapRef.current.get(draggedId) || 0;
      if (draggedBaseTop === undefined || draggedHeight <= 0 || baseOrder.length === 0) {
        setDragPreviewTarget(null);
        return;
      }
      const draggedTop = draggedBaseTop + dragCurrentTranslateYRef.current;
      const draggedBottom = draggedTop + draggedHeight;
      const thresholdEdge = dragCurrentTranslateYRef.current <= 0 ? draggedTop : draggedBottom;
      let insertIndex = baseOrder.length;
      for (let index = 0; index < baseOrder.length; index += 1) {
        const sessionId = baseOrder[index];
        const slotTop = dragBaseTopMapRef.current.get(sessionId);
        const slotHeight = dragBaseHeightMapRef.current.get(sessionId);
        if (slotTop === undefined || slotHeight === undefined) {
          continue;
        }
        const slotCenter = slotTop + slotHeight / 2;
        if (thresholdEdge <= slotCenter) {
          insertIndex = index;
          break;
        }
      }
      const originalInsertIndex = sourceOrder.indexOf(draggedId);
      if (insertIndex === originalInsertIndex) {
        setDragPreviewTarget(null);
        return;
      }
      const previewTarget = buildPreviewTargetFromInsertIndex(baseOrder, insertIndex);
      setDragPreviewTarget((current) => {
        if (
          current?.targetId === previewTarget?.targetId
          && current?.placement === previewTarget?.placement
        ) {
          return current;
        }
        return previewTarget;
      });
    };
    const clearDrag = (commitOrder: boolean) => {
      const draggedId = activeDragSessionIdRef.current;
      const previewTarget = dragPreviewTarget;
      if (commitOrder && draggedId && previewTarget) {
        skipNextOrderFlipRef.current = true;
        ghostDropStartedRef.current = false;
        setDragGhost((current) =>
          current && current.sessionId === draggedId
            ? { ...current, top: current.startTop + dragCurrentTranslateYRef.current, dropping: true }
            : current,
        );
        setSessionOrderByNode((current) => {
          const previous = current[nodeStorageKey] ?? dragCommittedOrderRef.current;
          const nextForNode = reorderIds(previous, draggedId, previewTarget.targetId, previewTarget.placement);
          if (nextForNode.every((id, index) => id === previous[index])) {
            return current;
          }
          const next = { ...current, [nodeStorageKey]: nextForNode };
          persistStoredRecord(SESSION_ORDER_STORAGE_KEY, next);
          return next;
        });
      } else {
        setDragGhost(null);
      }
      if (draggingSessionId) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 220);
      }
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      activeDragSessionIdRef.current = null;
      dragPointerIdRef.current = null;
      dragPressStartRef.current = null;
      dragCurrentTranslateYRef.current = 0;
      dragCardHeightRef.current = 0;
      dragBaseTopMapRef.current = new Map();
      dragBaseHeightMapRef.current = new Map();
      dragEngagedRef.current = false;
      setDragPreviewTarget(null);
      setDraggingSessionId(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    const preventTouchScroll = (event: TouchEvent) => {
      event.preventDefault();
    };
    const handlePointerUp = () => {
      clearDrag(true);
    };
    const handlePointerCancel = () => {
      clearDrag(false);
    };
    window.addEventListener("touchmove", preventTouchScroll, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.touchAction = previousTouchAction;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.webkitUserSelect = previousWebkitUserSelect;
      if (scrollParent) {
        scrollParent.style.overscrollBehavior = "";
        scrollParent.style.touchAction = "";
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchmove", preventTouchScroll);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [dragPreviewTarget, draggingSessionId, nodeStorageKey]);

  useEffect(() => {
    return () => {
      if (ghostClearTimerRef.current !== null) {
        window.clearTimeout(ghostClearTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = sidebarRootRef.current;
    if (!root) {
      return;
    }
    const scrollParent = findScrollParent(root);
    if (!scrollParent) {
      return;
    }
    const handleScroll = () => {
      cancelLongPressReorder();
    };
    const handleWheel = () => {
      cancelLongPressReorder();
    };
    scrollParent.addEventListener("scroll", handleScroll, { passive: true });
    scrollParent.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      scrollParent.removeEventListener("scroll", handleScroll);
      scrollParent.removeEventListener("wheel", handleWheel);
    };
  }, [draggingSessionId]);

  useLayoutEffect(() => {
    const previousOrder = previousOrderedSessionIdsRef.current;
    const orderChanged = previousOrder.length > 0 && !sameIdOrder(previousOrder, renderedSessionIds);
    const skipOrderFlip = skipNextOrderFlipRef.current;
    skipNextOrderFlipRef.current = false;
    for (const [sessionId, element] of cardRefs.current.entries()) {
      element.style.transition = "";
      element.style.transform = "";
    }
    const nextCardTops = new Map<string, number>();
    for (const [sessionId, element] of cardRefs.current.entries()) {
      nextCardTops.set(sessionId, element.getBoundingClientRect().top);
    }
    for (const [sessionId, nextTop] of nextCardTops.entries()) {
      if (sessionId === draggingSessionId) {
        continue;
      }
      const previousTop = previousCardTopsRef.current.get(sessionId);
      const element = cardRefs.current.get(sessionId);
      if (previousTop === undefined || !element) {
        continue;
      }
      if (!orderChanged || skipOrderFlip) {
        continue;
      }
      const deltaY = previousTop - nextTop;
      if (Math.abs(deltaY) < 1) {
        continue;
      }
      element.style.transition = "none";
      element.style.transform = `translateY(${deltaY}px)`;
      window.requestAnimationFrame(() => {
        element.style.transition = draggingSessionId
          ? "transform 220ms cubic-bezier(0.2, 0.82, 0.2, 1), border-color 220ms ease, box-shadow 220ms ease, background-color 220ms ease"
          : "transform 340ms cubic-bezier(0.18, 0.88, 0.2, 1), border-color 260ms ease, box-shadow 260ms ease, background-color 260ms ease";
        element.style.transform = "";
      });
    }
    previousCardTopsRef.current = nextCardTops;
    previousOrderedSessionIdsRef.current = renderedSessionIds;
    if (dragGhost?.dropping && !ghostDropStartedRef.current) {
      const targetElement = cardRefs.current.get(dragGhost.sessionId);
      if (!targetElement) {
        setDragGhost(null);
        return;
      }
      const targetRect = targetElement.getBoundingClientRect();
      ghostDropStartedRef.current = true;
      window.requestAnimationFrame(() => {
        setDragGhost((current) =>
          current && current.sessionId === dragGhost.sessionId
            ? {
                ...current,
                top: targetRect.top,
                left: targetRect.left,
                width: targetRect.width,
                height: targetRect.height,
              }
            : current,
        );
      });
      if (ghostClearTimerRef.current !== null) {
        window.clearTimeout(ghostClearTimerRef.current);
      }
      ghostClearTimerRef.current = window.setTimeout(() => {
        setDragGhost((current) => (current?.sessionId === dragGhost.sessionId ? null : current));
        ghostDropStartedRef.current = false;
        ghostClearTimerRef.current = null;
      }, 220);
    }
  }, [dragGhost, draggingSessionId, orderedSessionIds, renderedSessionIds]);

  useEffect(() => {
    if (!token || !currentNodeId || !workspaceRoot || !showCreateForm) {
      return;
    }
    let cancelled = false;
    const nodeId = currentNodeId;
    async function loadCurrentDirectories(): Promise<void> {
      try {
        setDirectoryLoading(true);
        const items = await listDirectory(token, nodeId, workspaceRoot, cwd, requestOptions);
        if (cancelled) {
          return;
        }
        setChildDirectories(items.filter((entry) => entry.type === "directory"));
        setDirectoryError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setChildDirectories([]);
        setDirectoryError(error instanceof Error ? error.message : "目录读取失败");
      } finally {
        if (!cancelled) {
          setDirectoryLoading(false);
        }
      }
    }
    void loadCurrentDirectories();
    return () => {
      cancelled = true;
    };
  }, [token, currentNodeId, workspaceRoot, cwd, showCreateForm]);

  useEffect(() => {
    if (!token || !currentNodeId || !workspaceRoot || !showCreateForm) {
      return;
    }
    const context = parsePathDraftForSuggestions(pathDraft, workspaceRoot, selectedRootLabel);
    if (!context) {
      setPathSuggestions([]);
      setSuggestionLoading(false);
      return;
    }
    const suggestionContext = context;
    let cancelled = false;
    const nodeId = currentNodeId;
    async function loadSuggestions(): Promise<void> {
      try {
        setSuggestionLoading(true);
        const items = await listDirectory(token, nodeId, workspaceRoot, suggestionContext.basePath, requestOptions);
        if (cancelled) {
          return;
        }
        const next = items
          .filter((entry) => entry.type === "directory")
          .filter((entry) =>
            suggestionContext.partialName
              ? entry.name.toLowerCase().includes(suggestionContext.partialName.toLowerCase())
              : true,
          )
          .slice(0, 8);
        setPathSuggestions(next);
      } catch {
        if (!cancelled) {
          setPathSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setSuggestionLoading(false);
        }
      }
    }
    void loadSuggestions();
    return () => {
      cancelled = true;
    };
  }, [token, currentNodeId, workspaceRoot, pathDraft, selectedRootLabel, showCreateForm]);

  function applyPathDraft(): void {
    try {
      const nextPath = parsePathInput(pathDraft, workspaceRoot, selectedRootLabel);
      setDirectoryPath(nextPath);
      setDirectoryError(null);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "路径无效");
    }
  }

  function resetCreateForm(): void {
    setTitle("");
    setPrompt("");
    setSourceId("");
    setDirectoryPath(".");
    setPathDraft(formatDirectoryLabel(selectedRootLabel, "."));
    setSubmitError(null);
    setDirectoryError(null);
    setMode("new");
    setNewFolderName("");
    setCreatingFolder(false);
  }

  function beginLongPressReorder(sessionId: string): void {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    activeDragSessionIdRef.current = sessionId;
    longPressTimerRef.current = window.setTimeout(() => {
      dragCommittedOrderRef.current = orderedSessionIds;
      const nextBaseTopMap = new Map<string, number>();
      const nextBaseHeightMap = new Map<string, number>();
      const draggedElement = cardRefs.current.get(sessionId);
      const draggedMeta = sessionCardMetaMap.get(sessionId);
      const draggedRect = draggedElement?.getBoundingClientRect();
      if (!draggedElement || !draggedMeta || !draggedRect) {
        activeDragSessionIdRef.current = null;
        longPressTimerRef.current = null;
        return;
      }
      for (const orderedSessionId of orderedSessionIds) {
        const element = cardRefs.current.get(orderedSessionId);
        if (!element) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        element.style.transition = "";
        if (orderedSessionId !== sessionId) {
          element.style.transform = "";
        } else {
          dragCardHeightRef.current = rect.height;
        }
        nextBaseTopMap.set(orderedSessionId, rect.top);
        nextBaseHeightMap.set(orderedSessionId, rect.height);
      }
      dragBaseTopMapRef.current = nextBaseTopMap;
      dragBaseHeightMapRef.current = nextBaseHeightMap;
      ghostDropStartedRef.current = false;
      setDragGhost({
        sessionId,
        title: draggedMeta.title,
        statusLabel: draggedMeta.statusLabel,
        statusTone: draggedMeta.statusTone,
        runtimeLabel: draggedMeta.runtimeLabel,
        runtimeTone: draggedMeta.runtimeTone,
        statusDetail: draggedMeta.statusDetail,
        runtimeDetail: draggedMeta.runtimeDetail,
        pathLabel: draggedMeta.pathLabel,
        left: draggedRect.left,
        top: draggedRect.top - 6,
        width: draggedRect.width,
        height: draggedRect.height,
        startTop: draggedRect.top - 6,
        dropping: false,
      });
      setDragPreviewTarget(null);
      setDraggingSessionId(sessionId);
      longPressTimerRef.current = null;
    }, 190);
  }

  function cancelLongPressReorder(): void {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (!draggingSessionId) {
      activeDragSessionIdRef.current = null;
      dragPointerIdRef.current = null;
      dragPressStartRef.current = null;
    }
  }

  async function handleCreateSubDirectory(): Promise<void> {
    if (!token || !currentNodeId || !workspaceRoot) {
      setDirectoryError("当前未选择可用节点或根目录");
      return;
    }
    const nextName = newFolderName.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!nextName || nextName.includes("..")) {
      setDirectoryError("请输入合法的子目录名");
      return;
    }
    const relativePath = cwd === "." ? nextName : `${cwd}/${nextName}`;
    try {
      setCreatingFolder(true);
      await createFolder(token, currentNodeId, workspaceRoot, normalizeRelativePath(relativePath), requestOptions);
      const items = await listDirectory(token, currentNodeId, workspaceRoot, cwd, requestOptions);
      setChildDirectories(items.filter((entry) => entry.type === "directory"));
      setDirectoryError(null);
      setNewFolderName("");
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "创建目录失败");
    } finally {
      setCreatingFolder(false);
    }
  }

  return (
    <div ref={sidebarRootRef} className="drawer-section session-sidebar">
      <div className="drawer-section-header">
        <div>
          <div className="eyebrow">终端</div>
          <h2>终端</h2>
        </div>
      </div>

      <div className="node-picker">
        <div className="directory-picker-summary">
          <strong>节点</strong>
          {selectedNode ? <span className="session-meta">{selectedNode.status === "online" ? "在线" : "离线"}</span> : null}
        </div>
        <select
          value={currentNodeId ?? ""}
          onChange={(event) => {
            onSelectNode(event.target.value);
          }}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label} · {node.status === "online" ? "在线" : "离线"}
            </option>
          ))}
        </select>
        {selectedNode ? (
          <div className="node-status-stack">
            <div className="session-meta">{selectedNode.directAccessReady ? "终端可直连" : "终端走统一入口"}</div>
            <div className="session-meta">最近检测：{formatNodeCheckedAt(selectedNode.lastCheckedAt)}</div>
          </div>
        ) : null}
        {selectedNode?.error ? <div className="session-meta">{selectedNode.error}</div> : null}
      </div>

      {interfaceBoundarySummary && interfaceBoundarySummary.totalCount > 0 ? (
        <div className="node-picker">
          <div className="directory-picker-summary">
            <strong>接口边界</strong>
            <span className="session-meta">
              {interfaceBoundarySummary.runtimeMode ? `${interfaceBoundarySummary.runtimeMode} 模式` : "运行模式待确认"}
            </span>
          </div>
          <div className="session-actions compact-meta-actions">
            <span className="status-pill status-pill-neutral">控制面 {interfaceBoundarySummary.controlPlaneCount}</span>
            <span className="status-pill status-pill-active">直连读 {interfaceBoundarySummary.nodeFirstReadCount}</span>
            <span className="status-pill status-pill-danger">统一写 {interfaceBoundarySummary.gatewayFirstWriteCount}</span>
          </div>
        </div>
      ) : null}

      <div className="session-list">
        {selectedNode?.status === "offline" ? (
          <div className="error-banner inline-banner">
            当前节点离线，先恢复节点再切换或新建终端。
          </div>
        ) : null}
        {renderedLiveSessions.length === 0 ? (
          <div className="session-meta">
            {selectedNode?.status === "offline" ? "当前无法确认是否还有运行中的终端。" : "当前没有运行中的终端。"}
          </div>
        ) : null}
        {renderedLiveSessions.map((session) => {
          const cardMeta = sessionCardMetaMap.get(session.id);
          if (!cardMeta) {
            return null;
          }
          return (
          <article
            key={session.id}
            data-session-id={session.id}
            className={`session-card ${currentSessionId === session.id ? "active" : ""} ${
              draggingSessionId === session.id ? "drag-placeholder" : ""
            } ${dragGhost?.dropping && dragGhost.sessionId === session.id ? "ghost-drop-target" : ""}`}
            ref={(element) => {
              if (element) {
                cardRefs.current.set(session.id, element);
              } else {
                cardRefs.current.delete(session.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
            }}
            onMouseDown={(event) => {
              if (event.target instanceof HTMLElement && event.target.closest("button")) {
                return;
              }
            }}
            onPointerDown={(event) => {
              if (event.target instanceof HTMLElement && event.target.closest("button")) {
                return;
              }
              document.getSelection()?.removeAllRanges();
              dragEngagedRef.current = false;
              dragPointerIdRef.current = event.pointerId;
              dragPressStartRef.current = { x: event.clientX, y: event.clientY };
              dragStartClientYRef.current = event.clientY;
              beginLongPressReorder(session.id);
            }}
            onPointerMove={(event) => {
              if (draggingSessionId || dragPointerIdRef.current !== event.pointerId || !dragPressStartRef.current) {
                return;
              }
              const deltaX = event.clientX - dragPressStartRef.current.x;
              const deltaY = event.clientY - dragPressStartRef.current.y;
              if (Math.hypot(deltaX, deltaY) > 8) {
                cancelLongPressReorder();
              }
            }}
            onTouchStartCapture={(event) => {
              if (event.target instanceof HTMLElement && event.target.closest("button")) {
                return;
              }
              document.getSelection()?.removeAllRanges();
            }}
            onClick={() => {
              if (suppressNextClickRef.current) {
                return;
              }
              onSelectSession(session.id);
              onCloseDrawer();
            }}
            onPointerUp={() => {
              cancelLongPressReorder();
            }}
            onPointerCancel={() => {
              cancelLongPressReorder();
            }}
            onPointerLeave={() => {
              if (!draggingSessionId) {
                cancelLongPressReorder();
              }
            }}
          >
            {renderSessionCardSummary(cardMeta)}
            <div className="session-actions">
              <button
                type="button"
                className="ghost-button"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectSession(session.id);
                  onCloseDrawer();
                }}
              >
                显示
              </button>
              <button
                type="button"
                className="ghost-button danger"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  void onForceCloseSession(session.id, session.nodeId);
                }}
              >
                强停
              </button>
            </div>
          </article>
        );
        })}
      </div>
      {dragGhost && typeof document !== "undefined"
        ? createPortal(
            <div
              className={`session-card drag-ghost ${dragGhost.dropping ? "dropping" : ""}`}
              style={{
                top: dragGhost.top,
                left: dragGhost.left,
                width: dragGhost.width,
                minHeight: dragGhost.height,
              }}
              aria-hidden="true"
            >
              {renderSessionCardSummary(dragGhost)}
              {renderSessionCardActions({ ghost: true })}
            </div>,
            document.body,
          )
        : null}

      <div className="drawer-section">
        <div className="drawer-section-header">
          <div>
            <div className="eyebrow">创建</div>
            <h2>新建终端</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setShowCreateForm((current) => {
                const next = !current;
                if (!next) {
                  resetCreateForm();
                }
                return next;
              });
            }}
          >
            {showCreateForm ? "收起" : "新建终端"}
          </button>
        </div>

        {!showCreateForm ? null : (
          <form
            className="session-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitting(true);
              setSubmitError(null);
              if (!currentNodeId) {
                setSubmitError("请先选择一个节点");
                setSubmitting(false);
                return;
              }
              if (!selectedNode || selectedNode.status !== "online") {
                setSubmitError(selectedNode?.error ?? "当前节点离线，无法创建新会话");
                setSubmitting(false);
                return;
              }
              void onCreateSession({
                nodeId: currentNodeId,
                title: title || `${mode === "new" ? "新建" : mode === "resume" ? "恢复" : "Fork"} 会话`,
                workspaceRoot,
                cwd,
                mode,
                prompt: prompt || undefined,
                sourceCodexSessionId: sourceId || undefined,
              })
                .then(() => {
                  resetCreateForm();
                  setShowCreateForm(false);
                })
                .catch((error) => {
                  setSubmitError(error instanceof Error ? error.message : "创建会话失败");
                })
                .finally(() => {
                  setSubmitting(false);
                });
            }}
          >
            {submitError ? <div className="error-banner">{submitError}</div> : null}
            <label>
              标题
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="比如：修复终端附着" />
            </label>
            <label>
              模式
              <select value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
                <option value="new">新建</option>
                <option value="resume">恢复已有 Codex 会话</option>
                <option value="fork">Fork 已有 Codex 会话</option>
              </select>
            </label>
            <label>
              工作根目录
              <select value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} disabled={roots.length === 0}>
                {roots.map((root) => (
                  <option key={root.rootPath} value={root.rootPath}>
                    {root.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="directory-picker">
              <div className="directory-picker-summary">
                <strong>目录</strong>
                {directoryLoading ? <span className="session-meta">读取中...</span> : null}
              </div>
              <div className="address-bar-row">
                <input
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    event.preventDefault();
                    applyPathDraft();
                  }}
                  aria-label="启动目录路径"
                  placeholder={formatDirectoryLabel(selectedRootLabel, ".")}
                />
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    applyPathDraft();
                  }}
                >
                  打开
                </button>
              </div>
              <div className="directory-actions-row">
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setDirectoryPath(".");
                    setDirectoryError(null);
                  }}
                >
                  根目录
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setDirectoryPath(parentRelativePath(cwd));
                    setDirectoryError(null);
                  }}
                  disabled={cwd === "."}
                >
                  上一级
                </button>
              </div>
              <label className="directory-create-inline">
                <span>当前目录新建子目录</span>
                <div className="address-bar-row">
                  <input
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") {
                        return;
                      }
                      event.preventDefault();
                      void handleCreateSubDirectory();
                    }}
                    placeholder="例如：my-task"
                  />
                  <button
                    type="button"
                    className="ghost-button compact-button"
                    disabled={creatingFolder}
                    onClick={() => {
                      void handleCreateSubDirectory();
                    }}
                  >
                    {creatingFolder ? "创建中..." : "新建目录"}
                  </button>
                </div>
              </label>
              <label>
                进入子目录
                <select
                  value=""
                  onChange={(event) => {
                    const nextPath = event.target.value;
                    if (!nextPath) {
                      return;
                    }
                    setDirectoryPath(nextPath);
                    setDirectoryError(null);
                  }}
                >
                  <option value="">请选择</option>
                  {childDirectories.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="directory-picker-top">
                <span className="session-meta">可直接输入完整路径，例如 {formatDirectoryLabel(selectedRootLabel, "projects")}。</span>
              </div>
              {directoryError ? <div className="error-banner">{directoryError}</div> : null}
              {!suggestionLoading && pathSuggestions.length === 0 ? null : (
                <div className="path-suggestion-list">
                  {suggestionLoading ? <span className="session-meta">路径建议读取中...</span> : null}
                  {pathSuggestions.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="ghost-button path-suggestion-button"
                      onClick={() => {
                        setDirectoryPath(entry.path);
                        setPathDraft(formatDirectoryLabel(selectedRootLabel, entry.path));
                        setDirectoryError(null);
                      }}
                    >
                      {formatDirectoryLabel(selectedRootLabel, entry.path)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {mode !== "new" ? (
              <>
                <label>
                  源 Codex Session
                  <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                    <option value="">请选择</option>
                    {historyOptions.map((item) => (
                      <option key={item.sessionId} value={item.sessionId}>
                        {item.sessionId.slice(0, 8)} · {trimPreview(item.firstSnippet || item.lastSnippet || "暂无内容", 18)} ·{" "}
                        {new Date(item.lastUpdatedAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {historyTransportLabel ? <div className="session-meta">{historyTransportLabel}</div> : null}
                {selectedHistoryItem ? (
                  <section className="inline-action-card history-preview-card">
                    <div className="inline-action-header">
                      <div>
                        <div className="eyebrow">预览</div>
                        <h3>{selectedHistoryItem.sessionId.slice(0, 8)}</h3>
                      </div>
                      <span className="session-meta">{selectedHistoryItem.messageCount} 条记录</span>
                    </div>
                    <div className="history-preview-line">
                      <strong>开场</strong>
                      <span>{selectedHistoryItem.firstSnippet || "暂无文本"}</span>
                    </div>
                    <div className="history-preview-line">
                      <strong>最近</strong>
                      <span>{selectedHistoryItem.lastSnippet || "暂无文本"}</span>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}
            <label>
              初始提示
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="可选。新建时作为初始 prompt，恢复/fork 时作为跟进 prompt。"
                rows={3}
              />
            </label>
            <button type="submit" disabled={submitting || !workspaceRoot || (mode !== "new" && !sourceId)}>
              {submitting
                ? "处理中..."
                : mode === "new"
                  ? "创建"
                  : mode === "resume"
                    ? "恢复"
                    : "Fork"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
