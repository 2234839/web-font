/**
 * 构建后端脚本
 * 1. 检测并下载 LLRT 二进制文件
 * 2. 运行 tsup 编译
 * 3. 使用 LLRT compile 生成 .lrt 文件
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** 自动读取 http_proxy/https_proxy 环境变量配置全局代理 */
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
  || process.env.http_proxy || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log(`Using proxy: ${proxyUrl}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const LLRT_BIN = join(ROOT_DIR, "llrt");

/** 映射 node arch 到 LLRT arch */
function getLlrtArch() {
  const a = arch();
  if (a === "x64") return "x64";
  if (a === "arm64") return "arm64";
  throw new Error(`Unsupported architecture: ${a}`);
}

/** 映射 node platform 到 LLRT platform */
function getLlrtPlatform() {
  const p = platform();
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  if (p === "win32") return "windows";
  throw new Error(`Unsupported platform: ${p}`);
}

/** 确保 llrt 二进制文件存在，不存在则下载 */
async function ensureLlrt() {
  if (existsSync(LLRT_BIN)) {
    console.log("LLRT binary found, skipping download.");
    return;
  }

  const llrtArch = getLlrtArch();
  const llrtPlatform = getLlrtPlatform();

  console.log("Fetching latest LLRT release version...");
  const res = await fetch("https://api.github.com/repos/awslabs/llrt/releases/latest");
  /** 响应数据 */
  const data = await res.json() as { tag_name: string };
  const version = data.tag_name;

  if (!version) {
    throw new Error("Failed to fetch latest LLRT version from GitHub");
  }

  console.log(`Latest LLRT version: ${version}`);

  const downloadUrl = `https://github.com/awslabs/llrt/releases/download/${version}/llrt-${llrtPlatform}-${llrtArch}-no-sdk.zip`;
  console.log(`Downloading from ${downloadUrl} ...`);

  const zipRes = await fetch(downloadUrl);
  if (!zipRes.ok) {
    throw new Error(`Failed to download LLRT: ${zipRes.status} ${zipRes.statusText}`);
  }

  /** 下载 zip 到临时文件 */
  const tmpDir = join(ROOT_DIR, ".tmp-llrt");
  await mkdir(tmpDir, { recursive: true });
  const zipPath = join(tmpDir, "llrt.zip");
  const arrayBuffer = await zipRes.arrayBuffer();
  await writeFile(zipPath, Buffer.from(arrayBuffer));

  /** 使用 unzip 命令解压（Node 内置没有 zip 解压） */
  const binaryName = platform() === "win32" ? "llrt.exe" : "llrt";
  execSync(`unzip -o -j "${zipPath}" "${binaryName}" -d "${ROOT_DIR}"`, {
    stdio: "inherit",
  });

  /** linux/mac 需要可执行权限 */
  if (platform() !== "win32") {
    execSync(`chmod +x "${LLRT_BIN}"`);
  }

  await rm(tmpDir, { recursive: true });

  console.log(`LLRT ${version} installed successfully.`);
}

/** 运行 tsup 编译 */
function runTsup() {
  console.log("\n--- Running tsup build ---");
  execSync("pnpm tsup", { stdio: "inherit", cwd: ROOT_DIR });
}

/** woff2 已使用纯 JS 实现（vendor/fonteditor-core/woff2/index.js），无需复制 wasm */

/** 使用 LLRT compile 生成 .lrt 文件 */
function runLlrtCompile() {
  console.log("\n--- Running LLRT compile ---");
  execSync(`${LLRT_BIN} compile ./dist_backend/backend/app.cjs ./dist_backend/app.lrt`, {
    stdio: "inherit",
    cwd: ROOT_DIR,
  });
  execSync(`${LLRT_BIN} compile "./dist_backend/基准测试_llrt.cjs" ./dist_backend/llrt_bench.lrt`, {
    stdio: "inherit",
    cwd: ROOT_DIR,
  });
  console.log("\nBackend build completed successfully!");
}

/** 主流程 */
async function main() {
  await ensureLlrt();
  runTsup();
  runLlrtCompile();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
