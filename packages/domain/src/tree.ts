/**
 * Generic tree helpers for the Category hierarchy.
 *
 * Kept pure and dependency-free (docs/05 §2) so the rules that protect invariant I-11 — *the tree is
 * acyclic and at most 5 deep* — are unit-testable without a database. A cycle in a Category tree is
 * not a cosmetic bug: every rollup, budget subtree and breadcrumb walks it, so a cycle is an infinite
 * loop in production.
 *
 * @module @finmate/domain
 */

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * Maximum Category depth.
 *
 * A limit rather than "as deep as you like": breadcrumbs, budget rollups and category pickers all
 * degrade past this, and docs/03 §4 enforces it in the service layer.
 */
export const MAX_TREE_DEPTH = 5;

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeError';
  }
}

/** Index children by parent for repeated lookups. `null` keys hold the roots. */
function childrenByParent(nodes: readonly TreeNode[]): Map<string | null, TreeNode[]> {
  const index = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const bucket = index.get(node.parentId);
    if (bucket) bucket.push(node);
    else index.set(node.parentId, [node]);
  }
  return index;
}

/** Ancestors of `id`, nearest first. Stops if it detects a cycle rather than looping forever. */
export function ancestorsOf(nodes: readonly TreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors: string[] = [];
  const seen = new Set<string>([id]);

  let current = byId.get(id)?.parentId ?? null;
  while (current !== null) {
    if (seen.has(current)) break; // pre-existing corruption: stop rather than hang
    seen.add(current);
    ancestors.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return ancestors;
}

/** Depth of a node, 1-based. A root is depth 1. */
export function depthOf(nodes: readonly TreeNode[], id: string): number {
  return ancestorsOf(nodes, id).length + 1;
}

/** Every descendant of `id`, excluding `id` itself. */
export function descendantsOf(nodes: readonly TreeNode[], id: string): string[] {
  const index = childrenByParent(nodes);
  const found: string[] = [];
  const queue = [...(index.get(id) ?? [])];
  const seen = new Set<string>([id]);

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue; // cycle guard
    seen.add(node.id);
    found.push(node.id);
    queue.push(...(index.get(node.id) ?? []));
  }
  return found;
}

/**
 * Would re-parenting `id` under `newParentId` create a cycle?
 *
 * This is the check that stands between a user and an infinite loop in every rollup. Reparenting a
 * node under itself, or under one of its own descendants, is the cycle case; both are refused.
 */
export function wouldCreateCycle(
  nodes: readonly TreeNode[],
  id: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  return descendantsOf(nodes, id).includes(newParentId);
}

/**
 * The depth any node would have under `newParentId`.
 *
 * Deliberately takes no node id: the resulting depth depends only on the new parent. Callers that
 * need to know whether the move is legal combine this with {@link subtreeHeight} and
 * {@link wouldCreateCycle} — the three are separate questions and conflating them is how a depth
 * check ends up missing a deep descendant.
 */
export function depthUnder(nodes: readonly TreeNode[], newParentId: string | null): number {
  if (newParentId === null) return 1;
  return depthOf(nodes, newParentId) + 1;
}

/**
 * The depth of the deepest node in `id`'s subtree, counting `id` as 1.
 *
 * Needed when moving a subtree: the constraint applies to the whole subtree, not just its root, so
 * moving a depth-1 node with depth-3 descendants under a depth-3 parent would breach the cap deep
 * inside the tree where nobody is looking.
 */
export function subtreeHeight(nodes: readonly TreeNode[], id: string): number {
  const index = childrenByParent(nodes);
  let height = 1;
  const queue: { id: string; depth: number }[] = [{ id, depth: 1 }];
  const seen = new Set<string>([id]);

  while (queue.length > 0) {
    const { id: currentId, depth } = queue.shift()!;
    height = Math.max(height, depth);
    for (const child of index.get(currentId) ?? []) {
      if (seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }
  return height;
}

/**
 * Validate that the tree is well formed: acyclic, and within the depth limit.
 *
 * Returns the offending ids instead of throwing, so a caller can report every problem at once
 * (useful when importing a category tree) rather than one per round trip.
 */
export function findTreeViolations(
  nodes: readonly TreeNode[],
  maxDepth: number = MAX_TREE_DEPTH,
): { cycles: string[]; tooDeep: string[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cycles: string[] = [];
  const tooDeep: string[] = [];

  for (const node of nodes) {
    // Walk to the root, counting; if we revisit a node, it is a cycle.
    const seen = new Set<string>([node.id]);
    let current = node.parentId;
    let depth = 1;

    while (current !== null) {
      if (seen.has(current)) {
        cycles.push(node.id);
        break;
      }
      seen.add(current);
      depth += 1;
      const parent = byId.get(current);
      if (!parent) break; // dangling parent: treated as a root, not a cycle
      current = parent.parentId;
    }

    if (depth > maxDepth) tooDeep.push(node.id);
  }

  return { cycles, tooDeep };
}

/** Breadcrumb from the root down to `id`, inclusive. */
export function pathTo(nodes: readonly TreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return path;
}
