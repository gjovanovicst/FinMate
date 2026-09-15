import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import {
  AI_CLASSIFIER,
  UNCONFIGURED_AI_CLASSIFIER,
  type AiClassifier,
} from './ai-classifier';
import { ClassificationResolver } from './classification.resolver';
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
    { provide: AI_CLASSIFIER, useValue: UNCONFIGURED_AI_CLASSIFIER satisfies AiClassifier },
    { provide: CALIBRATION_STORE, useValue: NO_CALIBRATION },
  ],
  // Exported so the ledger (task 2.2.5's `captureCommit`) can attach a decision to the Transaction it
  // wrote and can re-classify a row that never went through a preview, without a second pipeline.
  exports: [ClassificationService, AI_CLASSIFIER, CALIBRATION_STORE],
})
export class ClassificationModule {}
