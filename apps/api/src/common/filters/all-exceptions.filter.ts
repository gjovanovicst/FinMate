import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';

import { TenantContextMissingError } from '../tenancy/tenant-context';
import { TenancyError } from '../tenancy/tenancy.extension';

/**
 * Typed error model (docs/06-api-specification.md §10).
 *
 * Every failure leaves the API as a stable `code` the client can branch on, plus an HTTP status.
 * Messages are safe to show a user; internal detail stays in the logs. Stack traces are never
 * returned.
 */

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'IDEMPOTENT_REPLAY'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ApiErrorCode, HttpStatus> = {
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  CONFLICT: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  AI_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  QUOTA_EXCEEDED: HttpStatus.PAYMENT_REQUIRED,
  IDEMPOTENT_REPLAY: HttpStatus.OK,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // GraphQL errors must reach Apollo, which formats them through the driver's `formatError` and
    // returns a normal `{ errors: [...] }` body. Handling them here produced a second, malformed
    // response — and crashed on the missing request object, hiding the original error.
    if (host.getType<string>() === 'graphql') {
      // Convert here rather than letting the raw error through: NestJS does NOT populate
      // `originalError` for GraphQL contexts (verified by inspecting the error object), so an
      // `ApiError`'s `code` would be dropped and every failure would surface as
      // INTERNAL_SERVER_ERROR. Clients need UNAUTHENTICATED to trigger a token refresh.
      const code = exception instanceof ApiError ? exception.code : 'INTERNAL';
      const message =
        exception instanceof ApiError ? exception.message : 'An unexpected error occurred.';
      const retryable = exception instanceof ApiError ? exception.retryable : false;

      // Log BEFORE throwing. This branch used to throw immediately, which meant a genuine
      // server-side GraphQL failure produced a client-visible INTERNAL and NOTHING in the logs —
      // an outage nobody could diagnose. Unexplained errors are the ones that need the stack most.
      if (code === 'INTERNAL') {
        this.logger.error(
          `GRAPHQL ${message}`,
          exception instanceof Error ? exception.stack : String(exception),
        );
      } else if (code !== 'UNAUTHENTICATED' && code !== 'FORBIDDEN') {
        // Auth failures are routine and would otherwise flood the log.
        this.logger.warn(`GRAPHQL ${code}: ${message}`);
      }

      throw new GraphQLError(message, { extensions: { code, retryable } });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request | undefined>();

    const { status, body } = this.toResponse(exception, request);

    // 5xx is our fault and must be investigated; 4xx is the caller's. Log accordingly.
    if (status >= 500) {
      this.logger.error(
        `${request?.method ?? '?'} ${request?.url ?? '?'} -> ${status} ${body.error.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request?.method ?? '?'} ${request?.url ?? '?'} -> ${status} ${body.error.code}`);
    }

    response.status(status).json(body);
  }

  private toResponse(
    exception: unknown,
    request: Request | undefined,
  ): { status: number; body: ApiErrorBody } {
    const requestId = readRequestId(request);

    if (exception instanceof ApiError) {
      return {
        status: STATUS_BY_CODE[exception.code],
        body: { error: { code: exception.code, message: exception.message, requestId } },
      };
    }

    // A missing TenantContext is a programming error, not a client error. It must be loud in the
    // logs and opaque to the caller — leaking "you forgot a tenant filter" is a hint to an
    // attacker, and the correct user-facing answer is simply that the request failed.
    if (exception instanceof TenantContextMissingError || exception instanceof TenancyError) {
      this.logger.error(
        `TENANCY VIOLATION on ${request?.method ?? '?'} ${request?.url ?? '?'}: ${exception.message}`,
        exception.stack,
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: {
          error: {
            code: 'INTERNAL',
            message: 'The request could not be completed.',
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          error: {
            code: httpStatusToCode(status),
            message: Array.isArray(message) ? message.join('; ') : message,
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL',
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }
}

function readRequestId(request: Request | undefined): string | undefined {
  const value = (request as (Request & { requestId?: unknown }) | undefined)?.requestId;
  return typeof value === 'string' ? value : undefined;
}

function httpStatusToCode(status: number): ApiErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_FAILED';
    default:
      return status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED';
  }
}
