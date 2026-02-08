// Business type configurations for different shop types

export const BUSINESS_TYPES = {
  general: {
    name: 'General Store',
    icon: '🏪',
    units: ['each', 'pack', 'box', 'kg', 'litre'],
    categories: ['General', 'Food', 'Drinks', 'Household', 'Other'],
  },
  tuckshop: {
    name: 'Tuck Shop',
    icon: '🍬',
    units: ['each', 'pack', 'box'],
    categories: ['Snacks', 'Drinks', 'Sweets', 'Chips', 'Airtime', 'Other'],
  },
  tyre: {
    name: 'Tyre Shop',
    icon: '🛞',
    units: ['each', 'pair', 'set'],
    categories: ['Tyres', 'Rims', 'Tubes', 'Accessories', 'Services', 'Other'],
  },
  hardware: {
    name: 'Hardware Store',
    icon: '🔧',
    units: ['each', 'pack', 'box', 'kg', 'metre', 'litre'],
    categories: ['Tools', 'Electrical', 'Plumbing', 'Paint', 'Building', 'Garden', 'Other'],
  },
  grocery: {
    name: 'Grocery Store',
    icon: '🛒',
    units: ['each', 'kg', 'litre', 'pack', 'dozen'],
    categories: ['Fresh Produce', 'Meat', 'Dairy', 'Bakery', 'Frozen', 'Canned', 'Drinks', 'Other'],
  },
  pharmacy: {
    name: 'Pharmacy',
    icon: '💊',
    units: ['each', 'pack', 'box', 'bottle'],
    categories: ['Prescription', 'OTC', 'Vitamins', 'Personal Care', 'Baby', 'First Aid', 'Other'],
  },
  salon: {
    name: 'Salon / Barbershop',
    icon: '💇',
    units: ['each', 'bottle', 'pack'],
    categories: ['Hair Products', 'Services', 'Accessories', 'Cosmetics', 'Other'],
  },
  spaza: {
    name: 'Spaza Shop',
    icon: '🏠',
    units: ['each', 'pack', 'kg', 'litre'],
    categories: ['Groceries', 'Snacks', 'Drinks', 'Household', 'Airtime', 'Other'],
  },
  auto: {
    name: 'Auto Parts',
    icon: '🚗',
    units: ['each', 'pair', 'set', 'litre'],
    categories: ['Engine Parts', 'Body Parts', 'Electrical', 'Fluids', 'Accessories', 'Other'],
  },
  electronics: {
    name: 'Electronics',
    icon: '📱',
    units: ['each', 'pack'],
    categories: ['Phones', 'Accessories', 'Computers', 'Audio', 'Repairs', 'Other'],
  },
};

export type BusinessType = keyof typeof BUSINESS_TYPES;

export const getBusinessConfig = (type: string) => {
  return BUSINESS_TYPES[type as BusinessType] || BUSINESS_TYPES.general;
};

export const getAllBusinessTypes = () => {
  return Object.entries(BUSINESS_TYPES).map(([key, value]) => ({
    id: key,
    ...value,
  }));
};
