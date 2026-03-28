import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(frontendRoot, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const frontendPort = Number(env.TOUCHMUX_FRONTEND_PORT ?? 5173);
  const backendHttpOrigin = env.TOUCHMUX_BACKEND_ORIGIN ?? "http://127.0.0.1:8787";
  const backendWsOrigin = env.TOUCHMUX_BACKEND_WS_ORIGIN ?? backendHttpOrigin.replace(/^http/i, "ws");

  return {
    envDir: projectRoot,
    plugins: [react()],
    server: {
      port: frontendPort,
      proxy: {
        "/api": backendHttpOrigin,
        "/ws": {
          target: backendWsOrigin,
          ws: true,
        },
      },
    },
  };
});
