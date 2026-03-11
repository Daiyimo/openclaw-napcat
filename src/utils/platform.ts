/**
 * 跨平台兼容工具
 *
 * 统一 Mac / Linux / Windows 三大系统的：
 * - 用户主目录获取
 * - 临时目录获取
 * - 本地路径判断
 * - ffmpeg / ffprobe 可执行文件路径
 * - silk-wasm 原生模块兼容性检测
 * - 启动诊断报告
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";

// ============ 基础平台信息 ============

export type PlatformType = "darwin" | "linux" | "win32" | "other";

export function getPlatform(): PlatformType {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

// ============ 用户主目录 ============

/**
 * 安全获取用户主目录
 *
 * 优先级:
 * 1. os.homedir()（Node 原生，所有平台）
 * 2. $HOME（Mac/Linux）或 %USERPROFILE%（Windows）
 * 3. 降级到 /tmp（Linux/Mac）或 os.tmpdir()（Windows）
 */
export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) return home;
  } catch {}

  // fallback 环境变量
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) return envHome;

  // 最后降级
  return os.tmpdir();
}

/**
 * 获取 .openclaw/napcat-qq 下的子目录路径，并自动创建
 */
export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "napcat-qq", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============ 临时目录 ============

/**
 * 获取系统临时目录（跨平台安全）
 */
export function getTempDir(): string {
  return os.tmpdir();
}

// ============ 波浪线路径展开 ============

/**
 * 展开路径中的波浪线（~）为用户主目录
 */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return getHomeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

/**
 * 对路径进行完整的规范化处理：展开波浪线 + 去除首尾空白
 */
export function normalizePath(p: string): string {
  return expandTilde(p.trim());
}

// ============ 文件名 UTF-8 规范化 ============

/**
 * 规范化文件名为 UTF-8 编码格式
 */
export function sanitizeFileName(name: string): string {
  if (!name) return name;

  let result = name.trim();

  if (result.includes("%")) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // 解码失败，保留原始值
    }
  }

  result = result.normalize("NFC");
  result = result.replace(/[\x00-\x1F\x7F]/g, "");

  return result;
}

// ============ 本地路径判断 ============

/**
 * 判断字符串是否为本地文件路径（非 URL）
 */
export function isLocalPath(p: string): boolean {
  if (!p) return false;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return true;
  if (p.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  if (p.startsWith("./") || p.startsWith("../")) return true;
  if (p.startsWith(".\\") || p.startsWith("..\\")) return true;
  return false;
}

/**
 * 判断 markdown 中提取的路径是否像本地路径
 */
export function looksLikeLocalPath(p: string): boolean {
  if (isLocalPath(p)) return true;
  return /^(?:Users|home|tmp|var|private|[A-Z]:)/i.test(p);
}

// ============ ffmpeg 跨平台检测 ============

let _ffmpegPath: string | null | undefined; // undefined = 未检测, null = 不可用
let _ffmpegCheckPromise: Promise<string | null> | null = null;

/**
 * 检测 ffmpeg 是否可用，返回可执行路径
 */
export function detectFfmpeg(): Promise<string | null> {
  if (_ffmpegPath !== undefined) return Promise.resolve(_ffmpegPath);
  if (_ffmpegCheckPromise) return _ffmpegCheckPromise;

  _ffmpegCheckPromise = (async () => {
    // 1. 环境变量自定义路径
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      const ok = await testExecutable(envPath, ["-version"]);
      if (ok) {
        _ffmpegPath = envPath;
        console.log(`[platform] ffmpeg found via FFMPEG_PATH: ${envPath}`);
        return _ffmpegPath;
      }
      console.warn(`[platform] FFMPEG_PATH set but not working: ${envPath}`);
    }

    // 2. 系统 PATH 中检测
    const cmd = isWindows() ? "ffmpeg.exe" : "ffmpeg";
    const ok = await testExecutable(cmd, ["-version"]);
    if (ok) {
      _ffmpegPath = cmd;
      console.log(`[platform] ffmpeg detected in PATH`);
      return _ffmpegPath;
    }

    // 3. 常见安装位置
    const commonPaths = isWindows()
      ? [
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
          path.join(process.env.ProgramFiles || "", "ffmpeg", "bin", "ffmpeg.exe"),
        ]
      : [
          "/usr/local/bin/ffmpeg",
          "/opt/homebrew/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          "/snap/bin/ffmpeg",
        ];

    for (const p of commonPaths) {
      if (p && fs.existsSync(p)) {
        const works = await testExecutable(p, ["-version"]);
        if (works) {
          _ffmpegPath = p;
          console.log(`[platform] ffmpeg found at: ${p}`);
          return _ffmpegPath;
        }
      }
    }

    _ffmpegPath = null;
    return null;
  })().finally(() => {
    _ffmpegCheckPromise = null;
  });

  return _ffmpegCheckPromise;
}

