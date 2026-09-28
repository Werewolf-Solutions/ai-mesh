import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger. Credentials, prompts and generated text are never
 * logged by application code; the redaction list is defence in depth in case
 * a request object or header map is passed to a log call by mistake.
 */
export function createLogger(opts: { level?: string; name?: string; nodeLabel?: string } = {}): Logger {
  return pino({
    level: opts.level ?? process.env.MESH_LOG_LEVEL ?? 'info',
    name: opts.name ?? 'mesh',
    base: opts.nodeLabel ? { node: opts.nodeLabel } : { },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'authorization',
        '*.authorization',
        'token',
        '*.token',
        'adminToken',
        'clientTokens',
        'messages',
        '*.messages',
        'content',
        '*.content',
        'prompt',
        '*.prompt',
        'text',
        '*.text',
        'privateKey',
        '*.privateKey',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
