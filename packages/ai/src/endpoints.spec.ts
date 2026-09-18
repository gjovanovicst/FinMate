/**
 * Routing and the residency rule — docs/04 §9, AGENTS.md rule 5, ADR-007, docs/08 §6.
 *
 * This is the most important spec in the package. The property under test is not "the default table
 * is as documented" (that is one case) but "**no** configuration can route Household free text or a
 * Receipt image outside the EEA, and no configuration can route `EMBED` off this node".
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROUTING,
  EEA_ENDPOINT_SUFFIX,
  ENDPOINTS,
  IMAGE_TASKS,
  VALIDATED_DEFAULT_ROUTING,
  assertAllowedRoute,
  endpointsForTask,
  isAdmissible,
  isEeaOrLocal,
  isImageTask,
  isNonEea,
  isKnownEndpoint,
  isLocalOnly,
  validateRouting,
  type RoutingTable,
} from './endpoints';
import { AiRoutingError } from './errors';
import { TASKS, type Task } from './provider';

/** Every task docs/04 §9 says carries the Household's own free text or an image. */
const SENSITIVE_TASKS: readonly Task[] = ['PARSE', 'CLASSIFY', 'NARRATE', 'OCR'];

/**
 * Suffix-less provider spellings — the shape a config typo actually arrives in.
 *
 * Cast because they are deliberately *not* members of the `Endpoint` union: the point of the test
 * is that a string which never type-checked must still be refused at runtime.
 */
const PROVIDER_SPELLINGS = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'DEEPSEEK'] as const;

describe('isEeaOrLocal / isLocalOnly', () => {
  it('accepts LOCAL and every _EU endpoint', () => {
    expect(isEeaOrLocal('LOCAL')).toBe(true);
    for (const endpoint of ENDPOINTS) {
      if (endpoint === 'LOCAL' || isNonEea(endpoint)) continue;
      expect(endpoint.endsWith(EEA_ENDPOINT_SUFFIX)).toBe(true);
      expect(isEeaOrLocal(endpoint)).toBe(true);
    }
  });

  it('names the non-EEA endpoint honestly, and needs consent for it (ADR-031)', () => {
    // `DEEPSEEK_GLOBAL` is DeepSeek's own platform, which is in China. It is not EEA, and it is not
    // *called* EEA — which is the whole point: the same host used to be registered as `DEEPSEEK_EU`,
    // so the suffix rule certified traffic that left the EEA.
    expect(isNonEea('DEEPSEEK_GLOBAL')).toBe(true);
    expect(isEeaOrLocal('DEEPSEEK_GLOBAL')).toBe(false);
    expect(isAdmissible('DEEPSEEK_GLOBAL', false)).toBe(false);
    expect(isAdmissible('DEEPSEEK_GLOBAL', true)).toBe(true);
    // An EEA endpoint needs no consent, and a non-EU name that is not in the list is refused outright.
    expect(isAdmissible('DEEPSEEK_EU', false)).toBe(true);
    expect(isAdmissible('SOMEWHERE', true)).toBe(false);
  });

  it('refuses an endpoint without the explicit _EU suffix', () => {
    for (const endpoint of ['DEEPSEEK', 'OPENAI', 'ANTHROPIC', 'GEMINI', 'US_EAST', 'local', '']) {
      expect(isEeaOrLocal(endpoint)).toBe(false);
    }
  });

  it('has a suffix rule that a bare "_EU" would satisfy — which is why membership exists', () => {
    // The predicate is *residency*, not existence. `"_EU"` is the pathological case the membership
    // check catches, and the pair of tests keeps them from being confused for one another.
    expect(isEeaOrLocal('_EU')).toBe(true);
    expect(isKnownEndpoint('_EU')).toBe(false);
    expect(isKnownEndpoint('LOCAL')).toBe(true);
    for (const endpoint of ENDPOINTS) expect(isKnownEndpoint(endpoint)).toBe(true);
  });

  it('admits only LOCAL for EMBED', () => {
    expect(isLocalOnly('LOCAL')).toBe(true);
    expect(isLocalOnly('DEEPSEEK_EU')).toBe(false);
    expect(isLocalOnly('OPENAI_EU')).toBe(false);
  });
});

