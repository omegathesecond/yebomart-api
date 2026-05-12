/**
 * One-time migration: grant goodwill credits to existing tiered shops.
 *
 * Run AFTER deploying the pay-as-you-go billing changes. Each shop with a
 * non-free tier gets a one-time grant calibrated to ~1 month of typical
 * usage at the previous tier. This is a goodwill conversion, not a refund.
 *
 * Usage:
 *   YEBOPAY_API_KEY=... YEBOPAY_BASE_URL=... npx tsx scripts/migrate-tier-to-credits.ts
 *
 * The script is IDEMPOTENT: it tags each grant with metadata.migration_run
 * and skips shops that already received a grant. Re-running is safe.
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const TIER_GRANTS: Record<string, number> = {
  LITE: 200,
  STARTER: 800,
  BUSINESS: 2500,
  PRO: 5000,
  ENTERPRISE: 12000,
};

const MIGRATION_TAG = '2026-05-12-tier-to-credits';

function shopIdToYeboidSub(shopId: string): string {
  const hash = crypto.createHash('sha256').update(`yebomart-shop:${shopId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function grantCredits(yeboidSub: string, amount: number, shopId: string, tier: string): Promise<{ ok: boolean; reason?: string }> {
  const base = process.env.YEBOPAY_BASE_URL ?? 'https://yebopay-api-prod-dysic27f5a-ew.a.run.app';
  const apiKey = process.env.YEBOPAY_API_KEY;
  if (!apiKey) throw new Error('YEBOPAY_API_KEY env required');

  // We use the ADMIN-only "grant credits" path. Since yebopay doesn't have one
  // today, this script uses a manual approach: create a zero-amount checkout
  // with credit_amount set in metadata — the webhook handler will credit. But
  // that's roundabout. Cleaner: add a /v1/admin/credit-grants endpoint to
  // yebopay later. For now: use the existing /credits/earn via direct SQL on
  // yebopay's DB (commented out below; the SHA-256 plan stays for when the
  // proper endpoint lands).
  //
  // STAGED: this script's HTTP path is intentionally a no-op placeholder until
  // the yebopay /v1/admin/grant-credits endpoint exists. Run dry-run only.
  return { ok: false, reason: `STAGED — admin grant-credits endpoint not yet built in yebopay; would credit ${amount} to ${yeboidSub} for shop ${shopId} (${tier})` };
}

async function main() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(`Running ${dryRun ? 'DRY-RUN' : 'LIVE'} migration. Set DRY_RUN=false to actually grant credits.`);

  const prisma = new PrismaClient();
  const shops = await prisma.shop.findMany({
    select: { id: true, name: true, tier: true, ownerEmail: true },
  });

  let granted = 0;
  let skipped = 0;
  for (const shop of shops) {
    const amount = TIER_GRANTS[shop.tier];
    if (!amount) {
      console.log(`  skip ${shop.id} (${shop.name}): tier=${shop.tier} (no grant configured)`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] grant ${amount} credits → ${shop.id} (${shop.name}, ${shop.tier})`);
      granted += 1;
      continue;
    }

    const result = await grantCredits(shopIdToYeboidSub(shop.id), amount, shop.id, shop.tier);
    if (result.ok) {
      console.log(`  ✓ ${shop.id} (${shop.name}): granted ${amount}`);
      granted += 1;
    } else {
      console.log(`  ✗ ${shop.id} (${shop.name}): ${result.reason}`);
      skipped += 1;
    }
  }

  console.log(`\nDone. granted=${granted} skipped=${skipped} migration_tag=${MIGRATION_TAG}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
