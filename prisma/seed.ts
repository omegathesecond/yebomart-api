import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  
  const admin = await prisma.admin.upsert({
    where: { email: 'admin@yebomart.com' },
    update: {},
    create: {
      email: 'admin@yebomart.com',
      password: adminPassword,
      name: 'YeboMart Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Created admin:', admin.email);

  // Create Laslie's admin account
  const lasliePassword = await bcrypt.hash('omevision2024', 12);
  
  const laslie = await prisma.admin.upsert({
    where: { email: 'laslie@omevision.com' },
    update: {},
    create: {
      email: 'laslie@omevision.com',
      password: lasliePassword,
      name: 'Laslie Georges Jr.',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Created admin:', laslie.email);

  console.log('🌱 Seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
