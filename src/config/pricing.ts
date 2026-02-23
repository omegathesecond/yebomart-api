/**
 * YeboMart Country-Specific Pricing
 * PPP-adjusted pricing for all tiers across 15 African countries
 * 
 * Methodology: GDP per capita (PPP) adjustment relative to Eswatini baseline
 * Last updated: 2026-02-23
 */

export interface CountryPricing {
  countryCode: string;
  country: string;
  flag: string;
  currency: string;
  currencySymbol: string;
  phoneCode: string;
  timezone: string;
  tiers: {
    LITE: number;
    STARTER: number;
    BUSINESS: number;
    PRO: number;
    ENTERPRISE: number;
  };
}

export const COUNTRY_PRICING: Record<string, CountryPricing> = {
  SZ: {
    countryCode: 'SZ',
    country: 'Eswatini',
    flag: '🇸🇿',
    currency: 'SZL',
    currencySymbol: 'E',
    phoneCode: '+268',
    timezone: 'Africa/Mbabane',
    tiers: { LITE: 299, STARTER: 899, BUSINESS: 2499, PRO: 4999, ENTERPRISE: 9999 },
  },
  ZA: {
    countryCode: 'ZA',
    country: 'South Africa',
    flag: '🇿🇦',
    currency: 'ZAR',
    currencySymbol: 'R',
    phoneCode: '+27',
    timezone: 'Africa/Johannesburg',
    tiers: { LITE: 399, STARTER: 1299, BUSINESS: 3499, PRO: 6999, ENTERPRISE: 13999 },
  },
  KE: {
    countryCode: 'KE',
    country: 'Kenya',
    flag: '🇰🇪',
    currency: 'KES',
    currencySymbol: 'KSh',
    phoneCode: '+254',
    timezone: 'Africa/Nairobi',
    tiers: { LITE: 2499, STARTER: 7499, BUSINESS: 19999, PRO: 39999, ENTERPRISE: 79999 },
  },
  NG: {
    countryCode: 'NG',
    country: 'Nigeria',
    flag: '🇳🇬',
    currency: 'NGN',
    currencySymbol: '₦',
    phoneCode: '+234',
    timezone: 'Africa/Lagos',
    tiers: { LITE: 24999, STARTER: 74999, BUSINESS: 199999, PRO: 399999, ENTERPRISE: 799999 },
  },
  GH: {
    countryCode: 'GH',
    country: 'Ghana',
    flag: '🇬🇭',
    currency: 'GHS',
    currencySymbol: 'GH₵',
    phoneCode: '+233',
    timezone: 'Africa/Accra',
    tiers: { LITE: 349, STARTER: 999, BUSINESS: 2699, PRO: 5499, ENTERPRISE: 10999 },
  },
  TZ: {
    countryCode: 'TZ',
    country: 'Tanzania',
    flag: '🇹🇿',
    currency: 'TZS',
    currencySymbol: 'TSh',
    phoneCode: '+255',
    timezone: 'Africa/Dar_es_Salaam',
    tiers: { LITE: 29999, STARTER: 89999, BUSINESS: 249999, PRO: 499999, ENTERPRISE: 999999 },
  },
  UG: {
    countryCode: 'UG',
    country: 'Uganda',
    flag: '🇺🇬',
    currency: 'UGX',
    currencySymbol: 'USh',
    phoneCode: '+256',
    timezone: 'Africa/Kampala',
    tiers: { LITE: 59999, STARTER: 179999, BUSINESS: 499999, PRO: 999999, ENTERPRISE: 1999999 },
  },
  RW: {
    countryCode: 'RW',
    country: 'Rwanda',
    flag: '🇷🇼',
    currency: 'RWF',
    currencySymbol: 'FRw',
    phoneCode: '+250',
    timezone: 'Africa/Kigali',
    tiers: { LITE: 14999, STARTER: 44999, BUSINESS: 124999, PRO: 249999, ENTERPRISE: 499999 },
  },
  ET: {
    countryCode: 'ET',
    country: 'Ethiopia',
    flag: '🇪🇹',
    currency: 'ETB',
    currencySymbol: 'Br',
    phoneCode: '+251',
    timezone: 'Africa/Addis_Ababa',
    tiers: { LITE: 1499, STARTER: 4499, BUSINESS: 12499, PRO: 24999, ENTERPRISE: 49999 },
  },
  CI: {
    countryCode: 'CI',
    country: 'Ivory Coast',
    flag: '🇨🇮',
    currency: 'XOF',
    currencySymbol: 'CFA',
    phoneCode: '+225',
    timezone: 'Africa/Abidjan',
    tiers: { LITE: 9999, STARTER: 29999, BUSINESS: 84999, PRO: 169999, ENTERPRISE: 339999 },
  },
  SN: {
    countryCode: 'SN',
    country: 'Senegal',
    flag: '🇸🇳',
    currency: 'XOF',
    currencySymbol: 'CFA',
    phoneCode: '+221',
    timezone: 'Africa/Dakar',
    tiers: { LITE: 7999, STARTER: 24999, BUSINESS: 64999, PRO: 129999, ENTERPRISE: 259999 },
  },
  ZM: {
    countryCode: 'ZM',
    country: 'Zambia',
    flag: '🇿🇲',
    currency: 'ZMW',
    currencySymbol: 'ZK',
    phoneCode: '+260',
    timezone: 'Africa/Lusaka',
    tiers: { LITE: 299, STARTER: 899, BUSINESS: 2499, PRO: 4999, ENTERPRISE: 9999 },
  },
  ZW: {
    countryCode: 'ZW',
    country: 'Zimbabwe',
    flag: '🇿🇼',
    currency: 'USD',
    currencySymbol: '$',
    phoneCode: '+263',
    timezone: 'Africa/Harare',
    tiers: { LITE: 9, STARTER: 29, BUSINESS: 79, PRO: 149, ENTERPRISE: 299 },
  },
  BW: {
    countryCode: 'BW',
    country: 'Botswana',
    flag: '🇧🇼',
    currency: 'BWP',
    currencySymbol: 'P',
    phoneCode: '+267',
    timezone: 'Africa/Gaborone',
    tiers: { LITE: 549, STARTER: 1699, BUSINESS: 4499, PRO: 8999, ENTERPRISE: 17999 },
  },
  MZ: {
    countryCode: 'MZ',
    country: 'Mozambique',
    flag: '🇲🇿',
    currency: 'MZN',
    currencySymbol: 'MT',
    phoneCode: '+258',
    timezone: 'Africa/Maputo',
    tiers: { LITE: 299, STARTER: 899, BUSINESS: 2499, PRO: 4999, ENTERPRISE: 9999 },
  },
};

/** Get pricing for a country, fallback to Eswatini */
export function getPricingForCountry(countryCode: string): CountryPricing {
  return COUNTRY_PRICING[countryCode] || COUNTRY_PRICING['SZ'];
}

/** Get all supported countries */
export function getSupportedCountries(): CountryPricing[] {
  return Object.values(COUNTRY_PRICING);
}

/** Get tier price for a specific country */
export function getTierPrice(countryCode: string, tier: string): number {
  const pricing = getPricingForCountry(countryCode);
  return pricing.tiers[tier as keyof typeof pricing.tiers] || pricing.tiers.LITE;
}
