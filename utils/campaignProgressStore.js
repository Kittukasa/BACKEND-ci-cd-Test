const COMPLETED_STATUSES = new Set(['sent', 'delivered', 'read', 'seen']);

const progressStore = new Map();

const getDefaultRecipientEntry = (recipient) => ({
  phone: recipient.phone,
  name: recipient.name || '',
  status: 'queued',
  messageId: null,
  error: null,
  updatedAt: new Date().toISOString(),
});

const recalculateCounts = (progress) => {
  const recipients = Array.from(progress.recipients.values());
  progress.completedCount = recipients.filter((recipient) =>
    COMPLETED_STATUSES.has((recipient.status || '').toLowerCase())
  ).length;
  progress.failedCount = recipients.filter(
    (recipient) => (recipient.status || '').toLowerCase() === 'failed'
  ).length;
  progress.pendingCount = Math.max(
    0,
    progress.totalRecipients - (progress.completedCount + progress.failedCount)
  );

  if (progress.pendingCount === 0 && progress.status === 'running') {
    progress.status = progress.failedCount > 0 ? 'completed-with-errors' : 'completed';
    progress.completedAt = new Date().toISOString();
  }
};

function initCampaignProgress({
  campaignId,
  storeId,
  campaignName,
  templateName,
  recipients = [],
}) {
  const recipientMap = new Map();
  recipients.forEach((recipient) => {
    recipientMap.set(recipient.phone, getDefaultRecipientEntry(recipient));
  });

  progressStore.set(campaignId, {
    campaignId,
    storeId,
    campaignName,
    templateName: templateName || null,
    totalRecipients: recipients.length,
    completedCount: 0,
    failedCount: 0,
    pendingCount: recipients.length,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastUpdated: new Date().toISOString(),
    error: null,
    recipients: recipientMap,
  });
}

function updateRecipientProgress(campaignId, { phone, name, status, error, messageId }) {
  const progress = progressStore.get(campaignId);
  if (!progress || !phone) {
    return;
  }

  const existing = progress.recipients.get(phone) || getDefaultRecipientEntry({ phone, name });
  const normalizedStatus = status || existing.status || 'queued';

  progress.recipients.set(phone, {
    ...existing,
    name: name || existing.name,
    status: normalizedStatus,
    messageId: messageId || existing.messageId || null,
    error: error || null,
    updatedAt: new Date().toISOString(),
  });

  progress.lastUpdated = new Date().toISOString();
  recalculateCounts(progress);
}

function finalizeCampaignProgress(campaignId) {
  const progress = progressStore.get(campaignId);
  if (!progress) {
    return;
  }
  recalculateCounts(progress);
  if (progress.status === 'running') {
    progress.status = progress.failedCount > 0 ? 'completed-with-errors' : 'completed';
  }
  progress.completedAt = progress.completedAt || new Date().toISOString();
}

function failCampaignProgress(campaignId, reason) {
  const progress = progressStore.get(campaignId);
  if (!progress) {
    return;
  }
  progress.status = 'failed';
  progress.error = reason || 'Campaign failed';
  progress.completedAt = new Date().toISOString();
}

function getCampaignProgress(campaignId) {
  const progress = progressStore.get(campaignId);
  if (!progress) {
    return null;
  }
  return {
    campaignId: progress.campaignId,
    storeId: progress.storeId,
    campaignName: progress.campaignName,
    templateName: progress.templateName,
    totalRecipients: progress.totalRecipients,
    completedCount: progress.completedCount,
    failedCount: progress.failedCount,
    pendingCount: progress.pendingCount,
    status: progress.status,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    lastUpdated: progress.lastUpdated,
    error: progress.error,
    recipients: Array.from(progress.recipients.values()),
  };
}

function getActiveCampaignsByStore(storeId) {
  if (!storeId) {
    return [];
  }
  return Array.from(progressStore.values())
    .filter((entry) => entry.storeId === storeId && entry.status === 'running')
    .map((entry) => ({
      campaignId: entry.campaignId,
      campaignName: entry.campaignName,
      status: entry.status,
      totalRecipients: entry.totalRecipients,
      completedCount: entry.completedCount,
      failedCount: entry.failedCount,
      pendingCount: entry.pendingCount,
      updatedAt: entry.lastUpdated,
    }));
}

module.exports = {
  initCampaignProgress,
  updateRecipientProgress,
  finalizeCampaignProgress,
  failCampaignProgress,
  getCampaignProgress,
  getActiveCampaignsByStore,
};
