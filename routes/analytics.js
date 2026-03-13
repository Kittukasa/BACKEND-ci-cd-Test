const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const resendService = require('../services/resendService');
const billingService = require('../services/billingService');
const { docClient } = require('../config/dynamodb');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const RESEND_MAX_ATTEMPTS = Math.max(1, Number(process.env.RESEND_MAX_ATTEMPTS || 4));
const RESEND_SUCCESS_THRESHOLD = Number(process.env.RESEND_SUCCESS_THRESHOLD || 0.9);
const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || 'Test-Franchise_Wallets';
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const DEFAULT_WALLET_STORE_ID = 'ALL';

const toNumber = value => {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// GET /api/analytics/stores - Get all unique stores
router.get('/stores', async (req, res) => {
  try {
    const stores = await analyticsService.getStores();
    res.json(stores);
  } catch (error) {
    console.error('Error in /stores endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

// GET /api/analytics/invoices?storeId=... - Get invoices for a store
router.get('/invoices', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const invoices = await analyticsService.getInvoices(storeId);
    res.json(invoices);
  } catch (error) {
    console.error('Error in /invoices endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/daily-end-reports', async (req, res) => {
  try {
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }

    const invoices = await analyticsService.getDailyEndReportInvoices(storeId);
    res.json(invoices);
  } catch (error) {
    console.error('Error in /daily-end-reports endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch daily end reports' });
  }
});

router.post('/invoices/exclude', async (req, res) => {
  try {
    const providedStoreId =
      typeof req.body?.storeId === 'string'
        ? req.body.storeId.trim()
        : req.body?.storeId?.toString().trim();
    const tokenStoreId = req.user?.store_id ? req.user.store_id.toString() : null;
    const storeId = providedStoreId || tokenStoreId;
    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required.' });
    }
    if (tokenStoreId && tokenStoreId !== storeId) {
      return res.status(403).json({ error: 'You can only manage invoices for your store.' });
    }
    const invoicePayload = req.body?.invoice || {};
    const fingerprint =
      invoicePayload?.fingerprint || analyticsService.buildInvoiceFingerprint(invoicePayload);
    if (!fingerprint) {
      return res.status(400).json({ error: 'Invoice details are required to exclude.' });
    }
    await analyticsService.excludeInvoice(storeId, fingerprint);
    return res.json({ success: true, fingerprint });
  } catch (error) {
    console.error('Error excluding invoice', { error: error.message });
    return res.status(500).json({ error: 'Unable to exclude invoice right now.' });
  }
});

router.post('/invoices/include', async (req, res) => {
  try {
    const providedStoreId =
      typeof req.body?.storeId === 'string'
        ? req.body.storeId.trim()
        : req.body?.storeId?.toString().trim();
    const tokenStoreId = req.user?.store_id ? req.user.store_id.toString() : null;
    const storeId = providedStoreId || tokenStoreId;
    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required.' });
    }
    if (tokenStoreId && tokenStoreId !== storeId) {
      return res.status(403).json({ error: 'You can only manage invoices for your store.' });
    }
    const invoicePayload = req.body?.invoice || {};
    const fingerprint =
      invoicePayload?.fingerprint || analyticsService.buildInvoiceFingerprint(invoicePayload);
    if (!fingerprint) {
      return res.status(400).json({ error: 'Invoice details are required to include.' });
    }
    const restoreFromDaily = Boolean(invoicePayload?.is_daily_end_report);
    await analyticsService.includeInvoice(storeId, fingerprint, invoicePayload, { restoreFromDaily });
    return res.json({ success: true, fingerprint });
  } catch (error) {
    console.error('Error including invoice', { error: error.message });
    return res.status(500).json({ error: 'Unable to include invoice right now.' });
  }
});

router.post('/invoices/daily-end-report', async (req, res) => {
  try {
    const providedStoreId =
      typeof req.body?.storeId === 'string'
        ? req.body.storeId.trim()
        : req.body?.storeId?.toString().trim();
    const tokenStoreId = req.user?.store_id ? req.user.store_id.toString() : null;
    const storeId = providedStoreId || tokenStoreId;
    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required.' });
    }
    if (tokenStoreId && tokenStoreId !== storeId) {
      return res.status(403).json({ error: 'You can only manage invoices for your store.' });
    }
    const invoicePayload = req.body?.invoice || {};
    const fingerprint =
      invoicePayload?.fingerprint || analyticsService.buildInvoiceFingerprint(invoicePayload);
    if (!fingerprint) {
      return res.status(400).json({ error: 'Invoice details are required to continue.' });
    }
    await analyticsService.addInvoiceToDailyEndReport(storeId, fingerprint, invoicePayload);
    return res.json({ success: true, fingerprint });
  } catch (error) {
    console.error('Error sending invoice to daily end report', { error: error.message });
    return res.status(500).json({ error: 'Unable to send invoice to Daily End Reports right now.' });
  }
});

// GET /api/analytics/wallet-balance - Get franchise wallet balance for current store
router.get('/wallet-balance', async (req, res) => {
  try {
    const storeId = req.user?.store_id ? req.user.store_id.toString() : null;
    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required.' });
    }
    const franchiseId = await billingService.getFranchiseIdForStore(storeId);
    if (!franchiseId) {
      return res.json({
        balance: 0,
        currency: 'INR',
        low_balance_threshold: 0
      });
    }
    const response = await docClient.send(
      new GetCommand({
        TableName: WALLET_TABLE,
        Key: {
          franchise_id: franchiseId,
          store_id: DEFAULT_WALLET_STORE_ID
        }
      })
    );
    const wallet = response.Item || {};
    let walletEnabled = true;
    if (FRANCHISES_TABLE) {
      const franchiseResult = await docClient.send(
        new GetCommand({
          TableName: FRANCHISES_TABLE,
          Key: { franchise_id: franchiseId },
          ProjectionExpression: 'wallet_enabled'
        })
      );
      if (franchiseResult.Item && franchiseResult.Item.wallet_enabled === false) {
        walletEnabled = false;
      }
    }
    return res.json({
      balance: toNumber(wallet.balance),
      currency: wallet.currency || 'INR',
      low_balance_threshold: toNumber(wallet.low_balance_threshold),
      wallet_enabled: walletEnabled
    });
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return res.status(500).json({ error: 'Failed to fetch wallet balance.' });
  }
});

