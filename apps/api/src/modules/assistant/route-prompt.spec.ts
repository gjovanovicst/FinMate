import { describe, expect, it } from 'vitest';

import { ASSISTANT_ACTIONS } from './assistant-actions';
import { ASSISTANT_INTENTS } from './assistant-intents';
import { routeMembers, routePrompt, ROUTE_PROMPT } from './route-prompt';

/**
 * The routing prompt's bytes — ADR-036.
 *
 * ⚠️ **This is the assertion that a provider defect cannot reach production unseen.** `json_object`
 * mode constrains syntax and not keys, so a prompt that never names `route`/`text` is how the first live
 * provider made the classifier invent its own field names (docs/15). A stub in `packages/ai` cannot
 * catch that — the field names come from *here* — so the composed bytes are asserted here.
 */
describe('the routing prompt (ADR-036)', () => {
  it('names both fields the schema requires', () => {
    const prompt = routePrompt({ locale: 'sr-Latn' });
    const all = `${prompt.system}\n${prompt.user}`;

    // Without these two the model answers in keys of its own choosing, and `route` is never found.
    expect(all).toContain('"route"');
    expect(all).toContain('"text"');
    // The identity is recorded on every call (docs/04 §9's prompt versioning).
    expect(ROUTE_PROMPT.templateId).toBe('route.closed-registry');
  });

  it('lists every member of both unions, and nothing that is not one', () => {
    const listed = routeMembers().map((member) => member.name);

    for (const intent of ASSISTANT_INTENTS) {
      // `NO_TEMPLATE_MATCH` is the read planner's own refusal; offering it to the model would let it
      // answer "nothing fits" as if it were a capability.
      if (intent === 'NO_TEMPLATE_MATCH') expect(listed).not.toContain(intent);
      else expect(listed, intent).toContain(intent);
    }
    for (const action of ASSISTANT_ACTIONS) expect(listed, action).toContain(action);

    // And the list is not padded: one line per member, so a name in the prompt is a name the app has.
    expect(listed).toHaveLength(ASSISTANT_INTENTS.length - 1 + ASSISTANT_ACTIONS.length);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('tells the model it may answer in any language, and that inventing a name is not an option', () => {
    const { system } = routePrompt({ locale: 'de' });
    // The whole point of the rung: the same sentence in a language no cue list covers.
    expect(system).toMatch(/any language/i);
    // …and the bound that makes it safe: a name outside the list, or null.
    expect(system).toMatch(/never invent a name/i);
    expect(system).toMatch(/null/);
    expect(system).toContain('de');
  });

  it('tells the model to keep the amount inside the text it returns', () => {
    // ⚠️ Measured, not assumed: the C-5 run showed the model dropping the numeral from `text` — because
    // the prompt asked for "the words that name what it acts on" and a number is not a name — and the
    // builder then refused `NO_AMOUNT`, since it reads the amount out of that very text. The amount is
    // never sent *as* a number (ADR-001/003); it travels inside the user's own words.
    const { system } = routePrompt({ locale: 'en' });
    expect(system).toMatch(/keep any amount/i);
    expect(system).toMatch(/reads the\s+amount out of this text/i);
    // …and the per-action meaning says the same thing, because that is the line a model attends to.
    expect(routeMembers().find((member) => member.name === 'ADD_TRANSACTION')?.description).toMatch(
      /amount included/i,
    );
  });

  it('keeps the question out of the instructions', () => {
    // The adapter appends the question inside an untrusted span (docs/08 §6.9). Rendering it here too
    // would put untrusted text in the instruction half — the separation that exists to stop a merchant
    // name from reading as a rule.
    const prompt = routePrompt({ locale: 'sr-Latn' });
    expect(prompt.user).not.toContain('Lidl');
    expect(prompt.system).not.toContain('Lidl');
    // The member list is the user half; the rules are the system half.
    expect(prompt.user).toContain('Members you may answer with:');
    expect(prompt.system).not.toContain('Members you may answer with:');
  });
});
