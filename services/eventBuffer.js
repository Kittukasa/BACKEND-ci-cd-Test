const { logger } = require('../config/logger');

// In-memory buffers for events and analytics
const eventsBuffer = [];
const EVENTS_BUFFER_SIZE = parseInt(process.env.EVENTS_BUFFER_SIZE) || 100;

// User analytics aggregation
const userAnalytics = new Map();

class EventBuffer {
  static addEvent(event) {
    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    // Add to events buffer
    eventsBuffer.push(event);
    
    // Keep buffer size limited
    if (eventsBuffer.length > EVENTS_BUFFER_SIZE) {
      eventsBuffer.shift();
    }

    // Update user analytics
    this.updateUserAnalytics(event);

    logger.info('Event added to buffer', { 
      type: event.type, 
      from: event.from || event.recipient,
      bufferSize: eventsBuffer.length 
    });
  }

  static updateUserAnalytics(event) {
    let userId;
    
    if (event.type === 'message' && event.from) {
      userId = event.from;
    } else if (event.type === 'status' && event.recipient) {
      userId = event.recipient;
    } else {
      return; // Skip if no user identifier
    }

    // Initialize user analytics if not exists
    if (!userAnalytics.has(userId)) {
      userAnalytics.set(userId, {
        user: userId,
        messages_received: 0,
        last_message_text: '',
        last_message_time: '',
        statuses: {
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          other: 0
        },
        last_status: '',
        last_status_time: ''
      });
    }

    const userStats = userAnalytics.get(userId);

    if (event.type === 'message') {
      userStats.messages_received++;
      userStats.last_message_text = event.text || '';
      userStats.last_message_time = event.timestamp;
    } else if (event.type === 'status') {
      const status = event.status?.toLowerCase() || 'other';
      if (userStats.statuses.hasOwnProperty(status)) {
        userStats.statuses[status]++;
      } else {
        userStats.statuses.other++;
      }
      userStats.last_status = event.status || '';
      userStats.last_status_time = event.timestamp;
    }

    userAnalytics.set(userId, userStats);
  }

  static getEvents() {
    return [...eventsBuffer];
  }

  static getUserAnalytics() {
    return Array.from(userAnalytics.values());
  }

  static getEventsAsHtml() {
    const events = this.getEvents();
    
    if (events.length === 0) {
      return '<html><body><h1>WhatsApp Events</h1><p>No events found.</p></body></html>';
    }

    const rows = events.map(event => `
      <tr>
        <td>${event.type}</td>
        <td>${event.from || event.recipient || 'N/A'}</td>
        <td>${event.text || event.status || 'N/A'}</td>
        <td>${new Date(event.timestamp).toLocaleString()}</td>
      </tr>
    `).join('');

    return `
      <html>
        <head>
          <title>WhatsApp Events</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            tr:nth-child(even) { background-color: #f9f9f9; }
          </style>
        </head>
        <body>
          <h1>WhatsApp Events (${events.length})</h1>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>From/To</th>
                <th>Text/Status</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </body>
      </html>
    `;
  }

  static getUserAnalyticsAsHtml() {
    const analytics = this.getUserAnalytics();
    
    if (analytics.length === 0) {
      return '<html><body><h1>WhatsApp User Analytics</h1><p>No analytics data found.</p></body></html>';
    }

    const rows = analytics.map(user => `
      <tr>
        <td>${user.user}</td>
        <td>${user.messages_received}</td>
        <td>${user.last_message_text}<br><small>${new Date(user.last_message_time).toLocaleString()}</small></td>
        <td>S:${user.statuses.sent} D:${user.statuses.delivered} R:${user.statuses.read} F:${user.statuses.failed}</td>
        <td>${user.last_status}<br><small>${new Date(user.last_status_time).toLocaleString()}</small></td>
      </tr>
    `).join('');

    return `
      <html>
        <head>
          <title>WhatsApp User Analytics</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            small { color: #666; }
          </style>
        </head>
        <body>
          <h1>WhatsApp User Analytics (${analytics.length} users)</h1>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Messages</th>
                <th>Last Message</th>
                <th>Status Counts</th>
                <th>Last Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </body>
      </html>
    `;
  }
}

module.exports = EventBuffer;
