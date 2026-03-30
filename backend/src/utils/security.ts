import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NodeRequestReplayGuard } from "../services/nodeRequestReplayGuard.js";

interface TokenPayload {
  iat: number;
  exp: number;
  jti: string;
}

interface NodeRequestSignatureInput {
  secret: string;
  method: string;
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  body: string;
}

interface VerifyNodeRequestSignatureInput {
  secret: string;
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  body: string;
  signature: string;
  maxSkewMs: number;
}

interface VerifyNodeRequestHeadersInput {
  secret: string;
  method: string;
  pathWithQuery: string;
  headers: IncomingHttpHeaders;
  body: string;
  maxSkewMs: number;
  replayGuard?: NodeRequestReplayGuard;
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function signToken(secret: string, ttlSec = 60 * 60 * 24 * 7): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    iat: nowSec,
    exp: nowSec + ttlSec,
    jti: crypto.randomUUID(),
  };
  const body = toBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken(token: string, secret: string): boolean {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    return (
      typeof payload.iat === "number" &&
      typeof payload.exp === "number" &&
      typeof payload.jti === "string" &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

function buildNodeSignaturePayload({
  method,
  pathWithQuery,
  timestampMs,
  nonce,
  body,
}: Omit<NodeRequestSignatureInput, "secret">): string {
  return [method.toUpperCase(), pathWithQuery, String(timestampMs), nonce, body].join("\n");
}

export function createNodeRequestSignature(input: NodeRequestSignatureInput): string {
  return crypto
    .createHmac("sha256", input.secret)
    .update(buildNodeSignaturePayload(input))
    .digest("base64url");
}

export function createNodeRequestHeaders(input: Omit<NodeRequestSignatureInput, "timestampMs" | "nonce"> & { timestampMs?: number }) {
  const timestampMs = input.timestampMs ?? Date.now();
  const nonce = crypto.randomUUID();
  return {
    "x-touchmux-node-secret": input.secret,
    "x-touchmux-node-ts": String(timestampMs),
    "x-touchmux-node-nonce": nonce,
    "x-touchmux-node-signature": createNodeRequestSignature({
      ...input,
      timestampMs,
      nonce,
    }),
  };
}

export function verifyNodeRequestSignature({
  secret,
  method,
  pathWithQuery,
  timestamp,
  nonce,
  body,
  signature,
  maxSkewMs,
}: VerifyNodeRequestSignatureInput): { ok: true } | { ok: false; message: string } {
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { ok: false, message: "节点时间戳无效" };
  }
  if (!signature) {
    return { ok: false, message: "缺少节点签名" };
  }
  if (!nonce) {
    return { ok: false, message: "缺少节点 nonce" };
  }
  if (Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    return { ok: false, message: "节点签名已过期" };
  }
  const expected = createNodeRequestSignature({
    secret,
    method,
    pathWithQuery,
    timestampMs,
    nonce,
    body,
  });
  if (!safeEqual(signature, expected)) {
    return { ok: false, message: "节点签名校验失败" };
  }
  return { ok: true };
}

export function verifyNodeRequestHeaders({
  secret,
  method,
  pathWithQuery,
  headers,
  body,
  maxSkewMs,
  replayGuard,
}: VerifyNodeRequestHeadersInput): { ok: true } | { ok: false; message: string } {
  const providedSecret = String(headers["x-touchmux-node-secret"] ?? "");
  if (!secret || !providedSecret || !safeEqual(providedSecret, secret)) {
    return { ok: false, message: "节点鉴权失败" };
  }
  const signatureCheck = verifyNodeRequestSignature({
    secret,
    method,
    pathWithQuery,
    timestamp: String(headers["x-touchmux-node-ts"] ?? ""),
    nonce: String(headers["x-touchmux-node-nonce"] ?? "").trim(),
    signature: String(headers["x-touchmux-node-signature"] ?? ""),
    body,
    maxSkewMs,
  });
  if (!signatureCheck.ok) {
    return signatureCheck;
  }
  const nonce = String(headers["x-touchmux-node-nonce"] ?? "").trim();
  if (!nonce) {
    return { ok: false, message: "缺少节点 nonce" };
  }
  if (nonce.length > 128) {
    return { ok: false, message: "节点 nonce 非法" };
  }
  const timestampMs = Number(headers["x-touchmux-node-ts"] ?? "");
  if (replayGuard && !replayGuard.consume(nonce, timestampMs)) {
    return { ok: false, message: "节点请求疑似重放" };
  }
  return { ok: true };
}
