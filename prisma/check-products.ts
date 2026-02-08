import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const shop = await prisma.shop.findFirst();
  if (!shop) return;
  
  const products = await prisma.product.findMany({
    where: { shopId: shop.id },
    orderBy: { quantity: 'asc' }
  });
  
  console.log('\nProducts in', shop.name + ':');
  console.log('Shop tier:', shop.tier);
  console.log('-'.repeat(50));
  
  products.forEach(p => {
    const status = p.quantity === 0 ? '❌ OUT' : p.quantity <= p.reorderAt ? '⚠️ LOW' : '✅';
    console.log(`${status} ${p.name}: ${p.quantity} (reorder at ${p.reorderAt})`);
  });
  
  console.log('-'.repeat(50));
  console.log(`Total: ${products.length} products`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
