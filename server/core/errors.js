// ── Error envelope ───────────────────────────────────────────────────────
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, d) => new AppError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Sign in required.') =>
  new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have access to this resource.') =>
  new AppError(403, 'forbidden', m);
export const notFound = (m = 'Resource not found.') =>
  new AppError(404, 'not_found', m);
export const conflict = (m, d) => new AppError(409, 'conflict', m, d);
export const weakPassword = (problems) =>
  new AppError(422, 'weak_password', 'The password does not meet the password policy.', problems);
