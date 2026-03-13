const DEFAULT_CUSTOMER_TYPE_CONFIG = {
  premium: { min: 10000 },
  standard: { min: 5000, max: 9999 },
  basic: { max: 4999 }
};

const clampNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sanitizeCustomerTypeConfig = (input = {}) => {
  const fallback = DEFAULT_CUSTOMER_TYPE_CONFIG;
  const premiumMin =
    clampNumber(input?.premium?.min) !== null && clampNumber(input?.premium?.min) > 0
      ? clampNumber(input.premium.min)
      : fallback.premium.min;

  let standardMin =
    clampNumber(input?.standard?.min) !== null && clampNumber(input?.standard?.min) >= 0
      ? clampNumber(input.standard.min)
      : fallback.standard.min;
  if (standardMin >= premiumMin) {
    standardMin = Math.max(0, premiumMin - 1);
  }

  let standardMax =
    clampNumber(input?.standard?.max) !== null && clampNumber(input?.standard?.max) >= standardMin
      ? clampNumber(input.standard.max)
      : premiumMin - 1;
  if (standardMax >= premiumMin) {
    standardMax = premiumMin - 1;
  }
  if (standardMax < standardMin) {
    standardMax = standardMin;
  }

  let basicMax =
    clampNumber(input?.basic?.max) !== null && clampNumber(input?.basic?.max) < standardMin
      ? clampNumber(input.basic.max)
      : standardMin - 1;
  if (basicMax < 0) {
    basicMax = 0;
  }

  return {
    premium: { min: premiumMin },
    standard: { min: standardMin, max: standardMax },
    basic: { max: basicMax }
  };
};

const determineCustomerType = (total = 0, config = DEFAULT_CUSTOMER_TYPE_CONFIG) => {
  const normalizedConfig = sanitizeCustomerTypeConfig(config);
  const spend = Number(total) || 0;
  if (spend >= normalizedConfig.premium.min) {
    return 'Premium';
  }
  if (spend >= normalizedConfig.standard.min && spend <= normalizedConfig.standard.max) {
    return 'Standard';
  }
  return 'Basic';
};

module.exports = {
  DEFAULT_CUSTOMER_TYPE_CONFIG,
  sanitizeCustomerTypeConfig,
  determineCustomerType
};