// GET /api/analytics/kpis?storeId=...&from=...&to=... - Get KPI metrics
router.get('/kpis', async (req, res) => {
  try {
    const { storeId, from, to } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const kpis = await analyticsService.getKPIs(storeId, from, to);
    res.json(kpis);
  } catch (error) {
    console.error('Error in /kpis endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

// GET /api/customers?storeId=... - Get customers for a store
router.get('/customers', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const invoices = await analyticsService.getInvoices(storeId, { includeExcluded: false });
    
    // Function to normalize phone numbers
    const normalizePhone = (phone) => {
      if (!phone || typeof phone !== 'string') return null;
      // Remove all non-digit characters
      const cleaned = phone.replace(/\D/g, '');
      // Must be at least 10 digits
      if (cleaned.length < 10) return null;
      return cleaned;
    };
    
    // Extract unique customers with normalized phone numbers
    const customerMap = new Map();
    
    invoices.forEach(invoice => {
      const normalizedPhone = normalizePhone(invoice.customer_phone);
      const timestamp = invoice.processed_timestamp_ist || invoice.invoice_date;

      if (normalizedPhone && timestamp) {
        if (!customerMap.has(normalizedPhone)) {
          customerMap.set(normalizedPhone, {
            phone: normalizedPhone,
            name: invoice.customer_name || `Customer ${normalizedPhone}`,
            lastTransaction: timestamp
          });
        } else {
          // Update with latest transaction if newer
          const existing = customerMap.get(normalizedPhone);
          if (new Date(timestamp) > new Date(existing.lastTransaction)) {
            existing.lastTransaction = timestamp;
            if (invoice.customer_name) {
              existing.name = invoice.customer_name;
            }
          }
        }
      }
    });
    
    const customers = Array.from(customerMap.values()).sort((a, b) => 
      new Date(b.lastTransaction).getTime() - new Date(a.lastTransaction).getTime()
    );
    
    console.log(`Found ${customers.length} unique customers for store ${storeId}`);
    res.json(customers);
  } catch (error) {
    console.error('Error in /customers endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /api/analytics/visits-over-time?storeId=... - Get visits over time data
router.get('/visits-over-time', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const invoices = await analyticsService.getInvoices(storeId, { includeExcluded: false });
    
    // Comprehensive date parser for multiple formats
    const parseInvoiceDate = (dateString) => {
      if (!dateString) return null;
      
      // Format: DD-MM-YYYY HH:mm:ss (e.g., "27-07-2025 00:00:00")
      let match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, day, month, year, hour, minute, second] = match;
        return new Date(year, month - 1, day, hour, minute, second);
      }
      
      // Format: DD-MM-YYYY (e.g., "13-05-2025")
      match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (match) {
        const [, day, month, year] = match;
        return new Date(year, month - 1, day);
      }
      
      // Format: DD/MM/YYYY HH:mm:ss (e.g., "13/01/2025 13:54:50")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, day, month, year, hour, minute, second] = match;
        return new Date(year, month - 1, day, hour, minute, second);
      }
      
      // Format: DD/MM/YYYY (e.g., "13/01/2025")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (match) {
        const [, day, month, year] = match;
        return new Date(year, month - 1, day);
      }
      
      // Format: DD/MM/YY (e.g., "27/03/20")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (match) {
        const [, day, month, year] = match;
        const fullYear = parseInt(year) + 2000; // Assume 20xx
        return new Date(fullYear, month - 1, day);
      }
      
      // Format: DDMMYYYY (e.g., "04709720250" - seems malformed, try to extract)
      match = dateString.match(/^(\d{2})(\d{2})(\d{4})/);
      if (match && dateString.length >= 8) {
        const [, day, month, year] = match;
        if (parseInt(month) <= 12 && parseInt(day) <= 31) {
          return new Date(year, month - 1, day);
        }
      }
      
      // Fallback to standard Date parsing
      const fallbackDate = new Date(dateString);
      if (!isNaN(fallbackDate.getTime())) {
        return fallbackDate;
      }
      
      console.warn(`Could not parse date: ${dateString}`);
      return null;
    };
    
    // Group invoices by month
    const monthlyVisits = {};
    
    invoices.forEach(invoice => {
      const date = parseInvoiceDate(invoice.invoice_date);
      if (!date) {
        return; // Skip invalid dates
      }
      
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyVisits[monthKey]) {
        monthlyVisits[monthKey] = 0;
      }
      monthlyVisits[monthKey]++;
    });
    
    // Sort months and prepare data
    const sortedMonths = Object.keys(monthlyVisits).sort();
    const months = sortedMonths.map(month => {
      const [year, monthNum] = month.split('-');
      const date = new Date(year, monthNum - 1);
      return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    });
    const visits = sortedMonths.map(month => monthlyVisits[month]);
    
    res.json({ months, visits });
  } catch (error) {
    console.error('Error in /visits-over-time endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch visits over time data' });
  }
});

