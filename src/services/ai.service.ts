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
   * Get shop context for AI
   */
  private static async getShopContext(shopId: string) {
    const [shop, dailySummary, lowStock] = await Promise.all([
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
    ]);

    return {
      shop,
      todaySales: dailySummary,
      lowStockAlerts: lowStock,
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
    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `You are ${context.shop?.assistantName || 'Yebo'}, a friendly AI assistant for ${context.shop?.name || 'the shop'}. 
You help ${context.shop?.ownerName || 'the shop owner'} manage their business.

Current shop data:
- Currency: ${context.shop?.currency || 'SZL'}
- Today's sales: ${context.todaySales.totalSales} (${context.todaySales.totalTransactions} transactions)
- Average basket: ${context.todaySales.averageBasket}
- Low stock items: ${context.lowStockAlerts.total} products need attention

Top products today:
${context.todaySales.topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} sold`).join('\n')}

Critical stock (out of stock):
${context.lowStockAlerts.items.critical.slice(0, 5).map(p => `- ${p.name}: ${p.quantity} left`).join('\n') || 'None'}

Instructions:
- Be helpful, concise, and friendly
- Use the shop's currency (${context.shop?.currency || 'SZL'}) for money amounts
- If asked about specific products or sales, provide the data you have
- If you don't have specific data, say so honestly
- Keep responses under 200 words unless more detail is needed
- Use emojis sparingly for a friendly tone`;

    const chat = model.startChat({
      history: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }],
        },
        {
          role: 'model',
          parts: [{ text: `I understand! I'm ${context.shop?.assistantName || 'Yebo'}, ready to help with the shop. How can I assist you today?` }],
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
   * Process voice query (transcription would come from frontend)
   */
  static async voice(shopId: string, transcription: string) {
    // For now, just use the chat function with the transcription
    const result = await this.chat({
      shopId,
      message: transcription,
    });

    // Update the conversation type
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
    
    // Get weekly data for better insights
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

    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `Generate 3-5 brief, actionable business insights for a shop based on this data:

Today's sales: ${context.todaySales.totalSales} ${context.shop?.currency || 'SZL'} (${context.todaySales.totalTransactions} transactions)
This week's sales: ${weekSales._sum.totalAmount || 0} ${context.shop?.currency || 'SZL'} (${weekSales._count} transactions)
Low stock items: ${context.lowStockAlerts.total} products
Out of stock: ${context.lowStockAlerts.items.critical.length} products

Top sellers today:
${context.todaySales.topProducts.map((p, i) => `${i + 1}. ${p.name}: ${p.quantity} units, ${p.revenue} revenue`).join('\n')}

Format each insight as a JSON object with:
- title: Short title (3-5 words)
- insight: The insight (1-2 sentences)
- action: Recommended action (1 sentence)
- priority: "high", "medium", or "low"

Return as a JSON array. No markdown, just valid JSON.`;

    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]);
        
        // Store insights
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

    // Fallback to offline insights
    return this.getOfflineInsights(input.shopId);
  }

  /**
   * Offline/fallback insights
   */
  private static async getOfflineInsights(shopId: string) {
    const context = await this.getShopContext(shopId);
    const insights = [];

    // Low stock insight
    if (context.lowStockAlerts.total > 0) {
      insights.push({
        title: 'Stock Alert',
        insight: `${context.lowStockAlerts.total} products need restocking. ${context.lowStockAlerts.items.critical.length} are completely out of stock.`,
        action: 'Review and reorder low stock items today.',
        priority: context.lowStockAlerts.items.critical.length > 0 ? 'high' : 'medium',
      });
    }

    // Sales insight
    if (context.todaySales.totalTransactions > 0) {
      insights.push({
        title: 'Today\'s Performance',
        insight: `You've made ${context.todaySales.totalTransactions} sales totaling ${context.todaySales.totalSales}. Average basket is ${context.todaySales.averageBasket.toFixed(2)}.`,
        action: context.todaySales.averageBasket < 50 ? 'Consider upselling to increase basket size.' : 'Keep up the good work!',
        priority: 'medium',
      });
    }

    // Top product insight
    if (context.todaySales.topProducts.length > 0) {
      const top = context.todaySales.topProducts[0];
      insights.push({
        title: 'Best Seller',
        insight: `${top.name} is your top seller today with ${top.quantity} units sold.`,
        action: 'Make sure this product is well-stocked and visible.',
        priority: 'low',
      });
    }

    return { insights, generated: new Date(), offline: true };
  }
}
