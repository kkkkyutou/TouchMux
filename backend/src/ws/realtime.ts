import path from "node:path";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { config } from "../core/config.js";
import type { SessionSummary } from "../types/models.js";
import { createNodeRequestHeaders, verifyNodeRequestHeaders, verifyToken } from "../utils/security.js";
import { assertHubNodeService, assertLocalRuntime, type AppRuntime } from "../app/runtime.js";
import { trimSlash } from "../app/http.js";

export function setupRealtime(server: Server, appRuntime: AppRuntime): { refreshHubSnapshot: () => Promise<void> } {
  const { localRuntime, hubNodeService, nodeRequestReplayGuard } = appRuntime;
  const terminalWss = new WebSocketServer({ noServer: true });
  const eventWss = new WebSocketServer({ noServer: true });
  const nodeTerminalWss = new WebSocketServer({ noServer: true });

  if (localRuntime) {
    localRuntime.sessionManager.on("session-updated", (summary) => {
      const payload = JSON.stringify({
        type: "session-updated",
        payload: summary,
      });
      for (const client of eventWss.clients) {
        if (client.readyState === client.OPEN) {
          client.send(payload);
        }
      }
    });
  }

  let hubSnapshotPayload = JSON.stringify({
    type: "snapshot",
    payload: [] as SessionSummary[],
  });

  async function refreshHubSnapshot(): Promise<void> {
    if (!hubNodeService) {
      return;
    }
    const snapshot = await hubNodeService.listSessions();
    const payload = JSON.stringify({
      type: "snapshot",
      payload: snapshot,
    });
    if (payload === hubSnapshotPayload) {
      return;
    }
    hubSnapshotPayload = payload;
    for (const client of eventWss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(hubSnapshotPayload);
      }
    }
  }

  if (config.runtimeMode === "hub") {
    void refreshHubSnapshot().catch(() => undefined);
    setInterval(() => {
      void refreshHubSnapshot().catch(() => undefined);
    }, 2500);
  }

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "", `http://${request.headers.host}`);

      if (url.pathname === "/ws/node/terminal") {
        const signatureCheck = verifyNodeRequestHeaders({
          secret: config.nodeSharedSecret,
          method: request.method ?? "GET",
          pathWithQuery: request.url ?? url.pathname,
          headers: request.headers,
          body: "",
          maxSkewMs: config.nodeRequestMaxSkewMs,
          replayGuard: nodeRequestReplayGuard,
        });
        if (!config.nodeSharedSecret) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }
        if (!signatureCheck.ok) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        nodeTerminalWss.handleUpgrade(request, socket, head, (ws) => {
          nodeTerminalWss.emit("connection", ws, request, url);
        });
        return;
      }

      const token = url.searchParams.get("token");
      if (!token || !verifyToken(token, config.jwtSecret)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (url.pathname === "/ws/events") {
        eventWss.handleUpgrade(request, socket, head, (ws) => {
          eventWss.emit("connection", ws, request);
        });
        return;
      }
      if (url.pathname === "/ws/terminal") {
        terminalWss.handleUpgrade(request, socket, head, (ws) => {
          terminalWss.emit("connection", ws, request, url);
        });
        return;
      }
      socket.destroy();
    } catch {
      socket.destroy();
    }
  });

  eventWss.on("connection", (ws) => {
    if (config.runtimeMode === "hub") {
      ws.send(hubSnapshotPayload);
      return;
    }
    ws.send(
      JSON.stringify({
        type: "snapshot",
        payload: assertLocalRuntime(localRuntime).sessionManager.listSessionSummaries(),
      }),
    );
  });

  function handleLocalTerminalConnection(ws: WebSocket, url: URL): void {
    const runtime = assertLocalRuntime(localRuntime);
    const sessionId = url.searchParams.get("sessionId");
    const cols = Number(url.searchParams.get("cols") ?? 120);
    const rows = Number(url.searchParams.get("rows") ?? 32);
    if (!sessionId) {
      ws.close(1008, "missing sessionId");
      return;
    }

    let ptyProcess;
    try {
      ptyProcess = runtime.sessionManager.attachToSession(
        sessionId,
        cols,
        rows,
        (chunk) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "data", payload: chunk }));
          }
        },
        () => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "exit" }));
            ws.close();
          }
        },
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: error instanceof Error ? error.message : "终端附着失败",
        }),
      );
      ws.close();
      return;
    }

    ws.on("message", (buffer: RawData) => {
      try {
        const message = JSON.parse(buffer.toString()) as {
          type: "input" | "resize" | "tmux-copy-mode";
          payload?: string;
          cols?: number;
          rows?: number;
          action?: "enter" | "page_up" | "page_down" | "line_up" | "line_down" | "exit";
          repeat?: number;
        };
        if (message.type === "input" && typeof message.payload === "string") {
          runtime.sessionManager.noteInputActivity(sessionId);
          runtime.sessionManager.writeTerminal(ptyProcess, message.payload);
        }
        if (
          message.type === "tmux-copy-mode" &&
          (message.action === "enter" ||
            message.action === "page_up" ||
            message.action === "page_down" ||
            message.action === "line_up" ||
            message.action === "line_down" ||
            message.action === "exit")
        ) {
          runtime.sessionManager.tmuxCopyModeAction(sessionId, message.action, message.repeat);
        }
        if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
          runtime.sessionManager.resizeTerminal(sessionId, ptyProcess, message.cols, message.rows);
        }
      } catch {
        return;
      }
    });

    ws.on("close", () => {
      ptyProcess.kill();
    });
  }

  function handleHubTerminalConnection(ws: WebSocket, url: URL): void {
    const nodeId = url.searchParams.get("nodeId");
    const sessionId = url.searchParams.get("sessionId");
    const cols = Number(url.searchParams.get("cols") ?? 120);
    const rows = Number(url.searchParams.get("rows") ?? 32);
    if (!nodeId || !sessionId) {
      ws.send(JSON.stringify({ type: "error", payload: "缺少 nodeId 或 sessionId" }));
      ws.close();
      return;
    }

    const node = assertHubNodeService(hubNodeService).getConfiguredNode(nodeId);
    if (!node) {
      ws.send(JSON.stringify({ type: "error", payload: "节点不存在" }));
      ws.close();
      return;
    }

    const upstreamUrl = new URL(trimSlash(node.baseUrl));
    upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
    upstreamUrl.pathname = path.posix.join(upstreamUrl.pathname, "/ws/node/terminal");
    upstreamUrl.search = new URLSearchParams({
      sessionId,
      cols: String(cols),
      rows: String(rows),
    }).toString();
    const nodeTerminalPathWithQuery = `${upstreamUrl.pathname}${upstreamUrl.search}`;

    const upstream = new WebSocket(upstreamUrl.toString(), {
      headers: createNodeRequestHeaders({
        secret: node.sharedSecret ?? "",
        method: "GET",
        pathWithQuery: nodeTerminalPathWithQuery,
        body: "",
      }),
    });
    const pendingMessages: string[] = [];
    const flushPendingMessages = () => {
      while (pendingMessages.length > 0 && upstream.readyState === upstream.OPEN) {
        const next = pendingMessages.shift();
        if (typeof next === "string") {
          upstream.send(next);
        }
      }
    };

    upstream.on("message", (buffer) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.toString());
      }
    });

    upstream.on("open", () => {
      setTimeout(flushPendingMessages, 150);
    });

    upstream.on("close", () => {
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    });

    upstream.on("error", () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", payload: "节点终端连接失败" }));
        ws.close();
      }
    });

    ws.on("message", (buffer) => {
      const payload = buffer.toString();
      if (upstream.readyState === upstream.OPEN) {
        upstream.send(payload);
        return;
      }
      pendingMessages.push(payload);
    });

    ws.on("close", () => {
      upstream.close();
    });
  }

  terminalWss.on("connection", (ws, _request, url?: URL) => {
    if (!url) {
      ws.close(1008, "missing url context");
      return;
    }
    if (config.runtimeMode === "hub") {
      handleHubTerminalConnection(ws, url);
      return;
    }
    handleLocalTerminalConnection(ws, url);
  });

  nodeTerminalWss.on("connection", (ws, _request, url?: URL) => {
    if (!url) {
      ws.close(1008, "missing url context");
      return;
    }
    handleLocalTerminalConnection(ws, url);
  });

  if (localRuntime) {
    localRuntime.goalGuardService.start();
  }

  return {
    refreshHubSnapshot,
  };
}
