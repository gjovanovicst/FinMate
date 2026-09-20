#!/usr/bin/env node
/**
 * The bundle budget gate — docs/07 §11.
 *
 * Reads the production build the application builder just wrote (`apps/web/dist/stats.json` plus the
 * emitted chunks) and compares each route's **cold cost** against the documented ceiling: the eager
 * shell, plus every chunk the route pulls in that the shell did not already deliver. That is the number
 * the budget table is about — a route's own chunk is only 2–16 KB here, so a per-chunk reading of a
 * 180–300 KB ceiling would be a gate that can never fire.
 *
 * Three things this gets right that a naive reading misses, each learned by measuring:
 *
 *  1. **`ng build` defaults to the `development` configuration** (`defaultConfiguration` in
 *     `angular.json`). A budget measured without `--configuration production` reports numbers several
 *     times too large. This script refuses an unoptimised `stats.json` rather than reporting a
 *     fictional overrun.
 *  2. **A chunk's `imports` mix static and dynamic edges.** The entry chunk lists *every* lazy route as
 *     a `dynamic-import`, so following all edges puts the whole application inside "the shell" and makes
 *     every route's marginal cost zero. Only `import-statement` edges are followed; a dynamic one is
 *     fetched when its route is visited, which is exactly the cost being budgeted.
 *  3. **A route's chunk is an entry point, and a component is not a route.** `transaction-detail` and
 *     `receipt-attachment` are sheets inside the transactions route, not routes; completeness is checked
 *     against `app.routes.ts`'s lazy imports, not against "any file called *.component.ts".
 *
 * Usage: `nx run web:build && node apps/web/tools/bundle-budget.mjs`, or `pnpm bundle:budget`.
 *
 * @module apps/web/tools/bundle-budget
 */

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const DIST = join(WEB, 'dist');
const ROUTES_SOURCE = join(WEB, 'src', 'app', 'app.routes.ts');

/** The documented ceilings, in KB gzipped — docs/07 §11's table verbatim. `null` = the eager shell. */
export const DOCUMENTED = [
  // 150 → 156 in ADR-039: the registry was missing glyphs the templates already rendered (chevronDown,
  // chevronRight) and had lost three others to a bad regex (calendar, globe, logout), so restoring them is
  // a fix rather than growth; the rest is the shared field primitive, the danger button, the native-control
  // accent and the extracted brand component. docs/07 §11 states the reason and the option not taken.
  { label: 'App shell + boot', match: null, budget: 156 },
  { label: 'Capture', match: 'features/capture/capture.component.ts', budget: 180 },
  { label: 'Dashboard', match: 'features/dashboard/dashboard.component.ts', budget: 220 },
  { label: 'Transaction list', match: 'features/transactions/transactions.component.ts', budget: 260 },
  { label: 'Review queue', match: 'features/review/review.component.ts', budget: 220 },
  { label: 'Receipts', match: 'features/receipts/receipts-list.component.ts', budget: 240 },
  { label: 'Analytics', match: 'features/analytics/analytics.component.ts', budget: 300 },
  { label: 'Assistant', match: 'features/assistant/assistant.component.ts', budget: 280 },
];

/**
 * Every other lazy route this app has, each held to the one documented ceiling that is not per-route:
 * *"Total initial JS, cold visit to capture ≤ 320 KB"*.
 *
 * They are listed explicitly rather than given invented numbers, because docs/07 §11 names eight routes
 * and the router has twenty-four. A route **absent** from both lists fails the gate — that is §11's rule
 * 7 ("a new route without a budget entry fails the build") with a default it can actually use. Closing
 * the gap properly means naming a ceiling per route in docs/07, which is a performance decision and not
 * a tooling one.
 */
export const UNLISTED = [
  'features/accounts/accounts.component.ts',
  'features/auth/reset-password.component.ts',
  'features/auth/sign-in.component.ts',
  'features/auth/sign-up.component.ts',
  'features/auth/verify-email.component.ts',
  'features/budgets/budgets.component.ts',
  'features/categories/categories.component.ts',
  'features/counterparties/counterparties.component.ts',
  'features/goals/goals.component.ts',
  'features/merchants/merchants.component.ts',
  'features/not-found/not-found.component.ts',
  'features/notifications/notifications.component.ts',
  'features/onboarding/onboarding.component.ts',
  'features/pending/pending.component.ts',
  'features/profile/profile.component.ts',
  'features/receipts/receipt-detail.component.ts',
  'features/recurring/recurring.component.ts',
  'features/rules/rules.component.ts',
  'features/settings/settings.component.ts',
  'features/tags/tags.component.ts',
];

