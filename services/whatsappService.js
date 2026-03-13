const axios = require('axios');
const { logger } = require('../config/logger');

class WhatsAppService {
  constructor() {
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.graphApiVersion = process.env.GRAPH_API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.graphApiVersion}/${this.phoneNumberId}/messages`;

    // Validate required environment variables
    this.validateConfig();
  }

  validateConfig() {
    const required = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      logger.error('Missing required WhatsApp environment variables', { missing });
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    logger.info('WhatsApp service initialized', {
      phoneNumberId: this.phoneNumberId,
      graphApiVersion: this.graphApiVersion,
    });
  }

  async sendMessage(to, message) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: to,
        ...message,
      };

      const response = await axios.post(this.baseUrl, payload, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      logger.info('Message sent successfully', {
        to,
        messageId: response.data.messages?.[0]?.id,
        status: response.status,
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to send WhatsApp message', {
        to,
        error: error.message,
        response: error.response?.data,
      });
      throw error;
    }
  }

  async sendTextMessage(to, text) {
    const message = {
      type: 'text',
      text: { body: text },
    };
    return this.sendMessage(to, message);
  }

  async replyToMessage(to, text, messageId) {
    const message = {
      type: 'text',
      text: { body: text },
      context: { message_id: messageId },
    };
    return this.sendMessage(to, message);
  }

  async sendInteractiveList(to) {
    const message = {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: 'Choose an option',
        },
        body: {
          text: 'Please select one of the following options:',
        },
        footer: {
          text: 'BillBox WhatsApp Service',
        },
        action: {
          button: 'View Options',
          sections: [
            {
              title: 'Services',
              rows: [
                {
                  id: 'service_1',
                  title: 'Billing Support',
                  description: 'Get help with your billing',
                },
                {
                  id: 'service_2',
                  title: 'Account Info',
                  description: 'View your account details',
                },
              ],
            },
            {
              title: 'Support',
              rows: [
                {
                  id: 'support_1',
                  title: 'Contact Support',
                  description: 'Speak with our support team',
                },
              ],
            },
          ],
        },
      },
    };
    return this.sendMessage(to, message);
  }

  async sendReplyButtons(to) {
    const message = {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'text',
          text: 'Quick Actions',
        },
        body: {
          text: 'What would you like to do?',
        },
        footer: {
          text: 'BillBox WhatsApp Service',
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'btn_help',
                title: 'Get Help',
              },
            },
            {
              type: 'reply',
              reply: {
                id: 'btn_status',
                title: 'Check Status',
              },
            },
          ],
        },
      },
    };
    return this.sendMessage(to, message);
  }
}

module.exports = new WhatsAppService();
