import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

import { isEeaOrLocal, type Task } from '@finmate/ai';

import { consentKindForTask } from '../consent/consent';
import { ConsentKindEnum } from '../consent/consent.model';
import type { AiAssembly } from './ai-providers';

/**
 * What the deployment would actually send where (docs/08 §6.6, §6.5).
 *
 * ## Why this is a query and not copy in the client
 *
 * §6.6 requires the consent sheet to name *the provider and the region*. A client that hardcoded
 * "DeepSeek (China)" would be making a claim, and this project has already been burned by exactly that:
 * `DEEPSEEK_EU` was a suffix on a Chinese host and the suffix satisfied the residency check (ADR-031).
 * The only honest source of "where does this go" is the process that holds the routing table, so the
 * client asks.
 *
 * It is also the input the client needs to decide **whether to ask at all**: a deployment that routes
 * everything `LOCAL` has no consent to request, and a sheet offering one would be asking about nothing.
 */
export enum AiEgressRegionEnum {
  LOCAL = 'LOCAL',
  EEA = 'EEA',
  NON_EEA = 'NON_EEA',
}

registerEnumType(AiEgressRegionEnum, {
  name: 'AiEgressRegion',
  description:
    'Where the traffic goes, derived from the endpoint registry rather than from its name: LOCAL is this ' +
    'node, EEA is an `_EU` endpoint with its configured host, and NON_EEA is the consent-gated ' +
    'exception (docs/04 §9, ADR-031).',
});

@ObjectType()
export class AiEgressModel {
  @Field(() => ConsentKindEnum, {
    description: 'The consent purpose that governs this route (docs/08 §6.6).',
  })
  purpose!: string;

  @Field(() => String, {
    description:
      'Which task this row is about — `CLASSIFY`, `NARRATE`, `OCR` or `ROUTE`. A task the configuration routes but ' +
      'no code in this build calls is never listed, because it is not egress a person could consent to.',
  })
  task!: string;

  @Field(() => String, {
    description: 'The configured endpoint, e.g. `LOCAL`, `DEEPSEEK_EU` or `DEEPSEEK_GLOBAL`.',
  })
  endpoint!: string;

  @Field(() => String, { description: 'The provider that would answer, e.g. `DEEPSEEK` or `LOCAL`.' })
  provider!: string;

  @Field(() => AiEgressRegionEnum, { description: 'Derived from the registry, never from the name.' })
  region!: AiEgressRegionEnum;

  @Field(() => Boolean, {
    description:
      'True when this route needs recorded consent. The client shows a sheet only for these rows: ' +
      'asking permission for a LOCAL route would ask about nothing.',
  })
  requiresConsent!: boolean;
}

/**
 * Project the assembled routing table onto the wire, restricted to the tasks a caller can reach.
 *
 * Pure, so `ai-egress.spec.ts` can assert every branch without a Nest module — and so the mapping from
 * "an endpoint name" to "a region a person can be told about" has exactly one implementation.
 *
 * **`calledTasks` is a filter, not a convenience.** The routing table answers "where *could* this go";
 * a disclosure has to answer "what will this deployment send", and those differ by every routed task
 * with no call site in this build. `PARSE` is the live example: `packages/nlp` parses locally, nothing
 * invokes the task, and a row for it would put a Chapter V transfer in front of a person as something
 * they could permit — and could be asked to permit — when no request would ever be made. The rows are
 * therefore drawn from the intersection, and `AiSeams.calledTasks` is derived from the seams themselves
 * so a real caller cannot be added without appearing here.
 */
export function toAiEgressModels(
  assembly: AiAssembly,
  calledTasks: readonly Task[],
): AiEgressModel[] {
  const rows: AiEgressModel[] = [];

  for (const task of assembly.routedTasks) {
    if (!calledTasks.includes(task)) continue;

    const endpoint = assembly.routing[task]?.primary;
    if (endpoint === undefined) continue;

    // `EMBED` has no consent that could admit it — it never leaves this node (docs/08 §6.5) — and it is
    // not a routed task here. A null purpose means there is nothing for a person to decide, so there is
    // no row: a disclosure about a route that cannot be consented to is noise.
    const purpose = consentKindForTask(task);
    if (purpose === null) continue;

    const row = new AiEgressModel();
    row.purpose = purpose;
    row.task = task;
    row.endpoint = endpoint;
    row.provider = assembly.providers[endpoint]?.name ?? 'UNKNOWN';
    // The registry's own predicates, so this cannot drift from what the router enforces. Anything not
    // shown to be this node or an `_EU` endpoint is reported as NON_EEA — the same fail-closed posture
    // as `isAdmissible`, because a disclosure that guessed "probably fine" would be worse than none.
    row.region =
      endpoint === 'LOCAL'
        ? AiEgressRegionEnum.LOCAL
        : isEeaOrLocal(endpoint)
          ? AiEgressRegionEnum.EEA
          : AiEgressRegionEnum.NON_EEA;
    row.requiresConsent = row.region === AiEgressRegionEnum.NON_EEA;
    rows.push(row);
  }

  return rows;
}
