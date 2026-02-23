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
    tiers: { LITE: 499, STARTER: 1499, BUSINESS: 3999, PRO: 7999, ENTERPRISE: 15999 },
  },
  ZA: {
    countryCode: 'ZA',
    country: 'South Africa',
    flag: '🇿🇦',
    currency: 'ZAR',
    currencySymbol: 'R',
    phoneCode: '+27',
    timezone: 'Africa/Johannesburg',
    tiers: { LITE: 699, STARTER: 2099, BUSINESS: 5599, PRO: 11199, ENTERPRISE: 22399 },
  },
  KE: {
    countryCode: 'KE',
    country: 'Kenya',
    flag: '🇰🇪',
    currency: 'KES',
    currencySymbol: 'KSh',
    phoneCode: '+254',
    timezone: 'Africa/Nairobi',
    tiers: { LITE: 3999, STARTER: 11999, BUSINESS: 31999, PRO: 63999, ENTERPRISE: 127999 },
  },
  NG: {
    countryCode: 'NG',
    country: 'Nigeria',
    flag: '🇳🇬',
    currency: 'NGN',
    currencySymbol: '₦',
    phoneCode: '+234',
    timezone: 'Africa/Lagos',
    tiers: { LITE: 42999, STARTER: 128999, BUSINESS: 343999, PRO: 687999, ENTERPRISE: 1375999 },
  },
  GH: {
    countryCode: 'GH',
    country: 'Ghana',
    flag: '🇬🇭',
    currency: 'GHS',
    currencySymbol: 'GH₵',
    phoneCode: '+233',
    timezone: 'Africa/Accra',
    tiers: { LITE: 549, STARTER: 1649, BUSINESS: 4399, PRO: 8799, ENTERPRISE: 17599 },
  },
  TZ: {
    countryCode: 'TZ',
    country: 'Tanzania',
    flag: '🇹🇿',
    currency: 'TZS',
    currencySymbol: 'TSh',
    phoneCode: '+255',
    timezone: 'Africa/Dar_es_Salaam',
    tiers: { LITE: 49999, STARTER: 149999, BUSINESS: 399999, PRO: 799999, ENTERPRISE: 1599999 },
  },
  UG: {
    countryCode: 'UG',
    country: 'Uganda',
    flag: '🇺🇬',
    currency: 'UGX',
    currencySymbol: 'USh',
    phoneCode: '+256',
    timezone: 'Africa/Kampala',
    tiers: { LITE: 99999, STARTER: 299999, BUSINESS: 799999, PRO: 1599999, ENTERPRISE: 3199999 },
  },
  RW: {
    countryCode: 'RW',
    country: 'Rwanda',
    flag: '🇷🇼',
    currency: 'RWF',
    currencySymbol: 'FRw',
    phoneCode: '+250',
    timezone: 'Africa/Kigali',
    tiers: { LITE: 24999, STARTER: 74999, BUSINESS: 199999, PRO: 399999, ENTERPRISE: 799999 },
  },
  ET: {
    countryCode: 'ET',
    country: 'Ethiopia',
    flag: '🇪🇹',
    currency: 'ETB',
    currencySymbol: 'Br',
    phoneCode: '+251',
    timezone: 'Africa/Addis_Ababa',
    tiers: { LITE: 2499, STARTER: 7499, BUSINESS: 19999, PRO: 39999, ENTERPRISE: 79999 },
  },
  CI: {
    countryCode: 'CI',
    country: 'Ivory Coast',
    flag: '🇨🇮',
    currency: 'XOF',
    currencySymbol: 'CFA',
    phoneCode: '+225',
    timezone: 'Africa/Abidjan',
    tiers: { LITE: 16999, STARTER: 50999, BUSINESS: 135999, PRO: 271999, ENTERPRISE: 543999 },
  },
  SN: {
    countryCode: 'SN',
    country: 'Senegal',
    flag: '🇸🇳',
    currency: 'XOF',
    currencySymbol: 'CFA',
    phoneCode: '+221',
    timezone: 'Africa/Dakar',
    tiers: { LITE: 12999, STARTER: 38999, BUSINESS: 103999, PRO: 207999, ENTERPRISE: 415999 },
  },
  ZM: {
    countryCode: 'ZM',
    country: 'Zambia',
    flag: '🇿🇲',
    currency: 'ZMW',
    currencySymbol: 'ZK',
    phoneCode: '+260',
    timezone: 'Africa/Lusaka',
    tiers: { LITE: 499, STARTER: 1499, BUSINESS: 3999, PRO: 7999, ENTERPRISE: 15999 },
  },
  ZW: {
    countryCode: 'ZW',
    country: 'Zimbabwe',
    flag: '🇿🇼',
    currency: 'USD',
    currencySymbol: '$',
    phoneCode: '+263',
    timezone: 'Africa/Harare',
    tiers: { LITE: 15, STARTER: 45, BUSINESS: 120, PRO: 240, ENTERPRISE: 480 },
  },
  BW: {
    countryCode: 'BW',
    country: 'Botswana',
    flag: '🇧🇼',
    currency: 'BWP',
    currencySymbol: 'P',
    phoneCode: '+267',
    timezone: 'Africa/Gaborone',
    tiers: { LITE: 899, STARTER: 2699, BUSINESS: 7199, PRO: 14399, ENTERPRISE: 28799 },
  },
  MZ: {
    countryCode: 'MZ',
    country: 'Mozambique',
    flag: '🇲🇿',
    currency: 'MZN',
    currencySymbol: 'MT',
    phoneCode: '+258',
    timezone: 'Africa/Maputo',
    tiers: { LITE: 499, STARTER: 1499, BUSINESS: 3999, PRO: 7999, ENTERPRISE: 15999 },
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