/** The documented total, and the only ceiling an unlisted route can be held to. */
export const TOTAL_COLD_BUDGET = 320;
/** `packages/nlp` ships on the pre-network path: docs/07 §11's own isolated ceiling. */
export const NLP_BUDGET = 40;

/** The chunks the browser fetches before the application can render: the entry and its modulepreloads. */
export function parseInitial(html) {
  const scripts = [...html.matchAll(/<script[^>]+src="\/?([^"]+)"/g)].map((match) => match[1]);
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)].map(
    (match) => match[1],
  );
  return [...new Set([...scripts, ...preloads])];
}

/** The route components the router lazily loads — the list completeness is checked against. */
export function routeComponents(source) {
  const found = new Set();
  // The import specifier has no extension (`import('./features/tags/tags.component')`); the budget
  // tables are keyed the way the build reports its inputs, which is with `.ts`.
  for (const match of source.matchAll(/import\('\.\/([^']+\.component)(?:\.ts)?'\)/g)) {
    found.add(`${match[1]}.ts`);
  }
  return [...found];
}

/**
 * The chunks reachable from `entry` over **static** imports only.
 *
 * A `dynamic-import` edge is the lazy route itself: it is fetched when that route is visited, so it
 * belongs to the route's cost and not to the shell's.
 */
export function staticClosure(entry, outputs, seen = new Set()) {
  if (seen.has(entry) || outputs[entry] === undefined) return seen;
  seen.add(entry);
  for (const edge of outputs[entry].imports ?? []) {
    if (edge.kind !== 'import-statement') continue;
    if (typeof edge.path === 'string' && edge.path.endsWith('.js')) staticClosure(edge.path, outputs, seen);
  }
  return seen;
}

/** The output chunks whose inputs include a source path. */
export function chunksFor(needle, outputs) {
  return Object.entries(outputs)
    .filter(
      ([name, value]) =>
        name.endsWith('.js') && !name.endsWith('.map') && inputPaths(value).some((path) => path.includes(needle)),
    )
    .map(([name]) => name);
}

function inputPaths(output) {
  const inputs = output?.inputs;
  if (Array.isArray(inputs)) return inputs.map(String);
  if (inputs !== null && typeof inputs === 'object') return Object.keys(inputs);
  return [];
}

/** The size of a route or the shell, in KB gzipped, given the sizes already measured. */
export function coldCost(chunks, initial, outputs, gz) {
  const delivered = staticClosureOfAll(initial, outputs);
  const reachable = staticClosureOfAll(chunks, outputs);
  let total = 0;
  for (const name of reachable) {
    if (delivered.has(name)) continue;
    total += gz.get(name) ?? 0;
  }
  return total;
}

function staticClosureOfAll(entries, outputs) {
  const all = new Set();
  for (const entry of entries) staticClosure(entry, outputs, all);
  return all;
}

/** `ok` · `warn` at 90 % · `fail` at 100 % — docs/07 §11's thresholds. */
export function statusOf(ratio) {
  if (ratio >= 1) return 'FAIL';
  if (ratio >= 0.9) return 'warn';
  return 'ok';
}

/**
 * Evaluate every documented route, every unlisted one, and whether each route has an entry at all.
 *
 * Pure: it takes `outputs` (the stats map), `initial` (the chunk names in `index.html`), `gz`
 * (`Map<chunk, bytes>`) and `routes` (the router's lazy components), so the self-check can exercise
 * every branch — including the ones that fail — without building anything.
 */
