import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const envExample = read(".env.example");
const backendConfig = read("backend/src/core/config.ts");
const backendServer = read("backend/src/server.ts");
const backendAuth = read("backend/src/app/auth.ts");
const backendRuntime = read("backend/src/app/runtime.ts");
const hubNodeService = read("backend/src/services/hubNodeService.ts");
const realtime = read("backend/src/ws/realtime.ts");
const readme = read("README.md");
const readmeCn = read("README_CN.md");
const deployNotes = read("docs/04_deployment_notes.md");
const apiDocs = read("docs/02_api_and_events.md");

assert(envExample.includes("TOUCHMUX_RUNTIME_MODE=single"), ".env.example 缺少运行模式示例");
assert(envExample.includes("TOUCHMUX_NODE_SHARED_SECRET"), ".env.example 缺少节点共享密钥说明");
assert(envExample.includes("TOUCHMUX_NODE_REQUEST_TIMEOUT_MS"), ".env.example 缺少节点超时配置");
assert(envExample.includes("TOUCHMUX_NODE_REQUEST_MAX_SKEW_MS"), ".env.example 缺少节点签名时间窗口配置");
assert(envExample.includes("TOUCHMUX_NODE_REQUEST_REPLAY_CACHE_LIMIT"), ".env.example 缺少节点防重放缓存配置");
assert(envExample.includes("TOUCHMUX_MAX_UPLOAD_BYTES"), ".env.example 缺少上传大小限制配置");
assert(envExample.includes("TOUCHMUX_TOKEN_TTL_SEC"), ".env.example 缺少 token TTL 配置");
assert(envExample.includes("TOUCHMUX_ALLOW_INSECURE_DEFAULTS"), ".env.example 缺少显式放宽默认弱配置的开关说明");
assert(envExample.includes("TOUCHMUX_ALLOWED_ORIGINS"), ".env.example 缺少 CORS 白名单配置");
assert(envExample.includes("TOUCHMUX_SESSION_HOME"), ".env.example 缺少会话 HOME 配置");

assert(backendConfig.includes("tokenTtlSec"), "后端配置未暴露 token TTL");
assert(backendConfig.includes("sessionHome"), "后端配置未暴露会话 HOME");
assert(backendConfig.includes("nodeRequestTimeoutMs"), "后端配置未暴露节点请求超时");
assert(backendConfig.includes("nodeRequestMaxSkewMs"), "后端配置未暴露节点签名时间窗口");
assert(backendConfig.includes("nodeRequestReplayCacheLimit"), "后端配置未暴露节点防重放缓存配置");
assert(backendConfig.includes("maxUploadBytes"), "后端配置未暴露上传大小限制");
assert(backendConfig.includes("allowInsecureDefaults"), "后端配置未暴露默认弱配置放宽开关");
assert(backendConfig.includes("allowedOrigins"), "后端配置未暴露 CORS 白名单");

assert(backendServer.includes("X-Content-Type-Options"), "服务端未设置基础安全响应头");
assert(backendServer.includes("x-touchmux-node-signature"), "服务端未声明节点签名请求头");
assert(backendServer.includes("x-touchmux-node-nonce"), "服务端未声明节点 nonce 请求头");
assert(backendServer.includes("config.allowedOrigins"), "服务端未接入 CORS 白名单");
assert(backendAuth.includes("verifyNodeRequestHeaders"), "节点侧 HTTP 未校验签名请求");
assert(backendRuntime.includes("TOUCHMUX_ALLOW_INSECURE_DEFAULTS"), "服务端未对默认弱配置给出明确启动约束");

assert(hubNodeService.includes("AbortSignal.timeout"), "Hub 调用 Node 时缺少超时控制");
assert(hubNodeService.includes("createNodeRequestHeaders"), "Hub 调用 Node 时未生成签名请求头");
assert(realtime.includes("verifyNodeRequestHeaders"), "节点侧 WebSocket 握手未校验签名请求");
assert(realtime.includes("createNodeRequestHeaders"), "Hub 终端 WebSocket 未附带签名请求头");
assert(realtime.includes("nodeRequestReplayGuard"), "节点侧 WebSocket 未接入防重放守卫");

assert(readme.includes("TOUCHMUX_NODE_SHARED_SECRET"), "README 缺少节点共享密钥说明");
assert(readme.includes("TOUCHMUX_ALLOWED_ORIGINS"), "README 缺少 CORS 白名单说明");
assert(readme.includes("TOUCHMUX_SESSION_HOME"), "README 缺少会话 HOME 说明");
assert(readme.includes("/api/system/health/detail"), "README 缺少健康检查分级说明");
assert(readme.includes("x-touchmux-node-nonce"), "README 缺少节点 nonce 说明");
assert(readme.includes("Two Deployment Modes"), "README 未清晰区分两种部署模式");
assert(readme.includes("Three Runtime Roles"), "README 未清晰区分三种运行角色");
assert(readmeCn.includes("TOUCHMUX_NODE_SHARED_SECRET"), "README_CN 缺少节点共享密钥说明");
assert(readmeCn.includes("TOUCHMUX_ALLOWED_ORIGINS"), "README_CN 缺少 CORS 白名单说明");
assert(readmeCn.includes("TOUCHMUX_SESSION_HOME"), "README_CN 缺少会话 HOME 说明");
assert(readmeCn.includes("/api/system/health/detail"), "README_CN 缺少健康检查分级说明");
assert(readmeCn.includes("x-touchmux-node-nonce"), "README_CN 缺少节点 nonce 说明");
assert(readmeCn.includes("两种部署模式"), "README_CN 未清晰区分两种部署模式");
assert(readmeCn.includes("三种运行角色"), "README_CN 未清晰区分三种运行角色");
assert(
  deployNotes.includes("建议只公开 Hub，把 Node 放在可信内网"),
  "部署文档未强调 Node 不应直接裸露公网",
);
assert(deployNotes.includes("x-touchmux-node-signature"), "部署文档未提到 Hub -> Node 请求签名");
assert(deployNotes.includes("x-touchmux-node-nonce"), "部署文档未提到 Hub -> Node nonce");
assert(deployNotes.includes("TOUCHMUX_SESSION_HOME"), "部署文档未提到会话 HOME 配置");
assert(apiDocs.includes("/ws/node/terminal"), "API 文档缺少节点终端 WebSocket 描述");
assert(apiDocs.includes("x-touchmux-node-signature"), "API 文档未提到节点签名请求头");
assert(apiDocs.includes("x-touchmux-node-nonce"), "API 文档未提到节点 nonce 请求头");

console.log("config-check: ok");
