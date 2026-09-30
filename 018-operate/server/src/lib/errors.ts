export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, detail?: unknown) => new AppError(400, 'bad_request', msg, detail);
export const unauthorized = (msg = 'ログインが必要です') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'この操作を行う権限がありません') => new AppError(403, 'forbidden', msg);
// Resources the actor may not see are reported as 404 so their existence is not disclosed.
export const notFound = (msg = '見つかりません') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, detail?: unknown) => new AppError(409, 'conflict', msg, detail);
export const tooMany = (msg = 'リクエストが多すぎます。しばらくしてから再度お試しください') => new AppError(429, 'rate_limited', msg);
