export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Writes one JSON object per line to stdout/stderr, suitable for log shipping. */
export const jsonLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), message, ...fields })),
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
