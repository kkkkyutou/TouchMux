# Contributing

欢迎以 issue、PR 或部署反馈的方式参与 TouchMux。

## 开发要求

- Node.js 24+
- `tmux`
- `codex` CLI
- Linux 优先

## 本地开发

```bash
cp .env.example .env
npm install
npm run dev:backend
npm run dev:frontend
```

## 提交前建议

```bash
npm run typecheck
npm run build
```

## 贡献边界

欢迎改进：

- 移动端终端交互
- 选择项识别器
- goal guard 规则扩展
- Docker 与多平台部署
- 安全与认证增强

请在提交说明里明确：

- 改动动机
- 影响的模块
- 是否变更 API 或配置
- 如何验证
