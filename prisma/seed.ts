import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Default admin password
  const adminPassword = await bcrypt.hash('Toredo3108084$', 12);
  
  // Create default admin user
  const admin = await prisma.admin.upsert({
    where: { email: 'admin@yebomart.com' },
    update: { password: adminPassword },
    create: {
      email: 'admin@yebomart.com',
      password: adminPassword,
      name: 'YeboMart Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Admin:', admin.email);

  // Create Laslie's admin account
  const laslie = await prisma.admin.upsert({
    where: { email: 'laslie@omevision.com' },
    update: { password: adminPassword },
    create: {
      email: 'laslie@omevision.com',
      password: adminPassword,
      name: 'Laslie Georges Jr.',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Admin:', laslie.email);

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
