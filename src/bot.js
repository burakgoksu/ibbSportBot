/**
 * IBB Spor Rezervasyon Botu
 * ─────────────────────────────────────────────────
 * Kullanım:
 *   node bot.js
 *
 * Parametreler CMD'den sorulur.
 *
 * Akış:
 *  1. Login (başlangıçta)
 *  2. /uyeseanssecim sayfasına git, açık tut
 *  3. Session keepalive (her 3dk'da bir sessionsuz istek)
 *  4. Normal polling (her 30sn) — iptal edilen seanslara karşı
 *  5. Hedef zamanda precision timer → anında rezervasyon
 *  6. Twilio SMS kodu → doğrulama
 */

'use strict';

require('dotenv').config();
const { chromium }  = require('playwright');
const readline      = require('readline');
const SmsHelper     = require('./sms');
const fs            = require('fs');

// ── Logger ───────────────────────────────────────────────────────────────────
const LOG_FILE = `bot_${new Date().toISOString().slice(0,19).replace(/[T:]/g, '-')}.log`;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(tag, msg, extra = '') {
  const line = `[${ts()}] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Network logger: sadece önemli istekler ───────────────────────────────────
const IGNORE_PATTERNS = [
  /\.(css|js|png|jpg|gif|woff2?|otf|ico|svg)(\?|$)/i,
  /cdn-cgi/,
  /google|facebook|analytics|gtm|doubleclick/i,
  /WebResource\.axd/,
  /embeddedfiles\/images/i,
  /assets\//,
  /mhz\/fonts/,
];

function shouldLog(url) {
  return !IGNORE_PATTERNS.some(p => p.test(url));
}

function attachNetworkLogger(page) {
  page.on('request', req => {
    const url = req.url();
    if (!shouldLog(url)) return;
    log('REQ', `${req.method()} ${url.replace('https://online.spor.istanbul', '')}`);
  });

  page.on('response', res => {
    const url = res.url();
    if (!shouldLog(url)) return;
    const status = res.status();
    const location = res.headers()['location'] ? ` → ${res.headers()['location']}` : '';
    const tag = status >= 400 ? 'RES-ERR' : 'RES';
    log(tag, `${status} ${url.replace('https://online.spor.istanbul', '')}${location}`);
  });

  page.on('requestfailed', req => {
    const url = req.url();
    if (!shouldLog(url)) return;
    log('REQ-FAIL', `${req.method()} ${url.replace('https://online.spor.istanbul', '')} | ${req.failure()?.errorText}`);
  });
}

// ── Yardımcı: CMD'den input al ──────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Yardımcı: Belirli ms bekle ───────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Yardımcı: Precision wait — hedef zamana kadar aktif döngü ───────────────
async function waitUntilPrecise(targetMs) {
  const ahead = 1000; // 1 saniye önce aktif döngüye gir
  const coarseWait = targetMs - Date.now() - ahead;
  if (coarseWait > 0) await sleep(coarseWait);
  // Son 1 saniye: busy wait (1ms çözünürlük)
  while (Date.now() < targetMs) {
    await sleep(1);
  }
}

// ── Login (retry'lı) ─────────────────────────────────────────────────────────
async function login(page, tcNo, sifre, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('BOT', `Login deneme ${attempt}/${maxRetries}...`);
      await page.goto('https://online.spor.istanbul/uyegiris', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.fill('#txtTCPasaport', tcNo);
      await page.fill('#txtSifre', sifre);
      await page.click('#btnGirisYap');
      await page.waitForURL('**/anasayfa**', { timeout: 15000 });

      // Popup kapat
      try {
        await page.waitForSelector('#closeModal', { timeout: 3000 });
        await page.click('#closeModal');
      } catch { /* popup yok */ }

      log('BOT', 'Login başarılı');
      return; // başarılı, çık
    } catch (e) {
      log('BOT-ERR', `Login deneme ${attempt} başarısız: ${e.message}`);
      if (attempt < maxRetries) {
        log('BOT', `5 saniye sonra tekrar denenecek...`);
        await sleep(5000);
      } else {
        log('BOT-ERR', 'Tüm login denemeleri başarısız oldu!');
        throw e;
      }
    }
  }
}

// ── Seans Seçim Sayfasına Git (retry'lı) ─────────────────────────────────────
async function goToSeansSecim(page, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('BOT', `Seans sayfasına gidiliyor (deneme ${attempt}/${maxRetries})...`);
      await page.goto('https://online.spor.istanbul/uyespor', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('[id*="lbtnSeansSecim"]', { timeout: 10000 });
      const btn = await page.$('[id*="lbtnSeansSecim"]');
      await Promise.all([
        page.waitForURL('**/uyeseanssecim**', { timeout: 15000 }),
        btn.click(),
      ]);
      log('BOT', '/uyeseanssecim sayfasına ulaşıldı');
      return;
    } catch (e) {
      log('BOT-ERR', `Seans sayfası deneme ${attempt} başarısız: ${e.message}`);
      if (attempt < maxRetries) {
        log('BOT', '5 saniye sonra tekrar denenecek...');
        await sleep(5000);
      } else {
        log('BOT-ERR', 'Tüm seans sayfası denemeleri başarısız!');
        throw e;
      }
    }
  }
}

// ── Session kontrolü: hâlâ login miyiz? ──────────────────────────────────────
async function isLoggedIn(page) {
  try {
    const result = await page.evaluate(async () => {
      const res = await fetch('/anasayfa', { method: 'GET', credentials: 'include', redirect: 'manual' });
      return { status: res.status, type: res.type };
    });
    // Login değilse /uyegiris'e redirect eder (opaqueredirect veya 302)
    return result.type !== 'opaqueredirect' && result.status !== 302;
  } catch {
    return false;
  }
}

// ── Session canlı tut + gerekirse re-login ────────────────────────────────────
async function keepAlive(page, tcNo, sifre) {
  try {
    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      log('KEEPALIVE', 'Session aktif');
      return;
    }

    log('KEEPALIVE', '⚠️ Session düştü! Yeniden login yapılıyor...');
    await login(page, tcNo, sifre);
    await goToSeansSecim(page);
    log('KEEPALIVE', '✅ Re-login başarılı');
  } catch (e) {
    log('KEEPALIVE-ERR', 'Re-login başarısız: ' + e.message);
  }
}

// ── Hedef seansı sayfada ara ve tıkla ────────────────────────────────────────
// targetTime: "19:00" formatında
// targetDate: "09.04.2026" formatında (görüntülenen metin içinde arayacağız)
async function tryBook(page, targetTime, targetDate, tcNo, sifre) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });

    // Reload sonrası login sayfasına düştüysek → re-login yap
    const currentUrl = page.url();
    if (currentUrl.includes('uyegiris')) {
      log('SESSION', '⚠️ Session düştü (redirect /uyegiris) — yeniden login yapılıyor...');
      await login(page, tcNo, sifre);
      await goToSeansSecim(page);
      log('SESSION', '✅ Re-login tamamlandı, polling devam ediyor');
      return { found: false, reason: 'session yenilendi, sonraki poll\'da denenecek' };
    }

    const found = await page.evaluate(({ time, date }) => {
      // Saat span'larını bul: id içinde "lblSeansSaat" geçenler
      // İçerikleri "19:00 - 20:00" formatında
      const saatSpans = document.querySelectorAll('[id*="lblSeansSaat"]');
      for (const span of saatSpans) {
        if (!span.textContent.includes(time)) continue;
        const well = span.closest('.well');
        if (!well) continue;
        // Tarihi panel başlığında kontrol et
        if (date) {
          const panel = well.closest('[class*="panel"], .panel');
          if (panel && !panel.textContent.includes(date)) continue;
        }
        const cb = well.querySelector('input[type=checkbox]');
        if (!cb || cb.disabled) return { found: false, reason: `checkbox yok/disabled — ${span.textContent.trim()}` };
        cb.click();
        return { found: true, wellId: well.id, saat: span.textContent.trim() };
      }
      return { found: false, reason: 'eşleşen seans bulunamadı' };
    }, { time: targetTime, date: targetDate });

    return found;
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// ── Onay checkbox + Kaydet ────────────────────────────────────────────────────
async function confirmAndSave(page) {
  // Onay checkbox
  const onay = await page.$('#pageContent_cboxOnay');
  if (!onay) throw new Error('Onay checkbox bulunamadı');
  await onay.check();

  // Kaydet butonu (lblKaydet veya lbtnKaydet)
  const kaydet = await page.$('#lblKaydet, #lbtnKaydet, [id*="Kaydet"]');
  if (!kaydet) throw new Error('Kaydet butonu bulunamadı');
  await kaydet.click();

  log('BOT', 'Kaydet tıklandı');
}

// ── SMS Doğrulama ─────────────────────────────────────────────────────────────
async function verifySms(page, smsHelper) {
  const requestedAt = new Date();
  log('SMS', 'Kod bekleniyor...');
  const code = await smsHelper.waitForCode(requestedAt, 500, 30000);

  // Kodu gir
  await page.fill('#pageContent_txtDogrulamaKodu', code);
  await page.evaluate(() => {
    const btn = document.getElementById('btnCepTelDogrulamaGonder');
    if (btn) btn.click();
  });
  log('SMS', 'Doğrulama kodu gönderildi: ' + code);
}

// ── ANA FONKSİYON ─────────────────────────────────────────────────────────────
(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('═══════════════════════════════════════════');
  console.log('       IBB Spor Rezervasyon Botu           ');
  console.log('═══════════════════════════════════════════');

  // ── Parametreleri al (.env varsa kullan, yoksa sor) ──────────────────────
  const tcNo       = process.env.TC_NO       || await ask(rl, 'TC No              : ');
  const sifre      = process.env.SIFRE       || await ask(rl, 'Şifre              : ');
  const twilioSid   = process.env.TWILIO_SID  || await ask(rl, 'Twilio SID         : ');
  const twilioToken = process.env.TWILIO_TOKEN || await ask(rl, 'Twilio Token       : ');
  const twilioFrom  = process.env.TWILIO_FROM  || await ask(rl, 'Twilio From No     : ');

  // Tarih/saat her seferinde sorulur
  const targetDate = await ask(rl, 'Tarih (gg.aa.yyyy)                  : '); // ör: 09.04.2026
  const targetTime = await ask(rl, 'Saat (ss:dd)                        : '); // ör: 19:00
  const targetDT   = await ask(rl, 'Hedef datetime (YYYY-MM-DDTHH:mm:ss): '); // ör: 2026-04-09T19:00:00

  const pollInterval      = 30 * 1000;     // 30sn polling
  const keepAliveInterval = 3 * 60 * 1000; // 3dk keepalive

  rl.close();

  const targetMs = new Date(targetDT).getTime();
  if (isNaN(targetMs)) {
    log('ERR', 'Geçersiz tarih formatı. Örnek: 2026-04-09T19:00:00');
    process.exit(1);
  }

  const smsHelper = new SmsHelper(twilioSid, twilioToken, twilioFrom, LOG_FILE);

  // ── Browser başlat ────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 3. parti kaynakları blokla — sadece yavaşlatır
  const BLOCK_DOMAINS = ['serdoo.com', 'cloudflareinsights.com', 'google-analytics.com',
    'googletagmanager.com', 'facebook.net', 'doubleclick.net', 'conversionsapigateway.com'];
  await page.route('**/*', route => {
    if (BLOCK_DOMAINS.some(d => route.request().url().includes(d))) {
      route.abort();
    } else {
      route.continue();
    }
  });

  attachNetworkLogger(page);
  log('BOT', `Log dosyası: ${LOG_FILE}`);

  // ── Login ─────────────────────────────────────────────────────────────────
  await login(page, tcNo, sifre);
  await goToSeansSecim(page);

  // ── Timers ────────────────────────────────────────────────────────────────
  let booked = false;

  // Bot Ctrl+C veya rezervasyon tamamlanana kadar çalışır

  async function doBook(source) {
    const result = await tryBook(page, targetTime, targetDate, tcNo, sifre);
    if (result.found) {
      booked = true;
      clearInterval(pollTimer);
      clearInterval(keepAliveTimer);
      log(source, `✅ Seans seçildi: ${result.saat}`);
      await confirmAndSave(page);
      await verifySms(page, smsHelper);
      log('BOT', '✅ Rezervasyon tamamlandı!');
      setTimeout(() => { browser.close(); process.exit(0); }, 5000);
    }
    return result;
  }

  // Session keepalive timer
  const keepAliveTimer = setInterval(() => keepAlive(page, tcNo, sifre), keepAliveInterval);

  // Normal polling (hem öncesi iptal slotlar, hem sonrası)
  const pollTimer = setInterval(async () => {
    if (booked) return;
    const now = Date.now();

    // Hedef zamana 10sn kala precision timer devralır
    if (now >= targetMs - 10000 && now < targetMs + 10000) return;

    const label = now < targetMs ? 'POLL' : 'POLL-SONRASI';
    log(label, 'Kontrol ediliyor...');
    const result = await doBook(label);
    if (!result.found) log(label, 'Seans yok: ' + result.reason);
  }, pollInterval);

  // ── Precision Timer (hedef zamanda) ───────────────────────────────────────
  const msUntilTarget = targetMs - Date.now();
  if (msUntilTarget > 0) {
    log('BOT', `Hedef: ${targetDT} | Kalan: ${Math.round(msUntilTarget / 1000)} saniye`);

    waitUntilPrecise(targetMs).then(async () => {
      if (booked) return;
      log('PRECISION', `⚡ T=0 — ${new Date().toISOString()}`);

      let result = { found: false };
      let attempts = 0;
      while (!result.found && attempts < 20) {
        result = await doBook('PRECISION');
        if (result.found) return;
        await sleep(500);
        attempts++;
        log('PRECISION', `Deneme ${attempts} — ${result.reason}`);
      }

      if (!result.found) {
        log('BOT', `❌ T=0 anında seans açılmadı. Polling devam ediyor...`);
      }
    });
  } else {
    log('BOT', 'Hedef zaman geçmiş — sadece polling modu aktif');
  }

  log('BOT', 'Hazır. Polling ve keepalive aktif.');
})();
