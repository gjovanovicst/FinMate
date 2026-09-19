import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { ReconciliationState } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient, GraphQLRequestError } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { AvatarLoaderComponent } from '../../shared/ui/avatar-loader/avatar-loader.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import {
  cameraSupported,
  capturedLabel,
  messageKeyForStatus,
  receiptProblem,
  reconciliationLabelKey,
  sha256Hex,
  toneForState,
  uploadPercent,
} from './receipts.view';

/**
 * The Receipt library — F-14/F-34, docs/02 §4.11, task 4.1.5.
 *
 * ## What this screen is for
 *
 * A receipt is not a Transaction yet. This is the shelf the photos land on, and the capture action
 * is the only way in: the image is uploaded, an empty Receipt is opened over it, and the user is
 * taken straight to the mismatch screen where its lines are read or typed. Nothing here posts
 * anything to the ledger — that is `/receipts/:id`'s *Napravi transakciju*, behind I-6.
 *
 * ## Why the upload lives here rather than in a shared service
 *
 * It is the **same four-step pipeline** `fm-receipt-attachment` runs in the Transaction sheet, with
 * two deliberate differences: the presign purpose is `RECEIPT`, and `commitAttachment` carries no
 * `transactionId` (there is no Transaction yet — `commitReceipt` links the photo later, inside the
 * API). Pulling the pipeline into a service would mean inventing a seam neither caller needs; the
 * parts that are silently wrong (the allowlist, the digest, the progress percentage, the scan-state
 * note) already live in `receipts.view.ts` with their own spec, which is what keeps this thin.
 *
 * ## Why every camera track is stopped in a `finally`
 *
 * Same rule as the Transaction sheet: a track that is not stopped leaves the recording indicator lit
 * after the photo is taken, which a person rightly reads as the app still watching them. The
 * `finally` covers the failure path too, so a rejected `toBlob` cannot leak the camera either.
 *
 * ## Why a failed upload keeps its blob
 *
 * "Please try again" is only honest if trying again does not mean walking back to the shop. The
 * chosen photo is held in {@link pending} until it succeeds, so *Try again* re-runs the upload
 * rather than reopening the picker.
 *
 * @module apps/web/src/app/features/receipts
 */
