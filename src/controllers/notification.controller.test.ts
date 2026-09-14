/**
 * Tests for the internal daily-notifications run endpoint.
 *
 * This is a cron-fired route (Cloud Scheduler -> POST /api/internal/notifications/run,
 * behind internalSecretAuth) with no human watching it in real time, so a silent
 * regression here — e.g. always returning 200 even when the service quietly
 * no-ops — would go unnoticed until shop owners complain their reports stopped.
 *
 * Two contracts locked in:
 *   1. the optional `date` override is parsed correctly (or left undefined so
 *      the service defaults to "today");
 *   2. per-shop failures inside the summary do NOT turn into an HTTP failure —
 *      the run itself succeeded (200) and failures are surfaced in the summary
 *      body, per the explicit comment in notification.controller.ts. Only a
 *      thrown exception from the service itself becomes a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NotificationController } from './notification.controller';
import { NotificationService } from '../services/notification.service';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.send = () => res;
  return res;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationController.run', () => {
  it('calls runDailyNotifications with undefined when no date is given (defaults to "today")', async () => {
    const run = vi.spyOn(NotificationService, 'runDailyNotifications').mockResolvedValue({
      date: '2026-09-14',
      shopsConsidered: 0,
      reportsSent: 0,
      lowStockAlertsSent: 0,
      skipped: 0,
      notEntitled: 0,
      failures: [],
    });

    const req: any = { body: {} };
    const res = mockRes();

    await NotificationController.run(req, res);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('converts a date string in the body into a Date object before calling the service', async () => {
    const run = vi.spyOn(NotificationService, 'runDailyNotifications').mockResolvedValue({
      date: '2026-01-15',
      shopsConsidered: 0,
      reportsSent: 0,
      lowStockAlertsSent: 0,
      skipped: 0,
      notEntitled: 0,
      failures: [],
    });

    const req: any = { body: { date: '2026-01-15' } };
    const res = mockRes();

    await NotificationController.run(req, res);

    expect(run).toHaveBeenCalledOnce();
    const passedArg = run.mock.calls[0][0];
    expect(passedArg).toBeInstanceOf(Date);
    expect((passedArg as Date).getTime()).toBe(new Date('2026-01-15').getTime());
  });

  it('returns 200/success with the exact summary even when it contains per-shop failures', async () => {
    const summaryWithFailures = {
      date: '2026-09-14',
      shopsConsidered: 5,
      reportsSent: 3,
      lowStockAlertsSent: 1,
      skipped: 0,
      notEntitled: 0,
      failures: [
        { shopId: 'shop_a', kind: 'report' as const, error: 'YeboLink: insufficient credits' },
        { shopId: 'shop_b', kind: 'lowStock' as const, error: 'YeboLink: send failed' },
      ],
    };
    vi.spyOn(NotificationService, 'runDailyNotifications').mockResolvedValue(summaryWithFailures);

    const req: any = { body: {} };
    const res = mockRes();

    await NotificationController.run(req, res);

    // The run itself succeeded (200) — failures live inside the summary, not the HTTP status.
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(summaryWithFailures);
  });

  it('returns a 500 via serverError when runDailyNotifications throws', async () => {
    vi.spyOn(NotificationService, 'runDailyNotifications').mockRejectedValue(
      new Error('DB connection failed')
    );

    const req: any = { body: {} };
    const res = mockRes();

    await NotificationController.run(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('DB connection failed');
  });
});
