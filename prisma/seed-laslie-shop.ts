import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Helper to get random date in past year
function randomPastDate(daysAgo: number = 365): Date {
  const now = new Date();
  const pastDate = new Date(now.getTime() - Math.random() * daysAgo * 24 * 60 * 60 * 1000);
  return pastDate;
}

// Helper to get random item from array
function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Helper to get random number in range
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log('🌱 Seeding Laslie\'s Enterprise Shop with 1 year of data...\n');

  const shopPassword = await bcrypt.hash('123456', 12);
  
  // ==================== CREATE/UPDATE SHOP ====================
  const shop = await prisma.shop.upsert({
    where: { ownerPhone: '+26878422613' },
    update: { 
      password: shopPassword,
      tier: 'BUSINESS',
      name: "Laslie's Mega Mart",
    },
    create: {
      name: "Laslie's Mega Mart",
      ownerName: 'Laslie Georges Jr.',
      ownerPhone: '+26878422613',
      ownerEmail: 'laslie@omevision.com',
      password: shopPassword,
      businessType: 'grocery',
      assistantName: 'Yebo',
      currency: 'SZL',
      timezone: 'Africa/Mbabane',
      address: 'Mbabane City Center, Eswatini',
      tier: 'BUSINESS',
    },
  });
  console.log('✅ Shop:', shop.name, '(BUSINESS tier)');

  // ==================== CLEAR OLD DATA ====================
  await prisma.saleItem.deleteMany({ where: { sale: { shopId: shop.id } } });
  await prisma.sale.deleteMany({ where: { shopId: shop.id } });
  await prisma.stockLog.deleteMany({ where: { shopId: shop.id } });
  await prisma.expense.deleteMany({ where: { shopId: shop.id } });
  await prisma.customer.deleteMany({ where: { shopId: shop.id } });
  await prisma.product.deleteMany({ where: { shopId: shop.id } });
  console.log('✅ Cleared old data');

  // ==================== PRODUCTS (150+ items) ====================
  const productData = [
    // Beverages (30)
    { name: 'Coca-Cola 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12 },
    { name: 'Coca-Cola 2L', category: 'Beverages', costPrice: 18, sellPrice: 26 },
    { name: 'Coca-Cola 330ml Can', category: 'Beverages', costPrice: 7, sellPrice: 10 },
    { name: 'Fanta Orange 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12 },
    { name: 'Fanta Grape 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12 },
    { name: 'Sprite 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12 },
    { name: 'Stoney Ginger Beer 500ml', category: 'Beverages', costPrice: 8, sellPrice: 12 },
    { name: 'Red Bull 250ml', category: 'Beverages', costPrice: 18, sellPrice: 28 },
    { name: 'Monster Energy 500ml', category: 'Beverages', costPrice: 22, sellPrice: 35 },
    { name: 'Water Still 500ml', category: 'Beverages', costPrice: 4, sellPrice: 8 },
    { name: 'Water Still 1L', category: 'Beverages', costPrice: 6, sellPrice: 12 },
    { name: 'Oros Orange 1L', category: 'Beverages', costPrice: 22, sellPrice: 32 },
    { name: 'Ceres Juice 1L', category: 'Beverages', costPrice: 28, sellPrice: 38 },
    { name: 'Castle Lager 340ml', category: 'Beverages', costPrice: 14, sellPrice: 20 },
    { name: 'Savanna Dry 330ml', category: 'Beverages', costPrice: 18, sellPrice: 28 },
    { name: 'Milk Fresh 1L', category: 'Beverages', costPrice: 18, sellPrice: 24 },
    { name: 'Milk Fresh 2L', category: 'Beverages', costPrice: 32, sellPrice: 42 },
    { name: 'Chocolate Milk 500ml', category: 'Beverages', costPrice: 15, sellPrice: 22 },

    // Snacks (25)
    { name: 'Simba Cheese', category: 'Snacks', costPrice: 8, sellPrice: 12 },
    { name: 'Simba Salt & Vinegar', category: 'Snacks', costPrice: 8, sellPrice: 12 },
    { name: 'Simba BBQ', category: 'Snacks', costPrice: 8, sellPrice: 12 },
    { name: 'Lays Original', category: 'Snacks', costPrice: 10, sellPrice: 15 },
    { name: 'Doritos Nacho', category: 'Snacks', costPrice: 14, sellPrice: 22 },
    { name: 'Nik Naks Original', category: 'Snacks', costPrice: 6, sellPrice: 10 },
    { name: 'Ghost Pops', category: 'Snacks', costPrice: 5, sellPrice: 8 },
    { name: 'Bar One', category: 'Snacks', costPrice: 10, sellPrice: 15 },
    { name: 'KitKat 4 Finger', category: 'Snacks', costPrice: 12, sellPrice: 18 },
    { name: 'Lunch Bar', category: 'Snacks', costPrice: 10, sellPrice: 15 },
    { name: 'Cadbury Dairy Milk', category: 'Snacks', costPrice: 18, sellPrice: 28 },
    { name: 'Biltong 50g', category: 'Snacks', costPrice: 35, sellPrice: 55 },
    { name: 'Oreo Cookies', category: 'Snacks', costPrice: 22, sellPrice: 32 },
    { name: 'Bakers Biscuits', category: 'Snacks', costPrice: 18, sellPrice: 26 },
    { name: 'Pringles Original', category: 'Snacks', costPrice: 45, sellPrice: 65 },

    // Bread & Bakery (10)
    { name: 'White Bread', category: 'Bakery', costPrice: 14, sellPrice: 18 },
    { name: 'Brown Bread', category: 'Bakery', costPrice: 15, sellPrice: 20 },
    { name: 'Hotdog Rolls 6pk', category: 'Bakery', costPrice: 18, sellPrice: 26 },
    { name: 'Burger Buns 6pk', category: 'Bakery', costPrice: 20, sellPrice: 28 },
    { name: 'Scones 6pk', category: 'Bakery', costPrice: 18, sellPrice: 26 },
    { name: 'Muffins Choc 4pk', category: 'Bakery', costPrice: 28, sellPrice: 38 },
    { name: 'Doughnuts 6pk', category: 'Bakery', costPrice: 24, sellPrice: 35 },

    // Dairy (12)
    { name: 'Eggs 6pk', category: 'Dairy', costPrice: 25, sellPrice: 32 },
    { name: 'Eggs 12pk', category: 'Dairy', costPrice: 45, sellPrice: 58 },
    { name: 'Eggs 30pk', category: 'Dairy', costPrice: 95, sellPrice: 120 },
    { name: 'Butter 500g', category: 'Dairy', costPrice: 65, sellPrice: 85 },
    { name: 'Cheese Cheddar 400g', category: 'Dairy', costPrice: 58, sellPrice: 78 },
    { name: 'Yoghurt Strawberry', category: 'Dairy', costPrice: 8, sellPrice: 12 },
    { name: 'Yoghurt Vanilla', category: 'Dairy', costPrice: 8, sellPrice: 12 },
    { name: 'Cream Fresh 250ml', category: 'Dairy', costPrice: 22, sellPrice: 32 },

    // Groceries (30)
    { name: 'Sugar White 1kg', category: 'Groceries', costPrice: 22, sellPrice: 28 },
    { name: 'Sugar White 2.5kg', category: 'Groceries', costPrice: 48, sellPrice: 62 },
    { name: 'Rice White 2kg', category: 'Groceries', costPrice: 45, sellPrice: 58 },
    { name: 'Maize Meal 2.5kg', category: 'Groceries', costPrice: 38, sellPrice: 48 },
    { name: 'Maize Meal 5kg', category: 'Groceries', costPrice: 68, sellPrice: 85 },
    { name: 'Flour Cake 2.5kg', category: 'Groceries', costPrice: 35, sellPrice: 45 },
    { name: 'Cooking Oil 750ml', category: 'Groceries', costPrice: 35, sellPrice: 45 },
    { name: 'Cooking Oil 2L', category: 'Groceries', costPrice: 75, sellPrice: 95 },
    { name: 'Salt 1kg', category: 'Groceries', costPrice: 12, sellPrice: 18 },
    { name: 'Spaghetti 500g', category: 'Groceries', costPrice: 18, sellPrice: 26 },
    { name: 'Macaroni 500g', category: 'Groceries', costPrice: 16, sellPrice: 24 },
    { name: 'Baked Beans 410g', category: 'Groceries', costPrice: 14, sellPrice: 22 },
    { name: 'Pilchards 400g', category: 'Groceries', costPrice: 22, sellPrice: 32 },
    { name: 'Tuna Chunks 170g', category: 'Groceries', costPrice: 24, sellPrice: 35 },
    { name: 'Tomato Sauce 700ml', category: 'Groceries', costPrice: 28, sellPrice: 38 },
    { name: 'Mayonnaise 750g', category: 'Groceries', costPrice: 45, sellPrice: 62 },
    { name: 'Peanut Butter 400g', category: 'Groceries', costPrice: 38, sellPrice: 52 },
    { name: 'Jam Strawberry 450g', category: 'Groceries', costPrice: 32, sellPrice: 45 },
    { name: 'Tea Bags 100s', category: 'Groceries', costPrice: 42, sellPrice: 58 },
    { name: 'Coffee Instant 200g', category: 'Groceries', costPrice: 68, sellPrice: 88 },
    { name: 'Cereal Corn Flakes 500g', category: 'Groceries', costPrice: 48, sellPrice: 65 },
    { name: 'Oats 1kg', category: 'Groceries', costPrice: 35, sellPrice: 48 },
    { name: '2-Minute Noodles', category: 'Groceries', costPrice: 6, sellPrice: 10 },

    // Airtime (8)
    { name: 'MTN Airtime E5', category: 'Airtime', costPrice: 5, sellPrice: 5 },
    { name: 'MTN Airtime E10', category: 'Airtime', costPrice: 10, sellPrice: 10 },
    { name: 'MTN Airtime E25', category: 'Airtime', costPrice: 25, sellPrice: 25 },
    { name: 'MTN Airtime E50', category: 'Airtime', costPrice: 50, sellPrice: 50 },
    { name: 'MTN Airtime E100', category: 'Airtime', costPrice: 100, sellPrice: 100 },
    { name: 'MTN Data 1GB', category: 'Airtime', costPrice: 45, sellPrice: 50 },
    { name: 'Eswatini Mobile E25', category: 'Airtime', costPrice: 25, sellPrice: 25 },
    { name: 'Eswatini Mobile E50', category: 'Airtime', costPrice: 50, sellPrice: 50 },

    // Utilities (4)
    { name: 'Electricity E50', category: 'Utilities', costPrice: 50, sellPrice: 52 },
    { name: 'Electricity E100', category: 'Utilities', costPrice: 100, sellPrice: 103 },
    { name: 'Electricity E200', category: 'Utilities', costPrice: 200, sellPrice: 206 },
    { name: 'Electricity E500', category: 'Utilities', costPrice: 500, sellPrice: 515 },

    // Household (15)
    { name: 'Toilet Paper 9pk', category: 'Household', costPrice: 65, sellPrice: 85 },
    { name: 'Dishwashing Liquid 750ml', category: 'Household', costPrice: 28, sellPrice: 38 },
    { name: 'Laundry Powder 2kg', category: 'Household', costPrice: 68, sellPrice: 88 },
    { name: 'Bleach 1L', category: 'Household', costPrice: 18, sellPrice: 28 },
    { name: 'Floor Cleaner 1L', category: 'Household', costPrice: 25, sellPrice: 35 },
    { name: 'Refuse Bags 20s', category: 'Household', costPrice: 28, sellPrice: 38 },
    { name: 'Matches Box', category: 'Household', costPrice: 2, sellPrice: 5 },
    { name: 'Candles 6pk', category: 'Household', costPrice: 18, sellPrice: 28 },
    { name: 'Batteries AA 4pk', category: 'Household', costPrice: 25, sellPrice: 38 },
    { name: 'Light Bulb 60W', category: 'Household', costPrice: 12, sellPrice: 20 },

    // Personal Care (10)
    { name: 'Toothpaste Colgate', category: 'Personal Care', costPrice: 28, sellPrice: 40 },
    { name: 'Toothbrush', category: 'Personal Care', costPrice: 15, sellPrice: 25 },
    { name: 'Soap Bar Lux', category: 'Personal Care', costPrice: 12, sellPrice: 18 },
    { name: 'Shampoo 400ml', category: 'Personal Care', costPrice: 45, sellPrice: 62 },
    { name: 'Body Lotion 400ml', category: 'Personal Care', costPrice: 38, sellPrice: 52 },
    { name: 'Deodorant Spray', category: 'Personal Care', costPrice: 42, sellPrice: 58 },
    { name: 'Vaseline 250ml', category: 'Personal Care', costPrice: 32, sellPrice: 45 },
    { name: 'Hand Sanitizer 100ml', category: 'Personal Care', costPrice: 18, sellPrice: 28 },

    // Frozen (8)
    { name: 'Chicken Portions 2kg', category: 'Frozen', costPrice: 85, sellPrice: 110 },
    { name: 'Beef Mince 500g', category: 'Frozen', costPrice: 55, sellPrice: 75 },
    { name: 'Boerewors 500g', category: 'Frozen', costPrice: 48, sellPrice: 65 },
    { name: 'Fish Fingers 400g', category: 'Frozen', costPrice: 45, sellPrice: 62 },
    { name: 'Frozen Chips 1kg', category: 'Frozen', costPrice: 38, sellPrice: 52 },
    { name: 'Ice Cream 2L', category: 'Frozen', costPrice: 55, sellPrice: 72 },
    { name: 'Pizza Frozen', category: 'Frozen', costPrice: 48, sellPrice: 65 },
    { name: 'Polony 1kg', category: 'Frozen', costPrice: 35, sellPrice: 48 },
  ];

  const products = [];
  for (const p of productData) {
    const product = await prisma.product.create({
      data: {
        shopId: shop.id,
        name: p.name,
        category: p.category,
        costPrice: p.costPrice,
        sellPrice: p.sellPrice,
        quantity: randomInt(20, 100),
        reorderAt: 10,
        unit: 'each',
        isActive: true,
      },
    });
    products.push(product);
  }
  console.log(`✅ ${products.length} products created`);

  // ==================== CUSTOMERS (50) ====================
  const customerNames = [
    'Thandi Dlamini', 'Sipho Nkosi', 'Grace Mamba', 'David Zwane', 'Mary Simelane',
    'John Kunene', 'Sarah Maseko', 'Peter Gama', 'Rose Hlophe', 'James Shongwe',
    'Linda Fakudze', 'Michael Dube', 'Nancy Tsabedze', 'Robert Mkhabela', 'Susan Sihlongonyane',
    'William Magagula', 'Patricia Matsebula', 'George Nxumalo', 'Betty Ginindza', 'Thomas Tfwala',
    'Margaret Mhlanga', 'Charles Shabangu', 'Dorothy Motsa', 'Joseph Vilakati', 'Helen Ndlela',
    'Richard Mahlalela', 'Karen Mavimbela', 'Daniel Bhembe', 'Jennifer Thwala', 'Paul Makhanya',
    'Lisa Msibi', 'Steven Sibandze', 'Angela Diamini', 'Mark Sukati', 'Michelle Gwebu',
    'Brian Mthethwa', 'Diana Mhlabane', 'Kevin Lukhele', 'Sharon Khumalo', 'Timothy Matsenjwa',
    'Rebecca Dlamini', 'Eric Simelane', 'Laura Gama', 'Andrew Mamba', 'Christina Nkosi',
    'Martin Zwane', 'Samantha Maseko', 'Frank Hlophe', 'Virginia Shongwe', 'Douglas Kunene'
  ];

  const customers = [];
  for (let i = 0; i < customerNames.length; i++) {
    const customer = await prisma.customer.create({
      data: {
        shopId: shop.id,
        name: customerNames[i],
        phone: `+2687${randomInt(1000000, 9999999)}`,
        email: i % 3 === 0 ? `${customerNames[i].toLowerCase().replace(' ', '.')}@email.com` : null,
      },
    });
    customers.push(customer);
  }
  console.log(`✅ ${customers.length} customers created`);

  // ==================== SALES (1500+ over past year) ====================
  const paymentMethods: ('CASH' | 'CARD' | 'MOMO' | 'EMALI')[] = ['CASH', 'CARD', 'MOMO', 'EMALI'];
  let salesCreated = 0;
  
  // Generate sales for past 365 days
  for (let daysAgo = 365; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(randomInt(7, 20), randomInt(0, 59), 0, 0);
    
    // More sales on weekends
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const salesPerDay = isWeekend ? randomInt(5, 12) : randomInt(3, 8);
    
    for (let s = 0; s < salesPerDay; s++) {
      const saleDate = new Date(date);
      saleDate.setMinutes(saleDate.getMinutes() + s * randomInt(10, 60));
      
      // Random 1-6 items per sale
      const itemCount = randomInt(1, 6);
      const saleItems: any[] = [];
      let subtotal = 0;
      
      for (let i = 0; i < itemCount; i++) {
        const product = randomItem(products);
        const quantity = randomInt(1, 3);
        const price = product.sellPrice * quantity;
        subtotal += price;
        
        saleItems.push({
          productId: product.id,
          productName: product.name,
          quantity,
          unitPrice: product.sellPrice,
          costPrice: product.costPrice,
          totalPrice: price,
        });
      }
      
      // Random discount sometimes
      const discount = Math.random() > 0.9 ? Math.floor(subtotal * 0.05) : 0;
      const totalAmount = subtotal - discount;
      
      await prisma.sale.create({
        data: {
          shopId: shop.id,
          customerId: Math.random() > 0.7 ? randomItem(customers).id : null,
          subtotal,
          discount,
          tax: 0,
          totalAmount,
          paymentMethod: randomItem(paymentMethods),
          amountPaid: totalAmount,
          change: 0,
          status: 'COMPLETED',
          createdAt: saleDate,
          items: {
            create: saleItems,
          },
        },
      });
      salesCreated++;
    }
    
    // Progress indicator every 30 days
    if (daysAgo % 30 === 0 && daysAgo > 0) {
      console.log(`   ... ${365 - daysAgo} days of sales created`);
    }
  }
  console.log(`✅ ${salesCreated} sales created (past year)`);

  // ==================== STOCK LOGS ====================
  let stockLogsCreated = 0;
  for (const product of products) {
    // Initial stock received
    const initialQty = randomInt(50, 200);
    await prisma.stockLog.create({
      data: {
        shopId: shop.id,
        productId: product.id,
        type: 'INITIAL',
        quantity: initialQty,
        previousQty: 0,
        newQty: initialQty,
        createdAt: randomPastDate(365),
      },
    });
    stockLogsCreated++;
    
    // A few restocks throughout the year
    let qty = initialQty;
    for (let i = 0; i < randomInt(3, 8); i++) {
      const addQty = randomInt(20, 80);
      const newQty = qty + addQty;
      await prisma.stockLog.create({
        data: {
          shopId: shop.id,
          productId: product.id,
          type: 'RESTOCK',
          quantity: addQty,
          previousQty: qty,
          newQty: newQty,
          createdAt: randomPastDate(300),
        },
      });
      qty = newQty;
      stockLogsCreated++;
    }
  }
  console.log(`✅ ${stockLogsCreated} stock logs created`);

  // ==================== EXPENSES ====================
  let expensesCreated = 0;
  
  for (let month = 0; month < 12; month++) {
    const monthDate = new Date();
    monthDate.setMonth(monthDate.getMonth() - month);
    
    // Rent
    await prisma.expense.create({
      data: {
        shopId: shop.id,
        category: 'RENT',
        amount: 3500,
        description: 'Monthly rent',
        date: new Date(monthDate.getFullYear(), monthDate.getMonth(), 1),
      },
    });
    expensesCreated++;
    
    // Utilities
    await prisma.expense.create({
      data: {
        shopId: shop.id,
        category: 'UTILITIES',
        amount: randomInt(400, 800),
        description: 'Electricity & Water',
        date: new Date(monthDate.getFullYear(), monthDate.getMonth(), 5),
      },
    });
    expensesCreated++;
    
    // Supplies
    await prisma.expense.create({
      data: {
        shopId: shop.id,
        category: 'SUPPLIES',
        amount: randomInt(200, 500),
        description: 'Shopping bags, cleaning supplies',
        date: new Date(monthDate.getFullYear(), monthDate.getMonth(), randomInt(10, 20)),
      },
    });
    expensesCreated++;
    
    // Random expenses
    for (let i = 0; i < randomInt(2, 5); i++) {
      await prisma.expense.create({
        data: {
          shopId: shop.id,
          category: randomItem(['TRANSPORT', 'SUPPLIES', 'OTHER']),
          amount: randomInt(50, 300),
          description: randomItem(['Fuel', 'Repairs', 'Delivery', 'Miscellaneous']),
          date: new Date(monthDate.getFullYear(), monthDate.getMonth(), randomInt(1, 28)),
        },
      });
      expensesCreated++;
    }
  }
  console.log(`✅ ${expensesCreated} expenses created`);

  // ==================== SUMMARY ====================
  const totalSales = await prisma.sale.aggregate({
    where: { shopId: shop.id },
    _sum: { totalAmount: true },
    _count: true,
  });

  const totalExpenses = await prisma.expense.aggregate({
    where: { shopId: shop.id },
    _sum: { amount: true },
  });

  console.log('\n🌱 Seeding complete!');
  console.log(`   🏪 Shop: ${shop.name} (BUSINESS tier)`);
  console.log(`   📦 ${products.length} products`);
  console.log(`   👥 ${customers.length} customers`);
  console.log(`   🛒 ${totalSales._count} sales`);
  console.log(`   💰 E${totalSales._sum.totalAmount?.toLocaleString()} total revenue`);
  console.log(`   📝 ${stockLogsCreated} stock movements`);
  console.log(`   💸 ${expensesCreated} expenses (E${totalExpenses._sum.amount?.toLocaleString()})`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
