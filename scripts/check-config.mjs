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
const hubNodeService = read("backend/src/services/hubNodeService.ts");
const readme = read("README.md");
const readmeCn = read("README_CN.md");
const deployNotes = read("docs/04_deployment_notes.md");

assert(envExample.includes("TOUCHMUX_RUNTIME_MODE=single"), ".env.example 缺少运行模式示例");
assert(envExample.includes("TOUCHMUX_NODE_SHARED_SECRET"), ".env.example 缺少节点共享密钥说明");
assert(envExample.includes("TOUCHMUX_NODE_REQUEST_TIMEOUT_MS"), ".env.example 缺少节点超时配置");
assert(envExample.includes("TOUCHMUX_MAX_UPLOAD_BYTES"), ".env.example 缺少上传大小限制配置");
assert(envExample.includes("TOUCHMUX_TOKEN_TTL_SEC"), ".env.example 缺少 token TTL 配置");
assert(envExample.includes("TOUCHMUX_ALLOW_INSECURE_DEFAULTS"), ".env.example 缺少显式放宽默认弱配置的开关说明");

assert(backendConfig.includes("tokenTtlSec"), "后端配置未暴露 token TTL");
assert(backendConfig.includes("nodeRequestTimeoutMs"), "后端配置未暴露节点请求超时");
assert(backendConfig.includes("maxUploadBytes"), "后端配置未暴露上传大小限制");
assert(backendConfig.includes("allowInsecureDefaults"), "后端配置未暴露默认弱配置放宽开关");

assert(backendServer.includes("X-Content-Type-Options"), "服务端未设置基础安全响应头");
assert(backendServer.includes("上传文件名不能包含路径分隔符"), "服务端未阻止带路径分隔符的上传文件名");
assert(backendServer.includes("上传文件过大"), "服务端未限制上传文件大小");
assert(backendServer.includes("TOUCHMUX_ALLOW_INSECURE_DEFAULTS"), "服务端未对默认弱配置给出明确启动约束");
assert(backendServer.includes("config.tokenTtlSec"), "登录 token 仍未使用可配置 TTL");

assert(hubNodeService.includes("AbortSignal.timeout"), "Hub 调用 Node 时缺少超时控制");

assert(readme.includes("TOUCHMUX_NODE_SHARED_SECRET"), "README 缺少节点共享密钥说明");
assert(readmeCn.includes("TOUCHMUX_NODE_SHARED_SECRET"), "README_CN 缺少节点共享密钥说明");
assert(
  deployNotes.includes("建议只公开 Hub，把 Node 放在可信内网"),
  "部署文档未强调 Node 不应直接裸露公网",
);

console.log("config-check: ok");
