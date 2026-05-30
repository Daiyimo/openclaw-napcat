import { describe, it, expect } from "vitest";
import {
  escapeCQParam,
  extractImageUrls,
  cleanCQCodes,
  getReplyMessageId,
  normalizeTarget,
  parseTarget,
  splitMessage,
  stripMarkdown,
  processAntiRisk,
  extractMediaUrlsFromText,
} from "../message-parser.js";

// ── escapeCQParam ──────────────────────────────────────────────────────────

describe("escapeCQParam", () => {
  it("escapes & [ ] ,", () => {
    expect(escapeCQParam("a&b[c]d,e")).toBe("a&amp;b&#91;c&#93;d&#44;e");
  });
  it("leaves plain strings unchanged", () => {
    expect(escapeCQParam("hello world")).toBe("hello world");
  });
  it("handles empty string", () => {
    expect(escapeCQParam("")).toBe("");
  });
});

// ── extractImageUrls ───────────────────────────────────────────────────────

describe("extractImageUrls", () => {
  it("extracts from array format with url field", () => {
    const msg = [{ type: "image", data: { url: "https://example.com/img.jpg" } }] as any;
    expect(extractImageUrls(msg)).toEqual(["https://example.com/img.jpg"]);
  });
  it("extracts from array format with base64:// file field", () => {
    const msg = [{ type: "image", data: { file: "base64://abc123" } }] as any;
    expect(extractImageUrls(msg)).toEqual(["base64://abc123"]);
  });
  it("ignores non-http file fields in array", () => {
    const msg = [{ type: "image", data: { file: "local-file.jpg" } }] as any;
    expect(extractImageUrls(msg)).toEqual([]);
  });
  it("extracts from CQ code string", () => {
    expect(extractImageUrls("[CQ:image,url=https://a.com/b.jpg,type=show]")).toEqual([
      "https://a.com/b.jpg",
    ]);
  });
  it("respects maxImages limit", () => {
    const msg = [
      { type: "image", data: { url: "https://a.com/1.jpg" } },
      { type: "image", data: { url: "https://a.com/2.jpg" } },
      { type: "image", data: { url: "https://a.com/3.jpg" } },
    ] as any;
    expect(extractImageUrls(msg, 2)).toHaveLength(2);
  });
  it("returns empty for undefined input", () => {
    expect(extractImageUrls(undefined)).toEqual([]);
  });
  it("returns empty for empty array", () => {
    expect(extractImageUrls([])).toEqual([]);
  });
  it("falls back to file field when url is empty", () => {
    const msg = [{ type: "image", data: { url: "", file: "/path/to/img.jpg" } }] as any;
    expect(extractImageUrls(msg)).toEqual(["/path/to/img.jpg"]);
  });
  it("accepts file:// URLs", () => {
    const msg = [{ type: "image", data: { file: "file:///path/to/img.jpg" } }] as any;
    expect(extractImageUrls(msg)).toEqual(["file:///path/to/img.jpg"]);
  });
  it("accepts base64 from file field when url is empty", () => {
    const msg = [{ type: "image", data: { url: "", file: "base64://abc123" } }] as any;
    expect(extractImageUrls(msg)).toEqual(["base64://abc123"]);
  });
});

// ── cleanCQCodes ──────────────────────────────────────────────────────────

describe("cleanCQCodes", () => {
  it("replaces [CQ:face] with [表情]", () => {
    expect(cleanCQCodes("[CQ:face,id=1]你好")).toBe("[表情]你好");
  });
  it("replaces [CQ:image] with [图片] and appends URL", () => {
    // 源码先将 CQ:image 替换为 [图片]，再追加 URL 注释
    expect(cleanCQCodes("[CQ:image,url=https://a.com/img.jpg]")).toBe(
      "[图片] [图片: https://a.com/img.jpg]",
    );
  });
  it("prepends existing text before image URL annotation", () => {
    // 源码保留 [图片] 占位符，紧跟 URL 注释
    expect(cleanCQCodes("hello[CQ:image,url=https://a.com/img.jpg]")).toBe(
      "hello[图片] [图片: https://a.com/img.jpg]",
    );
  });
  it("removes unknown CQ codes entirely", () => {
    expect(cleanCQCodes("[CQ:video,file=x.mp4]text")).toBe("text");
  });
  it("returns empty string for undefined", () => {
    expect(cleanCQCodes(undefined)).toBe("");
  });
  it("collapses multiple spaces", () => {
    expect(cleanCQCodes("hello   world")).toBe("hello world");
  });
});

// ── getReplyMessageId ─────────────────────────────────────────────────────

describe("getReplyMessageId", () => {
  it("extracts id from array format reply segment", () => {
    const msg = [{ type: "reply", data: { id: "42" } }] as any;
    expect(getReplyMessageId(msg)).toBe("42");
  });
  it("falls back to rawMessage CQ code", () => {
    expect(getReplyMessageId(undefined, "[CQ:reply,id=99]")).toBe("99");
  });
  it("returns null when no reply segment", () => {
    expect(getReplyMessageId([{ type: "text", data: { text: "hi" } }] as any)).toBeNull();
  });
  it("returns null for undefined input", () => {
    expect(getReplyMessageId(undefined)).toBeNull();
  });
  it("rejects non-numeric id", () => {
    const msg = [{ type: "reply", data: { id: "abc" } }] as any;
    expect(getReplyMessageId(msg)).toBeNull();
  });
});

// ── normalizeTarget ───────────────────────────────────────────────────────

