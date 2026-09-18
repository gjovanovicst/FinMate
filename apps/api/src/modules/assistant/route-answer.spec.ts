import { describe, expect, it } from 'vitest';

import { ACTION_NAME_MAX_LENGTH } from './action-planner';
import { ASSISTANT_ACTIONS } from './assistant-actions';
import { ASSISTANT_INTENTS } from './assistant-intents';
import { validateRouteAnswer } from './route-answer';

/**
 * `validateRouteAnswer` — ADR-036's safety property.
 *
 * This is the only place an untrusted string from a model turns into a decision, so the suite is written
 * as the set of ways it could be *widened*: an invented member, a case variant, a member that is only
 * the read planner's own refusal, text attached to a question, text that is not a name. Each must come
 * back `null` or narrowed, because "the model asked for something nobody wrote" is the failure this
 * whole design exists to make impossible.
 */
describe('validateRouteAnswer (ADR-036)', () => {
  it('accepts every registered question, and never the planner\'s own refusal', () => {
    for (const intent of ASSISTANT_INTENTS) {
      const decision = validateRouteAnswer({ route: intent, text: null });
      if (intent === 'NO_TEMPLATE_MATCH') {
        // A refusal *from a model* is not a capability: the caller's existing refusal is already
        // honest, and it costs nothing.
        expect(decision).toBeNull();
      } else {
        expect(decision).toEqual({ kind: 'INTENT', intent });
      }
    }
  });

  it('accepts every registered write, carrying the text the sentence named', () => {
    for (const action of ASSISTANT_ACTIONS) {
      expect(validateRouteAnswer({ route: action, text: 'Odmor' })).toEqual({
        kind: 'ACTION',
        action,
        text: 'Odmor',
      });
    }
  });

  it('drops text beside a question, because no question has a create-style payload', () => {
    // If this ever returned text for an intent, a later stage would have a value nothing may use — and
    // the temptation to use it is exactly how a question starts writing.
    expect(validateRouteAnswer({ route: 'SPEND_TOTAL', text: 'Hrana' })).toEqual({
      kind: 'INTENT',
      intent: 'SPEND_TOTAL',
    });
  });

  it('rejects a name the app does not have, in any casing or shape', () => {
    for (const route of [
      'spend_total', // the right member, the wrong spelling — a contract violation, not a near miss
      'ADD_CATEGORIES',
      'DELETE_TRANSACTION', // a plausible capability, and one nobody wrote
      'runQuery',
      'https://api.example/graphql',
      '',
      '   ',
    ]) {
      expect(validateRouteAnswer({ route, text: null }), route).toBeNull();
    }
  });

  it('treats blank, over-long or missing text as "nothing named"', () => {
    const at = (text: string | null) =>
      validateRouteAnswer({ route: 'ADD_CATEGORY', text }) as { text: string | null } | null;

    expect(at(null)?.text).toBeNull();
    expect(at('')?.text).toBeNull();
    expect(at('   ')?.text).toBeNull();
    // ⚠️ Over-long is **absence, not truncation**: the builders bound a name at the same constant, and
    // a truncated name is a name nobody wrote. Absent text routes the action into the refusal the card
    // already phrases as "tell me what to call it".
    expect(at('x'.repeat(ACTION_NAME_MAX_LENGTH + 1))?.text).toBeNull();
    expect(at('x'.repeat(ACTION_NAME_MAX_LENGTH))?.text).toHaveLength(ACTION_NAME_MAX_LENGTH);
  });

  it('trims what it does keep, and answers null for an absent answer', () => {
    expect(validateRouteAnswer({ route: 'ADD_TAG', text: '  Odmor  ' })).toEqual({
      kind: 'ACTION',
      action: 'ADD_TAG',
      text: 'Odmor',
    });
    // A provider that answered nothing, or a router that never got a response.
    expect(validateRouteAnswer(null)).toBeNull();
    expect(validateRouteAnswer(undefined)).toBeNull();
  });
});
