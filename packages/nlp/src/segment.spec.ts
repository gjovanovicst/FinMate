import { describe, expect, it } from 'vitest';

import { segmentFragments } from './segment';

describe('segmentFragments', () => {
  it('splits the exit-criterion line into exactly three fragments', () => {
    expect(segmentFragments('Lidl 2000, gorivo 3500, plata 150000')).toEqual([
      'Lidl 2000',
      'gorivo 3500',
      'plata 150000',
    ]);
  });

  it('splits on every separator docs/04 §3 names', () => {
    expect(segmentFragments('Lidl 2000;gorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
    expect(segmentFragments('Lidl 2000\ngorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
    expect(segmentFragments('Lidl 2000 i gorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
    expect(segmentFragments('Lidl 2000 + gorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
    expect(segmentFragments('Lidl 2000 pa gorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
  });

  it('is stable across separator runs and case', () => {
    for (const separator of [',', ';', '\n', '+', ' i ', ' I ', ' pa ', ' PA ', ',,', ' i \n ', '\r\n']) {
      expect(segmentFragments(`Lidl 2000${separator}gorivo 3500`)).toEqual([
        'Lidl 2000',
        'gorivo 3500',
      ]);
    }
  });

  it('does not split inside a word that merely contains i', () => {
    expect(segmentFragments('pivo 200')).toEqual(['pivo 200']);
    expect(segmentFragments('Lidl iMax 200')).toEqual(['Lidl iMax 200']);
    expect(segmentFragments('Indian 200')).toEqual(['Indian 200']);
  });

  it('keeps a decimal comma inside one fragment', () => {
    // The whole point: `2,50` is one amount, not two fragments.
    expect(segmentFragments('2,50')).toEqual(['2,50']);
    expect(segmentFragments('1.250,50')).toEqual(['1.250,50']);
    expect(segmentFragments('Lidl 2,50 i gorivo 3,00')).toEqual(['Lidl 2,50', 'gorivo 3,00']);
  });

  it('still splits a comma that separates fragments', () => {
    expect(segmentFragments('Lidl 2000,gorivo 3500')).toEqual(['Lidl 2000', 'gorivo 3500']);
    expect(segmentFragments('2000, 3500')).toEqual(['2000', '3500']);
    expect(segmentFragments('2000,,3500')).toEqual(['2000', '3500']);
  });

  it('accepts the Cyrillic conjunctions as the same separators', () => {
    expect(segmentFragments('Лиди 2000 и гориво 3500')).toEqual(['Лиди 2000', 'гориво 3500']);
    expect(segmentFragments('Лиди 2000 па гориво 3500')).toEqual(['Лиди 2000', 'гориво 3500']);
  });

  it('drops blanks and trims every fragment', () => {
    expect(segmentFragments('  Lidl 2000 ,, ; \n gorivo 3500  ')).toEqual([
      'Lidl 2000',
      'gorivo 3500',
    ]);
    expect(segmentFragments('   ')).toEqual([]);
    expect(segmentFragments('')).toEqual([]);
    expect(segmentFragments(',;,')).toEqual([]);
  });

  it('preserves input order', () => {
    expect(segmentFragments('a 1;b 2;c 3')).toEqual(['a 1', 'b 2', 'c 3']);
  });
});
