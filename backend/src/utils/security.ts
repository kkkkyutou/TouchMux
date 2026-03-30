import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

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
  body: string;
}

interface VerifyNodeRequestSignatureInput {
  secret: string;
  method: string;
  pathWithQuery: string;
  timestamp: string;
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
  body,
}: Omit<NodeRequestSignatureInput, "secret">): string {
  return [method.toUpperCase(), pathWithQuery, String(timestampMs), body].join("\n");
}

export function createNodeRequestSignature(input: NodeRequestSignatureInput): string {
  return crypto
    .createHmac("sha256", input.secret)
    .update(buildNodeSignaturePayload(input))
    .digest("base64url");
}

export function createNodeRequestHeaders(input: Omit<NodeRequestSignatureInput, "timestampMs"> & { timestampMs?: number }) {
  const timestampMs = input.timestampMs ?? Date.now();
  return {
    "x-touchmux-node-secret": input.secret,
    "x-touchmux-node-ts": String(timestampMs),
    "x-touchmux-node-signature": createNodeRequestSignature({
      ...input,
      timestampMs,
    }),
  };
}

export function verifyNodeRequestSignature({
  secret,
  method,
  pathWithQuery,
  timestamp,
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
  if (Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    return { ok: false, message: "节点签名已过期" };
  }
  const expected = createNodeRequestSignature({
    secret,
    method,
    pathWithQuery,
    timestampMs,
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
}: VerifyNodeRequestHeadersInput): { ok: true } | { ok: false; message: string } {
  const providedSecret = String(headers["x-touchmux-node-secret"] ?? "");
  if (!secret || !providedSecret || !safeEqual(providedSecret, secret)) {
    return { ok: false, message: "节点鉴权失败" };
  }
  return verifyNodeRequestSignature({
    secret,
    method,
    pathWithQuery,
    timestamp: String(headers["x-touchmux-node-ts"] ?? ""),
    signature: String(headers["x-touchmux-node-signature"] ?? ""),
    body,
    maxSkewMs,
  });
}
