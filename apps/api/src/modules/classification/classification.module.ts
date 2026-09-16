import { Module } from '@nestjs/common';


import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
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
 * ## The AI provider comes from the composition root
 *
 * `AI_CLASSIFIER` and `EMBEDDINGS` are provided by `AiModule` (ADR-031 decision 6) from the validated
 * configuration and the Household's consent record. With no endpoint configured the tokens are the
 * `UNCONFIGURED_*` twins, which report the `RULES_KEYWORDS_ONLY` rung rather than pretending a call
 * happened — and that remains the true state of a deployment with no key and no local model, so the
 * degradation ladder still makes capture succeed (docs/04 §9). The tests inject a stub provider
 * instead of reaching the network.
 */
@Module({
  imports: [PrismaModule, GraphqlScalarsModule, AiModule],
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
    // `JSON` comes from `GraphqlScalarsModule` (imported above), not from this module's providers:
    // providing the same scalar twice gives the schema two types named `JSON` and a boot failure.
    EntityEmbeddingsService,
    { provide: CALIBRATION_STORE, useValue: NO_CALIBRATION },
  ],
  // Exported so the ledger (task 2.2.5's `captureCommit`) can attach a decision to the Transaction it
  // wrote and can re-classify a row that never went through a preview, without a second pipeline.
  //
  // `AiModule` is re-exported rather than `AI_CLASSIFIER` listed directly: Nest refuses to export a
  // provider the module only *imports* ("Nest cannot export a provider/module that is not a part of
  // the currently processed module"), which is the boot failure this line was. Re-exporting the
  // module is the supported form and preserves the ledger's import list.
  exports: [
    EntityEmbeddingsService,
    ClassificationService,
    RulesService,
    CorrectionsService,
    ReviewService,
    CALIBRATION_STORE,
    AiModule,
  ],
})
export class ClassificationModule {}
