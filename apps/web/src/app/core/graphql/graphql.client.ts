import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * A minimal GraphQL client.
 *
 * Deliberately not Apollo Client: Phase 0 needs correct request/response handling and typed error
 * codes, and a normalised cache is only worth its weight once there is more than one screen reading
 * the same entity. Until then, `HttpClient` plus signals is less machinery for the same result.
 *
 * The `code` field is the typed contract from docs/06 §10 (`UNAUTHENTICATED`, `CONFLICT`, …). The
 * API maps `ApiError` onto it for GraphQL specifically so clients can branch on it — do not replace
 * it with string matching on the message.
 */
export interface GraphQLError {
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly path?: readonly (string | number)[];
}

export class GraphQLRequestError extends Error {
  constructor(
    readonly errors: readonly GraphQLError[],
    readonly status: number,
  ) {
    super(errors[0]?.message ?? 'GraphQL request failed');
    this.name = 'GraphQLRequestError';
  }

  get code(): string {
    return this.errors[0]?.code ?? 'INTERNAL';
  }
}

@Injectable({ providedIn: 'root' })
export class GraphqlClient {
  private readonly http = inject(HttpClient);

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.post<{ data?: T; errors?: GraphQLError[] }>('/graphql', { query, variables }),
      );

      // GraphQL reports failures in the body with HTTP 200, so the errors array is the real
      // status check — not `response.ok`.
      if (response.errors?.length) throw new GraphQLRequestError(response.errors, 200);
      if (!response.data) throw new GraphQLRequestError([], 200);

      return response.data;
    } catch (error) {
      if (error instanceof GraphQLRequestError) throw error;
      if (error instanceof HttpErrorResponse) {
        const body = error.error as { errors?: GraphQLError[] } | null;
        throw new GraphQLRequestError(body?.errors ?? [], error.status);
      }
      throw error;
    }
  }
}
