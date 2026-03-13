const express = require('express');
const axios = require('axios');
const router = express.Router();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { logger } = require('../config/logger');

// Initialize DynamoDB client
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-south-2'
});
const docClient = DynamoDBDocumentClient.from(client);

const TEMPLATE_TABLE =
  process.env.TEMPLATE_CATALOG_TABLE ||
  process.env.TEMPLATE_TABLE ||
  'WhatsAppTemplateCatalog';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v17.0';

// Get all templates
router.get('/', async (req, res) => {
  try {
    const storeIdParam = req.query?.storeId || req.body?.storeId;
    const authenticatedStoreId = req.user?.store_id;
    const storeId = (storeIdParam || authenticatedStoreId || 'GLOBAL').toString();

    const params = {
      TableName: TEMPLATE_TABLE
    };

    const result = await docClient.send(new ScanCommand(params));
    const items = result.Items || [];

    const filtered =
      storeId && storeId !== 'GLOBAL'
        ? items.filter(item => item.storeId === storeId)
        : items;

    const templates = filtered.map(item => ({
      ...item,
      templateId: item.templateId || item.id,
      id: item.templateId || item.id,
      storeId: item.storeId || storeId || 'GLOBAL'
    }));

    res.json({
      success: true,
      data: templates,
      message: `Found ${templates.length} templates`
    });
  } catch (error) {
    logger.error('Error fetching templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch templates',
      error: error.message,
      data: []
    });
  }
});

// Get predefined templates (global library)
router.get('/predefined', async (req, res) => {
  try {
    const params = {
      TableName: TEMPLATE_TABLE
    };

    const result = await docClient.send(new ScanCommand(params));
    const items = result.Items || [];

    const templates = items
      .map(item => {
        const id = item.templateId || item.id || item.name;
        const name = item.name || 'Template';
        const category = (item.category || 'general').toString();
        const industryCategoryValue =
          item.industryCategory ||
          item.industry_category ||
          item.category ||
          null;
        const industryCategory =
          typeof industryCategoryValue === 'string' && industryCategoryValue.trim()
            ? industryCategoryValue.trim()
            : null;
        const occasionCategoryValue =
          item.occasionCategory ||
          item.occasion_category ||
          null;
        const occasionCategory =
          typeof occasionCategoryValue === 'string' && occasionCategoryValue.trim()
            ? occasionCategoryValue.trim()
            : null;
        const language = item.language || 'en_US';
        const rawStatus = (item.status || 'approved').toString().toLowerCase();
        const allowedStatuses = new Set(['draft', 'pending', 'approved', 'rejected']);
        const status = allowedStatuses.has(rawStatus) ? rawStatus : 'approved';
        const headerType = item.headerType || 'NONE';
        const headerText = item.headerText || null;
        const headerImageUrl =
          item.headerImageUrl || item.headerMediaUrl || item.previewImageUrl || null;
        const headerVideoUrl = item.headerVideoUrl || null;
        const headerDocumentUrl = item.headerDocumentUrl || null;
        const bodyText = item.bodyText || item.body || '';
        const footerText = item.footerText || item.footer || '';
        const buttons = Array.isArray(item.buttons) ? item.buttons : [];
        const variables = Array.isArray(item.sampleVariables)
          ? item.sampleVariables
          : Array.isArray(item.variables)
          ? item.variables
          : [];
        const examples = item.examples && typeof item.examples === 'object'
          ? {
              body: Array.isArray(item.examples.body) ? item.examples.body : [],
              headerText: Array.isArray(item.examples.headerText) ? item.examples.headerText : [],
              footerText: Array.isArray(item.examples.footerText) ? item.examples.footerText : []
            }
          : undefined;
        const previewImageUrl = item.previewImageUrl || headerImageUrl || null;
        const description = item.description || bodyText?.slice(0, 120);
        const updatedAt =
          item.updatedAt || item.updated_at || item.last_updated_time || new Date().toISOString();

        return {
          id,
          name,
          category,
          industryCategory,
          occasionCategory,
          language,
          status,
          headerType,
          headerText,
          headerImageUrl,
          headerVideoUrl,
          headerDocumentUrl,
          bodyText,
          footerText,
          buttons,
          variables,
          examples,
          previewImageUrl,
          description,
          updatedAt
        };
      })
      .filter(template => template.id);

    res.json({
      success: true,
      data: templates,
      message: `Found ${templates.length} predefined templates`
    });
  } catch (error) {
    logger.error('Error fetching predefined templates:', error);
    const status = error.name === 'ResourceNotFoundException' ? 404 : 500;
    const message =
      error.name === 'ResourceNotFoundException'
        ? `Template catalog table '${TEMPLATE_TABLE}' was not found. Please create it or update TEMPLATE_CATALOG_TABLE.`
        : 'Failed to fetch predefined templates';

    res.status(status).json({
      success: false,
      message,
      error: error.message,
      data: []
    });
  }
});

