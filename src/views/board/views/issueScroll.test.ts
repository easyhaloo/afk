/**
 * Unit tests for the IssueDetail scroll math (issue #28).
 *
 * AC1: j scrolls down by one line when not at bottom
 * AC2: k scrolls up by one line when not at top
 * AC3: j has no further effect when content is at bottom
 * AC4: k has no further effect when content is at top
 * AC5: scroll position is preserved while the same issue is selected
 *      (covered by the useEffect + prevItemRef in DetailScreen; here we
 *      verify the underlying math — bounds depend on the description, so
 *      switching issues must reset via the useEffect, not via the math)
 */
import { describe, it, expect } from 'vitest';
import { computeIssueScrollBounds, clampScrollOffset } from './issueScroll';

describe('computeIssueScrollBounds', () => {
  it('returns zero visible lines for a body smaller than the header chrome', () => {
    // bodyHeight < header(5) + chrome(4) = 9, so no description lines fit
    const b = computeIssueScrollBounds(5, 100);
    expect(b.visibleLines).toBe(0);
    expect(b.maxScroll).toBe(100);
  });

  it('makes the whole description fit when it is shorter than the window', () => {
    // bodyHeight=20, so visibleLines = 20 - 9 = 11; 5 desc lines all fit
    const b = computeIssueScrollBounds(20, 5);
    expect(b.visibleLines).toBe(11);
    expect(b.maxScroll).toBe(0);
  });

  it('caps maxScroll so the bottom of the window sits at totalLines', () => {
    // bodyHeight=20, visibleLines=11; 30 desc lines → maxScroll = 30 - 11 = 19
    const b = computeIssueScrollBounds(20, 30);
    expect(b.visibleLines).toBe(11);
    expect(b.maxScroll).toBe(19);
    // at maxScroll the last visible line index is 19 + 11 - 1 = 29
    expect(b.maxScroll + b.visibleLines - 1).toBe(29);
  });

  it('handles a description of exactly visibleLines length', () => {
    // 11 lines, 11 visible → maxScroll = 0 (already showing everything)
    const b = computeIssueScrollBounds(20, 11);
    expect(b.visibleLines).toBe(11);
    expect(b.maxScroll).toBe(0);
  });
});

describe('clampScrollOffset', () => {
  it('clamps negative offsets to 0 (k past top)', () => {
    expect(clampScrollOffset(-1, 5)).toBe(0);
    expect(clampScrollOffset(-100, 5)).toBe(0);
  });

  it('clamps offsets past the bottom to maxScroll (j past bottom)', () => {
    expect(clampScrollOffset(6, 5)).toBe(5);
    expect(clampScrollOffset(100, 5)).toBe(5);
  });

  it('leaves in-range offsets untouched', () => {
    expect(clampScrollOffset(0, 5)).toBe(0);
    expect(clampScrollOffset(3, 5)).toBe(3);
    expect(clampScrollOffset(5, 5)).toBe(5);
  });
});

describe('j/k scroll behavior against AC1-AC4', () => {
  // Simulate a 30-line description in a body of height 20 (visibleLines=11, maxScroll=19).
  // The key handler does offset+1 for j, offset-1 for k, then clamps.
  // We model "no further effect" as: applying the key at the bound keeps the offset unchanged.

  const bodyHeight = 20;
  const totalDesc = 30;
  const { visibleLines, maxScroll } = computeIssueScrollBounds(bodyHeight, totalDesc);

  it('AC1: j advances offset by one when not at bottom', () => {
    expect({ visibleLines, maxScroll }).toEqual({ visibleLines: 11, maxScroll: 19 });
    let offset = 0;
    offset = clampScrollOffset(offset + 1, maxScroll);
    expect(offset).toBe(1);
  });

  it('AC2: k decreases offset by one when not at top', () => {
    let offset = 5;
    offset = clampScrollOffset(offset - 1, maxScroll);
    expect(offset).toBe(4);
  });

  it('AC3: j has no further effect when at bottom', () => {
    let offset = maxScroll; // already at the bottom
    const next = clampScrollOffset(offset + 1, maxScroll);
    expect(next).toBe(maxScroll); // unchanged
  });

  it('AC4: k has no further effect when at top', () => {
    let offset = 0;
    const next = clampScrollOffset(offset - 1, maxScroll);
    expect(next).toBe(0); // unchanged
  });

  it('boundary: short description has maxScroll=0 so neither j nor k moves', () => {
    const short = computeIssueScrollBounds(bodyHeight, 5);
    expect(short.maxScroll).toBe(0);
    // j at top: offset+1 = 1, clamped to 0
    expect(clampScrollOffset(0 + 1, short.maxScroll)).toBe(0);
    // k at top: offset-1 = -1, clamped to 0
    expect(clampScrollOffset(0 - 1, short.maxScroll)).toBe(0);
  });
});

describe('AC5: scroll preservation per issue (math-only)', () => {
  it('different description lengths yield different maxScroll', () => {
    // Switching issues with different description sizes must reset the offset
    // via the useEffect in DetailScreen, because the previous offset may now
    // be out of range. The math confirms those ranges differ.
    const short = computeIssueScrollBounds(20, 3);
    const long = computeIssueScrollBounds(20, 50);
    expect(short.maxScroll).toBe(0);
    expect(long.maxScroll).toBe(39);
    // An offset of 10 from the long issue would be valid there but is past
    // the new maxScroll=0 after switching to the short one — confirms the
    // useEffect must reset on item change.
    expect(clampScrollOffset(10, short.maxScroll)).toBe(0);
  });
});
