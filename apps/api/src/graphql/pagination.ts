import { Type } from '@nestjs/common';
import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * Cursor pagination convention (docs/06 §1).
 *
 * **Cursor, not offset.** The ledger is append-only and grows at the top, so an offset page shifts
 * under the client as new Transactions arrive — a row can be skipped or shown twice. The cursor is
 * the row id, and because primary keys are **UUIDv7** (docs/03 §3.3) the id is already time-ordered,
 * so keyset pagination needs no extra index and no `created_at` tiebreak.
 *
 * Code-first GraphQL cannot express a generic type, so each entity gets a concrete Connection. This
 * helper builds one so the shape stays identical across entities without repeating the boilerplate.
 */

@ObjectType({ isAbstract: true })
export abstract class PageInfo {
  @Field(() => Boolean, { description: 'True when more rows exist after `endCursor`.' })
  hasNextPage!: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Pass as `after` to fetch the next page. Null when there is no next page.',
  })
  endCursor!: string | null;
}

/** Build `XConnection` / `XEdge` object types for an entity GraphQL class. */
export function Paginated<T>(classRef: Type<T>): Type<{
  edges: { node: T; cursor: string }[];
  pageInfo: PageInfo;
  totalCount: number;
}> {
  @ObjectType(`${classRef.name}Edge`)
  abstract class EdgeType {
    @Field(() => classRef)
    node!: T;

    @Field(() => String)
    cursor!: string;
  }

  @ObjectType(`${classRef.name}Connection`, { isAbstract: true })
  abstract class ConnectionType {
    @Field(() => [EdgeType])
    edges!: EdgeType[];

    @Field(() => PageInfo)
    pageInfo!: PageInfo;

    @Field(() => Int, {
      description:
        'Total rows matching the filter, ignoring the page window. Useful for "23 transactions" ' +
        'style labels, and cheap because it is a scoped COUNT.',
    })
    totalCount!: number;
  }

  return ConnectionType as Type<{
    edges: { node: T; cursor: string }[];
    pageInfo: PageInfo;
    totalCount: number;
  }>;
}

/** Maximum page size. Guards against a client asking for the whole ledger in one query. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/** Shape a page of rows into the Connection payload. */
export function toConnection<T extends { id: string }>(
  page: CursorPage<T>,
): { edges: { node: T; cursor: string }[]; pageInfo: PageInfo; totalCount: number } {
  return {
    edges: page.items.map((node) => ({ node, cursor: node.id })),
    pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
    totalCount: page.totalCount,
  };
}

/** Clamp a requested page size into the allowed range. */
export function normalisePageSize(first: number | undefined): number {
  if (first === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(first, 1), MAX_PAGE_SIZE);
}
