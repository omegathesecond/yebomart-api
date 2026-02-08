import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const shop = await prisma.shop.findFirst();
  if (!shop) {
    console.log('No shop found!');
    return;
  }
  
  console.log('Adding more products to:', shop.name);
  
  const moreProducts = [
    { name: 'Coca-Cola 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12, quantity: 48, reorderAt: 20 },
    { name: 'Fanta Orange 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12, quantity: 36, reorderAt: 20 },
    { name: 'Simba Chips', category: 'Snacks', costPrice: 6, sellPrice: 10, quantity: 30, reorderAt: 15 },
    { name: 'Rice 2kg', category: 'Groceries', costPrice: 35, sellPrice: 45, quantity: 12, reorderAt: 6 },
    { name: 'MTN Airtime E10', category: 'Airtime', costPrice: 9, sellPrice: 10, quantity: 100, reorderAt: 20 },
    { name: 'MTN Airtime E25', category: 'Airtime', costPrice: 22.5, sellPrice: 25, quantity: 50, reorderAt: 10 },
    { name: 'Soap Bar', category: 'Toiletries', costPrice: 8, sellPrice: 12, quantity: 25, reorderAt: 10 },
    { name: 'Toothpaste', category: 'Toiletries', costPrice: 15, sellPrice: 22, quantity: 18, reorderAt: 8 },
  ];
  
  for (const item of moreProducts) {
    const existing = await prisma.product.findFirst({
      where: { shopId: shop.id, name: item.name }
    });
    
    if (!existing) {
      await prisma.product.create({
        data: { ...item, shopId: shop.id, unit: 'each', isActive: true }
      });
      console.log(`Created ${item.name}`);
    } else {
      console.log(`${item.name} already exists`);
    }
  }
  
  // Verify products
  const count = await prisma.product.count({ where: { shopId: shop.id } });
  console.log(`Total products: ${count}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
