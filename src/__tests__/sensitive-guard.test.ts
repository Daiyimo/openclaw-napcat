/**
 * 系统文件预拦截守卫的单元测试
 *
 * 纯函数测试，零 mock。覆盖：
 *   - 文件名直命（中英大小写、词边界）
 *   - 动词+名词意图组合
 *   - 误伤防护（仅动词 / 仅名词 / 子串非词边界）
 *   - 配置覆盖（自定义 files / verbs / nouns）
 */

import { describe, it, expect } from "vitest";
import {
  detectSensitiveFileRequest,
  DEFAULT_SENSITIVE_FILES,
  DEFAULT_INTENT_VERBS,
  DEFAULT_INTENT_NOUNS,
} from "../utils/sensitive-guard.js";

describe("detectSensitiveFileRequest — 文件名直命 (filename)", () => {
  it("test_filename_hit_when_chinese_text_mentions_soul_md", () => {
    const r = detectSensitiveFileRequest("改一下你的 SOUL.md");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("filename");
    expect(r.hit).toBe("SOUL.md");
  });

  it("test_filename_hit_when_english_text_mentions_soul_md_lowercase", () => {
    const r = detectSensitiveFileRequest("please edit your soul.md");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("filename");
    expect(r.hit).toBe("SOUL.md");
  });

  it("test_filename_hit_when_uppercase_file_basename", () => {
    const r = detectSensitiveFileRequest("WRITE TO AGENTS.MD now");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("filename");
    expect(r.hit).toBe("AGENTS.md");
  });

  it("test_filename_hit_for_all_default_protected_files", () => {
    for (const f of DEFAULT_SENSITIVE_FILES) {
      const r = detectSensitiveFileRequest(`reference to ${f} inside`);
      expect(r.matched).toBe(true);
      expect(r.reason).toBe("filename");
    }
  });

  it("test_filename_unmatched_when_substring_without_word_boundary", () => {
    // "SOUL" 是英文词，必须有词边界。"SOULMATE" 不应命中 "soul"
    // 注意：DEFAULT_SENSITIVE_FILES 含 "SOUL.md"（含点），更不会误伤
    // 这里专门用自定义 files = ["soul"] 验证词边界
    const r = detectSensitiveFileRequest("SOULMATE 真好听", { files: ["soul"] });
    expect(r.matched).toBe(false);
  });
});

describe("detectSensitiveFileRequest — 动词+名词意图组合 (intent)", () => {
  it("test_intent_hit_when_chinese_verb_and_noun_together", () => {
    const r = detectSensitiveFileRequest("帮我修改一下人设");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("intent");
    expect(r.hit).toBe("修改+人设");
  });

  it("test_intent_hit_when_english_verb_and_noun_together", () => {
    const r = detectSensitiveFileRequest("can you update your persona please");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("intent");
    expect(r.hit).toBe("update+persona");
  });

  it("test_intent_hit_when_mixed_chinese_verb_english_noun", () => {
    const r = detectSensitiveFileRequest("帮我覆盖一下 memory");
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("intent");
  });

  it("test_intent_hit_when_verb_and_noun_not_adjacent", () => {
    const r = detectSensitiveFileRequest(
      "你能不能 修改 一下我之前说的那段关于 灵魂 的内容？",
    );
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("intent");
  });

  it("test_intent_unmatched_when_only_noun_no_verb", () => {
    const r = detectSensitiveFileRequest("我喜欢你的人设");
    expect(r.matched).toBe(false);
  });

  it("test_intent_unmatched_when_only_verb_no_noun", () => {
    const r = detectSensitiveFileRequest("我修改了文档");
    expect(r.matched).toBe(false);
  });

  it("test_intent_unmatched_when_english_verb_substring", () => {
    // "edited" 不应命中 "edit"（英文走 \b）
    const r = detectSensitiveFileRequest("I edited the file yesterday");
    expect(r.matched).toBe(false);
  });

  it("test_intent_unmatched_when_chinese_noun_in_idiom", () => {
    // 仅名词无动词；现状下"灵魂出窍"不应单独触发
    const r = detectSensitiveFileRequest("灵魂出窍是什么意思");
    expect(r.matched).toBe(false);
  });
});

describe("detectSensitiveFileRequest — 误伤防护与边界", () => {
  it("test_unmatched_for_unrelated_chitchat", () => {
    const r = detectSensitiveFileRequest("今天天气真好");
    expect(r.matched).toBe(false);
  });

  it("test_unmatched_for_empty_text", () => {
    expect(detectSensitiveFileRequest("").matched).toBe(false);
  });

  it("test_unmatched_for_whitespace_only_text", () => {
    expect(detectSensitiveFileRequest("   \n  ").matched).toBe(false);
  });
});

describe("detectSensitiveFileRequest — 配置覆盖", () => {
  it("test_custom_files_replace_defaults", () => {
    // 自定义 files = ["secret.txt"]，则原 SOUL.md 不再命中
    // 注意：输入文本避开默认 intent 词（"改"/"SOUL" 都会触发 intent path）
    const r1 = detectSensitiveFileRequest("hello banana.md", { files: ["secret.txt"] });
    expect(r1.matched).toBe(false);

    const r2 = detectSensitiveFileRequest("edit the secret.txt", { files: ["secret.txt"] });
    expect(r2.matched).toBe(true);
    expect(r2.reason).toBe("filename");
    expect(r2.hit).toBe("secret.txt");
  });

  it("test_custom_verbs_replace_defaults", () => {
    // 自定义 verbs 不含"修改"，仅含"删除"
    const r1 = detectSensitiveFileRequest("修改人设", { verbs: ["删除"] });
    expect(r1.matched).toBe(false);

    const r2 = detectSensitiveFileRequest("删除人设", { verbs: ["删除"] });
    expect(r2.matched).toBe(true);
    expect(r2.reason).toBe("intent");
  });

  it("test_custom_nouns_replace_defaults", () => {
    const r1 = detectSensitiveFileRequest("修改人设", { nouns: ["昵称"] });
    expect(r1.matched).toBe(false);

    const r2 = detectSensitiveFileRequest("修改昵称", { nouns: ["昵称"] });
    expect(r2.matched).toBe(true);
  });

  it("test_empty_overrides_disable_path", () => {
    // files=[] 让 filename path 完全失效；输入也避开默认 intent 词
    const r1 = detectSensitiveFileRequest("just a banana.md please", { files: [] });
    expect(r1.matched).toBe(false);

    // verbs=[] 让 intent path 失效（无动词 → 不可能命中 intent）
    const r2 = detectSensitiveFileRequest("修改人设", { verbs: [] });
    expect(r2.matched).toBe(false);

    // nouns=[] 同理
    const r3 = detectSensitiveFileRequest("修改人设", { nouns: [] });
    expect(r3.matched).toBe(false);
  });
});

describe("detectSensitiveFileRequest — 默认词表 sanity", () => {
  it("test_default_lists_are_non_empty_and_have_expected_entries", () => {
    expect(DEFAULT_SENSITIVE_FILES).toContain("SOUL.md");
    expect(DEFAULT_SENSITIVE_FILES).toContain("MEMORY.md");
    expect(DEFAULT_INTENT_VERBS).toContain("修改");
    expect(DEFAULT_INTENT_VERBS).toContain("edit");
    expect(DEFAULT_INTENT_NOUNS).toContain("人设");
    expect(DEFAULT_INTENT_NOUNS).toContain("persona");
  });
});
