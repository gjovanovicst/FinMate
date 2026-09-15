import '@angular/compiler';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

/**
 * Boot Angular's JIT compiler for a **mounted** component test.
 *
 * A spec that renders a component needs three things that a pure-logic spec does not:
 *
 * 1. `@angular/compiler`, because the tests are JIT — the production build AOT-compiles, and
 *    without the compiler loaded a decorator is just an annotation nobody reads;
 * 2. an initialised test environment, or `TestBed.configureTestingModule` fails deep inside
 *    Angular with `Cannot read properties of null (reading 'ngModule')`, which names neither the
 *    missing call nor the spec;
 * 3. a DOM, hence `// @vitest-environment jsdom` at the top of the spec file. The rest of the web
 *    suite stays on `node`, so this stays opt-in.
 *
 * Call it at module scope in the spec, once per file. Idempotent, because `initTestEnvironment`
 * throws if it is called twice in one process.
 */
let initialised = false;

export function initAngularTesting(): void {
  if (initialised) return;
  initialised = true;
  getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
}
