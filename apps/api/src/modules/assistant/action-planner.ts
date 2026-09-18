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

import { normaliseForMatching } from '../../common/text/normalise';
import { ACTION_TEMPLATES, type ActionSlotName, type AssistantAction } from './assistant-actions';
import { matchEntity, type NamedEntity } from './query-planner';

/** A word, with both spellings: the one to match on and the one to keep. */
interface RawToken {
  readonly raw: string;
  readonly folded: string;
}

/**
 * One action's cue vocabulary.
 *
 * The words and the `objects` are matched **token-wise** rather than as fixed phrases, because Serbian
 * and English both insert words between them: *"napravi **novu** kategoriju"*, *"add **a new**
 * category"*. A phrase list would have to enumerate every insertion, and the one it missed would be a
 * silent refusal.
 *
 * ## Two verb lists, because one of them is not a verb
 *
 * `imperatives` are real imperatives and count **anywhere** before the object, which is what makes
 * *"molim te dodaj kategoriju X"* and *"can you create a category X"* work.
 *
 * `leadAdjectives` are the adjective-only request shapes Serbian and English allow — *"nova kategorija
 * Hrana"*, *"new category Travel"* — and they count **only as the question's first token**. They have
 * to: `nova`/`novu`/`novi`/`novo`/`new` are ordinary attributive adjectives that occur inside real
 * questions, and counting them anywhere planned *"koja je nova kategorija najveća"* as a request to
 * create a Category named `najveća`, and *"koliko sam potrošio na novu kategoriju hrana"* as one
 * alongside the `SPEND_BY_CATEGORY` answer it should have got. A question may begin with the adjective
 * because that is the whole request; it does not begin with it when it is a question about one.
 *
 * `make` is deliberately **absent**: *"make a report of spending by category"* is a read, and no cheap
 * rule separates it from *"make a category X"*. A missed proposal is a refusal the user retries; a
 * wrong proposal is an offered write (R-29), so the ambiguity is resolved toward refusing.
 */
interface ActionCues {
  readonly imperatives: readonly string[];
  readonly leadAdjectives: readonly string[];
  readonly objects: readonly string[];
  /** Where the text after the anchor goes. Its own union, so a read template can never ask for it. */
  readonly slot: ActionSlotName;
  /**
   * Whether an imperative followed by a **number** is enough, with no object word.
   *
   * *"dodaj kafu 180"* is how a person actually asks for this, and it names nothing the object list
   * can list — the words between the verb and the amount are the *content*. The rung is safe only
   * because the action cannot be built without an amount anyway: a text that yields none is refused,
   * and *"dodaj kategoriju Putovanja"* carries no number at all (and matches its own action first).
   */
  readonly amountAnchor: boolean;
}

/**
 * Cues are folded, and they are listed **here** rather than in the registry for the same reason the
 * read cues live in the planner: the registry declares what an action *is*, this declares what people
 * *say*. Both languages, one list — the shape ADR-019's amendment fixed for the read side.
 */
