import { describe, expect, it } from 'vitest';

/**
 * No backtick inside a `template:` or `styles:` literal — not even inside a comment in one.
 *
 * docs/15 records this as one of the gotchas that bites hardest, and it is worse than the entry suggests:
 * a single backtick in a CSS comment ends the template literal, and the compiler then reports
 * **"Failed to resolve styles at position 1 to a string"** — an error that names neither the file nor the
 * backtick. It has shipped in this repository more than once, and it happened **five times in one task**
 * (ADR-039) while a shell, seven primitives and a dashboard were written; each time the dev server
 * silently kept serving the last good bundle, so the screenshots looked like a layout regression rather
 * than a build failure.
 *
 * Angular's AOT compiler does check this — but only when a build runs, and only with that unhelpful
 * message. This is the same check, in a second, with the file and the line in the failure.
 *
 * The scan is over the **source text**, because that is what the compiler sees. It deliberately does not
 * parse TypeScript: a backtick inside an ordinary string or a nested template expression on a *code* line
 * is legal and is skipped, and only content lines inside a template/styles literal are inspected.
 */

/** Every source file under `src`, as raw text, keyed by path. Vite resolves this; no `node:fs`. */
const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** A line that is *only* the closing (or opening) backtick of a literal. */
const DELIMITER = /^\s*`\s*,?\s*$/;
const OPENS_DIRECTLY = /^\s*(template|styles):\s*`\s*$/;
const OPENS_ARRAY = /^\s*(template|styles):\s*\[\s*$/;

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Offending lines in one file. */
function offencesIn(file: string, source: string): readonly Offence[] {
  const found: Offence[] = [];
  let inLiteral = false;
  let awaitingOpeningTick = false;

  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!inLiteral) {
      if (OPENS_DIRECTLY.test(line)) inLiteral = true;
      else if (OPENS_ARRAY.test(line)) awaitingOpeningTick = true;
      else if (awaitingOpeningTick && DELIMITER.test(line)) {
        inLiteral = true;
        awaitingOpeningTick = false;
      }
      continue;
    }

    if (DELIMITER.test(line)) {
      inLiteral = false;
      continue;
    }

    if (line.includes('`')) found.push({ file, line: index + 1, text: line.trim() });
  }

  return found;
}

describe('template and style literals', () => {
  it('scans the source tree it is supposed to scan', () => {
    // A glob that silently matches nothing is a green test that checks nothing — the same failure
    // `styles.tokens.spec.ts` had when an unprocessed CSS import resolved to an empty string.
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources).some((path) => path.includes('app.component.ts'))).toBe(true);
  });

  it('never contains a backtick, which would end the literal early', () => {
    const offences = Object.entries(sources).flatMap(([file, source]) => offencesIn(file, source));

    expect(
      offences.map((offence) => `${offence.file}:${offence.line}: ${offence.text}`),
      'a backtick inside a template/styles literal — the compiler will report "Failed to resolve styles"',
    ).toEqual([]);
  });
});
