/**
 * 环形日志缓冲区
 *
 * 拦截 console.log/warn/error，将日志写入内存缓冲区的同时保留原始输出。
 * 支持通过 /logs 命令导出最近 N 条日志。
 */

// ============ 类型 ============

export type LogLevel = "log" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: number;
}

// ============ 内部状态 ============

let _buffer: LogEntry[] = [];
let _maxSize = 200;
let _installed = false;

// ============ 核心 API ============

/**
 * 将一条日志写入环形缓冲区
 */
export function pushLog(level: LogLevel, msg: string): void {
  _buffer.push({ level, msg, ts: Date.now() });
  if (_buffer.length > _maxSize) {
    _buffer = _buffer.slice(_buffer.length - _maxSize);
  }
}

/**
 * 获取最近 n 条日志（不传则返回全部缓冲）
 */
export function getRecentLogs(n?: number): LogEntry[] {
  if (!n || n >= _buffer.length) return [..._buffer];
  return _buffer.slice(_buffer.length - n);
}

/**
 * 清空缓冲区
 */
export function clearLogBuffer(): void {
  _buffer = [];
}

// ============ 全局拦截器 ============

/**
 * 安装 console 全局拦截器，同时将日志写入缓冲区。
 * 幂等：多次调用只安装一次。
 *
 * @param maxSize 缓冲区最大条数（默认 200）
 */
export function installGlobalInterceptor(maxSize = 200): void {
  if (_installed) return;
  _installed = true;
  _maxSize = maxSize;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("log", msg);
    origLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("warn", msg);
    origWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    pushLog("error", msg);
    origError(...args);
  };
}

/**
 * 将日志条目格式化为可读字符串
 */
export function formatLogEntry(entry: LogEntry): string {
  const d = new Date(entry.ts);
  const ts = d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const prefix = entry.level === "error" ? "[ERR]" : entry.level === "warn" ? "[WRN]" : "[LOG]";
  return `${ts} ${prefix} ${entry.msg}`;
}
