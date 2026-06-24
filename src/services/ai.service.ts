import { GoogleGenerativeAI } from '@google/generative-ai';
import { prisma } from '@config/prisma';
import { SaleService } from './sale.service';
import { StockService } from './stock.service';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

interface ChatInput {
  shopId: string;
  message: string;
}

interface InsightInput {
  shopId: string;
}

export class AIService {
  private static genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  /**
   * Get time context for proactive suggestions
   */
  private static getTimeContext() {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    let period: string;
    let mood: string;
    let suggestion: string;

    if (hour >= 5 && hour < 9) {
      period = 'early morning';
      mood = 'energetic';
      suggestion = 'Great time to check stock before the morning rush!';
    } else if (hour >= 9 && hour < 12) {
      period = 'morning';
      mood = 'busy';
      suggestion = 'Morning rush hour! Focus on quick service.';
    } else if (hour >= 12 && hour < 14) {
      period = 'lunch time';
      mood = 'peak';
      suggestion = 'Lunch crowd incoming - snacks and drinks should be ready!';
    } else if (hour >= 14 && hour < 17) {
      period = 'afternoon';
      mood = 'steady';
      suggestion = 'Good time to restock shelves or review inventory.';
    } else if (hour >= 17 && hour < 20) {
      period = 'evening';
      mood = 'winding down';
      suggestion = 'After-work customers coming - dinner items and takeaways popular now.';
    } else if (hour >= 20 && hour < 23) {
      period = 'night';
      mood = 'closing time';
      suggestion = 'Time to count cash and prepare for tomorrow!';
    } else {
      period = 'late night';
      mood = 'rest';
      suggestion = 'Shop should be closed - get some rest, boss!';
    }

    return { hour, period, mood, suggestion, isWeekend, dayOfWeek };
  }

