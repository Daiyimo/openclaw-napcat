/**
 * 跨平台兼容工具
 *
 * 统一 Mac / Linux / Windows 三大系统的：
 * - 用户主目录获取
 * - ffmpeg / ffprobe 可执行文件路径
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import type { Logger } from "../types/channel-types.js";

// ============ 基础平台信息 ============

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

// ============ ffmpeg 跨平台检测 ============

let _ffmpegPath: string | null | undefined; // undefined = 未检测, null = 不可用
let _ffmpegCheckPromise: Promise<string | null> | null = null;
let _log: Logger = console;

/**
 * 检测 ffmpeg 是否可用，返回可执行路径
 */
export function detectFfmpeg(log?: Logger): Promise<string | null> {
  if (_ffmpegPath !== undefined) return Promise.resolve(_ffmpegPath);
  if (_ffmpegCheckPromise) return _ffmpegCheckPromise;

  _ffmpegCheckPromise = (async () => {
    // 1. 环境变量自定义路径
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      // 先验证路径指向一个合法文件（防止命令注入：FFMPEG_PATH 可能被设为任意命令）
      const resolved = path.resolve(envPath);
      try {
        const stat = await fs.promises.stat(resolved);
        if (!stat.isFile()) {
          (log ?? console).warn(`[platform] FFMPEG_PATH is not a regular file: ${resolved}`);
        } else if (await testExecutable(resolved, ["-version"])) {
          _ffmpegPath = resolved;
          (log ?? console).log(`[platform] ffmpeg found via FFMPEG_PATH: ${resolved}`);
          return _ffmpegPath;
        } else {
          (log ?? console).warn(`[platform] FFMPEG_PATH set but not working: ${resolved}`);
        }
      } catch (e) {
        (log ?? console).warn(`[platform] FFMPEG_PATH validation failed: ${envPath}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 2. 系统 PATH 中检测
    const cmd = isWindows() ? "ffmpeg.exe" : "ffmpeg";
    const ok = await testExecutable(cmd, ["-version"]);
    if (ok) {
      _ffmpegPath = cmd;
      (log ?? console).log(`[platform] ffmpeg detected in PATH`);
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
          (log ?? console).log(`[platform] ffmpeg found at: ${p}`);
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
