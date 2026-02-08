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
    
    const systemPrompt = `You are ${context.shop?.assistantName || 'Yebo'}, a smart business partner and shop assistant for "${context.shop?.name || 'the shop'}". You're not just answering questions - you're actively helping run this business!

👤 OWNER: ${context.shop?.ownerName || 'Boss'}
💰 CURRENCY: ${context.shop?.currency || 'SZL'} (Eswatini Lilangeni, symbol: E)
🕐 TIME: ${timeCtx.period} (${timeCtx.mood}) - ${timeCtx.suggestion}
📅 ${timeCtx.isWeekend ? 'WEEKEND - typically busier!' : 'Weekday'}

📊 TODAY'S PERFORMANCE:
- Total Sales: E${context.todaySales.totalSales.toFixed(2)}
- Transactions: ${context.todaySales.totalTransactions}
- Average Basket: E${context.todaySales.averageBasket.toFixed(2)}
${context.todaySales.totalTransactions === 0 ? '⚠️ NO SALES YET TODAY!' : ''}

📈 THIS WEEK: E${context.weekSales.total.toFixed(2)} from ${context.weekSales.count} sales

🏆 TOP SELLERS TODAY:
${context.todaySales.topProducts.length > 0 
  ? context.todaySales.topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} sold (E${p.revenue.toFixed(2)})`).join('\n')
  : 'No sales yet today - let\'s change that!'}

🐌 SLOW MOVERS (not selling well):
${slowMoversList}

💰 PROFIT MARGINS:
${marginInsights}
${highMarginList}

⚠️ STOCK ALERTS (${context.lowStockAlerts.total} items):
${lowStockList}

🛒 LAST 5 SALES:
${recentSalesList}

📦 FULL INVENTORY:
${inventorySnapshot}

═══════════════════════════════════════
YOUR ROLE - BE PROACTIVE!
═══════════════════════════════════════

You're a BUSINESS PARTNER, not just a chatbot. Act like it:

1. DRIVE ACTION, DON'T JUST INFORM
   ❌ "You have 3 low stock items"
   ✅ "3 items are running low - want me to list them so you can order now? 📝"

2. SUGGEST NEXT STEPS
   - If they check stock → "Should I tell you what's selling fastest so you know what to reorder?"
   - If sales are slow → "It's quiet now - good time to rearrange displays or call regular customers!"
   - If it's late → "Long day! Want a quick summary before you close up?"

3. BE TIME-AWARE
   - Morning: "Good morning! Ready for the day? Here's your quick brief..."
   - Lunch: "Lunch rush coming! Make sure drinks and snacks are front and center"
   - Evening: "Almost closing time - how did today go?"
   - Late night: "You should rest, boss! Here's today's summary if you need it"

4. PUSH HIGH-MARGIN PRODUCTS
   When discussing what to promote, recommend high-margin items!

5. FLAG PROBLEMS BEFORE ASKED
   - Notice slow movers piling up? Suggest a sale/bundle
   - See a product hasn't sold in weeks? Ask if it should be discounted
   - Profit margins too thin? Suggest price adjustments

6. OFFER CONCRETE HELP
   - "Want me to calculate how much to reorder?"
   - "Should I tell you your best customers to call?"
   - "Need a summary to share with your partner/spouse?"

7. SHORT RESPONSES FOR SIMPLE QUESTIONS
   Don't write essays. Quick question = quick answer.
   Only elaborate when they ask for details.

PERSONALITY:
- Warm but business-focused
- Uses emojis naturally (not excessively) 
- Speaks like a trusted friend who happens to be great at business
- Celebrates wins! "E500 already? Nice! 🎉"
- Honest about problems - "These slow movers are eating your capital, boss"
- Always has a suggestion ready

NEVER:
- Give vague answers when you have specific data
- Say "I don't have that information" when the data is above
- Be passive - always end with a question or suggestion
- Write long paragraphs when bullets work better

