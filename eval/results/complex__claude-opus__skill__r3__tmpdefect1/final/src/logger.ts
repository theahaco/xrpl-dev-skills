/**
 * Structured audit sink. Every state-changing compliance action is reported
 * through `info` with the transaction hash so it can be reconciled against
 * the ledger. Plug in your own implementation to route events to your
 * logging/audit pipeline.
 */
export interface AuditLogger {
  debug(event: string, data: Record<string, unknown>): void;
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Writes one JSON object per line to stdout/stderr. */
export class JsonLineLogger implements AuditLogger {
  constructor(private readonly minLevel: Level = 'info') {}

  debug(event: string, data: Record<string, unknown>): void {
    this.write('debug', event, data);
  }
  info(event: string, data: Record<string, unknown>): void {
    this.write('info', event, data);
  }
  warn(event: string, data: Record<string, unknown>): void {
    this.write('warn', event, data);
  }
  error(event: string, data: Record<string, unknown>): void {
    this.write('error', event, data);
  }

  private write(level: Level, event: string, data: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) {
      return;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  }
}

export const silentLogger: AuditLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
