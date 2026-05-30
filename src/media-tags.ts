/**
 * 富媒体标签预处理与纠错
 *
 * 将 AI 输出的各种畸形/错误的媒体标签修正为标准格式。
 * 移植自 openclaw-qqbot，适配 OneBot v11 协议。
 *
 * 标准格式：<qqimg>/path/to/file</qqimg>
 *
 * 纠错能力：
 * - 自闭合属性语法：<qqimg file="/path" /> → <qqimg>/path</qqimg>
 * - 标签名别名：<image>, <img>, <pic> 等 → <qqimg>
 * - 中文尖括号：＜qqimg＞ → <qqimg>
 * - 多余引号包裹：<qqimg>"path"</qqimg> → <qqimg>path</qqimg>
 * - 反引号包裹：`<qqimg>path</qqimg>` → <qqimg>path</qqimg>
 * - 闭合标签不匹配：<qqimg>url</img> → <qqimg>url</qqimg>
 * - 闭合标签缺失斜杠：<qqimg>url<qqimg> → <qqimg>url</qqimg>
 * - 标签内换行/制表符压缩
 */

// ============ 标签名别名映射 ============

/** 标准标签名（目前只支持图片） */
const VALID_TAGS = ["qqimg"] as const;

/** 开头标签别名（key 全部小写） */
const TAG_ALIASES: Record<string, typeof VALID_TAGS[number]> = {
  // ---- qqimg 变体 ----
  "qq_img": "qqimg",
  "qqimage": "qqimg",
  "qq_image": "qqimg",
  "qqpic": "qqimg",
  "qq_pic": "qqimg",
  "qqpicture": "qqimg",
  "qq_picture": "qqimg",
  "qqphoto": "qqimg",
  "qq_photo": "qqimg",
  "img": "qqimg",
  "image": "qqimg",
  "pic": "qqimg",
  "picture": "qqimg",
  "photo": "qqimg",
};

// 构建所有可识别的标签名列表（标准名 + 别名），按长度降序避免子串抢先匹配
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);
const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

// ============ 正则 ============

/**
 * 自闭合属性语法：
 *   <qqimg file="/path/to/file.png" />
 *   <img src="/path" />
 */
const SELF_CLOSING_TAG_REGEX = new RegExp(
  "`?" +
  "[<＜<]\\s*(" + TAG_NAME_PATTERN + ")" +
  "(?:\\s+(?!file|src|path|url)[a-z_-]+\\s*=\\s*[\"']?[^\"'/>＞>]*?[\"']?)*" +
  "\\s+(?:file|src|path|url)\\s*=\\s*" +
  "[\"']?" +
  "([^\"'＞>]+?)" +
  "[\"']?" +
  "(?:\\s+[a-z_-]+\\s*=\\s*[\"']?[^\"'/>＞>]*?[\"']?)*" +
  "\\s*/?" +
  "\\s*[>＞>]" +
  "`?",
  "gi",
);

/**
 * 宽容正则，匹配各种畸形标签写法
 */
const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  "`?" +
  "[<＜<]\\s*(" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  "[\"']?\\s*" +
  "([^<＜<＞>\"'`]+?)" +
  "\\s*[\"']?" +
  "[<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  "`?",
  "gi",
);

/**
 * 多行标签清理：将标签内部的换行/制表符压缩为空格
 */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "([<＜<]\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])" +
  "([\\s\\S]*?)" +
  "([<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])",
  "gi",
);

// ============ 内部函数 ============

/** 将标签名映射为标准名称 */
function resolveTagName(raw: string): typeof VALID_TAGS[number] {
  const lower = raw.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as typeof VALID_TAGS[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

// ============ 公共 API ============

/**
 * 预处理 AI 输出文本，将各种畸形/错误的富媒体标签修正为标准格式。
 *
 * @param text AI 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export function normalizeMediaTags(text: string): string {
  // 第 0 步：自闭合属性语法 → 标准包裹语法
  let cleaned = text.replace(SELF_CLOSING_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match;
    return `<${tag}>${trimmed}</${tag}>`;
  });

  // 第 1 步：标签内部换行/制表符压缩
  cleaned = cleaned.replace(MULTILINE_TAG_CLEANUP, (_m, open: string, body: string, close: string) => {
    const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
    return open + flat + close;
  });

  // 第 2 步：畸形标签统一修正
  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match;
    return `<${tag}>${trimmed}</${tag}>`;
  });
}
