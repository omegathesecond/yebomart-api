/**
 * Shop Types Configuration
 * Defines all supported business types and their default product categories
 * Keep in sync with yebomart-app/src/data/shopTypes.ts
 */

export interface ShopTypeConfig {
  id: string;
  name: string;
  description: string;
  categories: string[];
}

export const shopTypes: ShopTypeConfig[] = [
  // ==================== FOOD & GROCERY ====================
  {
    id: 'spaza',
    name: 'Spaza / Tuckshop',
    description: 'Small convenience store with everyday essentials',
    categories: [
      'Beverages', 'Snacks & Sweets', 'Bread & Bakery', 'Dairy & Eggs', 'Canned Goods',
      'Toiletries', 'Cleaning Supplies', 'Airtime & Data', 'Cigarettes', 'Ice & Cold Drinks', 'Other'
    ]
  },
  {
    id: 'grocery',
    name: 'Grocery Store',
    description: 'Full grocery with fresh produce and household items',
    categories: [
      'Fresh Produce', 'Meat & Poultry', 'Fish & Seafood', 'Dairy & Eggs', 'Bread & Bakery',
      'Beverages', 'Canned & Packaged', 'Frozen Foods', 'Snacks & Confectionery', 'Cooking & Baking',
      'Household & Cleaning', 'Personal Care', 'Baby Products', 'Pet Supplies', 'Other'
    ]
  },
  {
    id: 'butchery',
    name: 'Butchery',
    description: 'Fresh meat, poultry and related products',
    categories: [
      'Beef', 'Pork', 'Chicken', 'Lamb & Mutton', 'Goat', 'Offal', 'Mince & Sausages',
      'Boerewors', 'Marinated Meats', 'Braai Packs', 'Frozen Meats', 'Deli & Cold Cuts', 'Eggs', 'Other'
    ]
  },
  {
    id: 'bakery',
    name: 'Bakery',
    description: 'Bread, cakes, pastries and baked goods',
    categories: [
      'Bread - White', 'Bread - Brown', 'Bread - Specialty', 'Rolls & Buns', 'Cakes', 'Cupcakes',
      'Pastries', 'Pies & Tarts', 'Doughnuts', 'Biscuits & Cookies', 'Wedding Cakes', 'Custom Orders', 'Other'
    ]
  },
  {
    id: 'restaurant',
    name: 'Restaurant / Fast Food',
    description: 'Food service, takeaway and catering',
    categories: [
      'Breakfast', 'Lunch Specials', 'Dinner', 'Burgers & Sandwiches', 'Chicken', 'Pizza',
      'Pap & Meat', 'Sides', 'Beverages', 'Desserts', 'Combos / Meals', 'Catering', 'Other'
    ]
  },
  {
    id: 'liquor',
    name: 'Liquor Store / Bottle Store',
    description: 'Alcoholic beverages and mixers',
    categories: [
      'Beer - Local', 'Beer - Imported', 'Ciders', 'Wine - Red', 'Wine - White', 'Wine - Sparkling',
      'Spirits - Whisky', 'Spirits - Vodka', 'Spirits - Brandy', 'Spirits - Gin', 'Spirits - Rum',
      'Cream Liqueurs', 'Mixers & Soft Drinks', 'Ice', 'Snacks', 'Other'
    ]
  },

  // ==================== BEAUTY & PERSONAL CARE ====================
  {
    id: 'salon',
    name: 'Salon / Barbershop',
    description: 'Hair, beauty and grooming services',
    categories: [
      'Haircuts - Men', 'Haircuts - Women', 'Haircuts - Kids', 'Hair Styling', 'Hair Colouring',
      'Braiding', 'Weaves & Extensions', 'Dreadlocks', 'Relaxer & Perm', 'Treatments', 'Beard Grooming',
      'Shaving', 'Nails', 'Facial & Skincare', 'Hair Products', 'Beauty Products', 'Other Services'
    ]
  },
  {
    id: 'beauty',
    name: 'Beauty & Cosmetics Shop',
    description: 'Cosmetics, skincare and beauty products',
    categories: [
      'Skincare - Face', 'Skincare - Body', 'Lotions & Creams', 'Hair Care', 'Hair Extensions', 'Wigs',
      'Makeup - Face', 'Makeup - Eyes', 'Makeup - Lips', 'Nail Polish', 'Fragrances - Women',
      'Fragrances - Men', 'Deodorants', 'Oral Care', 'Feminine Care', 'Accessories', 'Other'
    ]
  },
  {
    id: 'makeup',
    name: 'Makeup & Cosmetics',
    description: 'Professional makeup products and tools',
    categories: [
      'Foundation', 'Concealer', 'Powder', 'Primer', 'Blush & Bronzer', 'Highlighter', 'Eyeshadow',
      'Eyeliner', 'Mascara', 'Eyebrows', 'Lipstick', 'Lip Gloss', 'Lip Liner', 'Setting Spray',
      'Brushes & Tools', 'Makeup Bags', 'Makeup Services', 'Other'
    ]
  },
  {
    id: 'spa',
    name: 'Spa & Wellness',
    description: 'Massage, treatments and wellness services',
    categories: [
      'Massage - Swedish', 'Massage - Deep Tissue', 'Massage - Hot Stone', 'Facials', 'Body Treatments',
      'Manicure', 'Pedicure', 'Waxing', 'Lash Extensions', 'Brow Services', 'Aromatherapy', 'Packages', 'Products', 'Other'
    ]
  },

  // ==================== AUTOMOTIVE ====================
  {
    id: 'tyre',
    name: 'Tyre Shop',
    description: 'Tyre sales, repairs and automotive accessories',
    categories: [
      'New Tyres - Car', 'New Tyres - SUV/4x4', 'New Tyres - Truck', 'New Tyres - Motorcycle',
      'Used Tyres', 'Tyre Repairs', 'Puncture Repair', 'Wheel Alignment', 'Wheel Balancing',
      'Rims & Mags', 'Tubes', 'Batteries', 'Oil & Lubricants', 'Accessories', 'Services'
    ]
  },
  {
    id: 'autoparts',
    name: 'Auto Parts & Accessories',
    description: 'Car parts, spares and accessories',
    categories: [
      'Engine Parts', 'Brake Parts', 'Suspension', 'Filters - Oil', 'Filters - Air', 'Filters - Fuel',
      'Belts & Hoses', 'Electrical', 'Lights & Bulbs', 'Batteries', 'Oils & Lubricants', 'Coolant & Fluids',
      'Wipers', 'Body Parts', 'Interior Accessories', 'Exterior Accessories', 'Car Audio', 'Tools', 'Other'
    ]
  },
  {
    id: 'carwash',
    name: 'Car Wash & Valet',
    description: 'Vehicle cleaning and detailing services',
    categories: [
      'Basic Wash', 'Full Wash', 'Interior Clean', 'Full Valet', 'Engine Wash', 'Wax & Polish',
      'Upholstery Cleaning', 'Leather Treatment', 'Tyre Shine', 'Air Fresheners', 'Detailing Products', 'Subscriptions', 'Other'
    ]
  },

  // ==================== HARDWARE & BUILDING ====================
  {
    id: 'hardware',
    name: 'Hardware Store',
    description: 'Building materials, tools and DIY supplies',
    categories: [
      'Power Tools', 'Hand Tools', 'Plumbing', 'Electrical', 'Paint & Supplies', 'Building Materials',
      'Cement & Sand', 'Roofing', 'Fasteners & Fixings', 'Safety Equipment', 'Garden & Outdoor',
      'Adhesives & Sealants', 'Doors & Windows', 'Locks & Security', 'Pipes & Fittings', 'Other'
    ]
  },
  {
    id: 'building',
    name: 'Building Supplies',
    description: 'Construction materials and building supplies',
    categories: [
      'Cement', 'Sand & Stone', 'Bricks & Blocks', 'Roofing Sheets', 'Roofing Tiles', 'Timber & Wood',
      'Steel & Metal', 'Doors', 'Windows', 'Tiles - Floor', 'Tiles - Wall', 'Plumbing Pipes',
      'Electrical Cables', 'Paint', 'Waterproofing', 'Insulation', 'Other'
    ]
  },

  // ==================== ELECTRONICS & TECH ====================
  {
    id: 'electronics',
    name: 'Electronics Shop',
    description: 'Phones, accessories and gadgets',
    categories: [
      'Smartphones', 'Feature Phones', 'Phone Accessories', 'Chargers & Cables', 'Headphones & Earbuds',
      'Power Banks', 'Screen Protectors', 'Phone Cases', 'Tablets', 'Laptops', 'TVs & Audio',
      'Gaming', 'Smart Watches', 'Repairs & Services', 'Airtime & Data', 'Other'
    ]
  },
  {
    id: 'computer',
    name: 'Computer Shop / Internet Café',
    description: 'Computers, accessories and internet services',
    categories: [
      'Desktops', 'Laptops', 'Monitors', 'Keyboards & Mice', 'Printers', 'Ink & Toner',
      'Storage - USB', 'Storage - Hard Drive', 'Cables & Adapters', 'Software', 'Internet - Per Hour',
      'Printing Services', 'Scanning', 'Photocopying', 'Computer Repairs', 'Other'
    ]
  },
  {
    id: 'repair',
    name: 'Phone & Electronics Repair',
    description: 'Device repairs and technical services',
    categories: [
      'Screen Replacement', 'Battery Replacement', 'Charging Port Repair', 'Water Damage',
      'Software Issues', 'Unlocking', 'Data Recovery', 'Laptop Repairs', 'TV Repairs',
      'Speaker Repairs', 'Accessories', 'Used Phones', 'Parts', 'Other'
    ]
  },

  // ==================== FASHION & CLOTHING ====================
  {
    id: 'clothing',
    name: 'Clothing Store',
    description: 'Fashion, apparel and accessories',
    categories: [
      "Men's Wear", "Women's Wear", "Kids' Wear", 'Baby Clothes', 'Shoes - Men', 'Shoes - Women',
      'Shoes - Kids', 'Accessories', 'Bags & Luggage', 'Underwear & Socks', 'Sportswear',
      'Workwear', 'Traditional Wear', 'Formal Wear', 'Other'
    ]
  },
  {
    id: 'shoes',
    name: 'Shoe Shop',
    description: 'Footwear for all ages and occasions',
    categories: [
      "Men's Casual", "Men's Formal", "Men's Sports", "Women's Casual", "Women's Formal",
      "Women's Heels", "Women's Flats", "Kids' Shoes", 'School Shoes', 'Sandals & Slippers',
      'Boots', 'Sneakers', 'Work Boots', 'Shoe Care', 'Bags & Accessories', 'Other'
    ]
  },
  {
    id: 'tailoring',
    name: 'Tailoring & Alterations',
    description: 'Custom clothing and alteration services',
    categories: [
      'Suits - Made to Order', 'Dresses - Custom', 'Traditional Wear - Custom',
      'Alterations - Hem', 'Alterations - Take In/Let Out', 'Alterations - Zip Replacement',
      'Alterations - Button', 'School Uniforms', 'Work Uniforms', 'Bridal Wear',
      'Fabric', 'Thread & Accessories', 'Other'
    ]
  },
  {
    id: 'thrift',
    name: 'Second-Hand / Thrift Store',
    description: 'Pre-owned clothing and goods',
    categories: [
      "Men's Clothing", "Women's Clothing", "Kids' Clothing", 'Shoes', 'Bags', 'Accessories',
      'Electronics', 'Books', 'Furniture', 'Kitchenware', 'Toys', 'Sports Equipment', 'Other'
    ]
  },

  // ==================== HEALTH & PHARMACY ====================
  {
    id: 'pharmacy',
    name: 'Pharmacy',
    description: 'Medicines, health and beauty products',
    categories: [
      'Prescription Medicines', 'Over-the-Counter', 'Pain Relief', 'Cold & Flu', 'Allergies',
      'Digestive Health', 'Vitamins & Supplements', 'First Aid', 'Medical Equipment', 'Personal Care',
      'Baby Care', 'Skincare', 'Hair Care', 'Oral Care', 'Eye Care', 'Other'
    ]
  },
  {
    id: 'traditional',
    name: 'Traditional Medicine / Herbalist',
    description: 'Traditional and herbal remedies',
    categories: [
      'Herbs - Dried', 'Herbs - Fresh', 'Traditional Remedies', 'Teas & Infusions',
      'Oils & Balms', 'Powders', 'Cleansing Products', 'Spiritual Items', 'Consultations', 'Other'
    ]
  },

  // ==================== HOME & FURNITURE ====================
  {
    id: 'furniture',
    name: 'Furniture Store',
    description: 'Home and office furniture',
    categories: [
      'Living Room', 'Bedroom', 'Dining Room', 'Kitchen', 'Office Furniture', 'Outdoor Furniture',
      'Mattresses', "Kids' Furniture", 'Storage & Shelving', 'TV Stands', 'Decor & Accessories',
      'Carpets & Rugs', 'Curtains & Blinds', 'Lighting', 'Other'
    ]
  },
  {
    id: 'homeware',
    name: 'Homeware & Kitchen',
    description: 'Household items and kitchenware',
    categories: [
      'Cookware', 'Bakeware', 'Utensils', 'Cutlery', 'Crockery', 'Glassware', 'Storage Containers',
      'Small Appliances', 'Cleaning Supplies', 'Laundry', 'Bathroom', 'Bedding', 'Towels', 'Decor', 'Other'
    ]
  },

  // ==================== STATIONERY & OFFICE ====================
  {
    id: 'stationery',
    name: 'Stationery & Office Supplies',
    description: 'School and office supplies',
    categories: [
      'Pens & Pencils', 'Notebooks & Pads', 'Files & Folders', 'Paper - A4', 'Paper - Other',
      'Envelopes', 'Calculators', 'Rulers & Sets', 'Art Supplies', 'School Bags', 'Lunch Boxes',
      'Labels & Stickers', 'Office Machines', 'Desk Accessories', 'Greeting Cards', 'Gift Wrap', 'Other'
    ]
  },
  {
    id: 'printing',
    name: 'Printing & Copy Shop',
    description: 'Printing, copying and design services',
    categories: [
      'Photocopying - B&W', 'Photocopying - Colour', 'Printing - Documents', 'Printing - Photos',
      'Printing - Large Format', 'Business Cards', 'Flyers & Brochures', 'Posters & Banners',
      'Binding', 'Laminating', 'Scanning', 'Typing Services', 'CV/Resume', 'Design Services', 'Other'
    ]
  },
  {
    id: 'bookshop',
    name: 'Bookshop',
    description: 'Books, magazines and educational materials',
    categories: [
      'Fiction', 'Non-Fiction', 'Educational - Primary', 'Educational - Secondary',
      'Educational - Tertiary', "Children's Books", 'Religious', 'Self-Help', 'Business',
      'Cookbooks', 'Magazines', 'Newspapers', 'Stationery', 'Other'
    ]
  },

  // ==================== AGRICULTURE & FARMING ====================
  {
    id: 'agri',
    name: 'Agricultural Supplies',
    description: 'Farming supplies, seeds and equipment',
    categories: [
      'Seeds - Vegetables', 'Seeds - Maize', 'Seeds - Other Crops', 'Fertilizers', 'Pesticides',
      'Herbicides', 'Animal Feed - Poultry', 'Animal Feed - Cattle', 'Animal Feed - Pigs',
      'Veterinary Products', 'Farm Tools', 'Irrigation', 'Fencing', 'Protective Gear', 'Other'
    ]
  },
  {
    id: 'nursery',
    name: 'Plant Nursery / Garden Centre',
    description: 'Plants, gardening supplies and landscaping',
    categories: [
      'Indoor Plants', 'Outdoor Plants', 'Trees & Shrubs', 'Flowers', 'Succulents',
      'Vegetables & Herbs', 'Seeds', 'Pots & Planters', 'Soil & Compost', 'Fertilizer',
      'Garden Tools', 'Irrigation', 'Decor & Ornaments', 'Other'
    ]
  },

  // ==================== SERVICES ====================
  {
    id: 'laundry',
    name: 'Laundry / Dry Cleaning',
    description: 'Laundry and dry cleaning services',
    categories: [
      'Wash & Fold - Per KG', 'Wash & Iron', 'Dry Cleaning - Suits', 'Dry Cleaning - Dresses',
      'Dry Cleaning - Coats', 'Ironing Only', 'Bedding & Linen', 'Curtains', 'Carpet Cleaning',
      'Stain Removal', 'Express Service', 'Delivery', 'Other'
    ]
  },
  {
    id: 'photography',
    name: 'Photography / Studio',
    description: 'Photography services and prints',
    categories: [
      'Passport Photos', 'ID Photos', 'Portrait Session', 'Family Photos', 'Event Coverage',
      'Wedding Photography', 'Corporate/Business', 'Photo Printing', 'Canvas Prints', 'Frames',
      'Video Services', 'Photo Editing', 'Other'
    ]
  },

  // ==================== ENTERTAINMENT & LEISURE ====================
  {
    id: 'gaming',
    name: 'Gaming / Entertainment',
    description: 'Video games, consoles and entertainment',
    categories: [
      'Gaming - Per Hour', 'PS5 Games', 'PS4 Games', 'Xbox Games', 'Nintendo Games', 'PC Games',
      'Consoles', 'Controllers', 'Gaming Accessories', 'Snacks & Drinks', 'Other'
    ]
  },
  {
    id: 'sport',
    name: 'Sports Shop',
    description: 'Sports equipment, apparel and accessories',
    categories: [
      'Football', 'Rugby', 'Cricket', 'Tennis', 'Running', 'Gym & Fitness', 'Swimming',
      'Boxing', 'Golf', 'Cycling', 'Sportswear', 'Sports Shoes', 'Bags & Accessories', 'Nutrition', 'Other'
    ]
  },
  {
    id: 'music',
    name: 'Music Shop',
    description: 'Musical instruments and accessories',
    categories: [
      'Guitars', 'Keyboards & Pianos', 'Drums & Percussion', 'Brass & Woodwind', 'Strings',
      'DJ Equipment', 'Microphones', 'Speakers & Amps', 'Recording Equipment', 'Accessories',
      'Sheet Music', 'Lessons', 'Other'
    ]
  },

  // ==================== GIFTS & SPECIALTY ====================
  {
    id: 'gift',
    name: 'Gift Shop',
    description: 'Gifts, souvenirs and specialty items',
    categories: [
      'Greeting Cards', 'Gift Wrap & Bags', 'Flowers', 'Chocolates & Sweets', 'Teddy Bears & Toys',
      'Jewellery', 'Watches', 'Fragrances', 'Photo Frames', 'Home Decor', 'Candles',
      'Souvenirs', 'Gift Hampers', 'Balloons', 'Other'
    ]
  },
  {
    id: 'jewellery',
    name: 'Jewellery Store',
    description: 'Jewellery, watches and accessories',
    categories: [
      'Rings - Gold', 'Rings - Silver', 'Rings - Fashion', 'Engagement Rings', 'Wedding Bands',
      'Necklaces', 'Bracelets', 'Earrings', 'Watches - Men', 'Watches - Women', 'Cufflinks',
      'Repairs', 'Custom Orders', 'Other'
    ]
  },
  {
    id: 'florist',
    name: 'Florist',
    description: 'Fresh flowers, arrangements and plants',
    categories: [
      'Single Flowers', 'Bouquets - Small', 'Bouquets - Medium', 'Bouquets - Large', 'Roses',
      'Mixed Arrangements', 'Funeral Flowers', 'Wedding Flowers', 'Event Flowers', 'Indoor Plants',
      'Vases', 'Chocolates & Add-ons', 'Delivery', 'Other'
    ]
  },
  {
    id: 'pet',
    name: 'Pet Shop',
    description: 'Pet food, supplies and accessories',
    categories: [
      'Dog Food', 'Cat Food', 'Bird Food', 'Fish Food', 'Small Animal Food', 'Pet Treats',
      'Collars & Leashes', 'Beds & Crates', 'Toys', 'Grooming', 'Health & Wellness',
      'Aquariums & Accessories', 'Bird Cages', 'Live Animals', 'Other'
    ]
  },
  {
    id: 'craft',
    name: 'Arts & Crafts',
    description: 'Art supplies, crafts and DIY materials',
    categories: [
      'Paints', 'Brushes', 'Canvas & Paper', 'Drawing Supplies', 'Beads & Jewellery Making',
      'Sewing & Knitting', 'Fabric', 'Scrapbooking', "Kids' Crafts", 'Glue & Adhesives',
      'Tools', 'Frames', 'Other'
    ]
  },

  // ==================== GENERAL ====================
  {
    id: 'general',
    name: 'General Store',
    description: 'Mixed retail - customize your own categories',
    categories: ['Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5', 'Other']
  }
];

/**
 * Get a shop type by ID
 */
export function getShopType(id: string): ShopTypeConfig | undefined {
  return shopTypes.find(t => t.id === id);
}

/**
 * Get categories for a shop type
 */
export function getCategories(shopTypeId: string): string[] {
  const shopType = getShopType(shopTypeId);
  return shopType?.categories || getShopType('general')?.categories || [];
}

/**
 * Check if a shop type ID is valid
 */
export function isValidShopType(id: string): boolean {
  return shopTypes.some(t => t.id === id);
}

/**
 * Get all shop type IDs
 */
export function getAllShopTypeIds(): string[] {
  return shopTypes.map(t => t.id);
}