const CUES: Readonly<Record<AssistantAction, ActionCues>> = Object.freeze({
  ADD_CATEGORY: {
    imperatives: [
      'dodaj', 'dodajte', 'dodati', 'napravi', 'napravite', 'napraviti',
      'kreiraj', 'kreirajte', 'kreirati',
      'add', 'create',
    ],
    leadAdjectives: ['nova', 'novu', 'novi', 'novo', 'new'],
    objects: ['kategorija', 'kategoriju', 'kategorije', 'kategorijom', 'category', 'categories'],
    slot: 'name',
    // A category name is not a number, and a bare *"dodaj 500"* must not create one called `500`.
    amountAnchor: false,
  },
  /**
   * A budget is **named** by what it limits, so this action's object is a word and its text carries the
   * amount — see `planAction`, which tries every action's object rung before any amount rung, so
   * *"dodaj budžet za hranu 20000"* is a budget and *"dodaj kafu 180"* is an entry.
   */
  SET_BUDGET: {
    imperatives: [
      'dodaj', 'dodajte', 'dodati',
      'postavi', 'postavite', 'postaviti',
      'podesi', 'podesite', 'podesiti',
      'promeni', 'promenite', 'promeniti',
      'ogranici', 'ogranicite', 'ograniciti',
      'set', 'change', 'update', 'configure', 'limit',
    ],
    leadAdjectives: [],
    // Folded forms, and `budžet` folds to `budzet` (docs/15's cue-list entry).
    objects: ['budzet', 'budzeta', 'budzetu', 'budzetom', 'limit', 'limita', 'limitu', 'budget', 'budgets'],
    slot: 'text',
    amountAnchor: false,
  },
  /**
   * A tag is a name, so this is the category action's shape: a verb, then the object, then the name.
   *
   * The object list carries both languages' words for it, and `label` is included because that is what an
   * English speaker calls one — the *canonical* vocabulary is Tag (docs/03), but a question is not
   * written in the glossary.
   */
  ADD_TAG: {
    imperatives: [
      'dodaj', 'dodajte', 'dodati',
      'napravi', 'napravite', 'napraviti',
      'kreiraj', 'kreirajte', 'kreirati',
      'postavi', 'postavite', 'postaviti',
      'add', 'create', 'new', 'set',
    ],
    leadAdjectives: [],
    objects: ['tag', 'taga', 'tagu', 'tagovi', 'tagove', 'oznaka', 'oznaku', 'oznake', 'label', 'labels'],
    slot: 'name',
    // A tag's name is not a number, and a bare *"dodaj tag 2"* must not create one called `2`. The name
    // is whatever follows the object, which is the same rule the category action uses.
    amountAnchor: false,
  },
  /**
   * A goal is **named** by the word for it, so this action joins `SET_BUDGET` on the object rung: the
   * object word (not the verb) is what says a goal is being made, and the two-pass rule in `planAction`
   * keeps *"dodaj cilj Letovanje 200000"* away from the entry action's amount rung.
   */
  ADD_GOAL: {
    imperatives: [
      'napravi', 'napravite', 'napraviti',
      'dodaj', 'dodajte', 'dodati',
      'postavi', 'postavite', 'postaviti',
      'kreiraj', 'kreirajte', 'kreirati',
      'set', 'create', 'add', 'new',
    ],
    leadAdjectives: [],
    // Folded forms (`štednju` → `stednju`, docs/15's cue-list entry).
    objects: ['cilj', 'cilja', 'cilju', 'ciljem', 'ciljeve', 'stednja', 'stednju', 'stednje', 'savings', 'goal', 'goals'],
    slot: 'text',
    amountAnchor: false,
  },
  ADD_TRANSACTION: {
    imperatives: [
      'dodaj', 'dodajte', 'dodati',
      'unesi', 'unesite', 'uneti',
      'zabelezi', 'zabelezite', 'zabeleziti',
      'upisi', 'upisite', 'upisati',
      'evidentiraj', 'evidentirajte',
      'add', 'record', 'log',
    ],
    // No lead adjectives: *"novi trošak"* is not how this is asked, and the rung's false-positive
    // surface is exactly what the adjectives were for on the category side.
    leadAdjectives: [],
    // ⚠️ **Folded forms, not English spellings.** Every cue here is compared against
    // `foldForMatching`'s output, and since A-10 that fold maps `x` → `ks` — so `expense` is the token
    // `ekspense` by the time this list sees it, and the spelling `expense` matched nothing. Found by a
    // test that asserted the text of *"add expense coffee 180"* and got the whole phrase back. If you
    // add a word here, add what the fold produces (docs/15).
    objects: [
      'trosak', 'transakciju', 'transakcija', 'transakcije',
      'rashod', 'prihod', 'uplatu', 'uplata', 'uplate',
      'ekspense', 'ekspenses', 'transaction', 'payment', 'income',
    ],
    slot: 'text',
    amountAnchor: true,
  },
});

function tokenise(question: string): readonly RawToken[] {
  return [...question.matchAll(/\S+/gu)].map((match) => ({
    raw: match[0],
    folded: foldForMatching(match[0]),
  }));
}

/**
 * Strip the typography people wrap a name in, and any trailing sentence punctuation.
 *
 * Exported for the goal builder (B-4b), which takes its name from what the parser left once the amount
 * is removed — the same "text the user invented" the category action slices out after its anchor, so the
 * two must be cleaned by the same rule rather than by two.
 */
