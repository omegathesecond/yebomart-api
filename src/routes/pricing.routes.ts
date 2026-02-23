import { Router } from 'express';
import { getSupportedCountries, getPricingForCountry } from '@config/pricing';
import { ApiResponse } from '@utils/ApiResponse';

const router = Router();

/**
 * GET /pricing/countries
 * Public — returns all supported countries with their pricing tiers
 */
router.get('/countries', (req, res) => {
  const countries = getSupportedCountries();
  ApiResponse.success(res, { countries });
});

/**
 * GET /pricing/:countryCode
 * Public — returns pricing for a specific country
 */
router.get('/:countryCode', (req, res) => {
  const { countryCode } = req.params;
  const pricing = getPricingForCountry(countryCode.toUpperCase());
  ApiResponse.success(res, { pricing });
});

export default router;
