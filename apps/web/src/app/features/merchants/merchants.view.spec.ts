import { describe, expect, it } from 'vitest';

import { foldForMatching } from '@finmate/nlp';

import {
  aliasUnion,
  deleteRefusal,
  mergeRefusal,
  sameMerchantName,
  type MerchantNode,
} from './merchants.view';

function merchant(overrides: Partial<MerchantNode> & { id: string }): MerchantNode {
  return {
    name: 'Shop',
    defaultCategoryId: null,
    defaultCategoryPath: null,
    aiHint: null,
    isGlobal: false,
    isOwnedByHousehold: true,
    aliases: [],
    transactionCount: 0,
    ...overrides,
  };
}

const aliases = (...values: string[]) =>
  values.map((alias, index) => ({ id: `a${index}`, alias }));

describe('foldForMatching on the client', () => {
  it('folds case, diacritics and whitespace like the server', () => {
    expect(foldForMatching('  Šećer   LIDL ')).toBe('secer lidl');
  });

  it('folds đ, which NFD alone cannot', () => {
    expect(foldForMatching('Đorđe')).toBe('dorde');
  });

  it('folds Cyrillic to Latin, the same fold the API uses', () => {
    // This is the web half of the "one fold" guarantee: the duplicate-name warning must agree with
    // the server's CONFLICT, and the server now transliterates too (docs/04 §3.1).
    expect(foldForMatching('Лиди')).toBe('lidi');
  });

  it('is idempotent', () => {
    const once = foldForMatching('Đački  Šećer');
    expect(foldForMatching(once)).toBe(once);
  });
});

describe('sameMerchantName', () => {
  it('treats variants of one name as the same shop', () => {
    expect(sameMerchantName('LIDL', 'lidl')).toBe(true);
    expect(sameMerchantName('Đorđe', 'Djordje')).toBe(false);
    expect(sameMerchantName('Đorđe', 'Dorde')).toBe(true);
    expect(sameMerchantName('Lidl', 'Maxi')).toBe(false);
  });
});

describe('aliasUnion', () => {
  it('unions both sides, de-duplicates and sorts', () => {
    const source = merchant({ id: 's', aliases: aliases('shared', 'from-source') });
    const target = merchant({ id: 't', aliases: aliases('from-target', 'shared') });
    expect(aliasUnion(source, target)).toEqual(['from-source', 'from-target', 'shared']);
  });

  it('returns nothing when either side is missing, rather than one side alone', () => {
    const source = merchant({ id: 's', aliases: aliases('a') });
    expect(aliasUnion(source, null)).toEqual([]);
    expect(aliasUnion(null, source)).toEqual([]);
  });

  it('handles a side with no aliases', () => {
    expect(aliasUnion(merchant({ id: 's' }), merchant({ id: 't', aliases: aliases('x') }))).toEqual([
      'x',
    ]);
  });
});

describe('mergeRefusal', () => {
  it('allows merging an owned merchant into a shipped one, which the server copies on write', () => {
    const source = merchant({ id: 's' });
    const target = merchant({ id: 't', isGlobal: true, isOwnedByHousehold: false });
    expect(mergeRefusal(source, target)).toBeNull();
  });

  it('refuses merging a shipped merchant away, and merging into itself', () => {
    expect(mergeRefusal(merchant({ id: 's', isGlobal: true }), merchant({ id: 't' }))).toBe(
      'SHIPPED_SOURCE',
    );
    expect(mergeRefusal(merchant({ id: 's' }), merchant({ id: 's' }))).toBe('SAME');
  });

  it('says nothing while a target has not been chosen', () => {
    expect(mergeRefusal(merchant({ id: 's' }), null)).toBeNull();
  });
});

describe('deleteRefusal', () => {
  it('refuses a shipped merchant, which is platform content', () => {
    expect(deleteRefusal(merchant({ id: 's', isGlobal: true }))).toBe('SHIPPED');
  });

  it('refuses one that is still referenced, pointing at merge instead', () => {
    expect(deleteRefusal(merchant({ id: 's', transactionCount: 3 }))).toBe('IN_USE');
  });

  it('allows an unused owned merchant', () => {
    expect(deleteRefusal(merchant({ id: 's' }))).toBeNull();
  });
});