// Get single template by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    let item = null;

    const primaryLookup = await docClient.send(
      new GetCommand({
        TableName: TEMPLATE_TABLE,
        Key: {
          templateId: id
        }
      })
    );

    if (primaryLookup.Item) {
      item = primaryLookup.Item;
    }

    if (!item) {
      const params = {
        TableName: TEMPLATE_TABLE,
        FilterExpression: '#legacyId = :id OR #name = :id',
        ExpressionAttributeNames: {
          '#legacyId': 'id',
          '#name': 'name'
        },
        ExpressionAttributeValues: {
          ':id': id
        }
      };

      const scanResult = await docClient.send(new ScanCommand(params));
      item = scanResult.Items?.[0] || null;
    }

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    res.json({
      success: true,
      data: {
        ...item,
        templateId: item.templateId || item.id,
        id: item.templateId || item.id
      },
      message: 'Template retrieved successfully'
    });
  } catch (error) {
    logger.error('Error fetching template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch template',
      error: error.message
    });
  }
});

// Create new template
router.post('/', async (req, res) => {
  try {
    const { storeId } = req.query;
    const {
      name,
      category,
      language = 'en',
      headerType,
      headerText,
      headerImageUrl,
      headerVideoUrl,
      headerDocumentUrl,
      bodyText,
      footerText,
      buttons = [],
      variables = [],
      examples = {}
    } = req.body;

    // Validation
    if (!name || !bodyText || !storeId) {
      return res.status(400).json({
        success: false,
        message: 'Name, body text, and store ID are required'
      });
    }

    const templateId = randomUUID();
    const now = new Date().toISOString();

    const template = {
      templateId,
      id: templateId,
      storeId,
      name,
      category: category || 'general',
      language,
      status: 'draft',
      headerType,
      headerText,
      headerImageUrl,
      headerVideoUrl,
      headerDocumentUrl,
      bodyText,
      footerText,
      buttons,
      variables: Array.isArray(variables) ? variables : [],
      examples:
        examples && typeof examples === 'object'
          ? {
              body: Array.isArray(examples.body) ? examples.body : [],
              headerText: Array.isArray(examples.headerText) ? examples.headerText : [],
              footerText: Array.isArray(examples.footerText) ? examples.footerText : []
            }
          : {
              body: [],
              headerText: [],
              footerText: []
            },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.userId || 'system'
    };

    logger.info('Template creation request received; skipping catalog persistence', {
      storeId,
      templateId,
      templateName: name
    });

    res.status(201).json({
      success: true,
      data: template,
      message: 'Template captured successfully'
    });

  } catch (error) {
    logger.error('Error creating template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create template',
      error: error.message
    });
  }
});

// Update template
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Remove fields that shouldn't be updated
    delete updateData.id;
    delete updateData.storeId;
    delete updateData.createdAt;
    delete updateData.createdBy;

    updateData.updatedAt = new Date().toISOString();

    // Build update expression
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    Object.keys(updateData).forEach((key, index) => {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      
      updateExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = updateData[key];
    });

    const params = {
      TableName: TEMPLATE_TABLE,
      Key: {
        templateId: id
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    const result = await docClient.send(new UpdateCommand(params));

    res.json({
      success: true,
      data: {
        ...result.Attributes,
        id: result.Attributes?.templateId || result.Attributes?.id
      },
      message: 'Template updated successfully'
    });

  } catch (error) {
    logger.error('Error updating template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update template',
      error: error.message
    });
  }
});