@Component({
  selector: 'fm-receipts-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MoneyComponent, IconComponent, AvatarLoaderComponent],
  template: `
    <main class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('receipts.library.title') }}</h1>
          <p class="fm-page__sub">{{ i18n.t('receipts.library.subtitle') }}</p>
        </div>
      </header>

      <section class="fm-card" aria-labelledby="receipts-capture">
        <div class="fm-card__head">
          <h2 class="fm-card__title" id="receipts-capture">
            <fm-icon name="receipts" [size]="18" />
            {{ i18n.t('receipts.library.capture') }}
          </h2>
        </div>

        <div class="capture__row">
          @if (cameraLive()) {
            <video
              #video
              autoplay
              muted
              playsinline
              [attr.aria-label]="i18n.t('receipts.camera.preview')"
            ></video>
            <button type="button" class="fm-btn fm-btn--primary" [disabled]="busy()" (click)="capture()">
              {{ i18n.t('receipts.camera.capture') }}
            </button>
          } @else {
            <button
              type="button"
              class="fm-btn fm-btn--primary"
              [disabled]="busy() || cameraStarting()"
              (click)="startCamera()"
            >
              {{ i18n.t('receipts.camera.start') }}
            </button>
          }

          <!-- The native control stays in the DOM (so it is what the label activates and what a
               keyboard reaches) but is never the UA's own chrome: the label is the button. -->
          <label class="fm-btn file" for="receipts-file">
            {{ i18n.t('receipts.file.label') }}
            <input
              #file
              id="receipts-file"
              class="fm-visually-hidden"
              type="file"
              accept="image/*"
              capture="environment"
              [disabled]="busy()"
              (change)="onFileSelected($event)"
            />
          </label>
        </div>

        @if (cameraStarting()) {
          <p class="muted small" role="status">{{ i18n.t('receipts.camera.starting') }}</p>
        }
        @if (cameraProblem(); as key) {
          <p class="muted small">{{ i18n.t(key) }}</p>
        }

        <div class="status" aria-live="polite">
          @if (busy()) {
            <span class="muted small">{{ i18n.t(status() ?? 'receipts.status.uploading') }}</span>
            @if (percent() > 0) {
              <span
                class="fm-progress"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuenow]="percent()"
                [attr.aria-label]="i18n.t(status() ?? 'receipts.status.uploading')"
              >
                <span class="fm-progress__bar" [style.inline-size.%]="percent()"></span>
              </span>
              <span class="muted small">{{ percent() }}%</span>
            }
          } @else if (status(); as key) {
            <span class="ok">{{ i18n.t(key) }}</span>
          }
        </div>

        @if (uploadError(); as key) {
          <p class="error" role="alert">
            {{ i18n.t(key) }}
            <button type="button" class="fm-btn fm-btn--ghost error__retry" (click)="retry()">
              {{ i18n.t('receipts.retry') }}
            </button>
          </p>
        }
      </section>

      @if (loading()) {
        <fm-avatar-loader [rows]="4" labelKey="receipts.library.loading" />
      } @else if (loadError(); as message) {
        <p class="alert" role="alert">{{ message }}</p>
      } @else if (rows().length === 0) {
        <div class="empty">
          <p class="empty__title">{{ i18n.t('receipts.library.emptyTitle') }}</p>
          <p class="empty__body">{{ i18n.t('receipts.library.emptyBody') }}</p>
        </div>
      } @else {
        <p class="muted small">{{ i18n.t('receipts.library.count', { count: rows().length }) }}</p>

        <ul class="list">
          @for (row of rows(); track row.id) {
            <li class="row">
              <a class="row__link" [routerLink]="['/receipts', row.id]">
                <span class="row__date">{{ dateLabel(row.capturedAt) }}</span>
                <span class="row__state state--{{ tone(row.reconciliation) }}">
                  {{ i18n.t(stateKey(row.reconciliation)) }}
                </span>
                <span class="row__figure">
                  <span class="row__label">{{ i18n.t('receipts.library.totalColumn') }}</span>
                  @if (row.total; as total) {
                    <fm-money [amount]="total" />
                  } @else {
                    <span class="muted small">{{ i18n.t('receipts.library.noTotal') }}</span>
                  }
                </span>
                <span class="row__figure">
                  <span class="row__label">{{ i18n.t('receipts.library.itemsColumn') }}</span>
                  <fm-money [amount]="row.itemsTotal" />
                </span>
                <span class="row__open">{{ i18n.t('receipts.library.open') }}</span>
              </a>
            </li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: var(--text-xs);
    }
    .capture__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
    }
    video {
      inline-size: 100%;
      max-inline-size: 22rem;
      border-radius: var(--radius-md);
      background: var(--color-surface-sunken);
    }
    /* The label is the button that opens the picker (the native input is visually hidden but stays in
       the DOM); this mirrors the focus ring onto it while that input holds focus. */
    .file:focus-within {
      border-color: var(--color-primary);
    }
    .error {
      margin: 0;
      color: var(--color-danger);
      font-size: var(--text-sm);
    }
    .error__retry {
      margin-inline-start: var(--space-2);
    }
    .ok {
      color: var(--color-success);
    }
    .alert {
      margin: 0;
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--color-danger) 15%, transparent);
      color: var(--color-danger);
      font-size: var(--text-sm);
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      min-block-size: var(--space-5);
    }
    .status .fm-progress {
      flex: 1 1 auto;
      min-inline-size: 0;
    }
    .empty {
      padding: var(--space-5);
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-lg);
      text-align: center;
    }
    .empty__title {
      margin: 0 0 var(--space-2);
      font-weight: var(--weight-semibold);
    }
    .empty__body {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .list {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row__link {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-4);
      padding: var(--space-3) var(--space-4);
      color: inherit;
      text-decoration: none;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .row__link:hover,
    .row__link:focus-visible {
      border-color: var(--color-primary);
    }
    .row__date {
      font-weight: var(--weight-semibold);
      min-inline-size: 0;
    }
    .row__figure {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
      min-inline-size: 0;
    }
    .row__label {
      color: var(--color-text-subtle);
      font-size: var(--text-xs);
    }
    .row__state {
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-sm);
      border: 1px solid currentColor;
    }
    .state--ok {
      color: var(--color-success);
    }
    .state--warn {
      color: var(--color-warning);
    }
    .state--danger {
      color: var(--color-danger);
    }
    .state--muted {
      color: var(--color-text-muted);
    }
    /* The repeated action is a column of noise on a narrow screen, so it appears only on hover or
       keyboard focus, exactly like the transaction rows. The whole row is the link either way. */
    .row__open {
      display: none;
      margin-inline-start: auto;
      color: var(--color-primary);
      font-size: var(--text-xs);
    }
    .row__link:hover .row__open,
    .row__link:focus-visible .row__open {
      display: inline;
    }
    @media (min-width: 640px) {
      .row__open {
        display: inline;
      }
    }
  `,
})
export class ReceiptsListComponent {
  readonly i18n = inject(I18nService);

  private readonly graphql = inject(GraphqlClient);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<readonly ReceiptRow[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  readonly busy = signal(false);
  readonly percent = signal(0);
  readonly status = signal<TranslationKey | null>(null);
  readonly uploadError = signal<TranslationKey | null>(null);

  readonly cameraStarting = signal(false);
  readonly cameraProblem = signal<TranslationKey | null>(null);

  private readonly stream = signal<MediaStream | null>(null);
  readonly cameraLive = computed(() => this.stream() !== null);

  /**
   * The photo that failed, kept so *Try again* retries the upload rather than the shopping trip.
   *
   * Not a signal: nothing renders from it, and a signal would make the template depend on a value it
   * never reads.
   */
  private pending: Blob | null = null;

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly fileRef = viewChild<ElementRef<HTMLInputElement>>('file');

  constructor() {
    // The stream is handed to the element here rather than in the click handler: the video only
    // exists once `cameraLive` renders it, and a signal effect re-runs when that view child appears.
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      if (video !== undefined) video.srcObject = this.stream();
    });

