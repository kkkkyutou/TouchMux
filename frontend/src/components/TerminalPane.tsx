import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  token: string;
  nodeId: string | null;
  sessionId: string | null;
  copyModeEnabled: boolean;
  inputLocked: boolean;
  onReady: (sender: ((text: string) => void) | null) => void;
  onTmuxCopyModeReady: (
    handler: ((action: "enter" | "page_up" | "page_down" | "line_up" | "line_down" | "exit") => void) | null,
  ) => void;
  onError: (message: string) => void;
}

type TmuxCopyModeAction = "enter" | "page_up" | "page_down" | "line_up" | "line_down" | "exit";

function resolveTerminalFontSize(): number {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const isPortraitMobile = width <= 720 && height > width;
  if (isPortraitMobile) {
    return Math.max(13, Math.min(16, Math.floor(width / 23)));
  }
  if (width <= 720) {
    return 14;
  }
  return 14;
}

export function TerminalPane({
  token,
  nodeId,
  sessionId,
  copyModeEnabled,
  inputLocked,
  onReady,
  onTmuxCopyModeReady,
  onError,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const touchStateRef = useRef<{ lastY: number; carry: number } | null>(null);
  const wheelCarryRef = useRef(0);
  const copyModeEnabledRef = useRef(copyModeEnabled);
  const inputLockedRef = useRef(inputLocked);
  const recentManualPasteRef = useRef<{ text: string; at: number } | null>(null);

  const sendInputToTerminal = (text: string) => {
    if (inputLockedRef.current || text.length === 0) {
      return;
    }
    const current = socketRef.current;
    if (current?.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify({ type: "input", payload: text }));
    }
  };

  useEffect(() => {
    copyModeEnabledRef.current = copyModeEnabled;
  }, [copyModeEnabled]);

  useEffect(() => {
    inputLockedRef.current = inputLocked;
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
      terminal.options.disableStdin = inputLocked;
    if (inputLocked) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
    }
  }, [inputLocked]);

  useEffect(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: inputLocked,
      fontFamily:
        '"Sarasa Mono SC", "Maple Mono NF CN", "Cascadia Mono", "JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", "Menlo", "Consolas", "Noto Sans Mono CJK SC", monospace',
      fontSize: resolveTerminalFontSize(),
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.22,
      letterSpacing: 0.1,
      theme: {
        background: "#101513",
        foreground: "#f1efe6",
        cursor: "#ffb84d",
        selectionBackground: "rgba(255, 184, 77, 0.25)",
        black: "#232a2f",
        red: "#e67e80",
        green: "#a7c080",
        yellow: "#dbbc7f",
        blue: "#7fbbb3",
        magenta: "#d699b6",
        cyan: "#83c092",
        white: "#d3c6aa",
        brightBlack: "#4f585e",
        brightRed: "#f08f90",
        brightGreen: "#b2ca8f",
        brightYellow: "#e7c38a",
        brightBlue: "#89c2bb",
        brightMagenta: "#e0a7c4",
        brightCyan: "#95d4a4",
        brightWhite: "#fff9e8",
      },
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    terminal.attachCustomKeyEventHandler((event) => {
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        const selection = terminal.getSelection();
        if (selection.trim().length === 0) {
          return false;
        }
        void navigator.clipboard.writeText(selection).catch(() => undefined);
        return false;
      }
      return true;
    });
    if (hostRef.current) {
      terminal.open(hostRef.current);
      fitAddon.fit();
    }
    const syncTerminalViewport = () => {
      terminal.options.fontSize = resolveTerminalFontSize();
      fitAddon.fit();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    };
    const scheduleViewportSync = () => {
      syncTerminalViewport();
      window.requestAnimationFrame(syncTerminalViewport);
      window.setTimeout(syncTerminalViewport, 120);
      window.setTimeout(syncTerminalViewport, 320);
    };
    const resizeObserver = new ResizeObserver(() => {
      scheduleViewportSync();
    });
    if (hostRef.current) {
      resizeObserver.observe(hostRef.current);
    }
    window.addEventListener("resize", scheduleViewportSync);
    window.addEventListener("orientationchange", scheduleViewportSync);
    const onPaste = (event: ClipboardEvent) => {
      const host = hostRef.current;
      if (!host || !host.contains(document.activeElement)) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) {
        return;
      }
      event.preventDefault();
      recentManualPasteRef.current = { text, at: Date.now() };
      sendInputToTerminal(text);
    };
    const onKeyDownCapture = (event: KeyboardEvent) => {
      const host = hostRef.current;
      if (!host || !host.contains(document.activeElement)) {
        return;
      }
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (!modifierPressed || event.key.toLowerCase() !== "v") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.readText().then((text) => {
        if (!text) {
          return;
        }
        recentManualPasteRef.current = { text, at: Date.now() };
        sendInputToTerminal(text);
      }).catch(() => undefined);
    };
    const onCopy = (event: ClipboardEvent) => {
      const host = hostRef.current;
      if (!host || !host.contains(document.activeElement)) {
        return;
      }
      const selection = terminal.getSelection();
      if (!selection.trim()) {
        return;
      }
      event.preventDefault();
      event.clipboardData?.setData("text/plain", selection);
      terminal.clearSelection();
    };
    hostRef.current?.addEventListener("paste", onPaste as EventListener, true);
    hostRef.current?.addEventListener("keydown", onKeyDownCapture as EventListener, true);
    document.addEventListener("copy", onCopy);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleViewportSync);
      window.removeEventListener("orientationchange", scheduleViewportSync);
      hostRef.current?.removeEventListener("paste", onPaste as EventListener, true);
      hostRef.current?.removeEventListener("keydown", onKeyDownCapture as EventListener, true);
      document.removeEventListener("copy", onCopy);
      onReady(null);
      onTmuxCopyModeReady(null);
      socketRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onReady, onTmuxCopyModeReady]);

  useEffect(() => {
    const sendCopyModeAction = (action: TmuxCopyModeAction, repeat = 1) => {
      const current = socketRef.current;
      if (current?.readyState !== WebSocket.OPEN) {
        return;
      }
      const safeRepeat = Number.isFinite(repeat) ? Math.max(1, Math.min(30, Math.floor(repeat))) : 1;
      current.send(
        JSON.stringify({
          type: "tmux-copy-mode",
          action,
          repeat: safeRepeat,
        }),
      );
    };

    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    terminal.reset();
    socketRef.current?.close();
    onReady(null);

    if (!sessionId || !nodeId) {
      terminal.writeln("请选择左侧会话，或新建一个 Codex/tmux 会话。");
      return;
    }

    fitAddon.fit();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socketUrl = `${protocol}://${location.host}/ws/terminal?token=${encodeURIComponent(
      token,
    )}&sessionId=${encodeURIComponent(sessionId)}&nodeId=${encodeURIComponent(nodeId)}&cols=${terminal.cols}&rows=${terminal.rows}`;
    let disposed = false;
    let retryCount = 0;
    let retryTimer: number | null = null;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        retryCount = 0;
        fitAddon.fit();
        window.requestAnimationFrame(() => fitAddon.fit());
        window.setTimeout(() => fitAddon.fit(), 140);
        onReady((text) => {
          const current = socketRef.current;
          if (current?.readyState !== WebSocket.OPEN) {
            return;
          }
          current.send(
            JSON.stringify({
              type: "input",
              payload: text,
            }),
          );
        });
        onTmuxCopyModeReady((action) => {
          sendCopyModeAction(action, 1);
        });
        if (copyModeEnabledRef.current) {
          sendCopyModeAction("enter", 1);
        }
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type: string; payload?: string };
        if (message.type === "data" && typeof message.payload === "string") {
          terminal.write(message.payload);
        }
        if (message.type === "error" && typeof message.payload === "string") {
          onError(message.payload);
          terminal.writeln(`\r\n[错误] ${message.payload}`);
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        onReady(null);
        onTmuxCopyModeReady(null);
        retryCount += 1;
        const retryDelayMs = Math.min(1000 * 2 ** Math.min(retryCount - 1, 3), 8000);
        retryTimer = window.setTimeout(connect, retryDelayMs);
      };
    };

    connect();

    const disposable = terminal.onData((data) => {
      const recentManualPaste = recentManualPasteRef.current;
      if (
        recentManualPaste
        && recentManualPaste.text === data
        && Date.now() - recentManualPaste.at < 500
      ) {
        recentManualPasteRef.current = null;
        return;
      }
      sendInputToTerminal(data);
    });

    return () => {
      disposed = true;
      clearRetryTimer();
      disposable.dispose();
      onTmuxCopyModeReady(null);
      socketRef.current?.close();
    };
  }, [sessionId, nodeId, token, onReady, onTmuxCopyModeReady, onError]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const onFocusIn = () => {
      if (window.innerWidth > 720) {
        return;
      }
      window.setTimeout(() => {
        const panel = host.closest(".console-panel");
        const target = panel instanceof HTMLElement ? panel : host;
        const top = target.getBoundingClientRect().top + window.scrollY - 12;
        window.scrollTo({
          top: Math.max(0, top),
          behavior: "smooth",
        });
      }, 120);
    };
    host.addEventListener("focusin", onFocusIn);
    const pixelsPerLine = 22;
    const sendScrollLines = (action: "line_up" | "line_down", lineCount: number) => {
      const current = socketRef.current;
      if (current?.readyState !== WebSocket.OPEN) {
        return;
      }
      const safeCount = Math.max(1, Math.min(30, Math.floor(lineCount)));
      current.send(
        JSON.stringify({
          type: "tmux-copy-mode",
          action,
          repeat: safeCount,
        }),
      );
    };
    const onTouchStart = (event: TouchEvent) => {
      if (!copyModeEnabled || event.touches.length === 0) {
        touchStateRef.current = null;
        return;
      }
      const touch = event.touches[0];
      touchStateRef.current = { lastY: touch.clientY, carry: 0 };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!copyModeEnabled || event.touches.length === 0 || !touchStateRef.current) {
        return;
      }
      event.preventDefault();
      const touch = event.touches[0];
      const deltaY = touch.clientY - touchStateRef.current.lastY;
      touchStateRef.current.lastY = touch.clientY;
      touchStateRef.current.carry += deltaY;
      if (Math.abs(touchStateRef.current.carry) < pixelsPerLine) {
        return;
      }
      const direction = touchStateRef.current.carry > 0 ? "line_up" : "line_down";
      const lines = Math.floor(Math.abs(touchStateRef.current.carry) / pixelsPerLine);
      touchStateRef.current.carry =
        direction === "line_up"
          ? touchStateRef.current.carry - lines * pixelsPerLine
          : touchStateRef.current.carry + lines * pixelsPerLine;
      sendScrollLines(direction, lines);
    };
    const onTouchEnd = () => {
      touchStateRef.current = null;
    };
    const onWheel = (event: WheelEvent) => {
      if (!copyModeEnabled) {
        wheelCarryRef.current = 0;
        return;
      }
      event.preventDefault();
      wheelCarryRef.current += event.deltaY;
      if (Math.abs(wheelCarryRef.current) < pixelsPerLine) {
        return;
      }
      const direction = wheelCarryRef.current > 0 ? "line_down" : "line_up";
      const lines = Math.floor(Math.abs(wheelCarryRef.current) / pixelsPerLine);
      wheelCarryRef.current =
        direction === "line_down"
          ? wheelCarryRef.current - lines * pixelsPerLine
          : wheelCarryRef.current + lines * pixelsPerLine;
      sendScrollLines(direction, lines);
    };

    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("touchcancel", onTouchEnd, { passive: true });
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.removeEventListener("wheel", onWheel);
    };
  }, [copyModeEnabled]);

  return <div ref={hostRef} className={`terminal-host ${copyModeEnabled ? "copy-mode-active" : ""}`} />;
}
