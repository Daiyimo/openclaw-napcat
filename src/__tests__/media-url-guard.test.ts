/**
 * 出站媒体 URL 安全防护测试
 *
 * 背景：resolveMediaUrl 的 http(s) 分支原先三条路径全部 `return url`，
 * 日志写 "SSRF blocked" 但实际未拦截任何内容（假阻断）。
 *
 * 关键语义差异（本测试保护的核心不变量）：
 * - 出站 resolveMediaUrl：插件不 fetch，URL 被交给 NapCat 下载 →
 *   想真阻断必须 throw，`return url` 等于放行。
 * - 入站 downloadImages：插件自己 fetch，`return` 即跳过下载 → 真阻断。
 *
 * 分级策略（mediaUrlGuard）：
 * - "metadata-only"（默认）：云元数据端点强制阻断；RFC1918 私网放行 + warn
 *   （用户的 NapCat 部署本身就在内网，见 docker-compose.yml QQ_HTTP_URL）
 * - "strict"：私网与回环一并阻断
 * - "off"：不做判定
 */

import { describe, it, expect, vi } from "vitest";
import {
  isCloudMetadataUrl,
  isUrlPrivate,
  resolveMediaUrl,
  MediaUrlBlockedError,
} from "../message-parser.js";

/** 静默 logger，避免测试输出噪音 */
const quietLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
};

// ============ isCloudMetadataUrl ============

describe("isCloudMetadataUrl", () => {
  it("AWS/通用链路本地元数据 IP 169.254.169.254 判定为云元数据", () => {
    expect(isCloudMetadataUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("阿里云元数据 IP 100.100.100.200 判定为云元数据", () => {
    expect(isCloudMetadataUrl("http://100.100.100.200/latest/meta-data/")).toBe(true);
  });

  it("GCP metadata.google.internal 判定为云元数据", () => {
    expect(isCloudMetadataUrl("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
  });

  it("metadata.aliyun.com 判定为云元数据", () => {
    expect(isCloudMetadataUrl("http://metadata.aliyun.com/")).toBe(true);
  });

  it("子域形式 foo.metadata.internal 判定为云元数据", () => {
    expect(isCloudMetadataUrl("http://foo.metadata.internal/")).toBe(true);
  });

  it("普通 RFC1918 私网地址不算云元数据（应由 isUrlPrivate 负责）", () => {
    expect(isCloudMetadataUrl("http://192.168.1.100:3000/img.png")).toBe(false);
    expect(isCloudMetadataUrl("http://10.0.0.5/img.png")).toBe(false);
    expect(isCloudMetadataUrl("http://127.0.0.1:8080/img.png")).toBe(false);
  });

  it("公网地址不算云元数据", () => {
    expect(isCloudMetadataUrl("https://gchat.qpic.cn/foo.jpg")).toBe(false);
  });

  it("非法 URL 不抛异常，返回 false（交由上游 scheme 校验处理）", () => {
    expect(isCloudMetadataUrl("not a url")).toBe(false);
  });
});

// ============ resolveMediaUrl: metadata-only（默认档） ============

describe("resolveMediaUrl - metadata-only（默认档）", () => {
  it("云元数据 URL 必须真阻断（抛 MediaUrlBlockedError，而非返回原 url）", async () => {
    await expect(
      resolveMediaUrl("http://169.254.169.254/latest/meta-data/iam/", quietLog),
    ).rejects.toThrow(MediaUrlBlockedError);
  });

  it("阻断错误信息包含 URL 前缀，便于排查", async () => {
    await expect(
      resolveMediaUrl("http://metadata.google.internal/token", quietLog),
    ).rejects.toThrow(/metadata\.google\.internal/);
  });

  it("RFC1918 私网 URL 放行并原样返回（用户 NapCat 部署在内网，不能掐断）", async () => {
    const url = "http://192.168.1.100:3000/media/img.png";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });

  it("回环地址放行并原样返回", async () => {
    const url = "http://127.0.0.1:8080/img.png";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });

  it("公网 URL 放行并原样返回", async () => {
    const url = "https://gchat.qpic.cn/gchatpic_new/0/0-0-ABC/0";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });

  it("放行私网时日志不得声称 blocked（原实现谎报）", async () => {
    const warn = vi.fn();
    await resolveMediaUrl("http://10.0.0.5/img.png", { ...quietLog, warn });
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).not.toMatch(/blocked/i);
  });
});

// ============ resolveMediaUrl: strict ============

describe("resolveMediaUrl - strict 档", () => {
  it("strict 下 RFC1918 私网被阻断", async () => {
    await expect(
      resolveMediaUrl("http://192.168.1.100:3000/img.png", quietLog, "strict"),
    ).rejects.toThrow(MediaUrlBlockedError);
  });

  it("strict 下回环被阻断", async () => {
    await expect(
      resolveMediaUrl("http://127.0.0.1:8080/img.png", quietLog, "strict"),
    ).rejects.toThrow(MediaUrlBlockedError);
  });

  it("strict 下云元数据同样被阻断", async () => {
    await expect(
      resolveMediaUrl("http://169.254.169.254/", quietLog, "strict"),
    ).rejects.toThrow(MediaUrlBlockedError);
  });

  it("strict 下公网仍放行", async () => {
    const url = "https://gchat.qpic.cn/foo.jpg";
    await expect(resolveMediaUrl(url, quietLog, "strict")).resolves.toBe(url);
  });
});

// ============ resolveMediaUrl: off ============

describe("resolveMediaUrl - off 档", () => {
  it("off 下云元数据也放行（显式关闭防护，由用户自担风险）", async () => {
    const url = "http://169.254.169.254/latest/meta-data/";
    await expect(resolveMediaUrl(url, quietLog, "off")).resolves.toBe(url);
  });

  it("off 下私网放行", async () => {
    const url = "http://192.168.1.100:3000/img.png";
    await expect(resolveMediaUrl(url, quietLog, "off")).resolves.toBe(url);
  });
});

// ============ 回归保护：非 http(s) 分支行为不变 ============

describe("resolveMediaUrl - 非 http(s) 输入行为不变（回归保护）", () => {
  it("base64:// 输入原样返回，不进入 SSRF 判定", async () => {
    const url = "base64://AAAA";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });

  it("不存在的本地路径原样返回（保持既有降级语义，不抛错）", async () => {
    const url = "/nonexistent/path/to/img-should-not-exist.png";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });

  it("云元数据判定只作用于 http(s)，不影响纯文本目标", async () => {
    const url = "169.254.169.254";
    await expect(resolveMediaUrl(url, quietLog)).resolves.toBe(url);
  });
});

// ============ isUrlPrivate 既有行为回归保护 ============

describe("isUrlPrivate 既有行为（回归保护）", () => {
  it("RFC1918 各段判定为私网", () => {
    expect(isUrlPrivate("http://10.0.0.1/")).toBe(true);
    expect(isUrlPrivate("http://172.16.0.1/")).toBe(true);
    expect(isUrlPrivate("http://192.168.1.100/")).toBe(true);
  });

  it("回环与链路本地判定为私网", () => {
    expect(isUrlPrivate("http://127.0.0.1/")).toBe(true);
    expect(isUrlPrivate("http://169.254.169.254/")).toBe(true);
  });

  it("公网地址不判定为私网", () => {
    expect(isUrlPrivate("https://gchat.qpic.cn/foo.jpg")).toBe(false);
  });

  it("非法 URL 判定为风险（保持原有 fail-closed 行为）", () => {
    expect(isUrlPrivate("://bad")).toBe(true);
  });
});
