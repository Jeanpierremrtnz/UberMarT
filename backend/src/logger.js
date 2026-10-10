import pino from 'pino';

export function createLogger({ level = 'info' } = {}) {
  return pino({
    level,
    base: { svc: 'ubermart-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.code',
        '*.otp',
        '*.cedula',
        '*.token',
        '*.refreshToken',
        '*.accessToken',
        '*.totp',
      ],
      censor: '[oculto]',
    },
  });
}
