import { describe, expect, it } from 'vitest';
import { visiblePageNumbers } from './pagination';

describe('visiblePageNumbers', () => {
  it('shows every page for short page ranges', () => {
    expect(visiblePageNumbers(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a compact page window for long page ranges', () => {
    expect(visiblePageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(visiblePageNumbers(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(visiblePageNumbers(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });
});
