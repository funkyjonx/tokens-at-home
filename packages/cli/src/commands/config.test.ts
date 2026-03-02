import { describe, it, expect } from 'vitest';
import { maskAuthToken } from './config.js';

describe('maskAuthToken', () => {
  it('returns placeholder when token is missing', () => {
    expect(maskAuthToken(undefined)).toBe('(not set)');
  });

  it('masks short tokens without revealing suffix', () => {
    expect(maskAuthToken('abcd123')).toBe('a***');
  });

  it('masks long tokens with prefix and suffix visible', () => {
    expect(maskAuthToken('sk-1234567890f9e2')).toBe('sk-***...f9e2');
  });
});
