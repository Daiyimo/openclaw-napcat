import { describe, it, expect } from "vitest";
import { normalizeMediaTags } from "../media-tags.js";

describe("normalizeMediaTags", () => {
  // ── 标准格式：不变 ──
  it("returns standard tags unchanged", () => {
    const input = "<qqimg>/path/to/image.png</qqimg>";
    expect(normalizeMediaTags(input)).toBe(input);
  });

  // ── 别名映射 ──
  it.each([
    "<img>/path.png</img>",
    "<image>/path.png</image>",
    "<pic>/path.png</pic>",
    "<photo>/path.png</photo>",
    "<qq_img>/path.png</qq_img>",
    "<qqimage>/path.png</qqimage>",
    "<qq_pic>/path.png</qq_pic>",
    "<qqpicture>/path.png</qqpicture>",
    "<qq_photo>/path.png</qq_photo>",
    "<qqphoto>/path.png</qqphoto>",
  ])("normalizes alias tag: %s", (input) => {
    expect(normalizeMediaTags(input)).toBe("<qqimg>/path.png</qqimg>");
  });

  // ── 自闭合属性语法 ──
  it("normalizes self-closing attribute syntax", () => {
    expect(normalizeMediaTags('<qqimg file="/path/to/file.png" />')).toBe(
      "<qqimg>/path/to/file.png</qqimg>",
    );
  });

  it("normalizes self-closing with src attribute", () => {
    expect(normalizeMediaTags('<img src="/path/to/img.jpg" />')).toBe(
      "<qqimg>/path/to/img.jpg</qqimg>",
    );
  });

  it("normalizes self-closing with extra attributes", () => {
    expect(normalizeMediaTags('<qqimg type="file" path="/path/to/file.zip" />')).toBe(
      "<qqimg>/path/to/file.zip</qqimg>",
    );
  });

  // ── 中文尖括号 ──
  it("normalizes Chinese angle brackets", () => {
    expect(normalizeMediaTags("＜qqimg＞/path.png＜/qqimg＞")).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 闭合标签不匹配 ──
  it("normalizes mismatched closing tag", () => {
    expect(normalizeMediaTags("<qqimg>/path.png</img>")).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 闭合标签缺失斜杠 ──
  it("normalizes missing closing slash", () => {
    expect(normalizeMediaTags("<qqimg>/path.png<qqimg>")).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 多余引号 ──
  it("strips quotes from content", () => {
    expect(normalizeMediaTags('<qqimg>"/path.png"</qqimg>')).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 反引号包裹 ──
  it("strips backtick wrapping", () => {
    expect(normalizeMediaTags("`<qqimg>/path.png</qqimg>`")).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 标签内换行 ──
  it("compresses newlines inside tags", () => {
    expect(normalizeMediaTags("<qqimg>\n/path/to/\nfile.png\n</qqimg>")).toBe(
      "<qqimg>/path/to/ file.png</qqimg>",
    );
  });

  // ── 标签内多余空格 ──
  it("trims content whitespace", () => {
    expect(normalizeMediaTags("<qqimg>  /path.png  </qqimg>")).toBe(
      "<qqimg>/path.png</qqimg>",
    );
  });

  // ── 空内容不处理 ──
  it("does not modify tags with empty content", () => {
    const input = "<qqimg></qqimg>";
    expect(normalizeMediaTags(input)).toBe(input);
  });

  // ── 非标签文本不变 ──
  it("leaves non-tag text unchanged", () => {
    const input = "Hello world, this is a normal text without tags.";
    expect(normalizeMediaTags(input)).toBe(input);
  });

  // ── 标签周围有文本 ──
  it("preserves text around tags", () => {
    expect(normalizeMediaTags("Here is an image: <img>/photo.jpg</img> done.")).toBe(
      "Here is an image: <qqimg>/photo.jpg</qqimg> done.",
    );
  });

  // ── 多个标签 ──
  it("normalizes multiple tags in one text", () => {
    const input = "<img>/a.png</img> and <pic>/b.jpg</pic>";
    expect(normalizeMediaTags(input)).toBe(
      "<qqimg>/a.png</qqimg> and <qqimg>/b.jpg</qqimg>",
    );
  });

  // ── HTTP URL 作为内容 ──
  it("handles HTTP URLs as content", () => {
    expect(normalizeMediaTags("<img>https://example.com/img.png</img>")).toBe(
      "<qqimg>https://example.com/img.png</qqimg>",
    );
  });

  // ── base64 内容 ──
  it("handles base64 content", () => {
    expect(normalizeMediaTags("<img>base64://ABC123</img>")).toBe(
      "<qqimg>base64://ABC123</qqimg>",
    );
  });
});
