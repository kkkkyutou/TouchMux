import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  token: string;
  sessionId: string | null;
  onReady: (sender: ((text: string) => void) | null) => void;
  onError: (message: string) => void;
}

function resolveTerminalFontSize(): number {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const isPortraitMobile = width <= 720 && height > width;
  if (isPortraitMobile) {
    return Math.max(12, Math.min(15, Math.floor(width / 24)));
  }
  if (width <= 720) {
    return 14;
  }
  return 14;
}

export function TerminalPane({ token, sessionId, onReady, onError }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"Iosevka Term", "JetBrains Mono", monospace',
      fontSize: resolveTerminalFontSize(),
      theme: {
        background: "#101513",
        foreground: "#f1efe6",
        cursor: "#ffb84d",
        selectionBackground: "rgba(255, 184, 77, 0.25)",
      },
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
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
    const resizeObserver = new ResizeObserver(() => {
      syncTerminalViewport();
    });
    if (hostRef.current) {
      resizeObserver.observe(hostRef.current);
    }
    window.addEventListener("resize", syncTerminalViewport);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncTerminalViewport);
      onReady(null);
      socketRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onReady]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    terminal.reset();
    socketRef.current?.close();
    onReady(null);

    if (!sessionId) {
      terminal.writeln("请选择左侧会话，或新建一个 Codex/tmux 会话。");
      return;
    }

    fitAddon.fit();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${location.host}/ws/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(
        sessionId,
      )}&cols=${terminal.cols}&rows=${terminal.rows}`,
    );
    socketRef.current = socket;

    socket.onopen = () => {
      onReady((text) => {
        socket.send(
          JSON.stringify({
            type: "input",
            payload: text,
          }),
        );
      });
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
      onReady(null);
    };

    const disposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", payload: data }));
      }
    });

    return () => {
      disposable.dispose();
      socket.close();
    };
  }, [sessionId, token, onReady, onError]);

  return <div ref={hostRef} className="terminal-host" />;
}
