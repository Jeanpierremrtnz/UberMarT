export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'No autenticado') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'No autorizado') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'No encontrado') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new HttpError(409, code, message);
export const unprocessable = (code, message) => new HttpError(422, code, message);
export const tooMany = (message = 'Demasiados intentos, espera un momento') => new HttpError(429, 'RATE_LIMITED', message);

export const isUniqueViolation = (err, constraint) =>
  err?.code === '23505' && (!constraint || err.constraint === constraint);
