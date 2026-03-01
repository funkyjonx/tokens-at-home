import { describe, it, expect } from 'vitest';
import { mapGitHubLabelsToComplexity } from './types.js';

describe('mapGitHubLabelsToComplexity', () => {
  it('returns null for unrecognized labels', () => {
    expect(mapGitHubLabelsToComplexity(['bug', 'enhancement', 'help wanted'])).toBeNull();
    expect(mapGitHubLabelsToComplexity([])).toBeNull();
  });

  describe('trivial', () => {
    it.each([
      ['good first issue'],
      ['good-first-issue'],
      ['Good First Issue'],
      ['good first contribution'],
      ['beginner'],
      ['beginner-friendly'],
      ['starter'],
      ['first-timer'],
      ['size/XS'],
      ['size/xs'],
      ['size: xs'],
      ['XS'],
    ])('maps %s → trivial', (label) => {
      expect(mapGitHubLabelsToComplexity([label])).toBe('trivial');
    });
  });

  describe('small', () => {
    it.each([
      ['size/S'],
      ['size/s'],
      ['size: s'],
      ['S'],
      ['small'],
      ['effort: easy'],
      ['effort:low'],
      ['complexity: simple'],
      ['complexity:minor'],
    ])('maps %s → small', (label) => {
      expect(mapGitHubLabelsToComplexity([label])).toBe('small');
    });
  });

  describe('medium', () => {
    it.each([
      ['size/M'],
      ['size/m'],
      ['M'],
      ['medium'],
      ['effort: medium'],
      ['effort:moderate'],
      ['complexity: normal'],
    ])('maps %s → medium', (label) => {
      expect(mapGitHubLabelsToComplexity([label])).toBe('medium');
    });
  });

  describe('large', () => {
    it.each([
      ['size/L'],
      ['size/XL'],
      ['size/XXL'],
      ['size/l'],
      ['L'],
      ['XL'],
      ['large'],
      ['effort: large'],
      ['effort:major'],
      ['complexity: hard'],
      ['complexity:high'],
      ['complexity: complex'],
    ])('maps %s → large', (label) => {
      expect(mapGitHubLabelsToComplexity([label])).toBe('large');
    });
  });

  it('returns the first match when multiple labels are present', () => {
    expect(mapGitHubLabelsToComplexity(['bug', 'size/M', 'size/L'])).toBe('medium');
  });

  it('ignores unrelated labels alongside size labels', () => {
    expect(mapGitHubLabelsToComplexity(['wontfix', 'size/S', 'typescript'])).toBe('small');
  });
});