// GET /api/analytics/customer-types?storeId=... - Get new vs returning customers data
router.get('/customer-types', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const invoices = await analyticsService.getInvoices(storeId, { includeExcluded: false });
    
    // Comprehensive date parser for multiple formats
    const parseInvoiceDate = (dateString) => {
      if (!dateString) return null;
      
      // Format: DD-MM-YYYY HH:mm:ss (e.g., "27-07-2025 00:00:00")
      let match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, day, month, year, hour, minute, second] = match;
        return new Date(year, month - 1, day, hour, minute, second);
      }
      
      // Format: DD-MM-YYYY (e.g., "13-05-2025")
      match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (match) {
        const [, day, month, year] = match;
        return new Date(year, month - 1, day);
      }
      
      // Format: DD/MM/YYYY HH:mm:ss (e.g., "13/01/2025 13:54:50")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, day, month, year, hour, minute, second] = match;
        return new Date(year, month - 1, day, hour, minute, second);
      }
      
      // Format: DD/MM/YYYY (e.g., "13/01/2025")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (match) {
        const [, day, month, year] = match;
        return new Date(year, month - 1, day);
      }
      
      // Format: DD/MM/YY (e.g., "27/03/20")
      match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (match) {
        const [, day, month, year] = match;
        const fullYear = parseInt(year) + 2000; // Assume 20xx
        return new Date(fullYear, month - 1, day);
      }
      
      // Format: DDMMYYYY (e.g., "04709720250" - seems malformed, try to extract)
      match = dateString.match(/^(\d{2})(\d{2})(\d{4})/);
      if (match && dateString.length >= 8) {
        const [, day, month, year] = match;
        if (parseInt(month) <= 12 && parseInt(day) <= 31) {
          return new Date(year, month - 1, day);
        }
      }
      
      // Fallback to standard Date parsing
      const fallbackDate = new Date(dateString);
      if (!isNaN(fallbackDate.getTime())) {
        return fallbackDate;
      }
      
      console.warn(`Could not parse date: ${dateString}`);
      return null;
    };
    
    // Function to normalize phone numbers
    const normalizePhone = (phone) => {
      if (!phone || typeof phone !== 'string') return null;
      const cleaned = phone.replace(/\D/g, '');
      if (cleaned.length < 10) return null;
      return cleaned;
    };
    
    // Track customer transaction history
    const customerTransactions = new Map();
    
    invoices.forEach(invoice => {
      const normalizedPhone = normalizePhone(invoice.customer_phone);
      const date = parseInvoiceDate(invoice.invoice_date);
      
      if (normalizedPhone && date) {
        if (!customerTransactions.has(normalizedPhone)) {
          customerTransactions.set(normalizedPhone, []);
        }
        customerTransactions.get(normalizedPhone).push({
          date: date,
          invoiceId: invoice.invoice_no || invoice.invoice_id || null
        });
      }
    });
    
    // Sort transactions by date for each customer
    customerTransactions.forEach((transactions, phone) => {
      transactions.sort((a, b) => a.date.getTime() - b.date.getTime());
    });
    
    let newCustomers = 0;
    let returningCustomers = 0;
    
    customerTransactions.forEach((transactions, phone) => {
      if (transactions.length === 1) {
        newCustomers++;
      } else {
        returningCustomers++;
      }
    });
    
    res.json({ newCustomers, returningCustomers });
  } catch (error) {
    console.error('Error in /customer-types endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch customer types data' });
  }
});

