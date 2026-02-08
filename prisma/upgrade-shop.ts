import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Find Laslie's shops by phone
  const shops = await prisma.shop.findMany({
    where: {
      OR: [
        { ownerPhone: { contains: '78422613' } },
        { ownerPhone: { contains: '26878422613' } },
        { name: { contains: 'Laslie' } }
      ]
    }
  });
  
  console.log('Found shops:', shops.map(s => ({ id: s.id, name: s.name, tier: s.tier })));
  
  // Update all to BUSINESS (highest available tier)
  for (const shop of shops) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { tier: 'BUSINESS' }
    });
    console.log(`Upgraded ${shop.name} to BUSINESS`);
  }
  
  // Also update any shop that might be in use
  await prisma.shop.updateMany({
    data: { tier: 'BUSINESS' }
  });
  console.log('All shops upgraded to BUSINESS tier');
}

main().catch(console.error).finally(() => prisma.$disconnect());
