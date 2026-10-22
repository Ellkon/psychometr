export class DomainError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const invalidCredentials = () =>
  new DomainError(
    401,
    'invalid_credentials',
    'Неверные данные входа или доступ временно заблокирован',
  );
export const invalidInvite = () =>
  new DomainError(
    401,
    'invalid_invite',
    'Приглашение недействительно. Проверьте код или обратитесь к врачу',
  );
export const unauthorized = () => new DomainError(401, 'unauthorized', 'Войдите в приложение');
export class AccessDenied extends DomainError {
  constructor() {
    super(403, 'forbidden', 'Доступ запрещён');
  }
}
export type Outcome<T> = { value: T; error?: never } | { error: DomainError; value?: never };
export function unwrap<T>(result: Outcome<T>): T {
  if (result.error) throw result.error;
  return result.value;
}
