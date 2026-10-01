require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

(async () => {
  console.log('Twilio bağlantısı test ediliyor...');
  try {
    const account = await client.api.accounts(process.env.TWILIO_SID).fetch();
    console.log('✅ Bağlantı başarılı. Account:', account.friendlyName, '| Status:', account.status);

    // Son 5 gelen mesajı listele
    const messages = await client.messages.list({ to: process.env.TWILIO_FROM, limit: 5 });
    console.log(`\nSon ${messages.length} gelen SMS:`);
    messages.forEach(m => console.log(` - [${m.dateSent}] ${m.from}: ${m.body}`));
  } catch (e) {
    console.error('❌ Hata:', e.message);
  }
})();
