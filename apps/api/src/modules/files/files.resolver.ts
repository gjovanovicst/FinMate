import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { AttachmentModel, CommitAttachmentInput, toAttachmentModel } from './file.model';
import { FilesService } from './files.service';

/**
 * Attachments over GraphQL — F-34, docs/06 §5, task 4.1.1.
 *
 * The upload and the download are REST (§9), because one is a presigned `PUT` and the other a `302`.
 * What is here is the part that *is* a data operation: reading an attachment's state, committing an
 * upload, and deleting one.
 *
 * `deleteAttachment` returns `Boolean` rather than docs/06's `SimplePayload`, and `commitAttachment`
 * returns the model rather than `AttachmentPayload` — the same deliberate deviation the repo has made
 * three times now (docs/06 §5.5, §5.7, §5.13): the arms a payload union would declare are already the
 * typed `ApiError` codes every other module returns, and declaring union arms with no distinct producer
 * is a contract that cannot be kept.
 *
 * `CommitAttachmentInput` also drops docs/06's `purpose` (the purpose was fixed at presign; accepting it
 * again invites a contradiction) and `receiptId` (nothing produces a Receipt yet — 4.1.3 does). Both
 * are recorded in §5.9's notes rather than accepted and ignored.
 *
 * @module apps/api/src/modules/files
 */
@Resolver(() => AttachmentModel)
export class FilesResolver {
  constructor(private readonly files: FilesService) {}

  @Query(() => AttachmentModel, {
    nullable: true,
    description: 'One attachment of this Household, or null when the id is not ours.',
  })
  async attachment(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<AttachmentModel | null> {
    const view = await this.files.getById(householdId, id);
    return view === null ? null : toAttachmentModel(view);
  }

  @Mutation(() => AttachmentModel, {
    description:
      'Verify an uploaded object (size, declared sha256, scan hook) and optionally attach it to a ' +
      'Transaction. Idempotent: a row already decided is linked, not re-scanned.',
  })
  async commitAttachment(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => CommitAttachmentInput }) input: CommitAttachmentInput,
  ): Promise<AttachmentModel> {
    const view = await this.files.commit(householdId, {
      attachmentId: input.attachmentId,
      transactionId: input.transactionId ?? null,
    });
    return toAttachmentModel(view);
  }

  @Mutation(() => Boolean, {
    description:
      'Delete the object and its row. A Transaction or Receipt pointing at it detaches rather than ' +
      'blocking (docs/03 §4). False when the id is not this Household’s.',
  })
  async deleteAttachment(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<boolean> {
    return this.files.remove(householdId, id);
  }
}