  /**
   * Get comprehensive shop context for AI
   */
  private static async getShopContext(shopId: string) {
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const [shop, dailySummary, lowStock, recentSales, allProducts, weekSales, productSaleStats] = await Promise.all([
      prisma.shop.findUnique({
        where: { id: shopId },
        select: {
          name: true,
          ownerName: true,
          assistantName: true,
          currency: true,
        },
      }),
      SaleService.getDailySummary(shopId),
      StockService.getLowStockAlerts(shopId),
      prisma.sale.findMany({
        where: { shopId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          items: { select: { productName: true, quantity: true, totalPrice: true } }
        }
      }),
      prisma.product.findMany({
        where: { shopId, isActive: true },
        select: { 
          id: true,
          name: true, 
          quantity: true, 
          sellPrice: true, 
          costPrice: true,
          category: true,
          createdAt: true,
        },
        take: 100
      }),
      // Weekly sales aggregation
      prisma.sale.aggregate({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: weekAgo },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
      // Get sale items with product info for slow movers analysis
      prisma.saleItem.groupBy({
        by: ['productId'],
        where: {
          sale: {
            shopId,
            status: 'COMPLETED',
            createdAt: { gte: monthAgo },
          }
        },
        _sum: { quantity: true },
        _count: true,
      })
    ]);

    // Calculate slow movers (products with low/no sales in past month)
    const productSalesMap = new Map(productSaleStats.map(ps => [ps.productId, ps._sum.quantity || 0]));
    const slowMovers = allProducts
      .filter(p => {
        const soldQty = productSalesMap.get(p.id) || 0;
        const daysSinceCreated = Math.floor((now.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24));
        // Product exists for at least 7 days and sold less than 5 units in 30 days
        return daysSinceCreated >= 7 && soldQty < 5;
      })
      .map(p => ({
        name: p.name,
        quantity: p.quantity,
        sellPrice: p.sellPrice,
        soldLast30Days: productSalesMap.get(p.id) || 0,
        stockValue: p.quantity * (p.costPrice || p.sellPrice * 0.7), // Estimate if no buy price
      }))
      .sort((a, b) => a.soldLast30Days - b.soldLast30Days)
      .slice(0, 10);

    // Calculate profit margins
    const productsWithMargins = allProducts
      .filter(p => p.costPrice && p.costPrice > 0)
      .map(p => ({
        name: p.name,
        margin: ((p.sellPrice - (p.costPrice || 0)) / p.sellPrice) * 100,
        sellPrice: p.sellPrice,
        costPrice: p.costPrice,
      }))
      .sort((a, b) => a.margin - b.margin);

    const lowMarginProducts = productsWithMargins.filter(p => p.margin < 15).slice(0, 5);
    const highMarginProducts = productsWithMargins.filter(p => p.margin >= 30).slice(-5).reverse();

    return {
      shop,
      todaySales: dailySummary,
      lowStockAlerts: lowStock,
      recentSales,
      allProducts,
      weekSales: {
        total: weekSales._sum.totalAmount || 0,
        count: weekSales._count || 0,
      },
      slowMovers,
      lowMarginProducts,
      highMarginProducts,
      timeContext: this.getTimeContext(),
    };
  }

  /**
   * Chat with AI assistant
   */
  static async chat(input: ChatInput) {
    if (!GEMINI_API_KEY) {
      throw new Error('AI service not configured');
    }

    const context = await this.getShopContext(input.shopId);
    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Build detailed low stock list
    const allLowStock = [
      ...context.lowStockAlerts.items.critical,
      ...context.lowStockAlerts.items.low,
      ...context.lowStockAlerts.items.warning,
    ];

    const lowStockList = allLowStock.length > 0
      ? allLowStock.map(p => {
          const status = p.quantity === 0 ? '🔴 OUT OF STOCK' : p.quantity <= 2 ? '🟠 CRITICAL' : '🟡 LOW';
          return `- ${p.name}: ${p.quantity} ${p.unit || 'units'} left (reorder at ${p.reorderAt}) ${status}`;
        }).join('\n')
      : 'All products are well stocked! ✅';

    // Build recent sales summary
    const recentSalesList = context.recentSales.length > 0
      ? context.recentSales.slice(0, 5).map((s, i) => {
          const items = s.items.map(item => `${item.productName} x${item.quantity}`).join(', ');
          return `${i + 1}. E${s.totalAmount.toFixed(2)} - ${items}`;
        }).join('\n')
      : 'No recent sales yet';

    // Build product inventory snapshot
    const inventorySnapshot = context.allProducts.slice(0, 20).map(p => 
      `- ${p.name}: ${p.quantity} in stock @ E${p.sellPrice}`
    ).join('\n');

    // Build slow movers list
    const slowMoversList = context.slowMovers.length > 0
      ? context.slowMovers.map(p => 
          `- ${p.name}: Only ${p.soldLast30Days} sold in 30 days, ${p.quantity} sitting in stock (E${p.stockValue.toFixed(0)} tied up)`
        ).join('\n')
      : 'All products moving well! 🎉';

    // Build margin insights
    const marginInsights = context.lowMarginProducts.length > 0
      ? `LOW MARGIN (consider price increase): ${context.lowMarginProducts.map(p => `${p.name} (${p.margin.toFixed(0)}%)`).join(', ')}`
      : '';
    
    const highMarginList = context.highMarginProducts.length > 0
      ? `HIGH MARGIN (push these!): ${context.highMarginProducts.map(p => `${p.name} (${p.margin.toFixed(0)}%)`).join(', ')}`
      : '';

    const timeCtx = context.timeContext;
    
    const systemPrompt = `You are ${context.shop?.assistantName || 'Yebo'}, a smart business partner for "${context.shop?.name || 'the shop'}".

OWNER: ${context.shop?.ownerName || 'Boss'}
CURRENCY: ${context.shop?.currency || 'SZL'} (symbol: E)
TIME: ${timeCtx.period} | ${timeCtx.isWeekend ? 'Weekend' : 'Weekday'}

═══════════════════════════════════════
📊 LIVE BUSINESS DATA (USE THIS!)
═══════════════════════════════════════

TODAY: E${context.todaySales.totalSales.toFixed(2)} from ${context.todaySales.totalTransactions} sales (avg basket: E${context.todaySales.averageBasket.toFixed(2)})
THIS WEEK: E${context.weekSales.total.toFixed(2)} from ${context.weekSales.count} sales

TOP SELLERS TODAY:
${context.todaySales.topProducts.length > 0 
  ? context.todaySales.topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} sold (E${p.revenue.toFixed(2)})`).join('\n')
  : '(no sales yet)'}

SLOW MOVERS (last 30 days):
${slowMoversList}

PROFIT MARGINS:
${marginInsights}
${highMarginList}

LOW STOCK (${context.lowStockAlerts.total} items):
${lowStockList}

RECENT SALES:
${recentSalesList}

INVENTORY (${context.allProducts.length} products):
${inventorySnapshot}

═══════════════════════════════════════
🧠 YOU ARE A BUSINESS ANALYST
═══════════════════════════════════════

You have FULL ACCESS to all product, sales, and inventory data above.
You CAN and SHOULD analyze it to answer ANY business question:

QUESTIONS YOU CAN ANSWER (examples):
- "What are my slow movers?" → Look at SLOW MOVERS data, list them with recommendations
- "Which products should I discount?" → Analyze slow movers + high stock = suggest discounts
- "What's making me the most money?" → Look at top sellers + margins
- "What should I restock?" → Check low stock + top sellers
- "How's business this week?" → Compare today vs week, give honest assessment
- "What products aren't selling?" → Slow movers analysis
- "Should I order more [product]?" → Check current stock vs sales velocity

HOW TO RESPOND:
1. ANALYZE the data above to find the answer
2. Give SPECIFIC product names and numbers
3. Make a RECOMMENDATION (don't just list data)
4. Ask if they want to take action: "Should I...?" or "Want me to...?"

EXAMPLES OF GOOD RESPONSES:

User: "What's not selling?"
You: "3 products are barely moving:
• Old Chips - only 2 sold this month, 50 sitting there (E500 stuck!)
• Stale Biscuits - 0 sold, 30 in stock
• Fancy Soap - 1 sold, 20 left

That's about E800 tied up in dead stock. Want me to suggest discount prices to clear them?"

User: "How's today going?"
You: "Slow start - E${context.todaySales.totalSales.toFixed(0)} so far from ${context.todaySales.totalTransactions} sales. ${context.todaySales.totalTransactions > 0 ? `${context.todaySales.topProducts[0]?.name || 'Bread'} is your top seller.` : 'No sales yet.'} ${timeCtx.period === 'morning' ? 'Still early though!' : timeCtx.period === 'afternoon' ? 'Afternoon rush coming!' : 'Evening now.'}"

User: "hi" or "hello"
You: Keep it SHORT! "Hey boss! ${context.todaySales.totalTransactions > 0 ? `E${context.todaySales.totalSales.toFixed(0)} so far today.` : 'No sales yet.'} What do you need?"

PERSONALITY:
- Talk like a friend who's great with numbers
- Short responses for simple questions
- Celebrate wins: "E500 already! 🔥"
- Be honest about problems: "These slow movers are killing your cash flow"
- Always suggest next action

NEVER SAY:
- "I don't have access to that data" (YOU DO - it's above!)
- "I can't calculate that" (YOU CAN - do the math!)
- Long paragraphs when bullets work better
- Suggest an action or ask what to do next
- Be the assistant who makes their life EASIER`;

    // Generate smart greeting based on context
    let smartGreeting = '';
    const ownerName = context.shop?.ownerName || 'boss';
    const assistantName = context.shop?.assistantName || 'Yebo';
    
    if (timeCtx.hour >= 5 && timeCtx.hour < 12) {
      smartGreeting = `Good morning, ${ownerName}! ☀️`;
    } else if (timeCtx.hour >= 12 && timeCtx.hour < 17) {
      smartGreeting = `Hey ${ownerName}! 👋`;
    } else if (timeCtx.hour >= 17 && timeCtx.hour < 21) {
      smartGreeting = `Good evening, ${ownerName}! 🌆`;
    } else {
      smartGreeting = `Hey ${ownerName}, you're up late! 🌙`;
    }

    // Add contextual opening based on shop status
    let contextualOpening = '';
    if (context.todaySales.totalTransactions === 0) {
      contextualOpening = `No sales yet today - let's change that! What can I help with?`;
    } else if (context.todaySales.totalSales > 1000) {
      contextualOpening = `Great day so far - E${context.todaySales.totalSales.toFixed(0)} in sales! 🔥 What do you need?`;
    } else if (context.lowStockAlerts.items.critical.length > 0) {
      const criticalCount = context.lowStockAlerts.items.critical.length;
      contextualOpening = `Heads up: ${criticalCount} product${criticalCount > 1 ? 's are' : ' is'} out of stock! Want the list?`;
    } else if (context.slowMovers.length > 5) {
      contextualOpening = `I've noticed some products aren't moving - might be worth discussing. What's on your mind?`;
    } else {
      contextualOpening = `I'm ${assistantName}, your shop assistant. What do you need?`;
    }

    const chat = model.startChat({
      history: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }],
        },
        {
          role: 'model',
          parts: [{ text: `${smartGreeting} ${contextualOpening}` }],
        },
      ],
    });

    const result = await chat.sendMessage(input.message);
    const response = result.response.text();

    // Store conversation
    await prisma.aIConversation.create({
      data: {
        shopId: input.shopId,
        userMessage: input.message,
        aiResponse: response,
        type: 'TEXT',
        context: {
          todaySales: context.todaySales.totalSales,
          transactions: context.todaySales.totalTransactions,
          lowStockCount: context.lowStockAlerts.total,
        },
      },
    });

    return {
      message: response,
      assistantName: context.shop?.assistantName || 'Yebo',
    };
  }

  /**
   * Process voice query
   */
  static async voice(shopId: string, transcription: string) {
    const result = await this.chat({
      shopId,
      message: transcription,
    });

    await prisma.aIConversation.updateMany({
      where: {
        shopId,
        userMessage: transcription,
      },
      data: {
        type: 'VOICE',
      },
    });

    return result;
  }

  /**
   * Generate AI insights.
   *
   * Fails loudly (no silent fallback — see CLAUDE.md). If Gemini is unconfigured,
   * errors, or returns a body we can't parse into the insights JSON, this THROWS
   * — exactly like chat() does. It must NEVER return locally-computed canned
   * "insights" dressed up as a real AI result, because:
   *   1. the customer would be misled into thinking the AI ran when it didn't, and
   *   2. the /insights route authorises a credit charge for this call. Serving
   *      fake data on a Gemini outage used to charge the shop for an AI call that
   *      never happened AND hide the outage. The charge is now settled only AFTER
   *      this resolves successfully (see ai.routes.ts + settlePendingCharge), so a
   *      thrown error here means the shop is never billed for the failed call.
   */
  static async generateInsights(input: InsightInput) {
    if (!GEMINI_API_KEY) {
      throw new Error('AI service not configured');
    }

    const context = await this.getShopContext(input.shopId);
    
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const weekSales = await prisma.sale.aggregate({
      where: {
        shopId: input.shopId,
        status: 'COMPLETED',
        createdAt: { gte: weekAgo },
      },
      _sum: { totalAmount: true },
      _count: true,
    });

    const allLowStock = [
      ...context.lowStockAlerts.items.critical,
      ...context.lowStockAlerts.items.low,
    ];

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Generate 3-5 specific, actionable business insights for this shop:

TODAY'S SALES: E${context.todaySales.totalSales.toFixed(2)} (${context.todaySales.totalTransactions} transactions)
THIS WEEK: E${weekSales._sum.totalAmount || 0} (${weekSales._count} transactions)
AVERAGE BASKET: E${context.todaySales.averageBasket.toFixed(2)}

LOW STOCK PRODUCTS (${allLowStock.length} items):
${allLowStock.map(p => `- ${p.name}: ${p.quantity} left`).join('\n') || 'None'}

TOP SELLERS TODAY:
${context.todaySales.topProducts.map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} units, E${p.revenue}`).join('\n') || 'No sales yet'}

Generate insights as JSON array with:
- title: Short catchy title (3-5 words)
- insight: Specific insight mentioning actual product names and numbers
- action: Clear action step
- priority: "high", "medium", or "low"

Return ONLY valid JSON array, no markdown.`;

    // Let Gemini errors propagate — a failed AI call must surface as a 5xx
    // (handled by the controller), never be swallowed into canned data.
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // The model answered but not in the JSON shape we asked for. That's a
      // real failure of the AI call — fail loud rather than fabricate insights.
      throw new Error('AI insights response did not contain valid JSON');
    }

    // JSON.parse throwing on malformed output also propagates by design.
    const insights = JSON.parse(jsonMatch[0]);

    await prisma.aIConversation.create({
      data: {
        shopId: input.shopId,
        userMessage: 'Generate insights',
        aiResponse: JSON.stringify(insights),
        type: 'INSIGHT',
      },
    });

    return { insights, generated: new Date() };
  }

  /**
   * Get slow-moving products analysis
   */
  static async getSlowMovers(shopId: string) {
    const context = await this.getShopContext(shopId);
    
    return {
      slowMovers: context.slowMovers,
      totalStockValue: context.slowMovers.reduce((sum, p) => sum + p.stockValue, 0),
      recommendations: context.slowMovers.slice(0, 3).map(p => ({
        product: p.name,
        suggestion: p.soldLast30Days === 0 
          ? `${p.name} hasn't sold at all! Consider 50% off or bundling.`
          : `${p.name} is slow. Try a ${Math.min(30, Math.floor((1 - p.soldLast30Days / 5) * 100))}% discount.`,
        potentialRecovery: p.stockValue * 0.7, // Estimate 70% recovery with discount
      })),
    };
  }

  /**
   * Get actionable business summary
   */
  static async getBusinessSummary(shopId: string) {
    const context = await this.getShopContext(shopId);
    const timeCtx = context.timeContext;

    const urgentActions: string[] = [];
    const suggestions: string[] = [];

    // Check critical stock
    if (context.lowStockAlerts.items.critical.length > 0) {
      urgentActions.push(`🚨 RESTOCK: ${context.lowStockAlerts.items.critical.map(p => p.name).join(', ')}`);
    }

    // Check slow movers
    if (context.slowMovers.length > 5) {
      const deadStockValue = context.slowMovers.reduce((sum, p) => sum + p.stockValue, 0);
      suggestions.push(`💸 E${deadStockValue.toFixed(0)} tied up in slow stock - consider a clearance sale`);
    }

    // Time-based suggestions
    if (timeCtx.hour >= 20) {
      suggestions.push(`🌙 It's ${timeCtx.period} - time to close up and rest!`);
    } else if (timeCtx.hour >= 12 && timeCtx.hour < 14) {
      suggestions.push(`🍔 Lunch rush! Make sure snacks and drinks are visible`);
    }

    // Sales performance
    const salesStatus = context.todaySales.totalTransactions === 0 
      ? '⚠️ No sales yet - time to hustle!'
      : context.todaySales.totalSales > context.weekSales.total / 7
        ? '🔥 Above average day!'
        : '📊 Normal day so far';

    return {
      greeting: `${timeCtx.period.charAt(0).toUpperCase() + timeCtx.period.slice(1)} update for ${context.shop?.name}`,
      salesStatus,
      todaySales: context.todaySales.totalSales,
      weekSales: context.weekSales.total,
      urgentActions,
      suggestions,
      topSeller: context.todaySales.topProducts[0]?.name || null,
      lowStockCount: context.lowStockAlerts.total,
      slowMoversCount: context.slowMovers.length,
    };
  }
}
