import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { quantity: 'asc' },
    take: 20
  });
  
  console.log('Low Stock Products:');
  products.filter(p => p.quantity <= p.reorderAt).forEach(p => {
    const status = p.quantity === 0 ? '❌ OUT' : '⚠️ LOW';
    console.log(`${status} ${p.name}: ${p.quantity} left (reorder at ${p.reorderAt})`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
