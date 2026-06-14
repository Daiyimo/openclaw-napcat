/**
 * 智能表情回应规则
 *
 * 根据消息内容的关键词匹配最合适的表情 ID。
 * 数据驱动：通过 EMOJI_RULES 数组配置，新增规则只需添加条目。
 */

/** 单条表情规则 */
export interface EmojiRule {
  /** 匹配正则 */
  readonly re: RegExp;
  /** 表情 ID */
  readonly emojiId: string;
}

/** 默认表情（无匹配时使用） */
export const DEFAULT_EMOJI_ID = "307";

/** 表情回应规则表，按优先级排列（先匹配的优先） */
export const EMOJI_RULES: readonly EmojiRule[] = [
  { re: /查找|查询|搜索|检查|检测|查看|打开|获取|看看|找|搜/, emojiId: "124" },
  { re: /好的|收到|确认|明白|了解|知道了|好|没问题|OK|ok/, emojiId: "76" },
  { re: /谢谢|感谢|谢了|多谢|感激/, emojiId: "297" },
  { re: /加油|继续|努力|坚持|棒|厉害|牛|强/, emojiId: "315" },
  { re: /哈哈|开心|高兴|快乐|好玩|有趣|笑|嘻嘻/, emojiId: "99" },
  { re: /难过|悲伤|伤心|哭|呜|唉|可怜|失落/, emojiId: "5" },
  { re: /生气|愤怒|气死|烦|滚|讨厌|恼火/, emojiId: "326" },
  { re: /[?？]|为什么|怎么|啥|什么|不懂|不明白|疑问/, emojiId: "32" },
  { re: /哇|惊|震惊|不会吧|真的吗|卧槽|天啊|没想到/, emojiId: "180" },
  { re: /喜欢|爱|爱你|心动|可爱|萌/, emojiId: "66" },
  { re: /你好|早|晚安|嗨|hi|hello|Hey|hey/, emojiId: "14" },
  { re: /帮|请|麻烦|劳烦|能不能|可以吗|求/, emojiId: "118" },
  { re: /吃|饿|饭|食|喝|美食/, emojiId: "53" },
  { re: /睡|困|累|休息|倦/, emojiId: "8" },
];

/**
 * 根据消息文本匹配最合适的表情 ID。
 * 遍历规则表，返回第一个匹配的 emojiId，无匹配返回 DEFAULT_EMOJI_ID。
 */
export function matchEmojiId(text: string): string {
  for (const rule of EMOJI_RULES) {
    if (rule.re.test(text)) return rule.emojiId;
  }
  return DEFAULT_EMOJI_ID;
}