// GET /api/analytics/campaign-history?storeId=... - Get campaign history for a store
router.get('/campaign-history', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const campaigns = await analyticsService.getCampaignHistory(storeId);
    const campaignIds = Array.from(
      new Set(
        campaigns
          .map(item => item.campaignId || item.campaign_id || null)
          .filter(Boolean)
      )
    );

    const metadataMap = new Map();
    const latestAttemptMap = new Map();
    const attemptStatsMap = new Map();
    const attemptStatusMap = new Map();

    const statsByCampaignId = new Map();
    campaigns.forEach(item => {
      const campaignId = item.campaignId || item.campaign_id || null;
      if (!campaignId) {
        return;
      }
      const status = (item.status || '').toString().toLowerCase();
      const errorCode = item.error_code ?? item.errorCode ?? null;
      const isFailed = status === 'failed' || status === 'error';
      const isSuccess = !isFailed && (errorCode === null || errorCode === undefined || errorCode === '');
      const existing = statsByCampaignId.get(campaignId) || { total: 0, success: 0 };
      existing.total += 1;
      if (isSuccess) {
        existing.success += 1;
      }
      statsByCampaignId.set(campaignId, existing);
    });

    await Promise.all(
      campaignIds.map(async campaignId => {
        const [metadata, attempts] = await Promise.all([
          analyticsService.getCampaignMetadataById(campaignId).catch(() => null),
          resendService.listResendAttemptsByCampaignId(campaignId).catch(() => [])
        ]);
        if (metadata) {
          metadataMap.set(campaignId, metadata);
        }
        if (attempts && attempts.length > 0) {
          const sorted = attempts.sort((a, b) => {
            const aTime = new Date(a.created_at || a.scheduled_at || 0).getTime();
            const bTime = new Date(b.created_at || b.scheduled_at || 0).getTime();
            return bTime - aTime;
          });
          latestAttemptMap.set(campaignId, sorted[0]);
          const attemptStatuses = sorted.map(item =>
            (item.status || '').toString().toUpperCase()
          );
          attemptStatusMap.set(campaignId, {
            hasActiveAttempt: attemptStatuses.some(status => ['SCHEDULED', 'RUNNING'].includes(status)),
            latestStatus: (sorted[0]?.status || '').toString().toUpperCase() || null
          });
          const attemptNumbers = sorted
            .map(item => Number(item.attempt_number || 0))
            .filter(value => Number.isFinite(value) && value > 0);
          const maxAttemptNumber = attemptNumbers.length
            ? Math.max(...attemptNumbers)
            : sorted.length;
          attemptStatsMap.set(campaignId, {
            maxAttemptNumber,
            totalAttempts: sorted.length
          });
        } else {
          attemptStatusMap.set(campaignId, {
            hasActiveAttempt: false,
            latestStatus: null
          });
        }
      })
    );

    const normalized = campaigns.map(item => {
      const campaignId = item.campaignId || item.campaign_id || null;
      if (!campaignId) {
        return item;
      }
      const metadata = metadataMap.get(campaignId);
      const latestAttempt = latestAttemptMap.get(campaignId);
      const attemptStats = attemptStatsMap.get(campaignId) || {
        maxAttemptNumber: 0,
        totalAttempts: 0
      };
      const resendSettings = metadata
        ? {
            enabled: Boolean(metadata.resend_enabled),
            delayOption: metadata.resend_delay_option || null,
            maxAttempts: RESEND_MAX_ATTEMPTS,
            stopped: Boolean(metadata.resend_stopped)
          }
        : { enabled: false, delayOption: null, maxAttempts: RESEND_MAX_ATTEMPTS, stopped: false };
      const headerImageS3Key = metadata?.header_image_s3_key || null;
      const latestResendAttempt = latestAttempt
        ? {
            status: latestAttempt.status || null,
            scheduledAt: latestAttempt.scheduled_at || null,
            attemptedCount: latestAttempt.attempted_count ?? 0,
            successCount: latestAttempt.success_count ?? 0,
            failedCount: latestAttempt.failed_count ?? 0,
            limitedByMetaCount: latestAttempt.limited_by_meta_count ?? 0,
            maxAttempts: latestAttempt.max_attempts ?? RESEND_MAX_ATTEMPTS
          }
        : null;
      const stats = statsByCampaignId.get(campaignId) || { total: 0, success: 0 };
      const successRate = stats.total > 0 ? stats.success / stats.total : 0;
      const attemptStatus = attemptStatusMap.get(campaignId) || {
        hasActiveAttempt: false,
        latestStatus: null
      };
      const hasTerminalAttempt = Boolean(
        attemptStatus.latestStatus &&
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(attemptStatus.latestStatus)
      );
      const maxAttemptNumber = attemptStats.maxAttemptNumber || 0;
      const shouldComplete =
        resendSettings.stopped ||
        !resendSettings.enabled ||
        successRate >= RESEND_SUCCESS_THRESHOLD ||
        maxAttemptNumber >= RESEND_MAX_ATTEMPTS ||
        (!attemptStatus.hasActiveAttempt && hasTerminalAttempt);
      return {
        ...item,
        resendSettings,
        latestResendAttempt,
        overallCampaignStatus: shouldComplete ? 'COMPLETED' : 'ONGOING',
        successRate,
        resendAttemptCount: attemptStats.totalAttempts || 0,
        headerImageS3Key,
        header_image_s3_key: headerImageS3Key
      };
    });

    res.json(normalized);
  } catch (error) {
    console.error('Error in /campaign-history endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

router.get('/campaign-history/:campaignId/recipients', async (req, res) => {
  const { campaignId } = req.params;
  const { storeId } = req.query;

  if (!storeId) {
    return res.status(400).json({ error: 'storeId parameter is required' });
  }

  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId parameter is required' });
  }

  let criteria;
  const decodeLegacy = () => {
    const legacyId = decodeURIComponent(campaignId);
    let campaignName = legacyId.trim();
    let start = null;
    let end = null;

    const lastDash = legacyId.lastIndexOf('-');
    if (lastDash !== -1) {
      const possibleDate = legacyId.slice(lastDash + 1).trim();
      const weekdayMatch = possibleDate.match(
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}$/
      );
      if (weekdayMatch) {
        campaignName = legacyId.slice(0, lastDash).trim() || campaignName;
        const parsed = new Date(possibleDate);
        if (!Number.isNaN(parsed.getTime())) {
          const startDate = new Date(parsed);
          startDate.setHours(0, 0, 0, 0);
          const endDate = new Date(parsed);
          endDate.setHours(23, 59, 59, 999);
          start = startDate.toISOString();
          end = endDate.toISOString();
        }
      }
    }

    return { campaignName, start, end };
  };

  try {
    criteria = JSON.parse(campaignId);
  } catch (primaryError) {
    try {
      criteria = JSON.parse(decodeURIComponent(campaignId));
    } catch (decodeError) {
      criteria = decodeLegacy();
    }
  }

  if (!criteria || typeof criteria !== 'object') {
    criteria = decodeLegacy();
  }

  try {
    const data = await analyticsService.getCampaignRecipients(storeId, criteria);
    res.json(data);
  } catch (error) {
    console.error('Error in /campaign-history/:campaignId/recipients endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch campaign recipients' });
  }
});

