import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { GraphqlClient, GraphQLRequestError } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import {
  cameraSupported,
  messageKeyForStatus,
  receiptNoteKeys,
  receiptProblem,
  sha256Hex,
  uploadPercent,
} from './receipts.view';

/**
 * Camera capture and receipt upload — F-14 and F-34, docs/02 §4.5 and docs/06 §9.
 *
 * ## Why the bytes never pass through the API
 *
 * The presign route allocates the row and signs a `PUT`; the browser sends the photo straight to object
 * storage (ADR-018). `commitAttachment` then verifies size and digest and links the file to the
 * Transaction. This component is therefore a *coordinator*, not a proxy: it validates locally for a fast
 * answer, and the API re-validates because a client check is not a guarantee.
 *
 * ## Why the upload uses `XMLHttpRequest`
 *
 * `fetch` cannot report upload progress, and a 12 MiB photo over a phone connection needs a moving bar
 * to look alive. XHR is the only platform API with `upload.onprogress`, which is why the fourth step is
 * a raw XHR rather than the `HttpClient` used for presign — and why the signed headers are copied
 * **verbatim**: they are part of the AWS signature, so a header added or dropped is a `403`.
 *
 * ## Why every camera track is stopped in a `finally`
 *
 * A `MediaStreamTrack` that is not stopped leaves the recording indicator on after the photo is taken,
 * which a person rightly reads as the app still watching them. The `finally` runs on the failure path
 * too, so a rejected `toBlob` cannot leak the camera either.
 *
 * Every decision that is silent when wrong — the allowlist, the hash, the percentage, what `SKIPPED`
 * means — lives in `receipts.view.ts` with its own spec.
 *
 * @module apps/web/src/app/features/receipts
 */
