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
  VALIDATED_DEFAULT_ROUTING,
  assertAllowedRoute,
  endpointsForTask,
  isEeaOrLocal,
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
const NON_EEA_ENDPOINTS = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'DEEPSEEK'] as const;

describe('isEeaOrLocal / isLocalOnly', () => {
  it('accepts LOCAL and every _EU endpoint', () => {
    expect(isEeaOrLocal('LOCAL')).toBe(true);
    for (const endpoint of ENDPOINTS) {
      if (endpoint === 'LOCAL') continue;
      expect(endpoint.endsWith(EEA_ENDPOINT_SUFFIX)).toBe(true);
      expect(isEeaOrLocal(endpoint)).toBe(true);
    }
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

describe('DEFAULT_ROUTING is docs/04 §9 verbatim', () => {
  it('routes parse/classify LOCAL then DEEPSEEK_EU', () => {
    expect(DEFAULT_ROUTING.PARSE).toEqual({ primary: 'LOCAL', fallback: 'DEEPSEEK_EU' });
    expect(DEFAULT_ROUTING.CLASSIFY).toEqual({ primary: 'LOCAL', fallback: 'DEEPSEEK_EU' });
  });

  it('routes narrate ANTHROPIC_EU then LOCAL', () => {
    expect(DEFAULT_ROUTING.NARRATE).toEqual({ primary: 'ANTHROPIC_EU', fallback: 'LOCAL' });
  });

  it('routes ocr LOCAL then GEMINI_EU', () => {
    expect(DEFAULT_ROUTING.OCR).toEqual({ primary: 'LOCAL', fallback: 'GEMINI_EU' });
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

  it('accepts an EEA-only table with cloud primaries', () => {
    const eeaOnly: RoutingTable = {
      PARSE: { primary: 'DEEPSEEK_EU', fallback: 'OPENAI_EU' },
      CLASSIFY: { primary: 'OPENAI_EU', fallback: 'DEEPSEEK_EU' },
      NARRATE: { primary: 'ANTHROPIC_EU', fallback: 'GEMINI_EU' },
      OCR: { primary: 'GEMINI_EU', fallback: null },
      EMBED: { primary: 'LOCAL', fallback: null },
    };
    expect(() => validateRouting(eeaOnly)).not.toThrow();
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

  it('refuses every non-EEA spelling on the union-like list for every sensitive task', () => {
    for (const task of SENSITIVE_TASKS) {
      for (const endpoint of NON_EEA_ENDPOINTS) {
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

describe('endpointsForTask', () => {
  it('returns primary then fallback', () => {
    expect(endpointsForTask(DEFAULT_ROUTING, 'CLASSIFY')).toEqual(['LOCAL', 'DEEPSEEK_EU']);
  });

  it('drops a null fallback', () => {
    expect(endpointsForTask(DEFAULT_ROUTING, 'EMBED')).toEqual(['LOCAL']);
  });

  it('returns an empty chain for an unrouted task', () => {
    expect(endpointsForTask({}, 'CLASSIFY')).toEqual([]);
  });
});