// GET /api/analytics/customer-kpis?storeId=...&timeFilter=... - Get customer KPIs
router.get('/customer-kpis', async (req, res) => {
  try {
    const { storeId, timeFilter = 'monthly' } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const kpis = await analyticsService.getCustomerKPIs(storeId, timeFilter);
    res.json(kpis);
  } catch (error) {
    console.error('Error in /customer-kpis endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch customer KPIs' });
  }
});

// GET /api/analytics/customer-spend?storeId=...&timeFilter=... - Get customer spend analysis
router.get('/customer-spend', async (req, res) => {
  try {
    const { storeId, timeFilter = 'monthly' } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const spend = await analyticsService.getCustomerSpend(storeId, timeFilter);
    res.json(spend);
  } catch (error) {
    console.error('Error in /customer-spend endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch customer spend' });
  }
});

// GET /api/analytics/customer-details?storeId=... - Get detailed customer information
router.get('/customer-details', async (req, res) => {
  try {
    const { storeId } = req.query;
    
    if (!storeId) {
      return res.status(400).json({ error: 'storeId parameter is required' });
    }
    
    const customers = await analyticsService.getCustomerDetails(
      storeId,
      req.user?.customer_type_config
    );
    res.json(customers);
  } catch (error) {
    console.error('Error in /customer-details endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch customer details' });
  }
});

module.exports = router;
