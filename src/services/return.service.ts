import { ReturnStatus } from '@prisma/client';

/**
 * Return state-machine rules.
 *
 * The legal lifecycle is PENDING → APPROVED → COMPLETED, with REJECTED as an
 * alternative terminal state reachable from PENDING or APPROVED:
 *
 *     PENDING ──approve──▶ APPROVED ──complete──▶ COMPLETED  (terminal)
 *        │                    │
 *        └──────reject────────┴────────▶ REJECTED            (terminal)
 *
 * This pure resolver is extracted from the controller so the guard can be unit
 * tested without a DB. It fixes two money-integrity holes:
 *
 *   1. `complete` used to be reachable directly from PENDING (skipping the
 *      approval step) and could be re-run on an already-COMPLETED return,
 *      re-running the restock/deduct loops and inflating stock. Now `complete`
 *      requires APPROVED, and re-completing a COMPLETED return is reported as an
 *      idempotent no-op (so the caller does NOT re-apply the stock/money side
 *      effects).
 *   2. COMPLETED and REJECTED are terminal — no action moves a return out of
 *      them (re-issuing the same terminal action is treated as idempotent).
 */

export type ReturnAction = 'approve' | 'reject' | 'complete';

export interface ReturnTransition {
  /** The status the return should hold after this action. */
  nextStatus: ReturnStatus;
  /**
   * True when the action targets a state the return is already in (a terminal
   * no-op). The caller MUST NOT re-apply side effects (restock, stock-out,
   * cash/credit booking) when this is true — it exists purely to make the
   * endpoint idempotent under double-submits/retries.
   */
  idempotent: boolean;
  /**
   * True only on the single legal transition that actually completes a return
   * (APPROVED → COMPLETED). The stock + money side effects run only then.
   */
  appliesCompletion: boolean;
}

/** Thrown when an action is not legal for the return's current status. */
export class InvalidReturnTransitionError extends Error {
  readonly code = 'INVALID_RETURN_TRANSITION';
  readonly current: ReturnStatus;
  readonly action: ReturnAction;
  constructor(current: ReturnStatus, action: ReturnAction) {
    super(`Cannot ${action} a return that is ${current}`);
    this.name = 'InvalidReturnTransitionError';
    this.current = current;
    this.action = action;
  }
}

/**
 * Resolve what an action does given the return's current status, or throw
 * InvalidReturnTransitionError if the action is illegal. Pure — no DB access.
 */
export function resolveReturnTransition(
  current: ReturnStatus,
  action: ReturnAction,
): ReturnTransition {
  switch (action) {
    case 'approve':
      if (current === 'PENDING') return { nextStatus: 'APPROVED', idempotent: false, appliesCompletion: false };
      if (current === 'APPROVED') return { nextStatus: 'APPROVED', idempotent: true, appliesCompletion: false };
      // COMPLETED / REJECTED are terminal.
      throw new InvalidReturnTransitionError(current, action);

    case 'reject':
      if (current === 'PENDING' || current === 'APPROVED')
        return { nextStatus: 'REJECTED', idempotent: false, appliesCompletion: false };
      if (current === 'REJECTED') return { nextStatus: 'REJECTED', idempotent: true, appliesCompletion: false };
      // Cannot reject a COMPLETED return — the money/stock have already moved.
      throw new InvalidReturnTransitionError(current, action);

    case 'complete':
      // Must be APPROVED first — no skipping straight from PENDING.
      if (current === 'APPROVED')
        return { nextStatus: 'COMPLETED', idempotent: false, appliesCompletion: true };
      // Re-completing is an idempotent no-op: do NOT re-run the side effects.
      if (current === 'COMPLETED')
        return { nextStatus: 'COMPLETED', idempotent: true, appliesCompletion: false };
      throw new InvalidReturnTransitionError(current, action);

    default:
      // Exhaustiveness guard — never silently accept an unknown action.
      throw new InvalidReturnTransitionError(current, action as ReturnAction);
  }
}
