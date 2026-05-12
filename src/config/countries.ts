/**
 * Country metadata for signup defaults: phone code, timezone, currency
 * symbol. Used by auth.service when creating a new Shop. Currency rate +
 * billing data lives in @utils/currencies.ts — these are separate concerns
 * (one is for sign-up defaults; the other for currency conversion).
 */

export interface CountryMetadata {
  phoneCode: string;
  timezone: string;
  currencySymbol: string;
  currency: string; // ISO 4217
}

export const COUNTRY_METADATA: Record<string, CountryMetadata> = {
  ZA: { phoneCode: '+27',  timezone: 'Africa/Johannesburg', currencySymbol: 'R',    currency: 'ZAR' },
  NG: { phoneCode: '+234', timezone: 'Africa/Lagos',        currencySymbol: '₦',    currency: 'NGN' },
  KE: { phoneCode: '+254', timezone: 'Africa/Nairobi',      currencySymbol: 'KSh',  currency: 'KES' },
  GH: { phoneCode: '+233', timezone: 'Africa/Accra',        currencySymbol: 'GH₵',  currency: 'GHS' },
  EG: { phoneCode: '+20',  timezone: 'Africa/Cairo',        currencySymbol: 'E£',   currency: 'EGP' },
  TZ: { phoneCode: '+255', timezone: 'Africa/Dar_es_Salaam', currencySymbol: 'TSh', currency: 'TZS' },
  UG: { phoneCode: '+256', timezone: 'Africa/Kampala',      currencySymbol: 'USh',  currency: 'UGX' },
  RW: { phoneCode: '+250', timezone: 'Africa/Kigali',       currencySymbol: 'Fr',   currency: 'RWF' },
  ET: { phoneCode: '+251', timezone: 'Africa/Addis_Ababa',  currencySymbol: 'Br',   currency: 'ETB' },
  SZ: { phoneCode: '+268', timezone: 'Africa/Mbabane',      currencySymbol: 'E',    currency: 'SZL' },
  BW: { phoneCode: '+267', timezone: 'Africa/Gaborone',     currencySymbol: 'P',    currency: 'BWP' },
  ZM: { phoneCode: '+260', timezone: 'Africa/Lusaka',       currencySymbol: 'K',    currency: 'ZMW' },
  MW: { phoneCode: '+265', timezone: 'Africa/Blantyre',     currencySymbol: 'K',    currency: 'MWK' },
  ZW: { phoneCode: '+263', timezone: 'Africa/Harare',       currencySymbol: '$',    currency: 'USD' },
  MA: { phoneCode: '+212', timezone: 'Africa/Casablanca',   currencySymbol: 'د.م.', currency: 'MAD' },
  SN: { phoneCode: '+221', timezone: 'Africa/Dakar',        currencySymbol: 'CFA',  currency: 'XOF' },
  CI: { phoneCode: '+225', timezone: 'Africa/Abidjan',      currencySymbol: 'CFA',  currency: 'XOF' },
  CM: { phoneCode: '+237', timezone: 'Africa/Douala',       currencySymbol: 'FCFA', currency: 'XAF' },
  MZ: { phoneCode: '+258', timezone: 'Africa/Maputo',       currencySymbol: 'MT',   currency: 'MZN' },
  AO: { phoneCode: '+244', timezone: 'Africa/Luanda',       currencySymbol: 'Kz',   currency: 'AOA' },
  NA: { phoneCode: '+264', timezone: 'Africa/Windhoek',     currencySymbol: 'N$',   currency: 'NAD' },
};

export const DEFAULT_COUNTRY: CountryMetadata = {
  phoneCode: '+268',
  timezone: 'Africa/Mbabane',
  currencySymbol: 'E',
  currency: 'SZL',
};

export function getCountryMetadata(countryCode?: string | null): CountryMetadata {
  if (!countryCode) return DEFAULT_COUNTRY;
  return COUNTRY_METADATA[countryCode.toUpperCase()] ?? DEFAULT_COUNTRY;
}
