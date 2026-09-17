/**
 * `pnpm test:evals` — the Phase 2 evaluation run (docs/10 §5, docs/04 §11).
 *
 * ## What it does
 *
 * Boots a **real** Nest application context against a real database, creates one synthetic Household,
 * seeds it with the shipped starter tree and the shipped merchant catalogue through the **production
 * writers** (`OnboardingService`), then pushes every case of the v1 golden dataset through
 * `ClassificationService.parse` — the same entry point the capture screen uses. Nothing is stubbed
 * except the model, which is genuinely absent: no provider is configured in this build, so every
 * decision is either deterministic or blocked. That is the honest state, and the report says so.
 *
 * ## Why the real pipeline and not a hand-built one
 *
 * docs/10 §5.4: *"the product's accuracy is the pipeline's accuracy; scoring the model alone measures
 * the wrong thing."* The corollary is that a harness assembling its own `PipelineInput` would grade a
 * second implementation of `loadContext`. This one grades the deployed one.
 *
 * ## What it deliberately does not do
 *
 * - **No LLM judge** (docs/10 §5.4).
 * - **No `evals` schema, no trend history** (docs/10 §5.7): the runner prints a report and writes two
 *   artefacts. History needs the nightly runner and its tables.
 * - **No live provider, no cassettes**: there is no provider to record from yet.
 *
 * Usage: `pnpm test:evals [--report-only]`. Exits non-zero when a docs/04 §11.2 gate is breached.
 *
 * @module apps/api/src/evals
 */