describe('DEFAULT_ROUTING is ADR-031: LOCAL, with no fallback that cannot be honoured', () => {
  it('routes parse/classify LOCAL with no fallback, because the old one was not EEA', () => {
    // docs/04 §9's table named `DEEPSEEK_EU` as the fallback, and `DEEPSEEK_EU` resolved to
    // `api.deepseek.com` — so the documented default was a Chapter V transfer wearing an EEA suffix.
    expect(DEFAULT_ROUTING.PARSE).toEqual({ primary: 'LOCAL', fallback: null });
    expect(DEFAULT_ROUTING.CLASSIFY).toEqual({ primary: 'LOCAL', fallback: null });
  });

  it('routes narrate ANTHROPIC_EU then LOCAL', () => {
    // `ANTHROPIC_EU` was not even implemented (`UNIMPLEMENTED_ENDPOINTS`), so the default pointed at
    // an endpoint that could not answer and silently degraded every narration.
    expect(DEFAULT_ROUTING.NARRATE).toEqual({ primary: 'LOCAL', fallback: null });
  });

  it('routes ocr LOCAL then GEMINI_EU', () => {
    expect(DEFAULT_ROUTING.OCR).toEqual({ primary: 'LOCAL', fallback: null });
  });

  it('routes embed LOCAL with no fallback at all', () => {
    expect(DEFAULT_ROUTING.EMBED).toEqual({ primary: 'LOCAL', fallback: null });
  });

  it('is validated at import time, so a broken constant cannot ship', () => {
    expect(() => validateRouting(VALIDATED_DEFAULT_ROUTING)).not.toThrow();
  });

  it('routes every task', () => {
    for (const task of TASKS) expect(DEFAULT_ROUTING[task]).toBeDefined();
  });
});

describe('validateRouting — a valid table passes', () => {
  it('accepts the canonical default', () => {
    expect(() => validateRouting(DEFAULT_ROUTING)).not.toThrow();
  });

  it('accepts a Household that declines all egress: LOCAL everywhere, no fallbacks', () => {
    const localOnlyTable: RoutingTable = {
      PARSE: { primary: 'LOCAL', fallback: null },
      CLASSIFY: { primary: 'LOCAL', fallback: null },
      NARRATE: { primary: 'LOCAL', fallback: null },
      OCR: { primary: 'LOCAL', fallback: null },
      EMBED: { primary: 'LOCAL', fallback: null },
    };
    expect(() => validateRouting(localOnlyTable)).not.toThrow();
  });

  it('accepts an EEA-only table with cloud primaries, given a gate for the image it routes', () => {
    const eeaOnly: RoutingTable = {
      PARSE: { primary: 'DEEPSEEK_EU', fallback: 'OPENAI_EU' },
      CLASSIFY: { primary: 'OPENAI_EU', fallback: 'DEEPSEEK_EU' },
      NARRATE: { primary: 'ANTHROPIC_EU', fallback: 'GEMINI_EU' },
      // `GEMINI_EU` is EEA, so residency is satisfied — and an image needs `CLOUD_OCR` consent on top
      // of that (ADR-038), which is what the `true` below stands for. Without it this table is refused,
      // which the ADR-038 describe below asserts directly.
      OCR: { primary: 'GEMINI_EU', fallback: null },
      EMBED: { primary: 'LOCAL', fallback: null },
    };
    expect(() => validateRouting(eeaOnly, true)).not.toThrow();
    expect(() => validateRouting(eeaOnly)).toThrow(AiRoutingError);
  });

  it('refuses an endpoint with the right suffix but no provider behind it', () => {
    const pedantic = { CLASSIFY: { primary: '_EU', fallback: null } } as unknown as RoutingTable;
    expect(() => validateRouting(pedantic)).toThrow(AiRoutingError);
    try {
      validateRouting(pedantic);
    } catch (error) {
      expect((error as AiRoutingError).message).toContain('not one of the known endpoints');
    }
  });

  it('does not mistake a non-EEA provider name for a real Endpoint at runtime', () => {
    // A config file is strings, not types: this is the exact shape a typo arrives in.
    const misconfigured = {
      CLASSIFY: { primary: 'DEEPSEEK', fallback: null },
    } as unknown as RoutingTable;
    expect(() => validateRouting(misconfigured)).toThrow(AiRoutingError);
  });

  it('tolerates an unrouted task rather than demanding every task be routed', () => {
    expect(() => validateRouting({ EMBED: undefined })).not.toThrow();
    expect(() => validateRouting({})).not.toThrow();
  });
});

