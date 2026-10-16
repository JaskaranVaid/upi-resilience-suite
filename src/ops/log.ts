export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, err?: unknown, fields?: LogFields): void;
}

function serializeError(err: unknown): LogFields {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}

/**
 * One JSON object per line (CloudWatch keeps each line as one event, so a stack trace stays with
 * its message, and metric filters can match fields). Fastify's request logs use the same shape.
 */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, fields?: LogFields) => write(JSON.stringify({ level, time: now().toISOString(), msg, ...fields }));
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, err, fields) => emit('error', msg, { ...fields, ...(err === undefined ? {} : { err: serializeError(err) }) }),
  };
}
