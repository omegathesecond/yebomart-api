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
   * Get comprehensive shop context for AI
   */
  private static async getShopContext(shopId: string) {
    const [shop, dailySummary, lowStock, recentSales, allProducts] = await Promise.all([
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
        select: { name: true, quantity: true, sellPrice: true, category: true },
        take: 50
      })
    ]);

    return {
      shop,
      todaySales: dailySummary,
      lowStockAlerts: lowStock,
      recentSales,
      allProducts,
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

    const systemPrompt = `You are ${context.shop?.assistantName || 'Yebo'}, a smart and friendly AI shop assistant for "${context.shop?.name || 'the shop'}".

👤 OWNER: ${context.shop?.ownerName || 'Boss'}
💰 CURRENCY: ${context.shop?.currency || 'SZL'} (Eswatini Lilangeni, symbol: E)

📊 TODAY'S PERFORMANCE:
- Total Sales: E${context.todaySales.totalSales.toFixed(2)}
- Transactions: ${context.todaySales.totalTransactions}
- Average Basket: E${context.todaySales.averageBasket.toFixed(2)}

🏆 TOP SELLERS TODAY:
${context.todaySales.topProducts.length > 0 
  ? context.todaySales.topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} sold (E${p.revenue.toFixed(2)})`).join('\n')
  : 'No sales yet today'}

⚠️ LOW STOCK ALERT (${context.lowStockAlerts.total} items need attention):
${lowStockList}

🛒 RECENT SALES:
${recentSalesList}

📦 INVENTORY SNAPSHOT:
${inventorySnapshot}

YOUR PERSONALITY:
- Be warm, helpful, and proactive like a real shop assistant
- Use specific product names and numbers from the data above
- When asked about stock, list the ACTUAL product names and quantities
- Give actionable advice (e.g., "You should reorder Milk 1L today - you're completely out!")
- Use emojis naturally to be friendly 😊
- Be conversational, not robotic
- If sales are slow, encourage them! If sales are good, celebrate!
- Always reference real data, never make up numbers

IMPORTANT: When listing products or stock, use the ACTUAL names from the data above. Never say "I don't have the names" - you DO have them!`;

    const chat = model.startChat({
      history: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }],
        },
        {
          role: 'model',
          parts: [{ text: `Hey ${context.shop?.ownerName || 'boss'}! 👋 I'm ${context.shop?.assistantName || 'Yebo'}, your shop assistant. I've got all the latest info on your sales and stock. What would you like to know?` }],
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
      insights.push({
        title: '🌅 New Day, Fresh Start',
        insight: 'No sales yet today. Time to attract some customers!',
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
}
