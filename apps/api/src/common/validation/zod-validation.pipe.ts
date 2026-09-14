import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ApiError } from '../filters/all-exceptions.filter';

/**
 * Validate a request body or query with a Zod schema.
 *
 * Zod is already the config-validation library, so using it here avoids running two validation
 * libraries (class-validator + class-transformer) whose decorator metadata would also interact with
 * the SWC build. The schema is the single source of truth for both the runtime check and the
 * TypeScript type.
 *
 * Usage:
 * ```ts
 * @Body(new ZodValidationPipe(signupSchema)) body: SignupInput
 * ```
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // Report every problem at once — a form that reveals one error per submit is hostile.
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new ApiError('VALIDATION_FAILED', message);
  }
}