export function evaluate({ outputs, initial, gz, routes }) {
  const rows = [];
  const problems = [];

  const shell = coldCost(initial, [], outputs, gz);
  const shellBudget = DOCUMENTED.find((entry) => entry.match === null)?.budget ?? 150;
  rows.push({ label: 'App shell + boot', measured: shell, budget: shellBudget });

  let capture = null;
  for (const entry of DOCUMENTED) {
    if (entry.match === null) continue;
    if (!routes.includes(entry.match)) {
      problems.push(`${entry.match} is budgeted but the router no longer loads it — remove the row or fix the path`);
      continue;
    }
    const chunks = chunksFor(entry.match, outputs);
    if (chunks.length === 0) {
      problems.push(`no chunk carries ${entry.match}: the route stopped being lazy, or the build is stale`);
      continue;
    }
    const measured = shell + coldCost(chunks, initial, outputs, gz);
    if (entry.label === 'Capture') capture = measured;
    rows.push({ label: entry.label, measured, budget: entry.budget });
  }

  if (capture !== null) {
    rows.push({ label: 'Total initial JS, cold visit to capture', measured: capture, budget: TOTAL_COLD_BUDGET });
  }

  // Completeness (docs/07 §11 rule 7): every route the router loads must have an entry.
  const documented = new Set(DOCUMENTED.map((entry) => entry.match).filter(Boolean));
  for (const route of routes) {
    if (documented.has(route) || UNLISTED.includes(route)) continue;
    problems.push(
      `no budget entry for ${route} — add it to docs/07 §11 with a ceiling, or to UNLISTED in this tool`,
    );
  }
  for (const stale of UNLISTED.filter((route) => !routes.includes(route))) {
    problems.push(`UNLISTED names ${stale}, which the router no longer loads — remove it`);
  }

  for (const match of UNLISTED) {
    const chunks = chunksFor(match, outputs);
    if (chunks.length === 0 || !routes.includes(match)) continue;
    const measured = shell + coldCost(chunks, initial, outputs, gz);
    rows.push({
      label: `(unlisted) ${match.replace('features/', '').replace('.component.ts', '')}`,
      measured,
      budget: TOTAL_COLD_BUDGET,
    });
  }

  const nlp = chunksFor('packages/nlp', outputs).reduce((sum, name) => sum + (gz.get(name) ?? 0), 0);
  rows.push({ label: 'packages/nlp (isolated)', measured: nlp, budget: NLP_BUDGET });

  return { rows, problems };
}

/**
 * The pure logic, checked against hand-made fixtures — run on every invocation, including CI's.
 *
 * A vitest spec would be its usual home, and it is deliberately not one: the web tsconfig sets
 * `types: []` (a browser program has no `node:fs`) and includes only `src`/`test`, so a spec for this
 * file would drag Node types into the *application* build's type-check. These are the same assertions a
 * spec would make, they cost nothing, and they run wherever the gate runs — so a broken tool fails the
 * gate instead of quietly passing it.
 */
export function selfCheck() {
  const outputs = {
    'main.js': {
      entryPoint: 'src/main.ts',
      inputs: ['src/main.ts'],
      imports: [
        { path: 'vendor.js', kind: 'import-statement' },
        { path: 'capture.js', kind: 'dynamic-import' },
      ],
    },
    'vendor.js': { inputs: ['node_modules/rxjs/index.mjs'], imports: [] },
    'capture.js': {
      entryPoint: 'src/app/features/capture/capture.component.ts',
      inputs: ['src/app/features/capture/capture.component.ts'],
      imports: [
        { path: 'vendor.js', kind: 'import-statement' },
        { path: 'capture.view.js', kind: 'import-statement' },
      ],
    },
    'capture.view.js': { inputs: ['src/app/features/capture/capture.view.ts'], imports: [] },
  };
  const gz = new Map([
    ['main.js', 1000],
    ['vendor.js', 2000],
    ['capture.js', 500],
    ['capture.view.js', 250],
  ]);
  const routes = [
    'features/capture/capture.component.ts',
    'features/dashboard/dashboard.component.ts',
    'features/brand-new/brand-new.component.ts',
  ];
  const check = (condition, message) => {
    if (!condition) throw new Error(`bundle-budget self-check failed: ${message}`);
  };

  check(
    JSON.stringify(parseInitial('<script src="main.js"></script><link rel="modulepreload" href="vendor.js"/>')) ===
      JSON.stringify(['main.js', 'vendor.js']),
    'parseInitial reads the entry and its modulepreloads',
  );
  check(
    JSON.stringify(
      routeComponents("loadComponent: () => import('./features/tags/tags.component').then(m => m.TagsComponent)"),
    ) === JSON.stringify(['features/tags/tags.component.ts']),
    'routeComponents reads a lazy import',
  );
  check(
    JSON.stringify([...staticClosure('capture.js', outputs)].sort()) ===
      JSON.stringify(['capture.js', 'capture.view.js', 'vendor.js']),
    'staticClosure follows import-statement edges only, never a dynamic route',
  );
  check(coldCost(['capture.js'], ['main.js'], outputs, gz) === 750, 'coldCost subtracts what the shell delivers');
  check(statusOf(0.89) === 'ok' && statusOf(0.9) === 'warn' && statusOf(0.999) === 'warn', 'the warning band is 90 %');
  check(statusOf(1) === 'FAIL' && statusOf(1.4) === 'FAIL', 'the failure threshold is 100 %');

  const { rows, problems } = evaluate({ outputs, initial: ['main.js'], gz, routes });
  check(
    rows.some((row) => row.label === 'App shell + boot' && row.measured === 3000),
    'the shell row sums the entry and its static closure',
  );
  check(
    problems.some((problem) => problem.includes('brand-new.component.ts')),
    'a route with no budget entry is a problem, which is docs/07 §11 rule 7',
  );
  check(
    problems.some((problem) => problem.includes('features/dashboard/dashboard.component.ts')),
    'a documented route the build does not emit is a problem too',
  );
  check(
    !problems.some((problem) => problem.includes('capture.view')),
    'a view file inside a route is not a route of its own',
  );
  return true;
}

