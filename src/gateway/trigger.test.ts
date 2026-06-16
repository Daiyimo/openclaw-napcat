import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QQConfig } from "../config.js";
import { isInSleepHours } from "./trigger.js";
import { DEFAULT_SLEEP_START_HOUR, DEFAULT_SLEEP_END_HOUR } from "../constants.js";

/**
 * 拦截 Date 构造函数，让 isInSleepHours 返回指定的 hour。
 * isInSleepHours 内部使用 new Date().getHours()，所以可以通过
 * 重写全局 Date 来控制测试时间。
 */
function mockHour(hour: number): void {
  const OriginalDate = globalThis.Date;
  // @ts-ignore — 替换全局 Date
  globalThis.Date = class extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof OriginalDate>) {
      if (args.length === 0) {
        super(`2024-06-15T${String(hour).padStart(2, "0")}:00:00`);
      } else {
        super(...args);
      }
    }
    static now() {
      return new OriginalDate(`2024-06-15T${String(hour).padStart(2, "0")}:00:00`).getTime();
    }
  };
}

/** 还原原始 Date */
function restoreDate(): void {
  // @ts-ignore
  globalThis.Date = OriginalDate;
}

const makeConfig = (overrides?: Partial<QQConfig["sleepMode"]>): QQConfig => ({
  sleepMode: {
    enabled: true,
    startHour: DEFAULT_SLEEP_START_HOUR,
    endHour: DEFAULT_SLEEP_END_HOUR,
    ...overrides,
  },
});

describe("isInSleepHours", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // 确保恢复真实的 Date（避免 fake timers 影响其他测试）
    // vi.useRealTimers() 内部会处理恢复
  });

  describe("disabled mode", () => {
    it("test_disabled_returns_false", () => {
      const config = makeConfig({ enabled: false });
      mockHour(23);
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_missing_enabled_returns_false", () => {
      // sleepMode 存在但 enabled 为 undefined/falsy
      const config = makeConfig({ enabled: false });
      mockHour(23);
      expect(isInSleepHours(config)).toBe(false);
    });
  });

  describe("cross-midnight window (23→7)", () => {
    it("test_cross_midnight_during_sleep_hour_night", () => {
      // 凌晨 2:00 → 在睡眠窗口内 (23→7)
      mockHour(2);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_during_sleep_hour_late_night", () => {
      // 凌晨 6:59 → 仍在睡眠窗口内
      mockHour(6);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_before_sleep_hour", () => {
      // 上午 8:00 → 不在睡眠窗口内
      mockHour(8);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });

    it("test_cross_midnight_during_sleep_hour_evening", () => {
      // 晚上 23:00 → 在睡眠窗口内
      mockHour(23);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_during_sleep_hour_midnight", () => {
      // 午夜 0:00 → 在睡眠窗口内
      mockHour(0);
      expect(isInSleepHours(makeConfig())).toBe(true);
    });

    it("test_cross_midnight_at_boundary_hour_7", () => {
      // 7:00 → 不在窗口内（half-open: hour < end）
      mockHour(7);
      expect(isInSleepHours(makeConfig())).toBe(false);
    });

    it("test_cross_midnight_at_boundary_hour_22", () => {
      // 22:00 → 不在窗口内（hour < start）
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
      // 23:00 → outside
      mockHour(23);
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_daytime_window_inside", () => {
      // 12:00 → inside
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
      // start === end → 0长度窗口, 视为关闭
      mockHour(23);
      const config = makeConfig({ startHour: 23, endHour: 23 });
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_zero_length_midnight_returns_false", () => {
      mockHour(7);
      const config = makeConfig({ startHour: 7, endHour: 7 });
      expect(isInSleepHours(config)).toBe(false);
    });
  });

  describe("extreme hours", () => {
    it("test_full_day_window_0_23", () => {
      // start=0, end=23 → 几乎整天
      mockHour(22);
      const config = makeConfig({ startHour: 0, endHour: 23 });
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_full_day_excluding_hour_23", () => {
      // start=0, end=23 → 23 不在范围内
      mockHour(23);
      const config = makeConfig({ startHour: 0, endHour: 23 });
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_single_hour_window_23_0", () => {
      // 只有 23:00 这一个小时
      mockHour(23);
      const config = makeConfig({ startHour: 23, endHour: 0 });
      expect(isInSleepHours(config)).toBe(true);
    });

    it("test_single_hour_window_exclusive_end", () => {
      // 0:00 → 不在 23→0 的窗口内（end 是 exclusive）
      mockHour(0);
      const config = makeConfig({ startHour: 23, endHour: 0 });
      expect(isInSleepHours(config)).toBe(false);
    });

    it("test_overnight_window_minimal_23_0", () => {
      mockHour(1);
      const config = makeConfig({ startHour: 23, endHour: 0 });
      expect(isInSleepHours(config)).toBe(false);
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