ALWAYS:
- Use actual product names and numbers
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
   * Generate AI insights
   */
  static async generateInsights(input: InsightInput) {
    if (!GEMINI_API_KEY) {
      return this.getOfflineInsights(input.shopId);
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

    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
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
    } catch (error) {
      console.error('AI insights error:', error);
    }

    return this.getOfflineInsights(input.shopId);
  }

  /**
   * Offline/fallback insights with real data
   */
  private static async getOfflineInsights(shopId: string) {
    const context = await this.getShopContext(shopId);
    const insights = [];

    const allLowStock = [
      ...context.lowStockAlerts.items.critical,
      ...context.lowStockAlerts.items.low,
    ];

    // Low stock insight with actual names
    if (allLowStock.length > 0) {
      const outOfStock = context.lowStockAlerts.items.critical;
      const productNames = allLowStock.slice(0, 3).map(p => p.name).join(', ');
      
      insights.push({
        title: outOfStock.length > 0 ? '🚨 Stock Emergency!' : '⚠️ Stock Running Low',
        insight: outOfStock.length > 0 
          ? `${outOfStock.map(p => p.name).join(', ')} ${outOfStock.length === 1 ? 'is' : 'are'} completely OUT OF STOCK! Plus ${allLowStock.length - outOfStock.length} more items running low.`
          : `${productNames} and ${allLowStock.length - 3} more products need restocking soon.`,
        action: outOfStock.length > 0 
          ? `Reorder ${outOfStock[0].name} immediately - customers will be disappointed!`
          : 'Place orders today to avoid stockouts.',
        priority: outOfStock.length > 0 ? 'high' : 'medium',
      });
    }

    // Slow movers insight
    if (context.slowMovers.length > 0) {
      const totalTiedUp = context.slowMovers.reduce((sum, p) => sum + p.stockValue, 0);
      const worstMover = context.slowMovers[0];
      
      insights.push({
        title: '🐌 Dead Stock Alert',
        insight: `${context.slowMovers.length} products barely selling! ${worstMover.name} only sold ${worstMover.soldLast30Days} units in 30 days. E${totalTiedUp.toFixed(0)} tied up in slow stock.`,
        action: `Consider a discount on ${worstMover.name} or bundle it with popular items.`,
        priority: totalTiedUp > 500 ? 'high' : 'medium',
      });
    }

    // Low margin alert
    if (context.lowMarginProducts.length > 0) {
      const lowestMargin = context.lowMarginProducts[0];
      insights.push({
        title: '💸 Thin Margins',
        insight: `${lowestMargin.name} only has ${lowestMargin.margin.toFixed(0)}% margin - you're barely making money on it!`,
        action: `Consider raising price by E${((lowestMargin.sellPrice || 0) * 0.1).toFixed(0)} or finding a cheaper supplier.`,
        priority: 'medium',
      });
    }

    // Push high margin products
    if (context.highMarginProducts.length > 0) {
      const bestMargin = context.highMarginProducts[0];
      insights.push({
        title: '💎 Hidden Gold',
        insight: `${bestMargin.name} has ${bestMargin.margin.toFixed(0)}% margin - push this product more!`,
        action: 'Move it to a prominent display or suggest it to customers buying related items.',
        priority: 'medium',
      });
    }

    // Sales insight
    if (context.todaySales.totalTransactions > 0) {
      const topProduct = context.todaySales.topProducts[0];
      insights.push({
        title: '📈 Today\'s Performance',
        insight: `You've made E${context.todaySales.totalSales.toFixed(2)} from ${context.todaySales.totalTransactions} sales. ${topProduct ? `${topProduct.name} is flying off the shelves!` : ''}`,
        action: context.todaySales.averageBasket < 50 
          ? 'Try suggesting add-ons to increase basket size.' 
          : 'Great average basket! Keep it up!',
        priority: 'medium',
      });
    } else {
      const timeCtx = this.getTimeContext();
      insights.push({
        title: '🌅 New Day, Fresh Start',
        insight: `No sales yet today. ${timeCtx.suggestion}`,
        action: 'Consider a morning special or reach out to regular customers.',
        priority: 'low',
      });
    }

    // Top product insight
    if (context.todaySales.topProducts.length > 0) {
      const top = context.todaySales.topProducts[0];
      insights.push({
        title: `🏆 ${top.name} Winning!`,
        insight: `${top.name} is your best seller with ${top.quantity} units sold (E${top.revenue.toFixed(2)} revenue).`,
        action: 'Make sure you have enough stock of this popular item!',
        priority: 'low',
      });
    }

    return { insights, generated: new Date(), offline: true };
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