    this.destroyRef.onDestroy(() => this.stopStream());
    void this.load();
  }

  // -------------------------------------------------------------------------------------------
  // The library
  // -------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const data = await this.graphql.query<{ receipts: ReceiptRow[] }>(RECEIPTS);
      this.rows.set(data.receipts);
    } catch (error) {
      // The typed code is localised; the server's message is only a fallback (docs/06 §10).
      this.loadError.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** A captured instant as the reader's own date — never through the money formatter. */
  dateLabel(instant: string): string {
    return capturedLabel(instant, this.i18n.tag());
  }

  stateKey(state: ReconciliationState): TranslationKey {
    return reconciliationLabelKey(state);
  }

  tone(state: ReconciliationState): string {
    return toneForState(state);
  }

  // -------------------------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------------------------

  async startCamera(): Promise<void> {
    this.cameraProblem.set(null);
    if (!cameraSupported(navigator)) {
      // Not an error the user caused: this browser simply has no camera API (an insecure origin).
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
      this.uploadError.set('receipts.error.capture');
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
    this.uploadError.set(null);
    this.status.set(null);
    const blob = this.pending;
    if (blob !== null) {
      void this.upload(blob);
      return;
    }
    this.fileRef()?.nativeElement.click();
  }

  /**
   * Presign → signed PUT → commit → open a Receipt, in that order.
   *
   * The bytes never pass through the API: presign allocates the row and signs a `PUT`, and the
   * browser sends the photo straight to object storage (ADR-018). The digest is what the API matches
   * against the object's own metadata on commit, so it is computed here and never faked.
   */
  private async upload(blob: Blob): Promise<void> {
    // 1. Validate locally for a fast, specific answer; the API validates again because this is a client.
    const problem = receiptProblem({ mimeType: blob.type, byteSize: blob.size });
    if (problem !== null) {
      this.pending = null;
      this.uploadError.set(problem === 'type' ? 'receipts.error.type' : 'receipts.error.size');
      return;
    }

    this.busy.set(true);
    this.uploadError.set(null);
    this.percent.set(0);
    this.status.set('receipts.status.hashing');

    try {
      // 2. The digest the API will match against the object's own metadata on commit.
      const sha256 = await sha256Hex(await blob.arrayBuffer());

      // 3. Presign over REST: the browser talks to `/api/*` and the dev proxy strips the prefix.
      //    `purpose: RECEIPT` is what lets `createReceipt` accept the attachment at all.
      this.status.set('receipts.status.uploading');
      const presigned = await firstValueFrom(
        this.http.post<PresignResponse>('/api/v1/files/presign', {
          purpose: 'RECEIPT',
          mimeType: blob.type,
          byteSize: blob.size,
          sha256,
        }),
      );

      // 4. The bytes go straight to storage; only this hop can report progress.
      await this.putBlob(presigned.uploadUrl, presigned.headers, blob);

      // 5. Commit verifies what arrived. No `transactionId`: there is no Transaction yet, and the
      //    receipt is what will own the photo until `commitReceipt` links it to the posted row.
      this.status.set('receipts.status.finishing');
      await this.graphql.query<{ commitAttachment: { id: string } }>(COMMIT_ATTACHMENT, {
        input: { attachmentId: presigned.attachmentId },
      });

      // 6. Open the Receipt over the committed attachment and go straight to its lines.
      this.status.set('receipts.status.opening');
      const created = await this.graphql.query<{ createReceipt: { id: string } }>(CREATE_RECEIPT, {
        input: { attachmentId: presigned.attachmentId },
      });

      this.pending = null;
      this.status.set('receipts.library.created');
      await this.router.navigate(['/receipts', created.createReceipt.id]);
    } catch (error) {
      // The bytes are worth keeping: the retry must not make the user re-photograph the receipt.
      this.pending = blob;
      this.status.set(null);
      this.uploadError.set(this.messageFor(error));
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

/** One row of the library, as selected (docs/06 §5.9's `receipts`). */
interface ReceiptRow {
  readonly id: string;
  readonly capturedAt: string;
  readonly reconciliation: ReconciliationState;
  readonly total: MoneyWire | null;
  readonly itemsTotal: MoneyWire;
  readonly variance: MoneyWire;
  readonly attachmentId: string | null;
  readonly transactionId: string | null;
}

/** The part of `POST /v1/files/presign` this component uses (docs/06 §9.2). */
interface PresignResponse {
  readonly attachmentId: string;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

const RECEIPTS = /* GraphQL */ `
  query Receipts {
    receipts(first: 50) {
      id
      capturedAt
      reconciliation
      total
      itemsTotal
      variance
      attachmentId
      transactionId
    }
  }
`;

const COMMIT_ATTACHMENT = /* GraphQL */ `
  mutation CommitAttachment($input: CommitAttachmentInput!) {
    commitAttachment(input: $input) {
      id
    }
  }
`;

const CREATE_RECEIPT = /* GraphQL */ `
  mutation CreateReceipt($input: CreateReceiptInput!) {
    createReceipt(input: $input) {
      id
    }
  }
`;
