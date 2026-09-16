import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AuthenticatedGuard } from '../../common/auth/guards';
import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ALLOWED_MIME_TYPES, FilesService, MAX_BYTE_SIZE, PURPOSES } from './files.service';

/**
 * `/v1/files/*` — docs/06 §9.2 and §9.4, ADR-018, task 4.1.1.
 *
 * ## Why these two routes are REST and not GraphQL
 *
 * docs/06 §9 puts them here for a reason that has not changed: a presigned URL is a **navigation** for
 * a browser PUT and a `302` for a download, and GraphQL has neither an upload nor a redirect. The
 * bytes never transit the API (ADR-018), so the API's part is signing and a redirect.
 *
 * ## `GET /v1/files/:id` answers three different things
 *
 * | Case | Answer |
 * |---|---|
 * | Not this Household's, or no such row | `404` — existence is information (threat T-01/T-04) |
 * | This Household's, but not linkable yet (`PENDING`/`INFECTED`/`FAILED`) | `409 CONFLICT` |
 * | Linkable | `302 Found` to a 5-minute presigned GET, `Cache-Control: no-store` |
 *
 * The `409` is a deliberate addition to docs/06 §9.4, which only spells out the cross-household case:
 * returning `404` for a file that exists but is still being checked would make the client show "file
 * missing" during the normal window between PUT and `commitAttachment`, and returning the bytes anyway
 * is exactly what `scan_state` exists to prevent.
 *
 * @module apps/api/src/modules/files
 */

export const presignBodySchema = z.object({
  purpose: z.enum(PURPOSES),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  // A whole number of bytes. `.int()` rejects `1.5`, and the upper bound is repeated here so a
  // 4 GiB claim is refused before it reaches the service's own check.
  byteSize: z.number().int().positive().max(MAX_BYTE_SIZE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lower-case hexadecimal characters'),
});

export type PresignBody = z.infer<typeof presignBodySchema>;

@Controller('v1/files')
@UseGuards(AuthenticatedGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('presign')
  @HttpCode(HttpStatus.CREATED)
  async presign(
    @CurrentHouseholdId() householdId: string,
    @Body(new ZodValidationPipe(presignBodySchema)) body: PresignBody,
  ): Promise<{
    attachmentId: string;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
    reused: boolean;
  }> {
    return this.files.presign(householdId, body);
  }

  @Get(':id')
  async download(
    @CurrentHouseholdId() householdId: string,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.files.downloadTarget(householdId, id);
    if (target === null) throw new ApiError('NOT_FOUND', 'Attachment not found.');
    if (target === 'pending') {
      throw new ApiError(
        'CONFLICT',
        'That file is still being checked. It becomes downloadable once commitAttachment accepts it.',
      );
    }
    // A presigned URL is a bearer credential for one object; it must never sit in a shared cache.
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(HttpStatus.FOUND, target.url);
  }
}
