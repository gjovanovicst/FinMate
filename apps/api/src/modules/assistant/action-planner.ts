/**
 * The action planner — pure, and the write-side twin of `query-planner.ts`.
 *
 * One job: decide whether a question is a **request to change something**, and if so which
 * registered action it names and what text it supplies. It computes nothing about the ledger and
 * resolves no id — ids come from the database and text from the question (ADR-035 decision 5).
 *
 * ## Why the name is taken from the raw text, not the folded one
 *
 * A name is **display text the user invented**. `foldForMatching` lower-cases, transliterates and
 * strips diacritics — all correct for *comparing*, all wrong for *storing*: a Category created from
 * `Rođendan` must not be called `rodendan`. So the cue is matched on the folded tokens and the name is
 * sliced out of the **raw** tokens, which is also what keeps a Cyrillic name Cyrillic.
 *
 * @module apps/api/src/modules/assistant
 */

import { foldForMatching } from '@finmate/nlp';

import { ACTION_TEMPLATES, type ActionSlotName, type AssistantAction } from './assistant-actions';

/** A word, with both spellings: the one to match on and the one to keep. */
interface RawToken {
  readonly raw: string;
  readonly folded: string;
}

/**
 * One action's cue vocabulary.
 *
 * `verbs` and `objects` are matched **token-wise** rather than as fixed phrases, because Serbian and
 * English both insert words between them: *"napravi **novu** kategoriju"*, *"add **a new** category"*.
 * A phrase list would have to enumerate every insertion, and the one it missed would be a silent
 * refusal.
 */
interface ActionCues {
  readonly verbs: readonly string[];
  readonly objects: readonly string[];
}

/**
 * Cues are folded, and they are listed **here** rather than in the registry for the same reason the
 * read cues live in the planner: the registry declares what an action *is*, this declares what people
 * *say*. Both languages, one list — the shape ADR-019's amendment fixed for the read side.
 */
const CUES: Readonly<Record<AssistantAction, ActionCues>> = Object.freeze({
  ADD_CATEGORY: {
    verbs: [
      'dodaj', 'dodajte', 'dodati', 'napravi', 'napravite', 'napraviti',
      'kreiraj', 'kreirajte', 'kreirati', 'nova', 'novu', 'novi', 'novo',
      'add', 'create', 'make', 'new',
    ],
    objects: ['kategorija', 'kategoriju', 'kategorije', 'kategorijom', 'category', 'categories'],
  },
});

function tokenise(question: string): readonly RawToken[] {
  return [...question.matchAll(/\S+/gu)].map((match) => ({
    raw: match[0],
    folded: foldForMatching(match[0]),
  }));
}

/** Strip the typography people wrap a name in, and any trailing sentence punctuation. */
function cleanName(raw: string): string {
  return raw
    // Wrapping quotes, in the two scripts' usual shapes.
    .replace(/^[\s"'„“”«»([{]+/u, '')
    .replace(/[\s"'„“”«»)\]}]+$/u, '')
    // A trailing question mark or full stop is the sentence's, not the name's.
    .replace(/[.?!,;:]+$/u, '')
    // A connector the user may put in front of the name ("za Putovanja").
    .replace(/^(za|pod|named|called)\s+/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The action a question asks for, with the text it supplies — or `null` when it asks for nothing.
 *
 * `null` is the ordinary case: most questions are reads, and this runs before the read planner so an
 * imperative must not be mistaken for one. The rule is the pair — a **verb before an object**, with
 * the name after it — which is why *"koliko sam potrošio na kategoriju hrana"* is not an action.
 */
export function planAction(question: string): {
  readonly action: AssistantAction;
  readonly slots: Readonly<Partial<Record<ActionSlotName, string>>>;
  readonly matchedOn: readonly string[];
} | null {
  const tokens = tokenise(question);
  if (tokens.length === 0) return null;

  for (const action of Object.keys(CUES) as readonly AssistantAction[]) {
    const cues = CUES[action];
    // The **first** object token, so a name that happens to be the word itself survives:
    // `dodaj kategoriju Kategorija` must propose `Kategorija`, not an empty name. Searching from the
    // right would swallow it.
    const objectAt = tokens.findIndex((token) => cues.objects.includes(token.folded));
    if (objectAt < 0) continue;

    // A verb *before* the object is what makes it an imperative rather than a mention.
    const hasVerb = tokens.slice(0, objectAt).some((token) => cues.verbs.includes(token.folded));
    if (!hasVerb) continue;

    const name = cleanName(tokens.slice(objectAt + 1).map((token) => token.raw).join(' '));
    if (name.length === 0) {
      // "dodaj kategoriju" with no name: the intent is unmistakable but the proposal is not
      // buildable. Returning the action with no `name` lets the caller refuse with a *reason*
      // (`UNRUNNABLE:name`) instead of silently treating the question as a read — the same
      // distinction `missingSlots` draws on the read side.
      return { action, slots: {}, matchedOn: [`action:${action}`, 'slot:name missing'] };
    }

    return { action, slots: { name }, matchedOn: [`action:${action}`, 'slot:name'] };
  }

  return null;
}

/** The name bound the service enforces, exported so the planner's refusal and the service agree. */
export const ACTION_NAME_MAX_LENGTH = 80;

/** A slot the proposal cannot be built without is a refusal, exactly as on the read side. */
export function missingActionSlots(
  action: AssistantAction,
  slots: Readonly<Partial<Record<ActionSlotName, string>>>,
): readonly ActionSlotName[] {
  return ACTION_TEMPLATES[action].requiredSlots.filter((slot) => {
    const value = slots[slot];
    return value === undefined || value.length === 0;
  });
}