import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { SHIPPED_MERCHANTS, uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../common/tenancy/tenant-context';
import { ConfigModule } from '../config/config.module';
import { ClassificationModule } from '../modules/classification/classification.module';
import { ClassificationService } from '../modules/classification/classification.service';
import { OnboardingModule } from '../modules/onboarding/onboarding.module';
import { OnboardingService } from '../modules/onboarding/onboarding.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { isRunnable, planQuestion } from '../modules/assistant/query-planner';
import {
  buildDataset,
  findWorkspaceRoot,
  loadAssistantBattery,
  loadCategoryExpectations,
  loadGoldenFixtures,
} from './dataset';
import {
  evaluateGates,
  evaluatePlannerGates,
  failingCases,
  plannerGaps,
  plannerMismatches,
  scoreCase,
  summarise,
  type PlannerOutcome,
} from './scoring';
import type { CaseScore, EvalReport, GateResult, ObservedCase, ObservedFragment } from './types';

/**
 * The smallest graph that can run the pipeline: config, database, the classifier, and the onboarding
 * service that seeds content. Deliberately not `AppModule` — GraphQL and the HTTP guards are noise
 * here, and a harness that boots the whole server fails for reasons unrelated to what it measures.
 */
@Module({
  imports: [ConfigModule.forRoot(), PrismaModule, ClassificationModule, OnboardingModule],
})
export class EvalModule {}

interface Options {
  readonly reportOnly: boolean;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  return {
    reportOnly: argv.includes('--report-only'),
    quiet: argv.includes('--quiet'),
  };
}

/** `id → 'Hrana / Supermarket'`, built from the rows the seed just wrote. */
async function categoryPaths(
  prisma: PrismaService,
  householdId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await prisma.client.categories.findMany({
    where: { household_id: householdId, deleted_at: null },
    select: { id: true, name: true, parent_id: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, string>();

  const pathOf = (id: string): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const row = byId.get(id);
    if (row === undefined) return '';
    const path = row.parent_id === null ? row.name : `${pathOf(row.parent_id)} / ${row.name}`;
    paths.set(id, path);
    return path;
  };

  for (const row of rows) pathOf(row.id);
  return paths;
}

function toObserved(
  result: Awaited<ReturnType<ClassificationService['parse']>>,
  paths: ReadonlyMap<string, string>,
  latencyMs: number,
): ObservedCase {
  const pathOf = (categoryId: string | null): string | null =>
    categoryId === null ? null : (paths.get(categoryId) ?? null);

  const fragments: ObservedFragment[] = result.fragments.map((fragment) => ({
    description: fragment.description,
    categoryId: fragment.categoryId,
    categoryPath: pathOf(fragment.categoryId),
    confidence: fragment.confidence,
    decidedBy: fragment.decidedBy,
    alternatives: fragment.alternatives.map((alternative) => ({
      categoryId: alternative.categoryId,
      categoryPath: pathOf(alternative.categoryId),
      confidence: alternative.confidence,
    })),
    amountMinor: fragment.amountMinor,
    kind: fragment.kind,
    occurredOn: fragment.occurredOn,
  }));

  return { fragments, latencyMs, usedAi: result.usedAi, degraded: result.degraded };
}

function percent(value: number | null): string {
  return value === null ? '  n/a' : `${(value * 100).toFixed(2)}%`;
}

/**
 * A gate's value in its own unit. Rates are percentages, but latency is milliseconds and cost is
 * dollars — printing `1500.00%` for a p95 would be the kind of quiet nonsense this whole file exists
 * to avoid.
 */
function formatGate(gate: GateResult): string {
  if (gate.skipped !== undefined) return '—';
  if (gate.value === null) return 'n/a';
  if (gate.unit === 'count') return String(gate.value);
  if (gate.metric.includes('latency')) return `${gate.value} ms`;
  if (gate.metric.includes('Cost')) return `$${gate.value.toFixed(5)}`;
  return percent(gate.value);
}

/**
 * The battery's own section of the report.
 *
 * It prints the **declared gaps**, not just a count: docs/16 A-4 asks for a gap list that is data, and
 * an eval report is the cheapest place to keep one honest — the fixture cannot record a refusal without
 * saying what it is, and this prints what it said.
 */
function renderPlanner(outcomes: readonly PlannerOutcome[]): string {
  const answered = outcomes.filter(
    (outcome) => outcome.observedIntent !== 'NO_TEMPLATE_MATCH' && outcome.runnable,
  ).length;
  const lines: string[] = [
    `assistant battery — ${answered} of ${outcomes.length} questions are answerable`,
  ];

  const mismatches = plannerMismatches(outcomes);
  if (mismatches.length > 0) {
    lines.push('', 'MISMATCHES (each one FAILED a gate):');
    for (const mismatch of mismatches) {
      lines.push(
        `  "${mismatch.question}"`,
        `    declared ${mismatch.declaredIntent}${mismatch.declaredRunnable ? '' : ' (unanswerable)'}` +
          ` · observed ${mismatch.observedIntent}${mismatch.runnable ? '' : ' (unrunnable)'}`,
      );
    }
  }

  const gaps = plannerGaps(outcomes);
  if (gaps.length > 0) {
    lines.push('', 'DECLARED GAPS (recorded in the fixture, docs/06 §8.8):');
    for (const gap of gaps) lines.push(`  "${gap.question}" — ${gap.why ?? 'no reason recorded'}`);
  }

  return lines.join('\n');
}

function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`AI evaluation run ${report.runId} (${report.cases} cases, ${report.durationMs} ms)`);
  lines.push(
    `pinned: provider=${report.pinned.aiProvider} model=${report.pinned.aiModel} ` +
      `prompt=${report.pinned.promptVersion ?? 'none'}`,
  );
  lines.push('');
  lines.push(
    'slice           cases  frags  rule-hit   top1(>=.90)  top3     overconf  should-ask  extract  p95ms',
  );
  for (const slice of report.slices) {
    lines.push(
      [
        slice.slice.padEnd(15),
        String(slice.cases).padStart(5),
        String(slice.fragments).padStart(6),
        percent(slice.ruleHitRatio).padStart(9),
        `${percent(slice.top1Accuracy)} (${slice.top1Bucket})`.padStart(13),
        percent(slice.top3Accuracy).padStart(8),
        percent(slice.overconfidentWrong).padStart(9),
        percent(slice.shouldAskRecall).padStart(11),
        percent(slice.extractionAccuracy).padStart(8),
        String(slice.p95LatencyMs).padStart(6),
      ].join(' '),
    );
  }
  lines.push('');
  lines.push('gate                                                    value      result');
  for (const gate of report.gates) {
    const result =
      gate.passed === null ? (gate.requiresProvider === true ? 'NOT GATED' : 'SKIPPED') : gate.passed ? 'pass' : 'FAIL';
    const value = formatGate(gate);
    lines.push(`${gate.metric.padEnd(55)} ${value.padStart(9)}  ${result}`);
    if (gate.skipped !== undefined) lines.push(`    ↳ not measurable here: ${gate.skipped}`);
  }
  if (report.failing.length > 0) {
    lines.push('');
    lines.push(`worst ${report.failing.length} failing cases:`);
    for (const entry of report.failing) {
      lines.push(
        `  ${entry.failure.padEnd(17)} ${entry.id.padEnd(15)} ${JSON.stringify(entry.rawInput).slice(0, 46)}` +
          ` → ${entry.predictedPath ?? 'uncategorised'} @ ${entry.confidence} (want ${entry.expectedPath ?? 'no category'})`,
      );
    }
  }
  lines.push('');
  lines.push(report.passed ? 'RESULT: every measurable gate passed' : 'RESULT: at least one gate BREACHED');
  return lines.join('\n');
}

function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# AI evaluation report — ${report.runId}`);
  lines.push('');
  lines.push(`- commit: \`${report.commitSha}\``);
  lines.push(`- cases: **${report.cases}**, duration: ${report.durationMs} ms`);
  lines.push(
    `- pinned triple: provider \`${report.pinned.aiProvider}\`, model \`${report.pinned.aiModel}\`, ` +
      `prompt version \`${report.pinned.promptVersion ?? 'none'}\``,
  );
  lines.push('');
  lines.push('| slice | cases | fragments | rule-hit | top-1 (≥0.90 bucket) | top-3 | overconfident-wrong | should-ask recall | extraction | p95 ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const slice of report.slices) {
    lines.push(
      `| ${slice.slice} | ${slice.cases} | ${slice.fragments} | ${percent(slice.ruleHitRatio)} | ` +
        `${percent(slice.top1Accuracy)} (n=${slice.top1Bucket}) | ${percent(slice.top3Accuracy)} | ` +
        `${percent(slice.overconfidentWrong)} | ${percent(slice.shouldAskRecall)} | ` +
        `${percent(slice.extractionAccuracy)} | ${slice.p95LatencyMs} |`,
    );
  }
  lines.push('');
  lines.push('| gate | threshold | value | result | source |');
  lines.push('|---|---|---|---|---|');
  for (const gate of report.gates) {
    const result = gate.passed === null ? 'skipped' : gate.passed ? 'pass' : '**FAIL**';
    const value = gate.skipped !== undefined ? `— _(${gate.skipped})_` : formatGate(gate);
    lines.push(`| ${gate.metric} | ${gate.threshold} | ${value} | ${result} | ${gate.source} |`);
  }
  if (report.failing.length > 0) {
    lines.push('');
    lines.push('## Failing cases');
    lines.push('');
    lines.push('| case | slice | failure | input | predicted | confidence | expected |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const entry of report.failing) {
      lines.push(
        `| ${entry.id} | ${entry.slice} | ${entry.failure} | \`${entry.rawInput.replace(/\n/g, '\\n')}\` | ` +
          `${entry.predictedPath ?? '—'} | ${entry.confidence} | ${entry.expectedPath ?? '— (should ask)'} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const root = findWorkspaceRoot();
  const startedAt = new Date();

  const dataset = buildDataset(loadGoldenFixtures(root), loadCategoryExpectations(root));

  const app = await NestFactory.createApplicationContext(EvalModule, {
    logger: options.quiet ? false : ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const classification = app.get(ClassificationService);
  const onboarding = app.get(OnboardingService);

  const userId = uuidv7();
  const scores: CaseScore[] = [];
  let seedSummary = { categories: 0, keywords: 0, merchants: 0 };
  /** One synthetic Household per currency the dataset names, because the ledger currency is a
   *  Household column and the amount scale is derived from it (ADR-011). `amount-0150` asserts a JPY
   *  Household reads `2000` as 2000 minor units, which a shared RSD Household cannot express. */
  const households = new Map<string, { id: string; context: TenantContext }>();

  try {
    // The user first: `households.owner_user_id` is a foreign key, so the reverse order fails.
    await prisma.client.users.create({
      data: {
        id: userId,
        email: `evals-${startedAt.getTime()}@eval.invalid`,
        display_name: 'AI evaluation',
      },
    });

    for (const currency of [...new Set(dataset.map((testCase) => testCase.ledgerCurrency))].sort()) {
      const id = uuidv7();
      const context: TenantContext = {
        householdId: id,
        userId,
        role: 'OWNER',
        requestId: `evals-${startedAt.toISOString()}-${currency}`,
      };
      const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

      await asTenant(async () => {
        await prisma.client.households.create({
          data: {
            id,
            name: `AI evaluation (synthetic, ${currency})`,
            owner_user_id: userId,
            ledger_currency: currency,
          },
        });
      });

      // The production writers, so the harness measures the knowledge a real Household gets —
      // including the `strong`/`include` keyword weights (docs/04 §8.1.3) a fixture tree would guess.
      const seeded = await asTenant(() => onboarding.seedStarterCategories(id));
      const selection = await asTenant(() =>
        onboarding.applyMerchantSelection(id, SHIPPED_MERCHANTS.map((merchant) => merchant.name)),
      );
      seedSummary = {
        categories: seeded.categories,
        keywords: seeded.keywords,
        merchants: selection.applied + selection.alreadyOwned,
      };

      households.set(currency, { id, context });
    }

    for (const testCase of dataset) {
      const household = households.get(testCase.ledgerCurrency);
      if (household === undefined) throw new Error(`no Household for ${testCase.ledgerCurrency}`);
      const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
        runWithTenant(household.context, fn);
      const paths = await asTenant(() => categoryPaths(prisma, household.id));

      const started = performance.now();
      const result = await asTenant(() =>
        classification.parse(household.id, {
          text: testCase.rawInput,
          // The v1 fixtures own the date format and the parsing harness asserts it; this cast is
          // the boundary between a JSON string and the branded calendar date.
          localDay: testCase.today as unknown as LocalDate,
          // `true` on purpose: the pipeline must degrade through the real path (docs/04 §9), and with
          // no provider configured that path is "the model could not answer".
          allowAi: true,
        }),
      );
      const latencyMs = Math.round(performance.now() - started);
      scores.push(scoreCase(testCase, toObserved(result, paths, latencyMs)));
    }
  } finally {
    for (const { id, context } of households.values()) {
      await runWithTenant(context, async () => {
        await prisma.client.classification_decisions.deleteMany({ where: { household_id: id } });
        await prisma.client.category_keywords.deleteMany({ where: { household_id: id } });
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await app.close();
  }

  // The pinned triple docs/10 §5.4 requires. `none` is a fact about this build, not a placeholder:
  // no provider is configured, so the pipeline is deterministic and the model gates are not enforced.
  const pinned = {
    promptTemplateId: null,
    promptVersion: null,
    aiProvider: 'none',
    aiModel: 'unconfigured',
  } as const;

  // The assistant battery — docs/06 §8.11. It needs no database and no model: the planner is pure, so
  // this half of the run is deterministic and cannot fail because the seed or a provider is missing.
  const battery = loadAssistantBattery(root);
  const plannerOutcomes: readonly PlannerOutcome[] = battery.questions.map((declared) => {
    const plan = planQuestion(declared.question, battery.context);
    const declaredRunnable = declared.runnable ?? true;
    return {
      question: declared.question,
      declaredIntent: declared.intent,
      declaredRunnable,
      observedIntent: plan.intent,
      runnable: isRunnable(plan),
      ...(declared.why === undefined ? {} : { why: declared.why }),
    };
  });

  const gates = [...evaluateGates(scores, pinned.aiProvider !== 'none'), ...evaluatePlannerGates(plannerOutcomes)];
  const passed = gates.every((gate) => gate.passed !== false);
  const report: EvalReport = {
    runId: `eval-${startedAt.toISOString()}`,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    commitSha: process.env['GIT_SHA'] ?? process.env['GITHUB_SHA'] ?? 'unknown',
    pinned,
    cases: dataset.length + plannerOutcomes.length,
    slices: summarise(scores),
    gates,
    passed,
    failing: failingCases(scores, dataset),
  };

  const outputDir = join(root, 'apps/api/.evals');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify({ ...report, seedSummary }, null, 2)}\n`);
  writeFileSync(join(outputDir, 'report.md'), renderMarkdown(report));

  if (!options.quiet) {
    new Logger('evals').log(
      `seeded ${seedSummary.categories} categories, ${seedSummary.keywords} keywords, ` +
        `${seedSummary.merchants} merchants into a synthetic Household`,
    );
    // Deliberately stdout, not the Nest logger: this report is the artefact, and CI should show it.
    process.stdout.write(`\n${renderReport(report)}\n`);
    process.stdout.write(`\n${renderPlanner(plannerOutcomes)}\n`);
    process.stdout.write(`report: apps/api/.evals/report.md\n`);
  }

  return options.reportOnly || passed ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A harness that throws must not look like a passing gate.
    process.stderr.write(`evals failed to run: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
