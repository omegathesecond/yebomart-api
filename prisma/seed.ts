import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ==================== ADMINS ====================
  const adminPassword = await bcrypt.hash('Toredo3108084$', 12);
  
  await prisma.admin.upsert({
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

  await prisma.admin.upsert({
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
  console.log('✅ Admins created');

  // ==================== LASLIE'S SHOP ====================
  const shopPassword = await bcrypt.hash('123456', 12);
  
  const laslieShop = await prisma.shop.upsert({
    where: { ownerPhone: '+26878422613' },
    update: { 
      password: shopPassword,
      tier: 'PRO',
    },
    create: {
      name: "Laslie's Tuck Shop",
      ownerName: 'Laslie Georges Jr.',
      ownerPhone: '+26878422613',
      ownerEmail: 'laslie@omevision.com',
      password: shopPassword,
      businessType: 'tuckshop',
      assistantName: 'Yebo',
      currency: 'SZL',
      timezone: 'Africa/Mbabane',
      address: 'Mbabane, Eswatini',
      tier: 'PRO',
    },
  });
  console.log('✅ Laslie\'s shop created:', laslieShop.name);

  // ==================== SAMPLE PRODUCTS FOR LASLIE'S SHOP ====================
  const products = [
    // Drinks
    { name: 'Coca-Cola 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12, quantity: 48, barcode: '5449000000996' },
    { name: 'Fanta Orange 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12, quantity: 36, barcode: '5449000000997' },
    { name: 'Sprite 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12, quantity: 24, barcode: '5449000000998' },
    { name: 'Water 500ml', category: 'Beverages', costPrice: 5, sellPrice: 8, quantity: 60, barcode: '6001240000001' },
    { name: 'Red Bull 250ml', category: 'Beverages', costPrice: 18, sellPrice: 28, quantity: 24, barcode: '9002490000001' },
    
    // Snacks
    { name: 'Simba Chips (Cheese)', category: 'Snacks', costPrice: 8, sellPrice: 12, quantity: 30, barcode: '6001240100001' },
    { name: 'Simba Chips (Salt & Vinegar)', category: 'Snacks', costPrice: 8, sellPrice: 12, quantity: 30, barcode: '6001240100002' },
    { name: 'Nik Naks', category: 'Snacks', costPrice: 6, sellPrice: 10, quantity: 40, barcode: '6001240100003' },
    { name: 'Bar One', category: 'Snacks', costPrice: 10, sellPrice: 15, quantity: 24, barcode: '6001068000001' },
    { name: 'KitKat', category: 'Snacks', costPrice: 12, sellPrice: 18, quantity: 20, barcode: '7613035000001' },
    
    // Bread & Bakery
    { name: 'White Bread', category: 'Bakery', costPrice: 14, sellPrice: 18, quantity: 20, barcode: '6001000000001' },
    { name: 'Brown Bread', category: 'Bakery', costPrice: 15, sellPrice: 20, quantity: 15, barcode: '6001000000002' },
    { name: 'Scones (6 pack)', category: 'Bakery', costPrice: 18, sellPrice: 25, quantity: 12, barcode: '6001000000003' },
    
    // Dairy
    { name: 'Fresh Milk 1L', category: 'Dairy', costPrice: 18, sellPrice: 24, quantity: 20, barcode: '6001001000001' },
    { name: 'Yoghurt (Strawberry)', category: 'Dairy', costPrice: 8, sellPrice: 12, quantity: 15, barcode: '6001001000002' },
    
    // Airtime & Essentials
    { name: 'MTN Airtime E10', category: 'Airtime', costPrice: 10, sellPrice: 10, quantity: 100 },
    { name: 'MTN Airtime E25', category: 'Airtime', costPrice: 25, sellPrice: 25, quantity: 50 },
    { name: 'MTN Airtime E50', category: 'Airtime', costPrice: 50, sellPrice: 50, quantity: 30 },
    { name: 'Electricity Token E50', category: 'Utilities', costPrice: 50, sellPrice: 52, quantity: 20 },
    { name: 'Electricity Token E100', category: 'Utilities', costPrice: 100, sellPrice: 103, quantity: 20 },
    
    // Groceries
    { name: 'Sugar 1kg', category: 'Groceries', costPrice: 22, sellPrice: 28, quantity: 25, barcode: '6001002000001' },
    { name: 'Cooking Oil 750ml', category: 'Groceries', costPrice: 35, sellPrice: 45, quantity: 15, barcode: '6001002000002' },
    { name: 'Rice 2kg', category: 'Groceries', costPrice: 45, sellPrice: 58, quantity: 20, barcode: '6001002000003' },
    { name: 'Maize Meal 2.5kg', category: 'Groceries', costPrice: 38, sellPrice: 48, quantity: 18, barcode: '6001002000004' },
    { name: 'Eggs (6 pack)', category: 'Groceries', costPrice: 25, sellPrice: 32, quantity: 15, barcode: '6001002000005' },
  ];

  // Clear existing products for clean seed
  await prisma.product.deleteMany({ where: { shopId: laslieShop.id } });
  
  for (const product of products) {
    await prisma.product.create({
      data: {
        shopId: laslieShop.id,
        name: product.name,
        category: product.category,
        costPrice: product.costPrice,
        sellPrice: product.sellPrice,
        quantity: product.quantity,
        reorderAt: 10,
        unit: 'each',
        barcode: product.barcode,
        isActive: true,
      },
    });
  }
  console.log(`✅ ${products.length} products added to Laslie's shop`);

  // ==================== SAMPLE SHOPS ====================
  const sampleShops = [
    {
      name: "Thandi's Mini Mart",
      ownerName: 'Thandi Dlamini',
      ownerPhone: '+26876111111',
      businessType: 'grocery',
      tier: 'FREE' as const,
    },
    {
      name: "Sipho's Hardware",
      ownerName: 'Sipho Nkosi',
      ownerPhone: '+26876222222',
      businessType: 'hardware',
      tier: 'BUSINESS' as const,
    },
    {
      name: "Grace Beauty Salon",
      ownerName: 'Grace Mamba',
      ownerPhone: '+26876333333',
      businessType: 'salon',
      tier: 'PRO' as const,
    },
    {
      name: "Quick Stop Tuckshop",
      ownerName: 'David Zwane',
      ownerPhone: '+26876444444',
      businessType: 'tuckshop',
      tier: 'FREE' as const,
    },
    {
      name: "Manzini Pharmacy",
      ownerName: 'Dr. Mary Simelane',
      ownerPhone: '+26876555555',
      businessType: 'pharmacy',
      tier: 'BUSINESS' as const,
    },
  ];

  for (const shop of sampleShops) {
    await prisma.shop.upsert({
      where: { ownerPhone: shop.ownerPhone },
      update: {},
      create: {
        ...shop,
        password: await bcrypt.hash('123456', 12),
        assistantName: 'Yebo',
        currency: 'SZL',
        timezone: 'Africa/Mbabane',
      },
    });
  }
  console.log(`✅ ${sampleShops.length} sample shops created`);

  // ==================== SUMMARY ====================
  const shopCount = await prisma.shop.count();
  const productCount = await prisma.product.count();
  const adminCount = await prisma.admin.count();

  console.log('\n🌱 Seeding complete!');
  console.log(`   📊 ${adminCount} admins`);
  console.log(`   🏪 ${shopCount} shops`);
  console.log(`   📦 ${productCount} products`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