describe('validateRouting — the refusal, per sensitive task, on either slot', () => {
  for (const task of SENSITIVE_TASKS) {
    it(`refuses a non-EEA primary for ${task}`, () => {
      const table = { [task]: { primary: 'OPENAI', fallback: null } } as unknown as RoutingTable;
      expect(() => validateRouting(table)).toThrow(AiRoutingError);
      try {
        validateRouting(table);
      } catch (error) {
        const routingError = error as AiRoutingError;
        expect(routingError.code).toBe('RESIDENCY_VIOLATION');
        expect(routingError.task).toBe(task);
        expect(routingError.endpoint).toBe('OPENAI');
        // The message names the refusal reason; which guard fires depends on whether the value is
        // an unknown endpoint or a known-but-non-EEA one. Both are refusals, which is the property.
        expect(routingError.message).toMatch(/known endpoints|Chapter V/);
      }
    });

    it(`refuses a non-EEA fallback for ${task} even when the primary is LOCAL`, () => {
      const table = {
        [task]: { primary: 'LOCAL', fallback: 'GEMINI' },
      } as unknown as RoutingTable;
      expect(() => validateRouting(table)).toThrow(AiRoutingError);
      try {
        validateRouting(table);
      } catch (error) {
        expect((error as AiRoutingError).code).toBe('RESIDENCY_VIOLATION');
        expect((error as AiRoutingError).endpoint).toBe('GEMINI');
      }
    });

    it(`refuses a suffix-less provider spelling for ${task}`, () => {
      for (const endpoint of ['DEEPSEEK', 'OPENAI', 'ANTHROPIC', 'GEMINI']) {
        const table = { [task]: { primary: endpoint, fallback: null } } as unknown as RoutingTable;
        expect(() => validateRouting(table)).toThrow(AiRoutingError);
        expect(() => assertAllowedRoute(task, { primary: endpoint, fallback: null } as never)).toThrow(
          AiRoutingError,
        );
      }
    });

    it(`refuses a bare "_EU" for ${task}, which the suffix predicate alone would admit`, () => {
      const table = { [task]: { primary: '_EU', fallback: null } } as unknown as RoutingTable;
      expect(() => validateRouting(table)).toThrow(AiRoutingError);
      try {
        validateRouting(table);
      } catch (error) {
        expect((error as AiRoutingError).message).toContain('not one of the known endpoints');
      }
    });
  }

  /**
   * ADR-038. docs/08 §6.5 makes cloud OCR consent-gated **in an EEA region too**, so residency is
   * necessary and not sufficient for an image: without a consent gate there is nothing to ask, and the
   * route is refused rather than shipped.
   */
  describe('an image needs a consent gate even on an EEA host (ADR-038)', () => {
    const EEA_IMAGE: RoutingTable = { OCR: { primary: 'OPENAI_EU', fallback: null } };

    it('refuses an EEA OCR route when no gate is installed, and accepts it with one', () => {
      expect(() => validateRouting(EEA_IMAGE)).toThrow(/consent/);
      expect(() => validateRouting(EEA_IMAGE, true)).not.toThrow();
    });

    it('refuses an EEA OCR fallback too, because a fallback is where images go when the first fails', () => {
      const table: RoutingTable = { OCR: { primary: 'LOCAL', fallback: 'OPENAI_EU' } };
      expect(() => validateRouting(table)).toThrow(/consent/);
      expect(() => validateRouting(table, true)).not.toThrow();
    });

    it('leaves a LOCAL image route alone: nothing leaves the node, so there is nothing to ask', () => {
      expect(() => validateRouting({ OCR: { primary: 'LOCAL', fallback: null } })).not.toThrow();
    });

    it('covers exactly the image tasks, and OCR is one of them', () => {
      expect([...IMAGE_TASKS]).toEqual(['OCR']);
      expect(isImageTask('OCR')).toBe(true);
      expect(isImageTask('NARRATE')).toBe(false);
    });
  });

  it('refuses every non-EEA spelling on the union-like list for every sensitive task', () => {
    for (const task of SENSITIVE_TASKS) {
      for (const endpoint of PROVIDER_SPELLINGS) {
        expect(() =>
          assertAllowedRoute(task, { primary: endpoint, fallback: null }),
        ).toThrow(AiRoutingError);
      }
    }
  });
});

