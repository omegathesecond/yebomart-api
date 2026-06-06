/**
 * Daily owner notifications — WhatsApp daily sales summary + low-stock alerts.
 *
 * Delivery goes through YeboLink (WhatsApp, SMS fallback). This is the layer the
 * schema always implied (DailyReport.sentViaWhatsApp / lowStock existed but
 * nothing ever sent). Driven by the authenticated internal run endpoint
 * (POST /api/internal/notifications/run), itself fired daily by Cloud Scheduler.
 *
 * No silent fallback (CLAUDE.md): if a send fails we log loudly and leave
 * DailyReport.sentViaWhatsApp false — we never mark a report "sent" that wasn't.
 */

import { prisma } from '@config/prisma';
import { ReportService } from '@services/report.service';
import { YeboLinkClient } from '@services/yebolink.client';

interface TopProduct {
  id: string;
  name: string;
  quantity: number;
  revenue: number;
}

interface LowStockItem {
  id: string;
  name: string;
  quantity: number;
  reorderAt: number;
}

export interface NotificationRunSummary {
  date: string;
  shopsConsidered: number;
  reportsSent: number;
  lowStockAlertsSent: number;
  skipped: number;
  failures: Array<{ shopId: string; kind: 'report' | 'lowStock'; error: string }>;
}

function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Build the daily sales summary message. `report` is the persisted DailyReport
 * row (numbers + topProducts JSON). "Other" = everything that isn't cash.
 */
function buildDailyReportMessage(
  shopName: string,
  currencySymbol: string,
  date: Date,
  report: {
    totalSales: number;
    totalTransactions: number;
    netProfit: number;
    cashSales: number;
    topProducts: TopProduct[];
  },
): string {
  const lines: string[] = [];
  lines.push(`📊 *${shopName}* — Daily Report`);
  lines.push(formatDate(date));
  lines.push('');

  if (report.totalTransactions === 0) {
    lines.push('No sales recorded today.');
    return lines.join('\n');
  }

  const other = report.totalSales - report.cashSales;
  lines.push(`💰 Sales: ${money(currencySymbol, report.totalSales)} (${report.totalTransactions} sale${report.totalTransactions === 1 ? '' : 's'})`);
  lines.push(`   Cash ${money(currencySymbol, report.cashSales)} · Other ${money(currencySymbol, other)}`);
  lines.push(`📈 Net profit: ${money(currencySymbol, report.netProfit)}`);

  const top = report.topProducts.slice(0, 5);
  if (top.length > 0) {
    lines.push('');
    lines.push('🏆 Top products:');
    top.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.name} — ${p.quantity} sold (${money(currencySymbol, p.revenue)})`);
    });
  }

  return lines.join('\n');
}

function buildLowStockMessage(shopName: string, items: LowStockItem[]): string {
  const lines: string[] = [];
  lines.push(`⚠️ *${shopName}* — Low Stock Alert`);
  lines.push(`${items.length} product${items.length === 1 ? '' : 's'} at or below reorder level:`);
  lines.push('');
  items.slice(0, 15).forEach((it) => {
    lines.push(`• ${it.name} — ${it.quantity} left (reorder at ${it.reorderAt})`);
  });
  if (items.length > 15) {
    lines.push(`…and ${items.length - 15} more.`);
  }
  return lines.join('\n');
}

export class NotificationService {
  /**
   * Run the daily notification pass for every opted-in shop.
   *
   * For each ACTIVE shop with at least one toggle on:
   *  - notifyWhatsAppReports → generate + persist the DailyReport, send the
   *    sales summary, mark sentViaWhatsApp=true on success.
   *  - notifyLowStock → send a low-stock alert IF there are items at/under
   *    reorderAt (no message when nothing is low).
   *
   * `date` defaults to "now" (run is scheduled for end of business day). Sends
   * are independent: one failing channel doesn't block the other shop/toggle.
   */
  static async runDailyNotifications(date: Date = new Date()): Promise<NotificationRunSummary> {
    const summary: NotificationRunSummary = {
      date: formatDate(date),
      shopsConsidered: 0,
      reportsSent: 0,
      lowStockAlertsSent: 0,
      skipped: 0,
      failures: [],
    };

    const shops = await prisma.shop.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ notifyWhatsAppReports: true }, { notifyLowStock: true }],
      },
      select: {
        id: true,
        name: true,
        currencySymbol: true,
        ownerPhone: true,
        notifyPhone: true,
        notifyWhatsAppReports: true,
        notifyLowStock: true,
      },
    });

    summary.shopsConsidered = shops.length;

    for (const shop of shops) {
      const recipient = shop.notifyPhone ?? shop.ownerPhone;
      if (!recipient) {
        // No phone to send to — nothing we can do; count and move on.
        console.warn(`[notifications] shop ${shop.id} (${shop.name}) has no recipient phone; skipping`);
        summary.skipped++;
        continue;
      }

      // Generate + persist the daily report once; both messages read from it.
      const report = await ReportService.generateDailyReport(shop.id, date);
      const topProducts = (report.topProducts as unknown as TopProduct[]) ?? [];
      const lowStock = (report.lowStock as unknown as LowStockItem[]) ?? [];

      if (shop.notifyWhatsAppReports) {
        try {
          const text = buildDailyReportMessage(shop.name, shop.currencySymbol, date, {
            totalSales: report.totalSales,
            totalTransactions: report.totalTransactions,
            netProfit: report.netProfit,
            cashSales: report.cashSales,
            topProducts,
          });
          await YeboLinkClient.sendTextWithFallback(recipient, text);
          await prisma.dailyReport.update({
            where: { id: report.id },
            data: { sentViaWhatsApp: true, sentAt: new Date() },
          });
          summary.reportsSent++;
        } catch (err: any) {
          // Loud failure; leave sentViaWhatsApp false so we know it didn't go.
          console.error(`[notifications] daily report send FAILED for shop ${shop.id} (${shop.name}): ${err?.message ?? err}`);
          summary.failures.push({ shopId: shop.id, kind: 'report', error: err?.message ?? String(err) });
        }
      }

      if (shop.notifyLowStock && lowStock.length > 0) {
        try {
          const text = buildLowStockMessage(shop.name, lowStock);
          await YeboLinkClient.sendTextWithFallback(recipient, text);
          summary.lowStockAlertsSent++;
        } catch (err: any) {
          console.error(`[notifications] low-stock alert send FAILED for shop ${shop.id} (${shop.name}): ${err?.message ?? err}`);
          summary.failures.push({ shopId: shop.id, kind: 'lowStock', error: err?.message ?? String(err) });
        }
      }
    }

    console.log(
      `[notifications] run complete (${summary.date}): considered=${summary.shopsConsidered} reports=${summary.reportsSent} lowStock=${summary.lowStockAlertsSent} skipped=${summary.skipped} failures=${summary.failures.length}`,
    );

    return summary;
  }
}
