import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Update all shops to ENTERPRISE
  const result = await prisma.shop.updateMany({
    data: { tier: 'ENTERPRISE' }
  });
  console.log(`Updated ${result.count} shops to ENTERPRISE`);
  
  // Verify
  const shops = await prisma.shop.findMany({ select: { name: true, tier: true } });
  shops.forEach(s => console.log(`  ${s.name}: ${s.tier}`));
}

main().catch(console.error).finally(() => prisma.$disconnect());
