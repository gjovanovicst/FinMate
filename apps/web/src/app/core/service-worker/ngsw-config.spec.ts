import { describe, expect, it } from 'vitest';

import rawConfig from '../../../../ngsw-config.json';

/**
 * The service-worker configuration is a **privacy boundary**, so it is asserted rather than reviewed.
 *
 * ADR-024 decided that the worker caches the app shell and *nothing else*: every offline figure comes
 * from the encrypted, minimised, TTL'd IndexedDB snapshot (docs/08 §3.9), never from an HTTP cache. The
 * failure this guards against is one line long — a well-meaning `dataGroups` entry for `/graphql` that
 * "makes the app work offline" and quietly writes a household's ledger into the browser's disk cache,
 * unencrypted and outliving the 24 h snapshot TTL.
 *
 * The config is **imported**, not read from disk at test time: `web:typecheck` and the production build
 * both compile this file (docs/15 §9 records why specs are in the program), and a file that imports
 * `node:fs` cannot be in a browser program. The import resolves through the very file `angular.json`
 * hands to the builder, so the two cannot disagree about which config ships.
 */
interface AssetGroup {
  readonly name: string;
  readonly installMode?: string;
  readonly resources?: { readonly files?: readonly string[] };
}
interface NgswConfig {
  readonly index?: string;
  readonly assetGroups?: readonly AssetGroup[];
  readonly dataGroups?: readonly { readonly name: string; readonly urls?: readonly string[] }[];
  readonly navigationUrls?: readonly string[];
}

const config = rawConfig as unknown as NgswConfig;

/** The paths that carry household data or a session, and may therefore never be cached or shell-served. */
const PRIVATE_PREFIXES = ['/graphql', '/api/', '/auth/', '/v1/'];

describe('ngsw-config.json', () => {
  it('declares no runtime data cache at all', () => {
    // An *empty array* would be as good as absent; a populated one is the defect this test exists for.
    expect(config.dataGroups ?? []).toEqual([]);
  });

  it('caches the app shell eagerly, so the app opens offline', () => {
    expect(config.index).toBe('/index.html');

    const app = config.assetGroups?.find((group) => group.name === 'app');
    expect(app, 'the app asset group is what makes the shell available offline').toBeDefined();
    expect(app?.installMode).toBe('prefetch');
    expect(app?.resources?.files).toContain('/index.html');
    // The hashed bundles: Angular writes them at the dist root with `outputHashing: all`.
    expect(app?.resources?.files).toContain('/*.js');
    expect(app?.resources?.files).toContain('/*.css');
  });

  it('never caches or shell-serves a private path', async () => {
    for (const group of config.dataGroups ?? []) {
      for (const url of group.urls ?? []) {
        for (const prefix of PRIVATE_PREFIXES) {
          expect(url.startsWith(prefix), `${group.name} caches ${url}`).toBe(false);
        }
      }
    }

    // Also assert the asset globs cannot reach them: Angular's asset globs start at the origin root,
    // so a pattern like `/**` would sweep up the API too.
    for (const group of config.assetGroups ?? []) {
      expect(group.resources?.files).not.toContain('/**');
    }
    expect(config.index).not.toBe('/');
  });

  it('treats only real routes as navigations, so the shell never answers for the API', () => {
    const urls = config.navigationUrls ?? [];
    expect(urls.length).toBeGreaterThan(0);

    // ngsw checks the patterns in order and the LAST match wins, so an exclusion is only effective if
    // it comes after the positive pattern it is narrowing.
    const positive = urls.findIndex((pattern) => !pattern.startsWith('!'));
    expect(positive).toBeGreaterThanOrEqual(0);

    for (const prefix of PRIVATE_PREFIXES) {
      const index = urls.findIndex((pattern) => pattern.startsWith(`!${prefix}`));
      expect(index, `no navigationUrls exclusion for ${prefix}`).toBeGreaterThan(positive);
    }
  });
});
