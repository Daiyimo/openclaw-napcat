import { describe, it, expect } from "vitest";
import {
  parseMediaTagsToSendQueue,
  stripMediaTags,
  isInsideCodeBlock,
  fixPathEncoding,
} from "../media-send.js";

describe("parseMediaTagsToSendQueue", () => {
  // ── 无标签 ──
  it("returns hasMediaTags=false for plain text", () => {
    const result = parseMediaTagsToSendQueue("Hello world");
    expect(result.hasMediaTags).toBe(false);
    expect(result.sendQueue).toEqual([]);
  });

  // ── 单个图片标签 ──
  it("parses a single image tag", () => {
    const result = parseMediaTagsToSendQueue("<qqimg>/path/to/img.png</qqimg>");
    expect(result.hasMediaTags).toBe(true);
    expect(result.sendQueue).toEqual([
      { type: "image", content: "/path/to/img.png" },
    ]);
  });

  // ── 标签前后有文本 ──
  it("splits text before and after tag", () => {
    const result = parseMediaTagsToSendQueue("Here is a photo: <qqimg>/photo.jpg</qqimg> Nice!");
    expect(result.hasMediaTags).toBe(true);
    expect(result.sendQueue).toEqual([
      { type: "text", content: "Here is a photo:" },
      { type: "image", content: "/photo.jpg" },
      { type: "text", content: "Nice!" },
    ]);
  });

  // ── 多个标签 ──
  it("parses multiple tags", () => {
    const result = parseMediaTagsToSendQueue("<img>/a.png</img> text <pic>/b.jpg</pic>");
    expect(result.hasMediaTags).toBe(true);
    expect(result.sendQueue).toEqual([
      { type: "image", content: "/a.png" },
      { type: "text", content: "text" },
      { type: "image", content: "/b.jpg" },
    ]);
  });

  // ── 别名标签自动规范化 ──
  it("normalizes alias tags before parsing", () => {
    const result = parseMediaTagsToSendQueue("<image>/path.png</image>");
    expect(result.hasMediaTags).toBe(true);
    expect(result.sendQueue).toEqual([
      { type: "image", content: "/path.png" },
    ]);
  });

  // ── 代码块内的标签被跳过 ──
  it("skips tags inside fenced code blocks", () => {
    const text = "Example:\n```\n<qqimg>/code-img.png</qqimg>\n```\nDone.";
    const result = parseMediaTagsToSendQueue(text);
    expect(result.hasMediaTags).toBe(false);
    expect(result.sendQueue).toEqual([]);
  });

  // ── 代码块外的标签正常处理 ──
  it("processes tags outside code blocks", () => {
    const text = "```\ncode\n```\n<qqimg>/real.png</qqimg>";
    const result = parseMediaTagsToSendQueue(text);
    expect(result.hasMediaTags).toBe(true);
    expect(result.sendQueue).toEqual([
      { type: "text", content: "```\ncode\n```" },
      { type: "image", content: "/real.png" },
    ]);
  });

  // ── HTTP URL 作为内容 ──
  it("handles HTTP URLs as image content", () => {
    const result = parseMediaTagsToSendQueue("<qqimg>https://example.com/img.png</qqimg>");
    expect(result.sendQueue).toEqual([
      { type: "image", content: "https://example.com/img.png" },
    ]);
  });

  // ── base64 内容 ──
  it("handles base64 content", () => {
    const result = parseMediaTagsToSendQueue("<qqimg>base64://ABC123</qqimg>");
    expect(result.sendQueue).toEqual([
      { type: "image", content: "base64://ABC123" },
    ]);
  });

  // ── MEDIA: 前缀被剥离 ──
  it("strips MEDIA: prefix", () => {
    const result = parseMediaTagsToSendQueue("<qqimg>MEDIA:/path.png</qqimg>");
    expect(result.sendQueue).toEqual([
      { type: "image", content: "/path.png" },
    ]);
  });
});

describe("stripMediaTags", () => {
  it("removes tags and returns remaining text", () => {
    // tag removal may leave extra whitespace, which is acceptable
    const result = stripMediaTags("Photo: <qqimg>/img.png</qqimg> done.");
    expect(result).toMatch(/Photo:\s+done\./);
  });

  it("returns original text when no tags present", () => {
    expect(stripMediaTags("Hello world")).toBe("Hello world");
  });

  it("normalizes before stripping", () => {
    const result = stripMediaTags("Photo: <image>/img.png</image> done.");
    expect(result).toMatch(/Photo:\s+done\./);
  });
});

describe("isInsideCodeBlock", () => {
  it("returns false for text outside code blocks", () => {
    expect(isInsideCodeBlock("hello <qqimg>/img.png</qqimg>", 7)).toBe(false);
  });

  it("returns true for text inside code blocks", () => {
    const text = "before\n```\n<qqimg>/img.png</qqimg>\n```\nafter";
    const pos = text.indexOf("<qqimg>");
    expect(isInsideCodeBlock(text, pos)).toBe(true);
  });

  it("handles nested code fences", () => {
    const text = "````\n```\n<qqimg>/img.png</qqimg>\n```\n````";
    const pos = text.indexOf("<qqimg>");
    expect(isInsideCodeBlock(text, pos)).toBe(true);
  });
});

describe("fixPathEncoding", () => {
  it("fixes double backslash", () => {
    expect(fixPathEncoding("C:\\\\Users\\\\file.txt")).toBe("C:\\Users\\file.txt");
  });

  it("preserves normal paths", () => {
    expect(fixPathEncoding("/home/user/file.png")).toBe("/home/user/file.png");
  });

  it("preserves Windows paths", () => {
    expect(fixPathEncoding("C:\\Users\\file.txt")).toBe("C:\\Users\\file.txt");
  });
});
