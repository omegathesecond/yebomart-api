import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Find all shops
  const shops = await prisma.shop.findMany();
  console.log('All shops:', shops.map(s => ({ id: s.id, name: s.name, tier: s.tier })));
  
  // Update all shops to BUSINESS tier
  await prisma.shop.updateMany({
    data: { tier: 'BUSINESS' }
  });
  console.log('\nUpdated all shops to BUSINESS tier');
  
  // Add low stock products to all shops
  const lowStockItems = [
    { name: 'Bread (White)', category: 'Bakery', costPrice: 12, sellPrice: 15, quantity: 2, reorderAt: 10 },
    { name: 'Milk 1L', category: 'Dairy', costPrice: 18, sellPrice: 24, quantity: 0, reorderAt: 8 },
    { name: 'Eggs (6 pack)', category: 'Dairy', costPrice: 28, sellPrice: 38, quantity: 1, reorderAt: 5 },
    { name: 'Sugar 2kg', category: 'Groceries', costPrice: 35, sellPrice: 45, quantity: 3, reorderAt: 10 },
    { name: 'Cooking Oil 750ml', category: 'Groceries', costPrice: 42, sellPrice: 55, quantity: 2, reorderAt: 8 },
  ];
  
  for (const shop of shops) {
    console.log(`\nProcessing shop: ${shop.name}`);
    
    for (const item of lowStockItems) {
      const existing = await prisma.product.findFirst({
        where: { shopId: shop.id, name: item.name }
      });
      
      if (!existing) {
        await prisma.product.create({
          data: { ...item, shopId: shop.id, unit: 'each', isActive: true }
        });
        console.log(`  Created ${item.name}`);
      } else {
        // Update to low stock
        await prisma.product.update({
          where: { id: existing.id },
          data: { quantity: item.quantity, reorderAt: item.reorderAt }
        });
        console.log(`  Updated ${item.name} to low stock`);
      }
    }
  }
  
  // Final check
  for (const shop of shops) {
    const products = await prisma.product.findMany({ 
      where: { shopId: shop.id },
      orderBy: { quantity: 'asc' }
    });
    const lowStock = products.filter(p => p.quantity <= p.reorderAt);
    console.log(`\n${shop.name}: ${products.length} products, ${lowStock.length} low stock`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