/** 测试可执行文件是否能正常运行 */
function testExecutable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** 重置 ffmpeg 缓存（用于测试） */
export function resetFfmpegCache(): void {
  _ffmpegPath = undefined;
  _ffmpegCheckPromise = null;
}

// ============ silk-wasm 兼容性 ============

let _silkWasmAvailable: boolean | null = null;

/**
 * 检测 silk-wasm 是否可用
 */
export async function checkSilkWasmAvailable(): Promise<boolean> {
  if (_silkWasmAvailable !== null) return _silkWasmAvailable;

  try {
    const { isSilk } = await import("silk-wasm");
    isSilk(new Uint8Array(0));
    _silkWasmAvailable = true;
    console.log("[platform] silk-wasm: available");
  } catch (err) {
    _silkWasmAvailable = false;
    console.warn(`[platform] silk-wasm: NOT available (${err instanceof Error ? err.message : String(err)})`);
  }
  return _silkWasmAvailable;
}

// ============ 启动环境诊断 ============

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  dataDir: string;
  ffmpeg: string | null;
  silkWasm: boolean;
  warnings: string[];
}

/**
 * 运行启动诊断，返回环境报告
 */
export async function runDiagnostics(): Promise<DiagnosticReport> {
  const warnings: string[] = [];

  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;
  const homeDir = getHomeDir();
  const tempDir = getTempDir();
  const dataDir = getQQBotDataDir();

  const ffmpegPath = await detectFfmpeg();
  if (!ffmpegPath) {
    warnings.push(
      isWindows()
        ? "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: choco install ffmpeg 或 scoop install ffmpeg"
        : getPlatform() === "darwin"
          ? "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: brew install ffmpeg"
          : "⚠️ ffmpeg 未安装。语音格式转换将受限。安装方式: sudo apt install ffmpeg"
    );
  }

  const silkWasm = await checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push("⚠️ silk-wasm 不可用。QQ 语音消息的收发将无法工作。请确认 Node.js 版本 >= 16 且 WASM 支持正常");
  }

  try {
    const testFile = path.join(dataDir, ".write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`⚠️ 数据目录不可写: ${dataDir}。请检查权限`);
  }

  if (isWindows()) {
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(" ")) {
      warnings.push(`⚠️ 用户目录包含中文或空格: ${homeDir}。某些工具可能无法正常工作`);
    }
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    dataDir,
    ffmpeg: ffmpegPath,
    silkWasm,
    warnings,
  };

  console.log("=== NapCat-QQ 环境诊断 ===");
  console.log(`  平台: ${platform} (${arch})`);
  console.log(`  Node: ${nodeVersion}`);
  console.log(`  主目录: ${homeDir}`);
  console.log(`  数据目录: ${dataDir}`);
  console.log(`  ffmpeg: ${ffmpegPath ?? "未安装"}`);
  console.log(`  silk-wasm: ${silkWasm ? "可用" : "不可用"}`);
  if (warnings.length > 0) {
    console.log("  --- 警告 ---");
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }
  console.log("==========================");

  return report;
}
