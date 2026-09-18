import { Module } from '@nestjs/common';

import { CONFIG, type AppConfig } from '../../config/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { AI_CLASSIFIER, type AiClassifier } from '../classification/ai-classifier';
import { EMBEDDINGS, type EmbeddingProvider } from '../classification/embedding-provider';
import { NARRATOR, type AssistantNarrator } from '../assistant/assistant-narrator';
import { OCR, type OcrService } from '../receipts/ocr';
import { type AssistantRouter } from '../assistant/assistant-router';
import { ConsentModule } from '../consent/consent.module';
import { ConsentsService } from '../consent/consents.service';
import { AiEgressResolver } from './ai-egress.resolver';
import { makeAiSeams, type AiSeams } from './ai-providers';
import { AI_ROUTER, AI_SEAMS } from './ai-tokens';

/**
 * The AI composition root — ADR-031 decision 6.
 *
 * ## One module owns "which model, on which host, with which key"
 *
 * Before this, four feature modules each answered that question by supplying an `UNCONFIGURED_*`
 * value, and the answer was never anything else. Now the answer is computed once, from the validated
 * configuration and the consent record, and the feature modules inject the result. A feature module
 * still never imports an adapter (AGENTS.md rule 10) — it imports a token, and this module is the
 * only place that knows a vendor exists.
 *
 * ## The graph is acyclic, and deliberately so
 *
 * `AiModule` imports `ConsentModule` and `PrismaModule`, and imports three *classes* from the feature
 * modules (`RoutedAiClassifier`, `RoutedNarrator`, `RoutedOcrService`) — plain TypeScript, not Nest
 * modules. The feature modules import `AiModule` for the tokens. So there is no `forwardRef` anywhere:
 * the direction is feature → ai → consent, and consent knows nothing about AI.
 *
 * ## `useFactory`, not `useValue`
 *
 * `CONFIG` is already validated by the time this runs, and `ConsentsService` is resolved from the
 * container, so nothing here reads `process.env` and nothing reaches for a global. The `AiSeams`
 * token is the single instance of the router, which matters because the circuit breakers are its
 * state: two routers would mean two half-open probes against one provider.
 *
 * @module apps/api/src/modules/ai
 */

@Module({
  imports: [PrismaModule, ConsentModule],
  providers: [
    // The egress query reads the same assembly the router does, so the consent sheet can name the
    // provider and region it would actually use rather than a claim in client copy.
    AiEgressResolver,
    {
      provide: AI_SEAMS,
      inject: [CONFIG, ConsentsService],
      useFactory: (config: AppConfig, consents: ConsentsService): AiSeams =>
        makeAiSeams(config, globalThis.fetch, {
          // The gate is the consent record itself, asked once per non-EEA endpoint per call. It fails
          // closed, so a read error degrades to rules and keywords rather than to egress (ADR-007).
          permits: (task) => consents.permits(task),
        }),
    },
    { provide: AI_CLASSIFIER, inject: [AI_SEAMS], useFactory: (seams: AiSeams): AiClassifier => seams.classifier },
    { provide: NARRATOR, inject: [AI_SEAMS], useFactory: (seams: AiSeams): AssistantNarrator => seams.narrator },
    { provide: OCR, inject: [AI_SEAMS], useFactory: (seams: AiSeams): OcrService => seams.ocr },
    {
      provide: EMBEDDINGS,
      inject: [AI_SEAMS],
      useFactory: (seams: AiSeams): EmbeddingProvider => seams.embeddings,
    },
    // ADR-036's rung. Inert (`UNCONFIGURED_ROUTER`) unless `AI_ROUTE_PRIMARY` names a usable endpoint,
    // so this token is safe to inject anywhere and the assistant needs no feature flag to hold it.
    {
      provide: AI_ROUTER,
      inject: [AI_SEAMS],
      useFactory: (seams: AiSeams): AssistantRouter => seams.questionRouter,
    },
  ],
  exports: [AI_CLASSIFIER, NARRATOR, OCR, EMBEDDINGS, AI_ROUTER, AI_SEAMS],
})
export class AiModule {}
