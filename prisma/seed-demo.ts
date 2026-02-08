import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Get first shop
  const shop = await prisma.shop.findFirst();
  if (!shop) {
    console.log('No shop found!');
    return;
  }
  
  console.log('Found shop:', shop.name, shop.id);
  
  // Update to BUSINESS tier
  await prisma.shop.update({
    where: { id: shop.id },
    data: { tier: 'BUSINESS' }
  });
  console.log('Updated tier to BUSINESS');
  
  // Get existing products and make some low stock
  const products = await prisma.product.findMany({ 
    where: { shopId: shop.id, isActive: true },
    take: 10 
  });
  
  console.log('Found', products.length, 'products');
  
  if (products.length >= 5) {
    // Update first 5 to be low stock
    for (let i = 0; i < 5; i++) {
      const p = products[i];
      await prisma.product.update({
        where: { id: p.id },
        data: { 
          quantity: i === 0 ? 0 : Math.floor(Math.random() * 3) + 1,
          reorderAt: 10
        }
      });
      console.log(`Set ${p.name} to low stock (qty: ${i === 0 ? 0 : 'low'})`);
    }
  } else {
    // Create low stock products
    const lowStockItems = [
      { name: 'Bread (White)', category: 'Bakery', costPrice: 12, sellPrice: 15, quantity: 2, reorderAt: 10, barcode: '6001234500001' },
      { name: 'Milk 1L', category: 'Dairy', costPrice: 18, sellPrice: 24, quantity: 0, reorderAt: 8, barcode: '6001234500002' },
      { name: 'Eggs (6 pack)', category: 'Dairy', costPrice: 28, sellPrice: 38, quantity: 1, reorderAt: 5, barcode: '6001234500003' },
      { name: 'Sugar 2kg', category: 'Groceries', costPrice: 35, sellPrice: 45, quantity: 3, reorderAt: 10, barcode: '6001234500004' },
      { name: 'Cooking Oil 750ml', category: 'Groceries', costPrice: 42, sellPrice: 55, quantity: 2, reorderAt: 8, barcode: '6001234500005' },
    ];
    
    for (const item of lowStockItems) {
      await prisma.product.create({
        data: { ...item, shopId: shop.id, unit: 'each', isActive: true }
      });
      console.log(`Created ${item.name}`);
    }
  }
  
  console.log('Done!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
