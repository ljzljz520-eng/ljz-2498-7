const sensitiveKeys = /(?:^|_)(subject|preview|body|html|email|recipient|content|personal|name)(?:_|$|[A-Z])/i;

export function redact(value, seen = new WeakMap(), sensitive = false) {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Sensitive payload branches are scrubbed; ID/status fields stay useful for operations.
    return sensitive ? '[redacted]' : value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.set(value, true);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, sensitive));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const childSensitive = sensitive || sensitiveKeys.test(key);
    return [key, redact(item, seen, childSensitive)];
  }));
}

export function safeLogger(output = console) {
  const write = (level, message, fields = {}) => {
    output.log(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...redact(fields),
    }));
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    debug: (message, fields) => {
      if (process.env.CAMPAIGN_DEBUG_LOG === '1') write('debug', message, fields);
    },
  };
}

export const logger = safeLogger();
