import type { Express, NextFunction, Request, Response } from "express";
import { config } from "../core/config.js";
import { AuditService } from "../services/auditService.js";
import { LoginRateLimiter } from "../services/loginRateLimiter.js";
import { safeEqual, signToken, verifyToken } from "../utils/security.js";
import { extractToken, getClientIp } from "./http.js";

export type AuthMiddleware = (request: Request, response: Response, next: NextFunction) => void;

interface AuthHandlers {
  requireAuth: AuthMiddleware;
  requireNodeSecret: AuthMiddleware;
  registerAuthRoutes: (app: Express) => void;
}

export function createAuthHandlers(
  auditService: AuditService,
  loginRateLimiter: LoginRateLimiter,
): AuthHandlers {
  const requireAuth: AuthMiddleware = (request, response, next) => {
    const token = extractToken(request);
    if (!token || !verifyToken(token, config.jwtSecret)) {
      response.status(401).json({ message: "未授权" });
      return;
    }
    next();
  };

  const requireNodeSecret: AuthMiddleware = (request, response, next) => {
    const provided = String(request.headers["x-touchmux-node-secret"] ?? "");
    if (!config.nodeSharedSecret || !provided || !safeEqual(provided, config.nodeSharedSecret)) {
      response.status(401).json({ message: "节点鉴权失败" });
      return;
    }
    next();
  };

  const registerAuthRoutes = (app: Express) => {
    app.post("/api/auth/login", (request, response) => {
      const clientIp = getClientIp(request);
      const blockRemainingMs = loginRateLimiter.getBlockRemainingMs(clientIp);
      if (blockRemainingMs > 0) {
        auditService.record({
          action: "auth.login.blocked",
          ip: clientIp,
          detail: { blockRemainingMs },
        });
        response.status(429).json({ message: `登录尝试过于频繁，请在 ${Math.ceil(blockRemainingMs / 1000)} 秒后重试` });
        return;
      }

      const password = typeof request.body?.password === "string" ? request.body.password : "";
      if (!safeEqual(password, config.password)) {
        const retryAfterMs = loginRateLimiter.registerFailure(clientIp);
        auditService.record({
          action: "auth.login.failed",
          ip: clientIp,
          detail: { blocked: retryAfterMs > 0, retryAfterMs },
        });
        response.status(401).json({ message: "密码错误" });
        return;
      }

      loginRateLimiter.registerSuccess(clientIp);
      auditService.record({
        action: "auth.login.succeeded",
        ip: clientIp,
      });
      response.json({
        token: signToken(config.jwtSecret, config.tokenTtlSec),
      });
    });
  };

  return {
    requireAuth,
    requireNodeSecret,
    registerAuthRoutes,
  };
}
