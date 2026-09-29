/** Minimal structured logger; compatible with console, pino, winston, etc. */
export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
  error?(message: string, fields?: Record<string, unknown>): void
}

export const silentLogger: Logger = {}
