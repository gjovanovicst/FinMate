import { Module } from '@nestjs/common';

import { JsonScalar } from '../../graphql/scalars/json.scalar';

import { PrismaModule } from '../../prisma/prisma.module';
import {
  AI_CLASSIFIER,
  UNCONFIGURED_AI_CLASSIFIER,
  type AiClassifier,
} from './ai-classifier';
import { EMBEDDINGS, UNCONFIGURED_EMBEDDINGS, type EmbeddingProvider } from './embedding-provider';
import { EntityEmbeddingsService } from './entity-embeddings.service';
import { ClassificationResolver } from './classification.resolver';
import { CorrectionsService } from './corrections.service';
import { ReviewService } from './review.service';
import { RulesResolver } from './rules.resolver';
import { RulesService } from './rules.service';
import {
  CALIBRATION_STORE,
  ClassificationService,
  NO_CALIBRATION,
} from './classification.service';

/**
 * `classification` — the pipeline that turns the pure packages into decisions (docs/04 §2).
 *
 * ## What it imports, and what it deliberately does not
 *
 * It imports `@finmate/nlp`, `@finmate/rules-engine`, `@finmate/ai` and `@finmate/domain` as source,
 * which the boundary rule allows for `scope:api`. It does **not** import an AI adapter directly: the
 * classifier goes through `AiRouter`, so the provider stays swappable (AGENTS.md rule 10, ADR-007).
 *
 * ## The AI provider is not configured yet
 *
 * `AI_CLASSIFIER` resolves to {@link UNCONFIGURED_AI_CLASSIFIER}, which reports the
 * `RULES_KEYWORDS_ONLY` rung rather than pretending a call happened. That is not a stub: with all API
 * keys empty and no local model listening, "no reachable provider" is the true state, and the
 * degradation ladder is supposed to make capture succeed anyway (docs/04 §9). Wiring the real
 * `RoutedAiClassifier` is a two-line change here once provider configuration exists — the router, its
 * fail-closed residency check and the adapters are already built and tested in `packages/ai` — and the
 * tests inject a stub provider instead of reaching the network.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ClassificationService,
    ClassificationResolver,
    // docs/05 §3 puts `rules` and `corrections` in this module, so the learning loop is not a new
    // module: it is the write half of the pipeline whose read half is already here.
    RulesService,
    CorrectionsService,
    RulesResolver,
    // The review queue (F-08) — the READ half. The resolver lives on the ledger, because composing
    // the queue needs both this service and the ledger's list, and only that module can reach both.
    ReviewService,
    // Custom scalars are registered by being provided; they are referenced by type in `@Field()`.
    // Omitting this makes Nest report `CannotDetermineInputTypeError` naming the class, which reads
    // like a decorator problem rather than a missing provider.
    JsonScalar,
    { provide: AI_CLASSIFIER, useValue: UNCONFIGURED_AI_CLASSIFIER satisfies AiClassifier },
    // docs/04 §4 rung 5. Same shape and same honesty as the classifier above: no local embedding model
    // is configured in this build, so rung 5 is INERT and the ladder ends at rung 4 (ADR-021). A real
    // local provider is a one-line swap here; nothing else in the pipeline changes.
    { provide: EMBEDDINGS, useValue: UNCONFIGURED_EMBEDDINGS satisfies EmbeddingProvider },
    EntityEmbeddingsService,
    { provide: CALIBRATION_STORE, useValue: NO_CALIBRATION },
  ],
  // Exported so the ledger (task 2.2.5's `captureCommit`) can attach a decision to the Transaction it
  // wrote and can re-classify a row that never went through a preview, without a second pipeline.
  exports: [
    EntityEmbeddingsService,
    ClassificationService,
    RulesService,
    CorrectionsService,
    ReviewService,
    AI_CLASSIFIER,
    CALIBRATION_STORE,
  ],
})
export class ClassificationModule {}
