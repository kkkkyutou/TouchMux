import { spawn } from "node:child_process";

const modeArg = process.argv.find((item) => item.startsWith("--mode="));
const runtimeMode = modeArg?.split("=")[1] ?? "single";

function start(name, color, command, args) {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      TOUCHMUX_RUNTIME_MODE: runtimeMode,
    },
  });

  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
  });

  return child;
}

const backend = start("backend", "36", "npm", ["run", "dev", "-w", "backend"]);
const frontend = start("frontend", "35", "npm", ["run", "dev", "-w", "frontend"]);
const children = [backend, frontend];

let exiting = false;

function shutdown(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 200);
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev-runner] child exited with ${reason}`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
