// Email service for sending receipts
// TODO: Configure proper email domain for YeboMart

interface ReceiptEmailData {
  email: string;
  shopName: string;
  receiptNumber: string;
  items: Array<{
    productName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  subtotal: number;
  discount: number;
  total: number;
  date: string;
}

export class EmailService {
  private static RESEND_API_KEY = process.env.RESEND_API_KEY;
  private static FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@yebomart.com';

  /**
   * Generate HTML receipt template
   */
  private static generateReceiptHTML(data: ReceiptEmailData): string {
    const itemsHTML = data.items.map(item => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.productName}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">x${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">E${item.totalPrice.toFixed(2)}</td>
      </tr>
    `).join('');

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Receipt from ${data.shopName}</title>
    </head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; border-bottom: 2px solid #f59e0b; padding-bottom: 20px; margin-bottom: 20px;">
        <h1 style="color: #f59e0b; margin: 0;">${data.shopName}</h1>
        <p style="color: #666; margin: 5px 0;">Receipt</p>
      </div>
      
      <div style="margin-bottom: 20px;">
        <p style="margin: 5px 0;"><strong>Receipt #:</strong> ${data.receiptNumber}</p>
        <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(data.date).toLocaleString()}</p>
      </div>
      
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background: #f5f5f5;">
            <th style="padding: 8px; text-align: left;">Item</th>
            <th style="padding: 8px; text-align: center;">Qty</th>
            <th style="padding: 8px; text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHTML}
        </tbody>
      </table>
      
      <div style="border-top: 2px solid #333; padding-top: 15px;">
        <div style="display: flex; justify-content: space-between; margin: 5px 0;">
          <span>Subtotal:</span>
          <span>E${data.subtotal.toFixed(2)}</span>
        </div>
        ${data.discount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin: 5px 0; color: #16a34a;">
          <span>Discount:</span>
          <span>-E${data.discount.toFixed(2)}</span>
        </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; margin: 10px 0; font-size: 1.3em; font-weight: bold;">
          <span>TOTAL:</span>
          <span>E${data.total.toFixed(2)}</span>
        </div>
      </div>
      
      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px dashed #ccc; color: #666;">
        <p style="margin: 5px 0;">Thank you for shopping with us!</p>
        <p style="margin: 5px 0; font-size: 0.9em;">Powered by YeboMart</p>
      </div>
    </body>
    </html>
    `;
  }

  /**
   * Send receipt email
   */
  static async sendReceipt(data: ReceiptEmailData): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const html = this.generateReceiptHTML(data);

    // If Resend API key is configured, use it
    if (this.RESEND_API_KEY) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.FROM_EMAIL,
            to: data.email,
            subject: `Your receipt from ${data.shopName} - #${data.receiptNumber}`,
            html,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          console.error('[EmailService] Resend API error:', error);
          return { success: false, error: 'Failed to send email' };
        }

        const result = await response.json() as { id: string };
        console.log('[EmailService] Receipt sent:', result.id);
        return { success: true, messageId: result.id };
      } catch (error: any) {
        console.error('[EmailService] Send error:', error);
        return { success: false, error: error.message };
      }
    }

    // Fallback: log the email (for development)
    console.log('[EmailService] Email would be sent to:', data.email);
    console.log('[EmailService] Receipt #:', data.receiptNumber);
    console.log('[EmailService] Total:', data.total);
    
    // Return success for development purposes
    return { success: true, messageId: 'dev-mode' };
  }
}
