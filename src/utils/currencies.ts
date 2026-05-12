/**
 * African currency map — display + processor-billability.
 * Rates are approximate; update periodically or swap in a live FX API.
 *
 * `directBillable` = the underlying payment processor (currently Stripe, via
 * yebopay) accepts charges in this currency directly. When false, yebomart
 * converts the amount to USD before sending to yebopay. This is an
 * implementation detail of the centralized YeboPay gateway, not a Stripe-
 * specific concept — the day yebopay picks up a different card processor
 * with different currency support, the flag values update; the abstraction
 * stays.
 */
export interface CurrencyInfo {
  code: string        // ISO 4217
  symbol: string
  rate: number        // units per 1 USD
  name: string
  directBillable: boolean
  decimals: number    // smallest unit multiplier (usually 100, but some are 1)
}

export const AFRICAN_CURRENCIES: Record<string, CurrencyInfo> = {
  ZA: { code: 'ZAR', symbol: 'R',    rate: 18.50,  name: 'South African Rand',   directBillable: true,  decimals: 100 },
  NG: { code: 'NGN', symbol: '₦',    rate: 1580,   name: 'Nigerian Naira',        directBillable: true,  decimals: 100 },
  KE: { code: 'KES', symbol: 'KSh',  rate: 130,    name: 'Kenyan Shilling',       directBillable: true,  decimals: 100 },
  GH: { code: 'GHS', symbol: 'GH₵',  rate: 15.4,   name: 'Ghanaian Cedi',         directBillable: true,  decimals: 100 },
  EG: { code: 'EGP', symbol: 'E£',   rate: 48,     name: 'Egyptian Pound',        directBillable: true,  decimals: 100 },
  TZ: { code: 'TZS', symbol: 'TSh',  rate: 2580,   name: 'Tanzanian Shilling',    directBillable: false, decimals: 100 },
  UG: { code: 'UGX', symbol: 'USh',  rate: 3700,   name: 'Ugandan Shilling',      directBillable: false, decimals: 1   },
  RW: { code: 'RWF', symbol: 'Fr',   rate: 1350,   name: 'Rwandan Franc',         directBillable: false, decimals: 1   },
  ET: { code: 'ETB', symbol: 'Br',   rate: 115,    name: 'Ethiopian Birr',        directBillable: false, decimals: 100 },
  SZ: { code: 'SZL', symbol: 'L',    rate: 18.50,  name: 'Swazi Lilangeni',       directBillable: false, decimals: 100 },
  BW: { code: 'BWP', symbol: 'P',    rate: 13.5,   name: 'Botswana Pula',         directBillable: false, decimals: 100 },
  ZM: { code: 'ZMW', symbol: 'K',    rate: 27,     name: 'Zambian Kwacha',        directBillable: false, decimals: 100 },
  MW: { code: 'MWK', symbol: 'K',    rate: 1730,   name: 'Malawian Kwacha',       directBillable: false, decimals: 100 },
  ZW: { code: 'USD', symbol: '$',    rate: 1,      name: 'US Dollar',             directBillable: true,  decimals: 100 },
  MA: { code: 'MAD', symbol: 'د.م.', rate: 9.9,    name: 'Moroccan Dirham',       directBillable: false, decimals: 100 },
  SN: { code: 'XOF', symbol: 'CFA',  rate: 590,    name: 'CFA Franc (UEMOA)',     directBillable: false, decimals: 100 },
  CI: { code: 'XOF', symbol: 'CFA',  rate: 590,    name: 'CFA Franc (UEMOA)',     directBillable: false, decimals: 100 },
  CM: { code: 'XAF', symbol: 'FCFA', rate: 590,    name: 'CFA Franc (CEMAC)',     directBillable: false, decimals: 100 },
  MZ: { code: 'MZN', symbol: 'MT',   rate: 64,     name: 'Mozambican Metical',    directBillable: false, decimals: 100 },
  AO: { code: 'AOA', symbol: 'Kz',   rate: 900,    name: 'Angolan Kwanza',        directBillable: false, decimals: 100 },
  NA: { code: 'NAD', symbol: 'N$',   rate: 18.50,  name: 'Namibian Dollar',       directBillable: false, decimals: 100 },
}

export const DEFAULT_CURRENCY: CurrencyInfo = {
  code: 'USD', symbol: '$', rate: 1, name: 'US Dollar', directBillable: true, decimals: 100,
}

/**
 * Get currency info for a country code (ISO 3166-1 alpha-2).
 * Falls back to USD if unknown.
 */
export function getCurrencyForCountry(countryCode?: string | null): CurrencyInfo {
  if (!countryCode) return DEFAULT_CURRENCY
  return AFRICAN_CURRENCIES[countryCode.toUpperCase()] || DEFAULT_CURRENCY
}

/**
 * Convert a USD amount (in cents) to local currency.
 * Returns the Stripe-compatible smallest unit amount.
 */
export function convertFromUSD(usdCents: number, currency: CurrencyInfo): number {
  const usdAmount = usdCents / 100
  const localAmount = usdAmount * currency.rate
  return Math.round(localAmount * currency.decimals)
}

/**
 * Format a local currency amount (smallest unit) for display.
 */
export function formatLocalAmount(smallestUnit: number, currency: CurrencyInfo): string {
  const amount = smallestUnit / currency.decimals
  // No decimal for currencies where it looks odd (UGX, RWF etc)
  const formatted = currency.decimals === 1
    ? Math.round(amount).toLocaleString()
    : amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return `${currency.symbol}${formatted}`
}

/**
 * Localise a credit package for a given country.
 * Returns display price + Stripe charge currency + amount.
 */
export function localisePackage(
  pkg: { credits: number; price: number; name: string },
  countryCode?: string | null
) {
  const currency = getCurrencyForCountry(countryCode)
  const chargeCurrency = currency.directBillable ? currency : DEFAULT_CURRENCY
  const chargeAmount = convertFromUSD(pkg.price, chargeCurrency)
  const displayAmount = convertFromUSD(pkg.price, currency)

  return {
    ...pkg,
    // Charge details (what Stripe sees)
    stripeCurrency: chargeCurrency.code.toLowerCase(),
    stripeAmount: chargeAmount,
    // Display details (what the user sees)
    displayCurrency: currency.code,
    displaySymbol: currency.symbol,
    displayAmount,
    displayFormatted: formatLocalAmount(displayAmount, currency),
    // Also include USD for reference
    usdPrice: pkg.price,
    usdFormatted: `$${(pkg.price / 100).toFixed(0)}`,
    showUsdNote: currency.code !== 'USD',
  }
}
