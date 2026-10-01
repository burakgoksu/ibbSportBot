// .well içindeki tam HTML yapısını incele
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto('https://online.spor.istanbul/uyegiris', { waitUntil: 'load', timeout: 60000 });
  await page.fill('#txtTCPasaport', process.env.TC_NO);
  await page.fill('#txtSifre', process.env.SIFRE);
  await page.click('#btnGirisYap');
  await page.waitForURL('**/anasayfa**', { timeout: 15000 });
  try { await page.waitForSelector('#closeModal', { timeout: 3000 }); await page.click('#closeModal'); } catch {}

  await page.goto('https://online.spor.istanbul/uyespor', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('[id*="lbtnSeansSecim"]', { timeout: 10000 });
  const btn = await page.$('[id*="lbtnSeansSecim"]');
  await Promise.all([
    page.waitForURL('**/uyeseanssecim**', { timeout: 15000 }),
    btn.click(),
  ]);

  // İlk .well'in tam inner HTML'ini al
  const firstWellHTML = await page.$eval('.well', el => el.innerHTML);
  console.log('\n=== İLK WELL HTML ===');
  console.log(firstWellHTML);

  // Tüm well'lerin içindeki tüm metin node'larını ve span'larını al
  const wellData = await page.$$eval('.well', els => els.slice(0, 3).map(el => {
    const spans = Array.from(el.querySelectorAll('span, label, p, div')).map(s => ({
      tag: s.tagName,
      id: s.id,
      className: s.className,
      text: s.textContent?.trim()?.substring(0, 100),
    })).filter(s => s.text);
    return { id: el.id, spans };
  }));

  console.log('\n=== WELL SPAN/DIV YAPISI ===');
  wellData.forEach(w => {
    console.log(`\n[${w.id}]`);
    w.spans.forEach(s => console.log(`  <${s.tag} id="${s.id}" class="${s.className}"> ${s.text}`));
  });

  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
})();
