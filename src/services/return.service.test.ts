import { describe, it, expect } from 'vitest';
import {
  resolveReturnTransition,
  InvalidReturnTransitionError,
} from './return.service';

describe('resolveReturnTransition — legal lifecycle', () => {
  it('approve: PENDING -> APPROVED (applies, not idempotent)', () => {
    const t = resolveReturnTransition('PENDING', 'approve');
    expect(t).toEqual({ nextStatus: 'APPROVED', idempotent: false, appliesCompletion: false });
  });

  it('complete: APPROVED -> COMPLETED is the ONLY transition that applies side effects', () => {
    const t = resolveReturnTransition('APPROVED', 'complete');
    expect(t).toEqual({ nextStatus: 'COMPLETED', idempotent: false, appliesCompletion: true });
  });

  it('reject: PENDING -> REJECTED', () => {
    expect(resolveReturnTransition('PENDING', 'reject').nextStatus).toBe('REJECTED');
  });

  it('reject: APPROVED -> REJECTED', () => {
    expect(resolveReturnTransition('APPROVED', 'reject').nextStatus).toBe('REJECTED');
  });
});

describe('resolveReturnTransition — idempotent terminal no-ops never re-apply effects', () => {
  it('re-completing a COMPLETED return is idempotent and does NOT apply completion', () => {
    const t = resolveReturnTransition('COMPLETED', 'complete');
    expect(t.idempotent).toBe(true);
    expect(t.appliesCompletion).toBe(false);
    expect(t.nextStatus).toBe('COMPLETED');
  });

  it('re-approving an APPROVED return is idempotent', () => {
    expect(resolveReturnTransition('APPROVED', 'approve').idempotent).toBe(true);
  });

  it('re-rejecting a REJECTED return is idempotent', () => {
    expect(resolveReturnTransition('REJECTED', 'reject').idempotent).toBe(true);
  });
});

describe('resolveReturnTransition — illegal transitions throw (terminal-state guard)', () => {
  it('cannot complete straight from PENDING (must approve first)', () => {
    expect(() => resolveReturnTransition('PENDING', 'complete')).toThrow(InvalidReturnTransitionError);
  });

  it('cannot complete a REJECTED return', () => {
    expect(() => resolveReturnTransition('REJECTED', 'complete')).toThrow(InvalidReturnTransitionError);
  });

  it('cannot reject a COMPLETED return (money/stock already moved)', () => {
    expect(() => resolveReturnTransition('COMPLETED', 'reject')).toThrow(InvalidReturnTransitionError);
  });

  it('cannot approve a COMPLETED return', () => {
    expect(() => resolveReturnTransition('COMPLETED', 'approve')).toThrow(InvalidReturnTransitionError);
  });

  it('the thrown error carries a machine-readable code + context', () => {
    try {
      resolveReturnTransition('PENDING', 'complete');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidReturnTransitionError);
      const err = e as InvalidReturnTransitionError;
      expect(err.code).toBe('INVALID_RETURN_TRANSITION');
      expect(err.current).toBe('PENDING');
      expect(err.action).toBe('complete');
    }
  });
});
