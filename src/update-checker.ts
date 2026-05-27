/**
 * 版本检查器
 *
 * - triggerUpdateCheck(): startAccount 时调用，后台预热缓存
 * - getUpdateInfo(): 实时查询 npm registry，返回最新结果
 *
 * 使用 HTTPS 直接请求 npm registry API（不依赖 npm CLI），
 * 支持多 registry fallback：npmjs.org → npmmirror.com，解决国内网络问题。
 */

import https from "node:https";
import { getPackageVersion } from "./utils/pkg-version.js";

const PKG_NAME = "@openclaw/qq";
const ENCODED_PKG = encodeURIComponent(PKG_NAME);

const REGISTRIES = [
  `https://registry.npmjs.org/${ENCODED_PKG}`,
  `https://registry.npmmirror.com/${ENCODED_PKG}`,
];

let CURRENT_VERSION = getPackageVersion(import.meta.url);

export interface UpdateInfo {
  current: string;
  /** 最佳升级目标（prerelease 用户优先 alpha，稳定版用户取 latest） */
  latest: string | null;
  /** 稳定版 dist-tag */
  stable: string | null;
  /** alpha dist-tag */
  alpha: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

let _log:
  | { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void }
  | undefined;

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout fetching ${url}`)); });
  });
}

async function fetchDistTags(): Promise<Record<string, string>> {
  for (const url of REGISTRIES) {
    try {
      const json = await fetchJson(url, 10_000);
      const tags = json["dist-tags"];
      if (tags && typeof tags === "object") return tags;
    } catch (e: any) {
      _log?.debug?.(`[napcat-qq:update-checker] ${url} failed: ${e.message}`);
    }
  }
  throw new Error("all registries failed");
}

function buildUpdateInfo(tags: Record<string, string>): UpdateInfo {
  const currentIsPrerelease = CURRENT_VERSION.includes("-");
  const stableTag = tags.latest || null;
  const alphaTag = tags.alpha || null;

  // 预发布用户优先与 alpha tag 比较；alpha 不存在时降级到 stable，避免静默失效
  const compareTarget = currentIsPrerelease ? (alphaTag ?? stableTag) : stableTag;

  const hasUpdate =
    typeof compareTarget === "string" &&
    compareTarget !== CURRENT_VERSION &&
    compareVersions(compareTarget, CURRENT_VERSION) > 0;

  return {
    current: CURRENT_VERSION,
    latest: compareTarget,
    stable: stableTag,
    alpha: alphaTag,
    hasUpdate,
    checkedAt: Date.now(),
  };
}

/** startAccount 时调用，保存 log 引用并触发后台预热 */
export function triggerUpdateCheck(log?: {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}): void {
  if (log) _log = log;
  // fire-and-forget
  getUpdateInfo()
    .then((info) => {
      if (info.hasUpdate) {
        _log?.info?.(
          `[napcat-qq:update-checker] new version available: ${info.latest} (current: ${CURRENT_VERSION})`,
        );
      }
    })
    .catch(() => {});
}

/** 实时查询 npm registry */
export async function getUpdateInfo(): Promise<UpdateInfo> {
  try {
    const tags = await fetchDistTags();
    return buildUpdateInfo(tags);
  } catch (err: any) {
    _log?.debug?.(`[napcat-qq:update-checker] check failed: ${err.message}`);
    return {
      current: CURRENT_VERSION,
      latest: null,
      stable: null,
      alpha: null,
      hasUpdate: false,
      checkedAt: Date.now(),
      error: err.message,
    };
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, "");
    const [main, pre] = clean.split("-", 2);
    return { parts: main.split(".").map(Number), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