describe("normalizeTarget", () => {
  it("removes qq: prefix", () => {
    expect(normalizeTarget("qq:12345")).toBe("12345");
  });
  it("removes QQ: prefix case-insensitively", () => {
    expect(normalizeTarget("QQ:12345")).toBe("12345");
  });
  it("leaves strings without prefix unchanged", () => {
    expect(normalizeTarget("12345")).toBe("12345");
  });
});

// ── parseTarget ───────────────────────────────────────────────────────────

describe("parseTarget", () => {
  it("parses plain number as private", () => {
    expect(parseTarget("12345678")).toEqual({ type: "private", userId: 12345678 });
  });
  it("parses private:N", () => {
    expect(parseTarget("private:12345678")).toEqual({ type: "private", userId: 12345678 });
  });
  it("parses group:N", () => {
    expect(parseTarget("group:88888888")).toEqual({ type: "group", groupId: 88888888 });
  });
  it("parses guild:A:B", () => {
    expect(parseTarget("guild:GUILDID:CHANID")).toEqual({
      type: "guild",
      guildId: "GUILDID",
      channelId: "CHANID",
    });
  });
  it("throws on invalid plain string", () => {
    expect(() => parseTarget("notanumber")).toThrow();
  });
  it("throws on invalid group target", () => {
    expect(() => parseTarget("group:abc")).toThrow();
  });
  it("throws on incomplete guild target (missing channelId)", () => {
    expect(() => parseTarget("guild:ONLYID")).toThrow();
  });
  it("throws on invalid private target", () => {
    expect(() => parseTarget("private:abc")).toThrow();
  });
});

// ── splitMessage ──────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single chunk when under limit", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });
  it("returns single chunk when exactly at limit", () => {
    expect(splitMessage("ab", 2)).toEqual(["ab"]);
  });
  it("splits into multiple chunks when over limit", () => {
    expect(splitMessage("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });
  it("handles empty string", () => {
    expect(splitMessage("", 10)).toEqual([""]);
  });
});

// ── stripMarkdown ─────────────────────────────────────────────────────────

describe("stripMarkdown", () => {
  it("removes bold **text**", () => {
    expect(stripMarkdown("**bold**")).toBe("bold");
  });
  it("removes italic *text*", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
  });
  it("replaces code block with [代码块]", () => {
    expect(stripMarkdown("```\ncode\n```")).toBe("[代码块]");
  });
  it("removes inline code backticks", () => {
    expect(stripMarkdown("`code`")).toBe("code");
  });
  it("removes heading #", () => {
    expect(stripMarkdown("## Title")).toBe("Title");
  });
  it("removes link brackets and keeps text", () => {
    expect(stripMarkdown("[text](https://example.com)")).toBe("text");
  });
  it("replaces blockquote > with ▎", () => {
    expect(stripMarkdown("> quote")).toBe("▎quote");
  });
  it("replaces list - with bullet •", () => {
    expect(stripMarkdown("- item")).toBe("• item");
  });
  it("replaces list * with bullet •", () => {
    expect(stripMarkdown("* item")).toBe("• item");
  });
});

// ── processAntiRisk ───────────────────────────────────────────────────────

describe("processAntiRisk", () => {
  it("inserts space after http://", () => {
    expect(processAntiRisk("http://example.com")).toBe("http:// example.com");
  });
  it("inserts space after https://", () => {
    expect(processAntiRisk("https://example.com")).toBe("https:// example.com");
  });
  it("does not modify non-URL text", () => {
    expect(processAntiRisk("hello world")).toBe("hello world");
  });
});

// ── extractMediaUrlsFromText ──────────────────────────────────────────────

describe("extractMediaUrlsFromText", () => {
  it("extracts image URL by extension", () => {
    const result = extractMediaUrlsFromText("see https://a.com/img.png here");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "image", url: "https://a.com/img.png" });
  });
  it("extracts video URL", () => {
    const result = extractMediaUrlsFromText("https://cdn.example.com/video.mp4");
    expect(result[0]).toMatchObject({ type: "video" });
  });
  it("extracts file URL (pdf)", () => {
    const result = extractMediaUrlsFromText("https://cdn.example.com/doc.pdf");
    expect(result[0]).toMatchObject({ type: "file" });
  });
  it("does not extract plain webpage links without extension", () => {
    const result = extractMediaUrlsFromText("https://example.com/page");
    expect(result).toHaveLength(0);
  });
  it("deduplicates repeated URLs", () => {
    const text = "https://a.com/img.jpg https://a.com/img.jpg";
    expect(extractMediaUrlsFromText(text)).toHaveLength(1);
  });
  it("returns empty for text without URLs", () => {
    expect(extractMediaUrlsFromText("plain text no url")).toHaveLength(0);
  });
  it("includes filename in result", () => {
    const result = extractMediaUrlsFromText("https://a.com/photo.jpg");
    expect(result[0].name).toBe("photo.jpg");
  });

  // ── Markdown 图片语法 ──
  it("extracts markdown image syntax", () => {
    const result = extractMediaUrlsFromText("![alt text](https://example.com/img.png)");
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/img.png");
    expect(result[0].type).toBe("image");
  });

  it("extracts markdown image without alt text", () => {
    const result = extractMediaUrlsFromText("![](https://a.com/photo.jpg)");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image");
  });

  it("extracts both markdown and bare URL images", () => {
    const text = "![md](https://a.com/md.png) and https://b.com/bare.jpg";
    const result = extractMediaUrlsFromText(text);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://a.com/md.png");
    expect(result[1].url).toBe("https://b.com/bare.jpg");
  });

  it("does not duplicate URLs found in both markdown and bare form", () => {
    const text = "![img](https://a.com/img.png) and https://a.com/img.png";
    const result = extractMediaUrlsFromText(text);
    expect(result).toHaveLength(1);
  });
});
