export type Level = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stdout/stderr. */
export function createLogger(level: Level): Logger {
  const emit = (at: Exclude<Level, "silent">, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[at] < ORDER[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: at, message, ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    (at === "error" || at === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = createLogger("silent");