function main() {
  try {
    selfCheck();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }

  let stats;
  try {
    stats = JSON.parse(readFileSync(join(DIST, 'stats.json'), 'utf8'));
  } catch {
    console.error(`No ${join(DIST, 'stats.json')}: run \`nx run web:build\` first (docs/07 §11).`);
    process.exit(2);
  }

  const outputs = stats.outputs ?? {};
  const html = readFileSync(join(DIST, 'browser', 'index.html'), 'utf8');
  const initial = parseInitial(html);
  const routes = routeComponents(readFileSync(ROUTES_SOURCE, 'utf8'));

  // A `development` build is unminified and emits source maps, so every number would be several times
  // too large — and the report would say "your bundle is 255 % over budget" instead of naming the real
  // problem. Refusing it is the difference between a gate and a false alarm.
  const sourceMaps = Object.keys(outputs).some((name) => name.endsWith('.map'));
  const shellNames = staticClosureOfAll(initial, outputs);
  const biggest = Math.max(...[...shellNames].map((name) => statSync(join(DIST, 'browser', name)).size));
  if (sourceMaps || biggest > 500_000) {
    console.error(
      `The build in ${DIST} looks unoptimised (` +
        `${sourceMaps ? 'it emits source maps' : `a ${(biggest / 1024).toFixed(0)} KB shell chunk`}). ` +
        `ng build defaults to the \`development\` configuration — build with --configuration production.`,
    );
    process.exit(2);
  }

  const gz = new Map();
  for (const name of Object.keys(outputs)) {
    if (!name.endsWith('.js') || name.endsWith('.map')) continue;
    try {
      gz.set(name, gzipSync(readFileSync(join(DIST, 'browser', name))).length);
    } catch {
      gz.set(name, null);
    }
  }

  const { rows, problems } = evaluate({ outputs, initial, gz, routes });

  console.log('bundle budgets — docs/07 §11 (gzipped, production build)\n');
  let worst = 'ok';
  for (const row of rows) {
    const ratio = row.measured / 1024 / row.budget;
    const status = statusOf(ratio);
    if (status === 'FAIL') worst = 'FAIL';
    else if (status === 'warn' && worst !== 'FAIL') worst = 'warn';
    console.log(
      `${status.padEnd(5)} ${row.label.padEnd(44)} ${(row.measured / 1024).toFixed(1).padStart(7)} KB / ${String(row.budget).padStart(3)} KB  ${(ratio * 100).toFixed(0).padStart(3)} %`,
    );
  }

  for (const problem of problems) console.log(`\nFAIL  ${problem}`);

  if (problems.length > 0 || worst === 'FAIL') {
    console.error(
      `\nbundle budgets: FAILED${problems.length > 0 ? ` (${problems.length} budget-entry problem(s))` : ''}`,
    );
    process.exit(1);
  }
  console.log(`\nbundle budgets: ok (worst ${worst})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
