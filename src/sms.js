/**
 * Twilio SMS helper
 * Son gelen SMS'i belirli bir süreden sonra okur
 */

const twilio = require('twilio');
const fs     = require('fs');

class SmsHelper {
  constructor(accountSid, authToken, fromNumber, logFile) {
    this.client     = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
    this.logFile    = logFile; // bot.js'den geçirilir
  }

  log(tag, msg) {
    const d    = new Date();
    const line = `[${d.toLocaleString('tr-TR')}.${String(d.getMilliseconds()).padStart(3, '0')}] [${tag}] ${msg}`;
    console.log(line);
    if (this.logFile) fs.appendFileSync(this.logFile, line + '\n');
  }

  async waitForCode(startedAfter, pollIntervalMs = 100, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    this.log('SMS', `Kod bekleniyor... (max ${timeoutMs / 1000}sn)`);

    while (Date.now() < deadline) {
      try {
        const messages = await this.client.messages.list({
          to: this.fromNumber,
          dateSentAfter: startedAfter,
          limit: 5,
        });

        for (const msg of messages) {
          const match = msg.body.match(/\b(\d{4})\b/);
          if (match) {
            this.log('SMS', `Kod bulundu: ${match[1]}`);
            return match[1];
          }
        }
      } catch (e) {
        this.log('SMS-ERR', 'Twilio API hatası: ' + e.message);
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    throw new Error('SMS zaman aşımı: kod alınamadı');
  }
}

module.exports = SmsHelper;
