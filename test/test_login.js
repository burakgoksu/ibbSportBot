// Sadece login + /uyeseanssecim akışını test eder, rezervasyon yapmaz
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('[TEST] Login...');
  await page.goto('https://online.spor.istanbul/uyegiris', { waitUntil: 'load', timeout: 60000 });
  await page.fill('#txtTCPasaport', process.env.TC_NO);
  await page.fill('#txtSifre', process.env.SIFRE);
  await page.click('#btnGirisYap');
  await page.waitForURL('**/anasayfa**', { timeout: 15000 });
  console.log('[TEST] Login OK, URL:', page.url());

  try {
    await page.waitForSelector('#closeModal', { timeout: 3000 });
    await page.click('#closeModal');
  } catch {}

  console.log('[TEST] /uyespor\'a gidiliyor...');
  await page.goto('https://online.spor.istanbul/uyespor', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('[id*="lbtnSeansSecim"]', { timeout: 10000 });
  const btn = await page.$('[id*="lbtnSeansSecim"]');
  console.log('[TEST] Buton bulundu, tıklanıyor...');

  await Promise.all([
    page.waitForURL('**/uyeseanssecim**', { timeout: 15000 }),
    btn.click(),
  ]);
  console.log('[TEST] /uyeseanssecim sayfasına ulaşıldı:', page.url());

  // Well div sayısı
  const wellCount = await page.$$eval('.well', els => els.length);
  const cbCount = await page.$$eval('input[type=checkbox]', els => els.length);
  console.log(`[TEST] .well sayısı: ${wellCount}, checkbox sayısı: ${cbCount}`);

  // Seans metinlerini göster
  const seansTexts = await page.$$eval('.well', els =>
    els.slice(0, 5).map(el => ({
      id: el.id,
      text: el.textContent?.trim()?.substring(0, 120),
      hasCheckbox: !!el.querySelector('input[type=checkbox]'),
    }))
  );
  console.log('\n[TEST] İlk 5 seans:');
  seansTexts.forEach(s => console.log(JSON.stringify(s)));

  console.log('\n[TEST] ✅ Test tamamlandı. Browser 10sn sonra kapanıyor...');
  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
})();
