import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import type { Request } from "express";
import { config } from "./core/config.js";
import { createAuthHandlers } from "./app/auth.js";
import {
  assertHubNodeService,
  assertLocalRuntime,
  createAppRuntime,
  ensureSecureDefaults,
} from "./app/runtime.js";
import { registerCoreRoutes } from "./routes/coreRoutes.js";
import { registerHubRoutes } from "./routes/hubRoutes.js";
import { registerLocalRoutes } from "./routes/localRoutes.js";
import { setupRealtime } from "./ws/realtime.js";

const appRuntime = createAppRuntime();
ensureSecureDefaults();

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "x-touchmux-node-secret",
      "x-touchmux-node-ts",
      "x-touchmux-node-nonce",
      "x-touchmux-node-signature",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(
  express.json({
    limit: `${Math.ceil(config.maxUploadBytes * 1.5)}b`,
    verify(request, _response, buffer) {
      (request as Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
    },
  }),
);

const authHandlers = createAuthHandlers(
  appRuntime.auditService,
  appRuntime.loginRateLimiter,
  appRuntime.nodeRequestReplayGuard,
);
authHandlers.registerAuthRoutes(app);

registerCoreRoutes({
  app,
  requireAuth: authHandlers.requireAuth,
  localRuntime: appRuntime.localRuntime,
  hubNodeService: appRuntime.hubNodeService,
});

let triggerHubSnapshotRefresh: () => Promise<void> = async () => {};

if (config.runtimeMode === "hub") {
  registerHubRoutes({
    app,
    authMiddleware: authHandlers.requireAuth,
    hubNodeService: assertHubNodeService(appRuntime.hubNodeService),
    auditService: appRuntime.auditService,
    onSessionsChanged: () => triggerHubSnapshotRefresh(),
  });
} else {
  registerLocalRoutes({
    app,
    prefix: "/api",
    authMiddleware: authHandlers.requireAuth,
    localRuntime: assertLocalRuntime(appRuntime.localRuntime),
    auditService: appRuntime.auditService,
  });
}

if (config.runtimeMode !== "hub") {
  registerLocalRoutes({
    app,
    prefix: "/api/node",
    authMiddleware: authHandlers.requireNodeSecret,
    localRuntime: assertLocalRuntime(appRuntime.localRuntime),
    auditService: appRuntime.auditService,
  });
}

const frontendDist = path.resolve(fileURLToPath(new URL("../../frontend/dist", import.meta.url)));
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^\/(?!api).*/, (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }
    response.sendFile(path.join(frontendDist, "index.html"));
  });
}

const server = app.listen(config.port, config.host, () => {
  console.log(`TouchMux ${config.runtimeMode} listening on http://${config.host}:${config.port}`);
  for (const warning of config.securityWarnings) {
    console.warn(`[security-warning] ${warning}`);
  }
});

const realtime = setupRealtime(server, appRuntime);
triggerHubSnapshotRefresh = realtime.refreshHubSnapshot;
