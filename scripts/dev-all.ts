/**
 * 同时启动前端 (vite) 和后端 (tsx backend/app.ts) 的开发服务器
 * Ctrl+C 会同时终止两个进程
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");

/** 子进程列表，用于退出时统一清理 */
const children: ReturnType<typeof spawn>[] = [];

/** 清理所有子进程 */
function cleanup() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

console.log("Starting frontend and backend dev servers...\n");

const backend = spawn("pnpx", ["tsx", "watch", "backend/app.ts"], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  shell: true,
});
children.push(backend);

const frontend = spawn("pnpm", ["dev:frontend"], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  shell: true,
});
children.push(frontend);