@Component({
  selector: 'fm-receipt-attachment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="receipt">
      <h2>{{ i18n.t('receipts.title') }}</h2>
      <p class="muted small">{{ i18n.t('receipts.hint') }}</p>

      @if (attachmentLoading()) {
        <p class="muted small">{{ i18n.t('receipts.loading') }}</p>
      }
      @if (attachmentError(); as key) {
        <p class="error" role="alert">
          {{ i18n.t(key) }}
          <button type="button" class="btn btn--link" (click)="reloadAttachment()">{{ i18n.t('receipts.retry') }}</button>
        </p>
      }
      @if (attachment(); as file) {
        <figure class="preview">
          @if (file.downloadUrl; as url) {
            <img [src]="url" [attr.alt]="i18n.t('receipts.imageAlt')" [attr.aria-label]="i18n.t('receipts.imageAlt')" />
          }
          @for (key of notes(); track key) {
            <figcaption class="muted small">{{ i18n.t(key) }}</figcaption>
          }
          <button type="button" class="btn btn--danger" [disabled]="busy()" (click)="remove()">
            {{ i18n.t('receipts.remove') }}
          </button>
        </figure>
      }

      <div class="capture">
        @if (cameraLive()) {
          <video #video autoplay muted playsinline [attr.aria-label]="i18n.t('receipts.camera.preview')"></video>
          <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="capture()">
            {{ i18n.t('receipts.camera.capture') }}
          </button>
        } @else {
          <button type="button" class="btn btn--primary" [disabled]="busy() || cameraStarting()" (click)="startCamera()">
            {{ i18n.t('receipts.camera.start') }}
          </button>
        }
        <label class="file">
          <span>{{ i18n.t('receipts.file.label') }}</span>
          <input #file type="file" accept="image/*" capture="environment" [disabled]="busy()" (change)="onFileSelected($event)" />
        </label>
      </div>

      @if (cameraStarting()) {
        <p class="muted small" role="status">{{ i18n.t('receipts.camera.starting') }}</p>
      }
      @if (cameraProblem(); as key) {
        <p class="muted small">{{ i18n.t(key) }}</p>
      }

      @if (error(); as key) {
        <p class="error" role="alert">
          {{ i18n.t(key) }}
          <button type="button" class="btn btn--link" (click)="retry()">{{ i18n.t('receipts.retry') }}</button>
        </p>
      }

      <div class="status" aria-live="polite">
        @if (busy()) {
          <span class="muted small">{{ i18n.t(status() ?? 'receipts.status.uploading') }}</span>
          @if (percent() > 0) {
            <progress [value]="percent()" max="100"></progress>
            <span class="muted small">{{ percent() }}%</span>
          }
        } @else if (status(); as key) {
          <span class="ok">{{ i18n.t(key) }}</span>
        }
      </div>
    </section>
  `,
  styles: `
    .receipt {
      display: flex;
      flex-direction: column;
      gap: var(--space-2, 0.5rem);
      /* No fixed width: the 320 px pass found every one of them (docs/02 §9). */
      max-inline-size: 100%;
    }
    h2 { font-size: 1.05rem; margin: 0; }
    .muted { color: var(--color-text-muted, #5a5a6b); }
    .small { font-size: 0.85rem; }
    .capture { display: flex; flex-wrap: wrap; gap: var(--space-3, 0.75rem); align-items: center; }
    video {
      inline-size: 100%;
      max-inline-size: 22rem;
      border-radius: var(--radius-md, 10px);
      background: #000;
    }
    .preview { margin: 0; display: flex; flex-direction: column; gap: var(--space-2, 0.5rem); align-items: flex-start; }
    .preview img {
      max-inline-size: 100%;
      max-block-size: 20rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--color-border, #dcdce5);
    }
    .file { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9rem; }
    .btn {
      padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
      font: inherit;
      font-weight: 600;
      border: 1px solid transparent;
      border-radius: var(--radius-md, 10px);
      cursor: pointer;
    }
    .btn:disabled { opacity: 0.6; cursor: default; }
    .btn--primary { color: var(--color-primary-contrast, #fff); background: var(--color-primary, #5b48e0); }
    .btn--danger { color: var(--color-danger, #f2555a); background: none; border-color: var(--color-danger, #f2555a); }
    .btn--link { border: 0; padding: 0; background: none; color: inherit; text-decoration: underline; }
    .error { color: var(--color-danger, #f2555a); }
    .ok { color: var(--color-success, #3fbf7f); }
    .status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2, 0.5rem); min-block-size: 1.25rem; }
    progress { inline-size: 12rem; max-inline-size: 100%; }
  `,
})
export class ReceiptAttachmentComponent {
  /** The Transaction the receipt belongs to — sent on commit, never before. */
  readonly transactionId = input.required<string>();
  /** The already-attached file to preview and remove, or `null` when there is none. */
  readonly attachmentId = input<string | null>(null);

  /** Emitted after a successful attach and after a successful remove. */
  readonly changed = output<void>();

  readonly i18n = inject(I18nService);

  private readonly graphql = inject(GraphqlClient);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly busy = signal(false);
  readonly percent = signal(0);
  readonly status = signal<TranslationKey | null>(null);
  readonly error = signal<TranslationKey | null>(null);

  readonly cameraStarting = signal(false);
  readonly cameraProblem = signal<TranslationKey | null>(null);

  readonly attachmentLoading = signal(false);
  readonly attachmentError = signal<TranslationKey | null>(null);
  /** Public because the template renders it; the only writers are the load effect and the pipeline. */
  readonly attachment = signal<AttachmentWire | null>(null);

  private readonly stream = signal<MediaStream | null>(null);
  readonly cameraLive = computed(() => this.stream() !== null);
  readonly notes = computed(() => {
    const file = this.attachment();
    if (file === null) return [];
    return receiptNoteKeys({ scanState: file.scanState, hasPreview: file.downloadUrl !== null });
  });

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly fileRef = viewChild<ElementRef<HTMLInputElement>>('file');

  constructor() {
    // The live stream is handed to the element here rather than in the click handler: the video only
    // exists once `cameraLive` renders it, and a signal effect re-runs when that view child appears.
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      if (video !== undefined) video.srcObject = this.stream();
    });

    // The attached file is identified by id, so the parent stays the only writer of that fact and the
    // component re-reads it when the id changes rather than caching a copy that can go stale.
    effect(() => {
      const id = this.attachmentId();
      if (id === null) {
        this.attachment.set(null);
        return;
      }
      void this.loadAttachment(id);
    });

    this.destroyRef.onDestroy(() => this.stopStream());
  }

  private async loadAttachment(id: string): Promise<void> {
    this.attachmentLoading.set(true);
    this.attachmentError.set(null);
    try {
      const data = await this.graphql.query<{ attachment: AttachmentWire | null }>(ATTACHMENT, { id });
      // A slow response for a previous id must not overwrite the newer one the user is looking at.
      if (this.attachmentId() !== id) return;
      this.attachment.set(data.attachment);
    } catch (error) {
      if (this.attachmentId() !== id) return;
      this.attachmentError.set(this.messageFor(error));
    } finally {
      // Only the request that still owns the input may clear the loader; a stale one must not hide it.
      if (this.attachmentId() === id) this.attachmentLoading.set(false);
    }
  }

  async startCamera(): Promise<void> {
    this.cameraProblem.set(null);
    if (!cameraSupported(navigator)) {
      // Not an error the user caused: this browser simply has no camera API (an insecure origin, say).
      this.cameraProblem.set('receipts.camera.unsupported');
      return;
    }

    this.cameraStarting.set(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      this.stopStream();
      this.stream.set(stream);
    } catch {
      // Permission denied is a normal path, not a dead button: explain it and leave the file input.
      this.cameraProblem.set('receipts.camera.denied');
    } finally {
      // Never leave a spinner: the explanation and the fallback are the failure output.
      this.cameraStarting.set(false);
    }
  }

  async capture(): Promise<void> {
    const video = this.videoRef()?.nativeElement;
    if (video === undefined) return;

    let blob: Blob | null = null;
    try {
      blob = await this.frameToBlob(video);
    } catch {
      blob = null;
    } finally {
      // Always: a stopped track turns the camera indicator off, and the user is done looking.
      this.stopStream();
    }

    if (blob === null) {
      this.error.set('receipts.error.capture');
      return;
    }
    await this.upload(blob);
  }

  private async frameToBlob(video: HTMLVideoElement): Promise<Blob> {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) throw new Error('The camera has not produced a frame yet.');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('This browser cannot draw to a canvas.');

    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    if (blob === null) throw new Error('The frame could not be encoded as a JPEG.');
    return blob;
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared so choosing the same photo twice still fires a change (e.g. after a retry).
    input.value = '';
    if (file === undefined) return;
    await this.upload(file);
  }

  retry(): void {
    this.error.set(null);
    this.status.set(null);
    this.fileRef()?.nativeElement.click();
  }

  /** Re-read the attachment after a load failure — the effect only fires when the id changes. */
  reloadAttachment(): void {
    const id = this.attachmentId();
    if (id !== null) void this.loadAttachment(id);
  }

  private async upload(blob: Blob): Promise<void> {
    // 1. Validate locally for a fast, specific answer; the API validates again because this is a client.
    const problem = receiptProblem({ mimeType: blob.type, byteSize: blob.size });
    if (problem !== null) {
      this.error.set(problem === 'type' ? 'receipts.error.type' : 'receipts.error.size');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.percent.set(0);
    this.status.set('receipts.status.hashing');

    try {
      // 2. The digest the API will match against the object's own metadata on commit.
      const sha256 = await sha256Hex(await blob.arrayBuffer());

      // 3. Presign over REST: the browser talks to `/api/*` and the dev proxy strips the prefix.
      this.status.set('receipts.status.uploading');
      const presigned = await firstValueFrom(
        this.http.post<PresignResponse>('/api/v1/files/presign', {
          purpose: 'TRANSACTION',
          mimeType: blob.type,
          byteSize: blob.size,
          sha256,
        }),
      );

      // 4. The bytes go straight to storage; only this hop can report progress.
      await this.putBlob(presigned.uploadUrl, presigned.headers, blob);

      // 5. Commit verifies what arrived and links it to the Transaction in one call.
      this.status.set('receipts.status.finishing');
      const committed = await this.graphql.query<{ commitAttachment: AttachmentWire }>(
        COMMIT_ATTACHMENT,
        { input: { attachmentId: presigned.attachmentId, transactionId: this.transactionId() } },
      );

      this.attachment.set(committed.commitAttachment);
      this.status.set('receipts.status.attached');
      this.changed.emit();
    } catch (error) {
      this.status.set(null);
      this.error.set(this.messageFor(error));
    } finally {
      this.busy.set(false);
    }
  }

  private putBlob(
    uploadUrl: string,
    headers: Readonly<Record<string, string>>,
    blob: Blob,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', uploadUrl, true);
      // Verbatim and nothing else: these headers are part of the AWS signature, so adding or dropping
      // one produces a 403 that looks like a permission problem.
      for (const [name, value] of Object.entries(headers)) {
        request.setRequestHeader(name, value);
      }
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) this.percent.set(uploadPercent(event.loaded, event.total));
      };
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new Error(`The upload failed with status ${request.status}.`));
      };
      request.onerror = () => reject(new Error('The upload failed.'));
      request.send(blob);
    });
  }

  async remove(): Promise<void> {
    const current = this.attachment();
    if (current === null) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query<{ deleteAttachment: boolean }>(DELETE_ATTACHMENT, { id: current.id });
      // The mutation deletes the object and the row; `transactions.attachment_id` is
      // `ON DELETE SET NULL` (docs/03 §4), so the Transaction detaches rather than blocking the delete.
      this.attachment.set(null);
      this.status.set('receipts.status.removed');
      this.changed.emit();
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.busy.set(false);
    }
  }

  private stopStream(): void {
    const stream = this.stream();
    // Every track, not just the video one: an audio track left running is the same leak.
    stream?.getTracks().forEach((track) => track.stop());
    this.stream.set(null);
  }

  private messageFor(error: unknown): TranslationKey {
    if (error instanceof GraphQLRequestError) {
      switch (error.code) {
        case 'VALIDATION_FAILED':
          return 'receipts.error.rejected';
        case 'NOT_FOUND':
          return 'receipts.error.notFound';
        case 'CONFLICT':
          return 'receipts.error.conflict';
        case 'RATE_LIMITED':
          return 'receipts.error.rateLimited';
        default:
          return 'receipts.error.generic';
      }
    }
    if (error instanceof HttpErrorResponse) return messageKeyForStatus(error.status);
    return 'receipts.error.generic';
  }
}

/** The subset of `AttachmentModel` this component renders (docs/06 §3.2). */
interface AttachmentWire {
  readonly id: string;
  readonly downloadUrl: string | null;
  readonly scanState: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

/** The part of `POST /v1/files/presign` this component uses (docs/06 §9.2). */
interface PresignResponse {
  readonly attachmentId: string;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

const ATTACHMENT = /* GraphQL */ `
  query Attachment($id: String!) {
    attachment(id: $id) {
      id
      downloadUrl
      scanState
      mimeType
      byteSize
    }
  }
`;

const COMMIT_ATTACHMENT = /* GraphQL */ `
  mutation CommitAttachment($input: CommitAttachmentInput!) {
    commitAttachment(input: $input) {
      id
      downloadUrl
      scanState
      mimeType
      byteSize
    }
  }
`;

const DELETE_ATTACHMENT = /* GraphQL */ `
  mutation DeleteAttachment($id: String!) {
    deleteAttachment(id: $id)
  }
`;
