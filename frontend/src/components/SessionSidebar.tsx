import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createFolder, listDirectory } from "../lib/api";
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
}

const SESSION_ORDER_STORAGE_KEY = "touchmux-session-order-v1";

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
        label: "守卫暂停",
        tone: "danger",
        detail: session.guardDecisionReason ?? "缺少严格 verifier，守卫已暂停确认成功。",
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
  const longPressTimerRef = useRef<number | null>(null);
  const activeDragSessionIdRef = useRef<string | null>(null);
  const suppressNextClickRef = useRef(false);
  const dragEngagedRef = useRef(false);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const previousCardTopsRef = useRef(new Map<string, number>());
  const dragPointerIdRef = useRef<number | null>(null);
  const dragPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartClientYRef = useRef(0);
  const dragCommittedOrderRef = useRef<string[]>([]);
  const dragBaseTopMapRef = useRef(new Map<string, number>());
  const previousOrderedSessionIdsRef = useRef<string[]>([]);
  const sidebarRootRef = useRef<HTMLDivElement | null>(null);

  const historyOptions = useMemo(() => historyItems.slice(0, 20), [historyItems]);
  const selectedHistoryItem = useMemo(
    () => historyItems.find((item) => item.sessionId === sourceId) ?? null,
    [historyItems, sourceId],
  );
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === currentNodeId) ?? null,
    [nodes, currentNodeId],
  );
  const roots = selectedNode?.roots ?? [];
  const liveSessions = useMemo(
    () => sessions.filter((session) => session.hasTmuxSession && session.nodeId === currentNodeId),
    [sessions, currentNodeId],
  );
  const nodeStorageKey = currentNodeId ?? "__none__";
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
    const previousTouchAction = document.body.style.touchAction;
    const previousUserSelect = document.body.style.userSelect;
    const previousWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.touchAction = "none";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    const applyDraggedCardTransform = (translateY: number) => {
      const draggedId = activeDragSessionIdRef.current;
      if (!draggedId) {
        return;
      }
      const element = cardRefs.current.get(draggedId);
      if (!element) {
        return;
      }
      element.style.transition = "none";
      element.style.transform = `translate3d(0, ${translateY - 6}px, 0) scale(1.018)`;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragPointerIdRef.current !== null && event.pointerId !== dragPointerIdRef.current) {
        return;
      }
      event.preventDefault();
      dragEngagedRef.current = true;
      applyDraggedCardTransform(event.clientY - dragStartClientYRef.current);
      const draggedId = activeDragSessionIdRef.current;
      const card = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }
          const sessionCard = element.closest("[data-session-id]");
          if (!(sessionCard instanceof HTMLElement)) {
            return false;
          }
          return sessionCard.dataset.sessionId !== draggedId;
        })
        ?.closest("[data-session-id]");
      const targetId = card instanceof HTMLElement ? card.dataset.sessionId ?? null : null;
      if (!draggedId || !targetId || draggedId === targetId) {
        return;
      }
      const targetRect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
      const placement =
        targetRect && event.clientY > targetRect.top + targetRect.height / 2
          ? "after"
          : "before";
      setDragPreviewTarget((current) => {
        if (current?.targetId === targetId && current.placement === placement) {
          return current;
        }
        return { targetId, placement };
      });
    };
    const clearDrag = (commitOrder: boolean) => {
      const draggedId = activeDragSessionIdRef.current;
      const previewTarget = dragPreviewTarget;
      if (commitOrder && draggedId && previewTarget) {
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
      }
      if (draggedId) {
        const draggedElement = cardRefs.current.get(draggedId);
        if (draggedElement) {
          draggedElement.style.transition = "";
          draggedElement.style.transform = "";
        }
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
      dragBaseTopMapRef.current = new Map();
      dragEngagedRef.current = false;
      setDragPreviewTarget(null);
      setDraggingSessionId(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    const handlePointerUp = () => {
      clearDrag(true);
    };
    const handlePointerCancel = () => {
      clearDrag(false);
    };
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      document.body.style.touchAction = previousTouchAction;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.webkitUserSelect = previousWebkitUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [dragPreviewTarget, draggingSessionId, nodeStorageKey]);

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
    if (draggingSessionId) {
      const draggedId = draggingSessionId;
      const sourceOrder = dragCommittedOrderRef.current.length > 0 ? dragCommittedOrderRef.current : orderedSessionIds;
      const previewOrder = dragPreviewTarget ? reorderIds(sourceOrder, draggedId, dragPreviewTarget.targetId, dragPreviewTarget.placement) : sourceOrder;
      const previewIndexMap = new Map(previewOrder.map((sessionId, index) => [sessionId, index]));
      for (const [sessionId, element] of cardRefs.current.entries()) {
        if (sessionId === draggedId) {
          continue;
        }
        const sourceIndex = sourceOrder.indexOf(sessionId);
        const previewIndex = previewIndexMap.get(sessionId);
        const currentTop = sourceIndex >= 0 ? dragBaseTopMapRef.current.get(sourceOrder[sourceIndex]) : undefined;
        const previewTop =
          previewIndex !== undefined
            ? dragBaseTopMapRef.current.get(sourceOrder[previewIndex] ?? "")
            : undefined;
        const offset = currentTop !== undefined && previewTop !== undefined ? previewTop - currentTop : 0;
        element.style.transition = "transform 220ms cubic-bezier(0.2, 0.82, 0.2, 1)";
        element.style.transform = offset === 0 ? "" : `translateY(${offset}px)`;
      }
      return;
    }
    const previousOrder = previousOrderedSessionIdsRef.current;
    const orderChanged = previousOrder.length > 0 && !sameIdOrder(previousOrder, orderedSessionIds);
    for (const [sessionId, element] of cardRefs.current.entries()) {
      if (sessionId !== draggingSessionId) {
        element.style.transition = "";
        element.style.transform = "";
      }
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
      if (!orderChanged) {
        continue;
      }
      const deltaY = previousTop - nextTop;
      if (Math.abs(deltaY) < 1) {
        continue;
      }
      element.style.transition = "none";
      element.style.transform = `translateY(${deltaY}px)`;
      window.requestAnimationFrame(() => {
        element.style.transition = "transform 340ms cubic-bezier(0.18, 0.88, 0.2, 1), border-color 260ms ease, box-shadow 260ms ease, background-color 260ms ease";
        element.style.transform = "";
      });
    }
    previousCardTopsRef.current = nextCardTops;
    previousOrderedSessionIdsRef.current = orderedSessionIds;
  }, [dragPreviewTarget, draggingSessionId, orderedLiveSessions, orderedSessionIds]);

  useEffect(() => {
    if (!token || !currentNodeId || !workspaceRoot || !showCreateForm) {
      return;
    }
    let cancelled = false;
    const nodeId = currentNodeId;
    async function loadCurrentDirectories(): Promise<void> {
      try {
        setDirectoryLoading(true);
        const items = await listDirectory(token, nodeId, workspaceRoot, cwd);
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
        const items = await listDirectory(token, nodeId, workspaceRoot, suggestionContext.basePath);
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
      for (const orderedSessionId of orderedSessionIds) {
        const element = cardRefs.current.get(orderedSessionId);
        if (!element) {
          continue;
        }
        element.style.transition = "";
        if (orderedSessionId !== sessionId) {
          element.style.transform = "";
        }
        nextBaseTopMap.set(orderedSessionId, element.getBoundingClientRect().top);
      }
      dragBaseTopMapRef.current = nextBaseTopMap;
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
      await createFolder(token, currentNodeId, workspaceRoot, normalizeRelativePath(relativePath));
      const items = await listDirectory(token, currentNodeId, workspaceRoot, cwd);
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
          <h2>管理终端</h2>
          <div className="session-meta">默认控制台保持空白，只有你手动选择某个终端后才显示对应内容。</div>
        </div>
      </div>

      <div className="node-picker">
        <div className="directory-picker-summary">
          <strong>当前机器</strong>
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
        {selectedNode?.error ? <div className="session-meta">{selectedNode.error}</div> : null}
      </div>

      <div className="session-list">
        {orderedLiveSessions.length === 0 ? <div className="session-meta">当前没有运行中的 Codex 终端。</div> : null}
        {orderedLiveSessions.map((session) => {
          const summary = guardStateSummary(session);
          return (
          <article
            key={session.id}
            data-session-id={session.id}
            className={`session-card ${currentSessionId === session.id ? "active" : ""} ${draggingSessionId === session.id ? "dragging" : ""}`}
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
            <div className="session-card-main compact">
              <div className="session-card-topline">
                <span className={`status-pill status-pill-${summary.tone}`}>{summary.label}</span>
              </div>
              <strong className="session-card-title">{session.title}</strong>
              <div className="session-meta session-path">
                {formatDirectoryLabel(rootLabelMap.get(session.workspaceRoot) ?? "当前根目录", session.cwd)}
              </div>
              <div className="session-meta session-status-detail">{summary.detail}</div>
            </div>
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
                删除
              </button>
            </div>
          </article>
        );
        })}
      </div>

      <div className="drawer-section">
        <div className="drawer-section-header">
          <div>
            <div className="eyebrow">新建</div>
            <h2>创建终端</h2>
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
                <strong>启动目录</strong>
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
                <span className="session-meta">可以直接输入完整路径，例如 {formatDirectoryLabel(selectedRootLabel, "projects")}。</span>
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
                {selectedHistoryItem ? (
                  <section className="inline-action-card history-preview-card">
                    <div className="inline-action-header">
                      <div>
                        <div className="eyebrow">会话预览</div>
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
                  ? "创建并启动"
                  : mode === "resume"
                    ? "恢复到新 tmux"
                    : "Fork 到新 tmux"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
