import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QQConfig } from "../config.js";
import { isInSleepHours } from "./trigger.js";
import { DEFAULT_SLEEP_START_HOUR, DEFAULT_SLEEP_END_HOUR } from "../constants.js";

/** 保存原始 Date */
let _OriginalDate: typeof Date;

/**
 * 用 class 覆写 globalThis.Date，使 new Date().getHours() 返回指定 hour。
 * 同时保留 Date.now() 和正常构造参数透传。
 */
function mockHour(hour: number): void {
  _OriginalDate = globalThis.Date as typeof Date;
  const fixed = new _OriginalDate(`2024-06-15T${String(hour).padStart(2, "0")}:00:00`);
  // @ts-ignore — 测试专用覆写
  globalThis.Date = class extends _OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixed.getTime());
      } else {
        // @ts-ignore — 透传构造参数
        super(...(args as ConstructorParameters<typeof _OriginalDate>));
      }
    }
    static now() {
      return fixed.getTime();
    }
  };
}

/** 恢复原始 Date */
function restoreDate(): void {
  if (_OriginalDate) {
    // @ts-ignore
    globalThis.Date = _OriginalDate;
    _OriginalDate = Date as typeof Date;
  }
}

/** 构造最小化 QQConfig（仅 sleepMode 相关字段） */
function makeConfig(overrides?: Partial<QQConfig["sleepMode"]>): QQConfig {
  return {
    sleepMode: {
      enabled: true,
      startHour: DEFAULT_SLEEP_START_HOUR,
      endHour: DEFAULT_SLEEP_END_HOUR,
      ...overrides,
    },
  } as unknown as QQConfig;
}

describe("isInSleepHours", () => {
  beforeEach(() => {
    mockHour(12); // 默认中午，不影响大多数测试（每个测试自行设置 hour）
  });

  afterEach(() => {
    restoreDate();
  });

  describe("disabled mode", () => {
    it("test_disabled_returns_false", () => {
      mockHour(23);
      expect(isInSleepHours(makeConfig({ enabled: false }))).toBe(false);
    });

    it("test_no_sleepMode_returns_false", () => {
      expect(isInSleepHours({} as unknown as QQConfig)).toBe(false);
    });
  });

  describe("cross-midnight window (23→7)", () => {
    it("test_cross_midnight_during_sleep_hour_night", () => {
      mockHour(2);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_during_sleep_hour_late_night", () => {
      mockHour(6);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_before_sleep_hour", () => {
      mockHour(8);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });

    it("test_cross_midnight_during_sleep_hour_evening", () => {
      mockHour(23);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_during_sleep_hour_midnight", () => {
      mockHour(0);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_at_boundary_hour_7", () => {
      mockHour(7);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });

    it("test_cross_midnight_at_boundary_hour_22", () => {
      mockHour(22);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });
  });

  describe("normal window (2→6)", () => {
    const config = makeConfig({ startHour: 2, endHour: 6 });

    it("test_normal_window_inside", () => {
      mockHour(3);
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_normal_window_at_start", () => {
      mockHour(2);
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_normal_window_at_end_exclusive", () => {
      mockHour(6);
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_normal_window_before_start", () => {
      mockHour(1);
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_normal_window_after_end", () => {
      mockHour(10);
      expect(isInSleepHours(config)).toBe(false);
    });
  });

  describe("daytime window (8→22)", () => {
    const config = makeConfig({ startHour: 8, endHour: 22 });

    it("test_daytime_window_outside", () => {
      mockHour(23);
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_daytime_window_inside", () => {
      mockHour(12);
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_daytime_window_at_start", () => {
      mockHour(8);
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_daytime_window_at_end_exclusive", () => {
      mockHour(22);
      expect(isInSleepHours(config)).toBe(false);
    });
  });

  describe("zero-length window (start === end)", () => {
    it("test_zero_length_returns_false", () => {
      mockHour(23);
      expect(isInSleepHours(makeConfig({ startHour: 23, endHour: 23 }))).toBe(false);
    });

    it("test_zero_length_midnight_returns_false", () => {
      mockHour(7);
      expect(isInSleepHours(makeConfig({ startHour: 7, endHour: 7 }))).toBe(false);
    });
  });

  describe("extreme hours", () => {
    it("test_full_day_window_0_23", () => {
      mockHour(22);
      expect(isInSleepHours(makeConfig({ startHour: 0, endHour: 23 }))).toBe(true);
    });

    it("test_full_day_excluding_hour_23", () => {
      mockHour(23);
      expect(isInSleepHours(makeConfig({ startHour: 0, endHour: 23 }))).toBe(false);
    });

    it("test_single_hour_window_23_0", () => {
      mockHour(23);
      expect(isInSleepHours(makeConfig({ startHour: 23, endHour: 0 }))).toBe(true);
    });

    it("test_single_hour_window_exclusive_end", () => {
      mockHour(0);
      expect(isInSleepHours(makeConfig({ startHour: 23, endHour: 0 }))).toBe(false);
    });

    it("test_overnight_window_minimal_23_0", () => {
      mockHour(1);
      expect(isInSleepHours(makeConfig({ startHour: 23, endHour: 0 }))).toBe(false);
    });
  });

  describe("defaults", () => {
    it("test_defaults_use_23_7", () => {
      const config = makeConfig();
      expect(config.sleepMode.startHour).toBe(23);
      expect(config.sleepMode.endHour).toBe(7);
    });

    it("test_default_cross_midnight_night_time", () => {
      mockHour(3);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_default_cross_midnight_daytime", () => {
      mockHour(15);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });
  });
});