export function cleanName(raw: string): string {
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
 *
 * ⚠️ **This runs first, but it does not win.** The read side answers a question it can answer, and the
 * card is offered only when the read refused (B-2b, the ordering docs/06 §8.16 records). That is the
 * second line of defence behind the cue lists: a cue list is a heuristic, and where it is wrong the
 * consequence here is a proposal nobody sees rather than a wrong answer.
 */
export function planAction(question: string): {
  readonly action: AssistantAction;
  readonly slots: Readonly<Partial<Record<ActionSlotName, string>>>;
  readonly matchedOn: readonly string[];
} | null {
  const tokens = tokenise(question);
  if (tokens.length === 0) return null;

  // **Every action's object rung is tried before any action's amount rung**, and that ordering is the
  // rule rather than the declaration order of `CUES`. A word naming *what is being configured*
  // (`kategorija`, `budžet`, `trošak`) is far stronger evidence than an imperative followed by a
  // number, and without the passes *"dodaj budžet za hranu 20000"* would match the entry action's
  // amount rung first — proposing a Transaction whose description is the word *budžet*.
  for (const on of ['object', 'amount'] as const) {
    for (const action of Object.keys(CUES) as readonly AssistantAction[]) {
      const cues = CUES[action];
      const anchor = anchorFor(tokens, cues, on);
      if (anchor === null) continue;

      const text = cleanName(tokens.slice(anchor.at + 1).map((token) => token.raw).join(' '));
      if (text.length === 0) {
        // "dodaj kategoriju" with no name: the intent is unmistakable but the proposal is not
        // buildable. Returning the action with no text lets the caller refuse with a *reason*
        // (`UNRUNNABLE:name`) instead of silently treating the question as a read — the same
        // distinction `missingSlots` draws on the read side.
        return { action, slots: {}, matchedOn: [`action:${action}`, `slot:${cues.slot} missing`] };
      }

      return {
        action,
        slots: { [cues.slot]: text },
        matchedOn: [`action:${action}`, `slot:${cues.slot}`, `anchor:${anchor.on}`],
      };
    }
  }

  return null;
}

/** One anchor for one action, on one rung — or `null` when that action does not match there. */
function anchorFor(
  tokens: readonly RawToken[],
  cues: ActionCues,
  on: 'object' | 'amount',
): { readonly at: number; readonly on: 'object' | 'amount' } | null {
  if (on === 'amount') return amountAnchorFor(tokens, cues);

  // The **first** object token, so a name that happens to be the word itself survives:
  // `dodaj kategoriju Kategorija` must propose `Kategorija`, not an empty name. Searching from the
  // right would swallow it.
  const objectAt = tokens.findIndex((token) => cues.objects.includes(token.folded));
  if (objectAt < 0) return null;
  return hasImperativeBefore(tokens, cues, objectAt) ? { at: objectAt, on: 'object' } : null;
}

/** A verb *before* the object is what makes it an imperative rather than a mention. */
function hasImperativeBefore(
  tokens: readonly RawToken[],
  cues: ActionCues,
  objectAt: number,
): boolean {
  const before = tokens.slice(0, objectAt);
  if (before.some((token) => cues.imperatives.includes(token.folded))) return true;
  // …and the adjective-only shapes count only in first position (see `ActionCues`).
  return cues.leadAdjectives.includes(tokens[0]?.folded ?? '') && objectAt > 0;
}

/**
 * The imperative-plus-a-number rung, anchored on the imperative so the text is what follows the verb.
 *
 * `/\d/` rather than `parseAmount`: the planner decides **whether a question is shaped like a
 * request**, and the amount itself is the parser's job one layer down — a numeric *existence* test is
 * enough to tell *"dodaj kafu 180"* from *"dodaj kategoriju Putovanja"*, and importing the money
 * parser here would put ADR-003's rules in the planner for no gain.
 */
function amountAnchorFor(
  tokens: readonly RawToken[],
  cues: ActionCues,
): { readonly at: number; readonly on: 'amount' } | null {
  if (!cues.amountAnchor) return null;
  const imperativeAt = tokens.findIndex((token) => cues.imperatives.includes(token.folded));
  if (imperativeAt < 0) return null;
  const rest = tokens.slice(imperativeAt + 1);
  if (!rest.some((token) => /\d/u.test(token.raw))) return null;
  return { at: imperativeAt, on: 'amount' };
}

/**
 * One entity named inside a short phrase — the **write** side's use of the read side's ladder.
 *
 * A budget's target is a Category the user names (*"postavi budžet za hranu na 20000"*), and it has to
 * resolve exactly as it would in a question, or the assistant would budget one Category and answer
 * about another. The rungs, the scoring and the tie-break are therefore the same function the read
 * planner calls — with the same name/breadcrumb/`INCLUDE`-keyword vocabulary (`planner-entities.ts`),
 * because a Category is named by all three in both directions.
 *
 * `null` is the honest answer, and it is the caller's to refuse on: a phrase that names nothing is not
 * the same as a phrase that names something unresolvable, and only the caller can tell.
 */
export function resolveEntityIn(
  phrase: string,
  entities: readonly NamedEntity[],
): NamedEntity | null {
  if (phrase.trim().length === 0) return null;
  return matchEntity(
    normaliseForMatching(phrase),
    entities,
    (entity) => [entity.name, ...(entity.path === undefined ? [] : [entity.path])],
    (entity) => entity.keywords ?? [],
  );
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
