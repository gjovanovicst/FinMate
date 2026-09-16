import '@angular/compiler';
import { ɵSIGNAL, type ɵInputSignalNode } from '@angular/core';
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

/**
 * Write a value onto a component's **signal input**, bypassing Angular's input machinery.
 *
 * ## Why this is needed
 *
 * Angular's **JIT** compiler cannot discover `input()` signal inputs: only the AOT build emits the
 * `inputs` metadata with `InputFlags.SignalBased`. So in this test runner `ComponentRef.setInput` warns
 * `NG0303`, writes nothing, and the component's own template then throws `NG0950` ("Input is required but
 * no value is available yet") — a failure that names the symptom and not the cause. The component is
 * correct in the production build; this writes the value onto the input's own signal node so a mounted
 * spec can exercise the real pipeline.
 *
 * Two consequences worth knowing before reaching for it:
 *
 * - A spec that mounts a **parent** binding one of these components cannot render the child at all — the
 *   parent's binding is the thing that no-ops. Those specs drop the child from the parent's `imports` and
 *   add `CUSTOM_ELEMENTS_SCHEMA` (ten of them do), then assert the parent's own responsibilities; the
 *   child's rendering is asserted by mounting the child directly and using this helper.
 * - It is **test-only shim code**. Never call it from application code, and prefer a real input binding
 *   wherever the harness allows one.
 */
export function setSignalInput<T>(component: object, name: string, value: T): void {
  const field = Reflect.get(component, name) as unknown;
  if (typeof field !== 'function') throw new Error(`"${name}" is not a signal input.`);
  const node = Reflect.get(field, ɵSIGNAL) as ɵInputSignalNode<T, T> | undefined;
  if (node === undefined) throw new Error(`"${name}" has no signal node.`);
  node.applyValueToInputSignal(node, value);
}
