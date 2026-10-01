/**
 * IBB Spor Bot - Network Analyzer v2
 * /uyeseanssecim sayfasındaki checkbox ve kaydet POST'unu yakalar
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { chromium } = require('playwright');
const fs = require('fs');

const TC_NO = process.env.TC_NO;
const SIFRE = process.env.SIFRE;

const captured = [];

function log(tag, data) {
  const entry = { tag, time: new Date().toISOString(), ...data };
  console.log(`\n[${tag}]`, JSON.stringify(data, null, 2).substring(0, 1000));
  captured.push(entry);
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 0 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Network intercept
  page.on('request', req => {
    if (req.method() === 'POST' && !req.url().includes('cdn-cgi') && !req.url().includes('rum')) {
      const postData = req.postData() || '';
      log('POST_REQUEST', {
        url: req.url(),
        bodyPreview: decodeURIComponent(postData).substring(0, 500),
      });
    }
  });

  page.on('response', async res => {
    if (res.request().method() === 'POST' && !res.url().includes('cdn-cgi')) {
      log('POST_RESPONSE', {
        status: res.status(),
        url: res.url(),
        location: res.headers()['location'] || null,
      });
    }
  });

  // ── 1. LOGIN ─────────────────────────────────────────────────────────────
  console.log('\n=== STEP 1: LOGIN ===');
  await page.goto('https://online.spor.istanbul/uyegiris', { waitUntil: 'load', timeout: 60000 });
  await page.fill('#txtTCPasaport', TC_NO);
  await page.fill('#txtSifre', SIFRE);
  await page.click('#btnGirisYap');
  await page.waitForLoadState('networkidle');
  console.log('Login done, URL:', page.url());

  try {
    await page.waitForSelector('#closeModal', { timeout: 3000 });
    await page.click('#closeModal');
  } catch { }

  // ── 2. /uyespor → Seans Seç butonuna tıkla ───────────────────────────────
  console.log('\n=== STEP 2: /uyespor ===');
  await page.goto('https://online.spor.istanbul/uyespor', { waitUntil: 'load' });

  // Seans Seç butonuna tıkla ve yönlendirmeyi bekle
  await page.waitForSelector('[id*="lbtnSeansSecim"]', { timeout: 10000 });
  const btn = await page.$('[id*="lbtnSeansSecim"]');
  const btnId = await btn.getAttribute('id');
  console.log('Butona tıklanıyor:', btnId);

  await Promise.all([
    page.waitForURL('**/uyeseanssecim**', { waitUntil: 'load' }),
    btn.click(),
  ]);

  console.log('Yönlendirme sonrası URL:', page.url());

  // ── 3. /uyeseanssecim sayfası analizi ────────────────────────────────────
  console.log('\n=== STEP 3: /uyeseanssecim SAYFASI ===');

  // Hidden field'ları kaydet
  const hiddenFields = await page.evaluate(() => {
    const fields = {};
    document.querySelectorAll('input[type=hidden]').forEach(el => {
      fields[el.name] = el.value?.substring(0, 100);
    });
    return fields;
  });
  log('HIDDEN_FIELDS_SEANS_SECIM', hiddenFields);

  // Tüm checkbox'ları listele
  const checkboxes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type=checkbox]')).map(el => ({
      id: el.id,
      name: el.name,
      value: el.value,
      nearestText: el.closest('.well, .panel, div')?.textContent?.trim()?.substring(0, 200),
    }));
  });
  log('CHECKBOXES', { count: checkboxes.length, first5: checkboxes.slice(0, 5) });

  // Seans kartlarının DOM yapısını analiz et
  const domStructure = await page.evaluate(() => {
    // Panel başlıkları (tarihler)
    const dates = Array.from(document.querySelectorAll('[class*="panel-title"], h3, h4')).slice(0, 10).map(el => ({
      tag: el.tagName, className: el.className, text: el.textContent?.trim()?.substring(0, 100)
    }));

    // Seans kartları
    const wells = Array.from(document.querySelectorAll('.well')).slice(0, 6).map(el => ({
      id: el.id,
      className: el.className,
      text: el.textContent?.trim()?.substring(0, 150),
      hasCheckbox: !!el.querySelector('input[type=checkbox]'),
      checkboxId: el.querySelector('input[type=checkbox]')?.id,
    }));

    return { dates, wells };
  });
  log('DOM_STRUCTURE', domStructure);

  // Tüm form action ve method'u
  const formInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, action: f.action, method: f.method
    }));
  });
  log('FORMS', { forms: formInfo });

  // ── 4. İLK CHECKBOX'A TIK (test) ────────────────────────────────────────
  if (checkboxes.length > 0) {
    console.log('\n=== STEP 4: İLK CHECKBOX TEST (gerçek rezervasyon yapılmıyor) ===');

    // İlk checkbox'ı işaretle
    const firstCb = checkboxes[0];
    console.log('Test için checkbox:', firstCb.id);

    // Checkbox POST'unu yakala (AJAX mı yoksa form submit mi?)
    await page.check(`#${firstCb.id}`);
    await page.waitForTimeout(1000);

    // Onay checkbox
    try {
      const onay = await page.$('#pageContent_cboxOnay');
      if (onay) {
        await onay.check();
        console.log('Onay checkbox işaretlendi');

        // Kaydet butonunu tıkla ve POST'u yakala
        const kaydetBtn = await page.$('#lbtnKaydet, [id*="Kaydet"]');
        if (kaydetBtn) {
          const kaydetId = await kaydetBtn.getAttribute('id');
          console.log('Kaydet butonu bulundu:', kaydetId);

          // SADECE network isteğini yakala, sayfa değişmesin diye intercept et
          await page.route('**', async route => {
            const req = route.request();
            if (req.method() === 'POST') {
              const body = req.postData() || '';
              log('KAYDET_POST_INTERCEPT', {
                url: req.url(),
                body: decodeURIComponent(body).substring(0, 1000),
              });
              // İsteği iptal et - gerçek rezervasyon yapmayalım
              await route.abort();
            } else {
              await route.continue();
            }
          });

          await kaydetBtn.click().catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
    } catch (e) {
      console.log('Onay/Kaydet adımı atlandı:', e.message);
    }
  }

  // ── 5. SONUÇLARI KAYDET ──────────────────────────────────────────────────
  fs.writeFileSync('analysis_result.json', JSON.stringify(captured, null, 2));
  console.log('\n✅ analysis_result.json kaydedildi');
  console.log('\n=== ÖNEMLİ BULGULAR ===');
  console.log('Redirect URL:', page.url());
  console.log('Checkbox sayısı:', checkboxes.length);
  console.log('\nEnter\'a basın kapatmak için...');

  await new Promise(resolve => {
    process.stdin.once('data', resolve);
    setTimeout(resolve, 60000);
  });

  fs.writeFileSync('analysis_result.json', JSON.stringify(captured, null, 2));
  await browser.close();
})();