// Delete template
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const queryTemplateName = req.query?.templateName;
    const bodyTemplateName = req.body?.templateName;

    const wabaId = req.user?.waba_id;
    const accessToken = req.user?.access_token;

    if (!wabaId || !accessToken) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp configuration not available for this store. Please configure WABA credentials.'
      });
    }

    let templateName = queryTemplateName || bodyTemplateName;
    let existingTemplate = null;

    if (!templateName) {
      try {
        const existing = await docClient.send(
          new GetCommand({
            TableName: TEMPLATE_TABLE,
            Key: {
              templateId: id
            }
          })
        );
        existingTemplate = existing.Item || null;
        templateName = existingTemplate?.name;
      } catch (lookupError) {
        logger.warn('Failed to fetch template before delete', {
          storeId,
          id,
          error: lookupError.message
        });
      }
    }

    if (!templateName) {
      return res.status(400).json({
        success: false,
        message: 'Template name is required to delete the template from WhatsApp.'
      });
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`;

    try {
      await axios.delete(url, {
        params: {
          name: templateName
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
    } catch (graphError) {
      const status = graphError.response?.status || 500;
      const graphMessage =
        graphError.response?.data?.error?.message ||
        graphError.message ||
        'Failed to delete template on WhatsApp';

      logger.error('Graph API template delete failed', {
        storeId,
        templateName,
        status,
        error: graphMessage,
        details: graphError.response?.data
      });

      return res.status(status).json({
        success: false,
        message: graphMessage,
        error: graphError.response?.data || null
      });
    }

    try {
      await docClient.send(
        new DeleteCommand({
          TableName: TEMPLATE_TABLE,
          Key: {
            templateId: id
          }
        })
      );
    } catch (dbError) {
      logger.warn('Failed to remove template record after WhatsApp delete', {
        id,
        error: dbError.message
      });
    }

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete template',
      error: error.message
    });
  }
});

// Request template verification
router.post('/:id/request-verification', async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;

    const params = {
      TableName: TEMPLATE_TABLE,
      Key: {
        id: id,
        storeId: storeId
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'pending',
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };

    const result = await docClient.send(new UpdateCommand(params));

    res.json({
      success: true,
      data: result.Attributes,
      message: 'Template verification requested successfully'
    });

  } catch (error) {
    logger.error('Error requesting template verification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to request template verification',
      error: error.message
    });
  }
});

// Approve template (admin only)
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;

    const params = {
      TableName: TEMPLATE_TABLE,
      Key: {
        id: id,
        storeId: storeId
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, approvedAt = :approvedAt, approvedBy = :approvedBy',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'approved',
        ':updatedAt': new Date().toISOString(),
        ':approvedAt': new Date().toISOString(),
        ':approvedBy': req.user?.userId || 'admin'
      },
      ReturnValues: 'ALL_NEW'
    };

    const result = await docClient.send(new UpdateCommand(params));

    res.json({
      success: true,
      data: result.Attributes,
      message: 'Template approved successfully'
    });

  } catch (error) {
    logger.error('Error approving template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve template',
      error: error.message
    });
  }
});

// Reject template (admin only)
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;
    const { reason } = req.body;

    const params = {
      TableName: TEMPLATE_TABLE,
      Key: {
        id: id,
        storeId: storeId
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, rejectedAt = :rejectedAt, rejectedBy = :rejectedBy, rejectionReason = :reason',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'rejected',
        ':updatedAt': new Date().toISOString(),
        ':rejectedAt': new Date().toISOString(),
        ':rejectedBy': req.user?.userId || 'admin',
        ':reason': reason || 'No reason provided'
      },
      ReturnValues: 'ALL_NEW'
    };

    const result = await docClient.send(new UpdateCommand(params));

    res.json({
      success: true,
      data: result.Attributes,
      message: 'Template rejected successfully'
    });

  } catch (error) {
    logger.error('Error rejecting template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject template',
      error: error.message
    });
  }
});

module.exports = router;
