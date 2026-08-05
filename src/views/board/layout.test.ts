import { describe, expect, it } from 'vitest';
import { getListViewportHeight, getRowColumns } from './layout';

describe('getListViewportHeight', () => {
  it('removes fixed dashboard chrome from terminal height', () => {
    expect(getListViewportHeight(24, { header: 1, context: 1, footer: 1, spacer: 1 })).toBe(20);
  });

  it('always reserves at least one row for the list', () => {
    expect(getListViewportHeight(3, { header: 1, context: 1, footer: 1, spacer: 1 })).toBe(1);
  });
});

describe('getRowColumns', () => {
  it('hides the summary below 80 columns', () => {
    expect(getRowColumns(79).summary).toBe(false);
    expect(getRowColumns(80).summary).toBe(true);
  });

  it('widens metadata at 120 columns', () => {
    expect(getRowColumns(80).metadataWidth).toBe(20);
    expect(getRowColumns(119).metadataWidth).toBe(20);
    expect(getRowColumns(120).metadataWidth).toBe(30);
  });
});
