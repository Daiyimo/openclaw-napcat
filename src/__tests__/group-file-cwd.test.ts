/**
 * 群文件 cwd 单元测试
 *
 * 零 mock 纯函数测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getCwd,
  pushCwd,
  popCwd,
  resetCwd,
  formatCwdPath,
  currentFolderId,
  _testReset,
} from "../utils/group-file-cwd.js";

const USER_A = 11111;
const USER_B = 22222;
const GROUP_X = 88888;
const GROUP_Y = 99999;

describe("group-file-cwd — push/pop/reset", () => {
  beforeEach(() => {
    _testReset();
  });

  it("test_initial_cwd_is_empty_means_root", () => {
    expect(getCwd(USER_A, GROUP_X)).toEqual([]);
    expect(currentFolderId([])).toBe("/");
    expect(formatCwdPath([])).toBe("/");
  });

  it("test_push_moves_into_subfolder", () => {
    pushCwd(USER_A, GROUP_X, { id: "abc123", name: "文档" });
    expect(getCwd(USER_A, GROUP_X)).toEqual([{ id: "abc123", name: "文档" }]);
    const stack = getCwd(USER_A, GROUP_X);
    expect(currentFolderId(stack)).toBe("abc123");
    expect(formatCwdPath(stack)).toBe("/文档");
  });

  it("test_multi_level_push_builds_stack", () => {
    pushCwd(USER_A, GROUP_X, { id: "f1", name: "文档" });
    pushCwd(USER_A, GROUP_X, { id: "f2", name: "2026" });
    pushCwd(USER_A, GROUP_X, { id: "f3", name: "Q1" });
    const stack = getCwd(USER_A, GROUP_X);
    expect(stack.length).toBe(3);
    expect(currentFolderId(stack)).toBe("f3");
    expect(formatCwdPath(stack)).toBe("/文档/2026/Q1");
  });

  it("test_pop_returns_popped_entry_and_shortens_stack", () => {
    pushCwd(USER_A, GROUP_X, { id: "f1", name: "文档" });
    pushCwd(USER_A, GROUP_X, { id: "f2", name: "2026" });
    const popped = popCwd(USER_A, GROUP_X);
    expect(popped).toEqual({ id: "f2", name: "2026" });
    expect(getCwd(USER_A, GROUP_X)).toEqual([{ id: "f1", name: "文档" }]);
  });

  it("test_pop_at_root_returns_null", () => {
    expect(popCwd(USER_A, GROUP_X)).toBe(null);
  });

  it("test_pop_to_root_clears_state", () => {
    pushCwd(USER_A, GROUP_X, { id: "f1", name: "文档" });
    popCwd(USER_A, GROUP_X);
    expect(getCwd(USER_A, GROUP_X)).toEqual([]);
    // 接着再 pop 应返回 null（已是根）
    expect(popCwd(USER_A, GROUP_X)).toBe(null);
  });

  it("test_reset_restores_root", () => {
    pushCwd(USER_A, GROUP_X, { id: "f1", name: "文档" });
    pushCwd(USER_A, GROUP_X, { id: "f2", name: "2026" });
    resetCwd(USER_A, GROUP_X);
    expect(getCwd(USER_A, GROUP_X)).toEqual([]);
  });
});

describe("group-file-cwd — 隔离性", () => {
  beforeEach(() => {
    _testReset();
  });

  it("test_different_users_have_independent_cwd", () => {
    pushCwd(USER_A, GROUP_X, { id: "fA", name: "AAA" });
    pushCwd(USER_B, GROUP_X, { id: "fB", name: "BBB" });
    expect(getCwd(USER_A, GROUP_X)).toEqual([{ id: "fA", name: "AAA" }]);
    expect(getCwd(USER_B, GROUP_X)).toEqual([{ id: "fB", name: "BBB" }]);
  });

  it("test_same_user_in_different_groups_has_independent_cwd", () => {
    pushCwd(USER_A, GROUP_X, { id: "fX", name: "X 群文档" });
    pushCwd(USER_A, GROUP_Y, { id: "fY", name: "Y 群文档" });
    expect(formatCwdPath(getCwd(USER_A, GROUP_X))).toBe("/X 群文档");
    expect(formatCwdPath(getCwd(USER_A, GROUP_Y))).toBe("/Y 群文档");
  });

  it("test_returned_cwd_is_copy_external_mutation_does_not_affect_state", () => {
    pushCwd(USER_A, GROUP_X, { id: "f1", name: "原" });
    const stack = getCwd(USER_A, GROUP_X);
    stack.push({ id: "fake", name: "篡改" });
    expect(getCwd(USER_A, GROUP_X)).toEqual([{ id: "f1", name: "原" }]);
  });
});
