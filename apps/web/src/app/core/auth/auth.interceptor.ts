import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { AuthStore } from './auth.store';

/**
 * Attach the access token, and react to authentication failures.
 *
 * The access token is held in memory only (a signal), never in `localStorage`: an XSS payload can
 * read `localStorage`, and a 15-minute token in memory is far less useful to an attacker than a
 * long-lived one on disk. The refresh token is an `httpOnly` cookie the script cannot touch.
 *
 * On `UNAUTHENTICATED` the store clears local state so the guard sends the user to sign-in, rather
 * than leaving a half-authenticated UI that fails on every action.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthStore);
  const token = auth.accessToken();

  const authorised = token
    ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : request;

  return next(authorised).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        auth.clear();
      }
      return throwError(() => error);
    }),
  );
};