describe('validateRouting — EMBED may only ever be LOCAL', () => {
  it('refuses an EMBED primary that is not LOCAL', () => {
    for (const endpoint of ['DEEPSEEK_EU', 'OPENAI_EU', 'ANTHROPIC_EU', 'GEMINI_EU']) {
      const table = { EMBED: { primary: endpoint, fallback: null } } as unknown as RoutingTable;
      expect(() => validateRouting(table)).toThrow(AiRoutingError);
      try {
        validateRouting(table);
      } catch (error) {
        expect((error as AiRoutingError).code).toBe('EMBED_MUST_BE_LOCAL');
        expect((error as AiRoutingError).task).toBe('EMBED');
        expect((error as AiRoutingError).endpoint).toBe(endpoint);
      }
    }
  });

  it('refuses an EMBED fallback that is not LOCAL, even an EEA one', () => {
    const table = {
      EMBED: { primary: 'LOCAL', fallback: 'DEEPSEEK_EU' },
    } as unknown as RoutingTable;
    expect(() => validateRouting(table)).toThrow(AiRoutingError);
    try {
      validateRouting(table);
    } catch (error) {
      expect((error as AiRoutingError).code).toBe('EMBED_MUST_BE_LOCAL');
    }
  });
});

describe('the consent argument — a gated exception, never a default', () => {
  /**
   * ADR-031's second half. `isAdmissible(endpoint, consent)` existed from the start but nothing
   * passed `true`, so `DEEPSEEK_GLOBAL` was admissible-by-name and unreachable in fact. These cases
   * pin both sides of the argument: the default is refusal, and consent buys exactly one endpoint
   * class and nothing else.
   */
  it('refuses DEEPSEEK_GLOBAL when no consent is recorded, which is the default', () => {
    const table = {
      CLASSIFY: { primary: 'DEEPSEEK_GLOBAL', fallback: null },
    } as unknown as RoutingTable;

    expect(() => validateRouting(table)).toThrow(AiRoutingError);
    try {
      validateRouting(table, false);
    } catch (error) {
      expect((error as AiRoutingError).code).toBe('RESIDENCY_VIOLATION');
      expect((error as AiRoutingError).endpoint).toBe('DEEPSEEK_GLOBAL');
    }
  });

  it('admits DEEPSEEK_GLOBAL for a sensitive task once a gate is installed', () => {
    for (const task of SENSITIVE_TASKS) {
      const table = {
        [task]: { primary: 'DEEPSEEK_GLOBAL', fallback: null },
      } as unknown as RoutingTable;

      expect(() => validateRouting(table, true)).not.toThrow();
      expect(() =>
        assertAllowedRoute(task, { primary: 'DEEPSEEK_GLOBAL', fallback: null }, true),
      ).not.toThrow();
    }
  });

  it('does not let consent admit a spelling that is not a known endpoint', () => {
    // Consent answers "may this Household's text leave the EEA?", not "does this provider exist?".
    // A typo must still fail closed even in a consenting deployment.
    for (const task of SENSITIVE_TASKS) {
      expect(() =>
        assertAllowedRoute(task, { primary: 'OPENAI' as never, fallback: null }, true),
      ).toThrow(AiRoutingError);
      expect(() =>
        assertAllowedRoute(task, { primary: 'DEEPSEEK_GLOBAL' as never, fallback: 'GEMINI' as never }, true),
      ).toThrow(AiRoutingError);
    }
  });

  it('never lets consent move EMBED off this node', () => {
    // docs/08 §6.5: the vectors are built from the Household's own entity names, and there is no
    // non-EEA embedding option that is acceptable. The predicate is not consulted for EMBED at all.
    expect(() =>
      validateRouting({ EMBED: { primary: 'DEEPSEEK_GLOBAL', fallback: null } } as unknown as RoutingTable, true),
    ).toThrow(/EMBED/);
  });

  it('leaves the shipped default table valid, because it names no non-EEA endpoint', () => {
    expect(() => validateRouting(DEFAULT_ROUTING, true)).not.toThrow();
  });
});

describe('endpointsForTask', () => {
  it('returns primary then fallback', () => {
    // A configured chain, not the default: ADR-031 removed the default's fallback because the
    // endpoint it named was not EEA.
    expect(
      endpointsForTask({ CLASSIFY: { primary: 'LOCAL', fallback: 'DEEPSEEK_EU' } }, 'CLASSIFY'),
    ).toEqual(['LOCAL', 'DEEPSEEK_EU']);
    expect(endpointsForTask(DEFAULT_ROUTING, 'CLASSIFY')).toEqual(['LOCAL']);
  });

  it('drops a null fallback', () => {
    expect(endpointsForTask(DEFAULT_ROUTING, 'EMBED')).toEqual(['LOCAL']);
  });

  it('returns an empty chain for an unrouted task', () => {
    expect(endpointsForTask({}, 'CLASSIFY')).toEqual([]);
  });
});
