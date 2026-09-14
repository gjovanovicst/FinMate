import { type HttpInterceptorFn } from '@angular/common/http';

/**
 * Send cookies with every API request.
 *
 * The session lives in `httpOnly` cookies (docs/08 §3), which JavaScript cannot read — that is the
 * point. The browser attaches them only when the request is made with credentials, so this
 * interceptor is what makes authentication work at all rather than a convenience.
 *
 * `withCredentials` also requires the API to allow the origin explicitly (it cannot use `*`), which
 * is enforced by CORS in the API rather than here.
 */
export const credentialsInterceptor: HttpInterceptorFn = (request, next) => {
  const isApiRequest = request.url.startsWith('/api') || request.url.startsWith('/graphql');
  if (!isApiRequest) return next(request);

  return next(request.clone({ withCredentials: true }));
};
