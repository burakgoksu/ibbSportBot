/**
 * IBB Spor Rezervasyon Botu — HTTP Modu (Playwright yok)
 * ──────────────────────────────────────────────────────
 * node bot_http.js
 */
'use strict';

const path     = require('path');

// ── Uygulama klasörü ─────────────────────────────────────────────────────────
// exe olarak paketlendiğinde (pkg / Node SEA) .env ve logs exe'nin yanında aranır
function isPackaged() {
  if (process.pkg) return true;
  try { return require('node:sea').isSea(); } catch { return false; }
}
const APP_DIR = isPackaged() ? path.dirname(process.execPath) : path.join(__dirname, '..');

require('dotenv').config({ path: path.join(APP_DIR, '.env'), quiet: true });
const axios    = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper }   = require('axios-cookiejar-support');
const cheerio  = require('cheerio');
const readline = require('readline');
const fs       = require('fs');
const SmsHelper = require('./sms');

const BASE = 'https://online.spor.istanbul';
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

// ── Logger ───────────────────────────────────────────────────────────────────
const LOG_DIR  = path.join(APP_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
// Dosya adı yerel saatle, sıralanabilsin diye yyyy-aa-gg-ss-dd-ss
const LOCAL_ISO = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
const LOG_FILE = path.join(LOG_DIR, `bot_http_${LOCAL_ISO.slice(0,19).replace(/[T:]/g,'-')}.log`);
// Yerel saat, girişlerle aynı format: gg.aa.yyyy ss:dd:ss.mmm
function ts() { const d = new Date(); return `${d.toLocaleString('tr-TR')}.${String(d.getMilliseconds()).padStart(3, '0')}`; }
function log(tag, msg) {
  const line = `[${ts()}] [${tag}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
// Aynı mesaj art arda tekrar ediyorsa (retry / re-navigate) bir kez yazar
let lastOnceMsg = '';
function logOnce(tag, msg) {
  if (msg === lastOnceMsg) return;
  lastOnceMsg = msg;
  log(tag, msg);
}

// ── HTTP Client ───────────────────────────────────────────────────────────────
function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    maxRedirects: 10,
    timeout: 20000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9',
    },
  }));
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ask(rl, q) { return new Promise(r => rl.question(q, a => r(a.trim()))); }

async function askRequired(rl, q) {
  let a = '';
  while (!a) a = await ask(rl, q);
  return a;
}

// Geçersiz girişte örnek gösterip tekrar sorar; parse geçerli değeri ya da null/false döndürür
async function askUntil(rl, q, parse, ornek) {
  for (;;) {
    const v = parse(await ask(rl, q));
    if (v) return v;
    console.log(`  ⚠ Geçersiz format — örnek: ${ornek}`);
  }
}

const pad = n => String(n).padStart(2, '0');
const formatTarih = dt => `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`;

// "gg.aa.yyyy" (saatli=false) ya da "gg.aa.yyyy ss:dd[:ss]" (saatli=true) → Date (yerel saat); geçersizse null
function parseTarihSaat(text, saatli) {
  const m = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m || saatli !== (m[4] !== undefined)) return null;
  const [gun, ay, yil, saat, dk, sn] = m.slice(1).map(v => +(v || 0));
  const dt = new Date(yil, ay - 1, gun, saat, dk, sn);
  // 31.02 ya da 25:00 gibi taşan değerleri reddet
  const gecerli = dt.getDate() === gun && dt.getMonth() === ay - 1 &&
                  dt.getHours() === saat && dt.getMinutes() === dk && dt.getSeconds() === sn;
  return gecerli ? dt : null;
}

// "ss:dd" → "ss:dd" (sıfır eklenmiş); geçersizse null
function parseSaat(text) {
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  return m && +m[1] < 24 && +m[2] < 60 ? `${pad(m[1])}:${m[2]}` : null;
}

async function waitUntilPrecise(targetMs) {
  const coarse = targetMs - Date.now() - 1000;
  if (coarse > 0) await sleep(coarse);
  while (Date.now() < targetMs) await sleep(1);
}

// ── VIEWSTATE parse ───────────────────────────────────────────────────────────
function parseViewState(html) {
  const $ = cheerio.load(html);
  return {
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val() || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTTARGET:        $('input[name="__EVENTTARGET"]').val() || '',
    __EVENTARGUMENT:      $('input[name="__EVENTARGUMENT"]').val() || '',
    __SCROLLPOSITIONX:    $('input[name="__SCROLLPOSITIONX"]').val() || '0',
    __SCROLLPOSITIONY:    $('input[name="__SCROLLPOSITIONY"]').val() || '0',
  };
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(client, tcNo, sifre, maxRetries = 5) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      log('LOGIN', `Deneme ${i}/${maxRetries}...`);
      const t0 = Date.now();

      const loginPage = await client.get(`${BASE}/uyegiris`);
      const vs = parseViewState(loginPage.data);
      if (!vs.__VIEWSTATE) throw new Error('VIEWSTATE alınamadı');

      const resp = await client.post(`${BASE}/uyegiris`,
        new URLSearchParams({ ...vs, txtTCPasaport: tcNo, txtSifre: sifre, btnGirisYap: 'Giriş Yap' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyegiris` } }
      );

      const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || '';
      if (!finalUrl.includes('anasayfa') && !finalUrl.includes('uyespor')) {
        throw new Error(`Login sonrası beklenmeyen URL: ${finalUrl}`);
      }

      log('LOGIN', `✅ Başarılı (${Date.now()-t0}ms)`);
      return true;
    } catch (e) {
      log('LOGIN-ERR', `Deneme ${i} başarısız: ${e.message}`);
      if (i < maxRetries) { log('LOGIN', '5sn sonra tekrar...'); await sleep(5000); }
      else throw e;
    }
  }
}

// ── /uyespor'dan üyelik adına göre doğru EVENTTARGET'ı bul ──────────────────
function normalize(str) {
  // Türkçe karakterleri sadeleştir (İ→i, ş→s, ü→u ...), tire/noktalamayı boşluğa çevir
  return (str || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function cellTexts($, tr) {
  return $(tr).children('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
}

// Satış tarihi hücresi "gg.aa.yyyy ss:dd" → ms (değilse 0)
function parseSatisTarihi(text) {
  const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]).getTime() : 0;
}

function findSeansButton($, uyelikAdi) {
  const aranan = normalize(uyelikAdi).split(' ');
  // Bir hücrede aranan kelimelerin hepsi geçiyorsa eşleşir (tire, Türkçe karakter, büyük/küçük harf farkı önemsiz)
  const eslesir = text => { const k = new Set(normalize(text).split(' ')); return aranan.every(w => k.has(w)); };

  const satirlar = [];
  $('[id*="lbtnSeansSecim"]').each((sira, el) => {
    const match = ($(el).attr('href') || '').match(/__doPostBack\('([^']+)'/);
    if (!match) return;
    const cells = cellTexts($, $(el).closest('tr'));
    satirlar.push({
      eventTarget: match[1],
      ad:      cells.reduce((a, b) => (b.length > a.length ? b : a), ''), // en uzun hücre = üyelik adı
      satis:   Math.max(0, ...cells.map(parseSatisTarihi)),
      sira,
      eslesti: cells.some(eslesir),
    });
  });

  // Aynı isimde birden fazla üyelik varsa en güncel satış tarihli olan; tarih okunamazsa tablodaki en üstteki
  const eslesenler = satirlar.filter(s => s.eslesti)
    .sort((a, b) => (b.satis - a.satis) || (a.sira - b.sira));

  if (eslesenler.length) {
    logOnce('NAV', `Eşleşen üyelik (${eslesenler.length} adet, en güncel seçildi): ${eslesenler[0].ad}`);
    return eslesenler[0].eventTarget;
  }

  // Eşleşme bulunamazsa mevcut üyelikleri logla
  if (satirlar.length) {
    logOnce('NAV', `"${uyelikAdi}" eşleşmedi. Seans Seç butonu olan üyelikler:\n` +
      satirlar.map(s => `  → ${s.ad}`).join('\n'));
  } else {
    const tumu = $('table tr').map((_, tr) => cellTexts($, tr).reduce((a, b) => (b.length > a.length ? b : a), '')).get()
      .filter(Boolean).slice(0, 10);
    logOnce('NAV', `Hesapta Seans Seç butonu olan aktif üyelik yok (üyelik bitmiş ya da kalan hak 0 olabilir). ` +
      `Listedeki ilk ${tumu.length} kayıt:\n` + tumu.map(t => `  → ${t}`).join('\n'));
  }

  return null;
}

// ── Seans seçim sayfasına git ─────────────────────────────────────────────────
async function getSeansPage(client, sporAdi, maxRetries = 5) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      log('NAV', `Deneme ${i}/${maxRetries} /uyespor...`);
      const t0 = Date.now();

      const uyesporPage = await client.get(`${BASE}/uyespor`);
      const $ = cheerio.load(uyesporPage.data);
      const vs = parseViewState(uyesporPage.data);
      if (!vs.__VIEWSTATE) throw new Error('VIEWSTATE alınamadı (/uyespor)');

      // Spor adına göre doğru butonu bul
      const eventTarget = findSeansButton($, sporAdi);
      if (!eventTarget) throw new Error(`"${sporAdi}" için Seans Seç butonu bulunamadı`);
      log('NAV', `Hedef buton: ${eventTarget}`);

      const resp = await client.post(`${BASE}/uyespor`,
        new URLSearchParams({ ...vs, __EVENTTARGET: eventTarget }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyespor` } }
      );

      const finalUrl = resp.request?.res?.responseUrl || '';
      if (!finalUrl.includes('uyeseanssecim')) throw new Error(`Beklenmeyen URL: ${finalUrl}`);

      log('NAV', `✅ /uyeseanssecim alındı (${Date.now()-t0}ms)`);
      return resp.data;
    } catch (e) {
      log('NAV-ERR', `Deneme ${i} başarısız: ${e.message}`);
      if (i < maxRetries) { log('NAV', '5sn sonra tekrar...'); await sleep(5000); }
      else throw e;
    }
  }
}

// ── Seansı bul ve rezervasyon POST'u oluştur ─────────────────────────────────
function findSession(html, targetTime, targetDate) {
  const $ = cheerio.load(html);

  let foundCheckboxName = null;
  let foundCheckboxValue = null;

  $('[id*="lblSeansSaat"]').each((_, el) => {
    const saat = $(el).text().trim();
    if (!saat.includes(targetTime)) return;

    // Tarihi panel başlığında kontrol et
    if (targetDate) {
      const panel = $(el).closest('.panel-info');
      if (panel.length && !panel.text().includes(targetDate)) return;
    }

    // Checkbox
    const well = $(el).closest('.well');
    const cb = well.find('input[type=checkbox]');
    if (!cb.length) return;
    if (cb.attr('disabled')) return;

    foundCheckboxName  = cb.attr('name');
    foundCheckboxValue = cb.attr('value') || 'on';
    return false; // break
  });

  return { found: !!foundCheckboxName, name: foundCheckboxName, value: foundCheckboxValue };
}

// ── Rezervasyon yap ───────────────────────────────────────────────────────────
async function tryBook(client, targetTime, targetDate, maxRetries = 3, prefetchedHtml = null) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const t0 = Date.now();
      let html;
      if (prefetchedHtml && i === 1) {
        html = prefetchedHtml;
        log('BOOK', 'Önceden alınan sayfa kullanılıyor...');
      } else {
        const resp = await client.get(`${BASE}/uyeseanssecim`, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
          },
        });
        html = resp.data;
      }

      // Session düştü mü? (login sayfasına redirect olduysa)
      if (html.includes('txtTCPasaport') || html.includes('btnGirisYap')) {
        log('SESSION', '⚠️ Session düştü — re-login gerekiyor');
        return { found: false, sessionDrop: true };
      }

      const session = findSession(html, targetTime, targetDate);
      if (!session.found) {
        log('BOOK', `Seans bulunamadı (${Date.now()-t0}ms)`);
        return { found: false, sessionDrop: false };
      }

      log('BOOK', `✅ Seans bulundu (${Date.now()-t0}ms) — Adım 1: checkbox postback...`);

      // Adım 1: Checkbox seçimi (ASP.NET __doPostBack tetikler)
      const vs1 = parseViewState(html);
      const step1Body = new URLSearchParams({
        ...vs1,
        __EVENTTARGET: session.name,
        __EVENTARGUMENT: '',
        [session.name]: session.value,
      }).toString();

      const t1 = Date.now();
      const step1Resp = await client.post(`${BASE}/uyeseanssecim`, step1Body,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyeseanssecim` } }
      );
      log('BOOK', `Adım 1 yanıtı ${step1Resp.status} (${Date.now()-t1}ms)`);

      // Adım 2: Onay checkbox + Kaydet
      const vs2 = parseViewState(step1Resp.data);
      const step2Body = new URLSearchParams({
        ...vs2,
        [session.name]: session.value,
        'ctl00$pageContent$cboxOnay': 'on',
        __EVENTTARGET: 'ctl00$pageContent$lbtnKaydet',
        __EVENTARGUMENT: '',
      }).toString();

      const t2 = Date.now();
      const bookResp = await client.post(`${BASE}/uyeseanssecim`, step2Body,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyeseanssecim` } }
      );
      log('BOOK', `Adım 2 (Kaydet) yanıtı ${bookResp.status} (${Date.now()-t2}ms)`);
      return { found: true, html: bookResp.data, sessionName: session.name };
    } catch (e) {
      log('BOOK-ERR', `Deneme ${i}: ${e.message}`);
      if (i < maxRetries) await sleep(1000);
    }
  }
  return { found: false, sessionDrop: false };
}

// ── SMS Doğrulama ─────────────────────────────────────────────────────────────
async function verifySms(client, html, smsHelper, sessionName) {
  const requestedAt = new Date();
  log('SMS', 'Kod bekleniyor...');
  const code = await smsHelper.waitForCode(requestedAt, 500, 30000);

  const vs = parseViewState(html);
  const body = new URLSearchParams({
    ...vs,
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    'ctl00$pageContent$cboxOnay': 'on',
    'ctl00$pageContent$txtDogrulamaKodu': code,
    'ctl00$pageContent$btnCepTelDogrulamaGonder': 'Kodunu Doğrula',
    ...(sessionName ? { [sessionName]: 'on' } : {}),
  }).toString();

  await client.post(`${BASE}/uyeseanssecim`, body,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyeseanssecim` } }
  );
  log('SMS', `✅ Kod gönderildi: ${code}`);
}

// ── Session keepalive ─────────────────────────────────────────────────────────
async function keepAlive(client, tcNo, sifre, sporAdi) {
  try {
    const resp = await client.get(`${BASE}/anasayfa`, { maxRedirects: 0, validateStatus: s => s < 400 });
    if (resp.request?.res?.responseUrl?.includes('uyegiris') || resp.status === 302) {
      log('KEEPALIVE', '⚠️ Session düştü — re-login yapılıyor...');
      await login(client, tcNo, sifre);
      await getSeansPage(client, sporAdi);
    } else {
      log('KEEPALIVE', 'Session aktif');
    }
  } catch (e) {
    log('KEEPALIVE-ERR', e.message);
  }
}

// ── Çıkış ────────────────────────────────────────────────────────────────────
// exe çift tıklamayla açıldığında pencere hemen kapanmasın diye Enter beklenir
const timers = [];
let stopped = false;
function finish(code) {
  if (stopped) return;
  stopped = true;
  timers.forEach(clearInterval);
  if (!process.stdin.isTTY) process.exit(code);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nKapatmak için Enter\'a basın...', () => process.exit(code));
}

process.on('unhandledRejection', e => {
  log('HATA', `❌ ${e?.message || e}`);
  finish(1);
});

// ── ANA FONKSİYON ─────────────────────────────────────────────────────────────
(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('═══════════════════════════════════════════');
  console.log('   IBB Spor Rezervasyon Botu — HTTP Modu   ');
  console.log('═══════════════════════════════════════════');

  // .env'de yoksa sorulur
  const tcNo        = process.env.TC_NO        || await askRequired(rl, 'TC No              : ');
  const sifre       = process.env.SIFRE        || await askRequired(rl, 'Şifre              : ');
  const sporAdi     = process.env.SPOR         || await askRequired(rl, 'Üyelik adı         : ');
  const twilioSid   = process.env.TWILIO_SID   || await ask(rl, 'Twilio SID         : ');
  const twilioToken = process.env.TWILIO_TOKEN || await ask(rl, 'Twilio Token       : ');
  const twilioFrom  = process.env.TWILIO_FROM  || await ask(rl, 'Twilio From No     : ');
  console.log(`Üyelik: ${sporAdi}`);

  const targetDate = formatTarih(await askUntil(rl, 'Tarih (gg.aa.yyyy)                : ',
    t => parseTarihSaat(t, false), '01.10.2026'));
  const targetTime = await askUntil(rl, 'Saat (ss:dd)                      : ', parseSaat, '20:00');
  const targetAt   = await askUntil(rl, 'Hedef zaman (gg.aa.yyyy ss:dd:ss) : ',
    t => parseTarihSaat(t, true), '01.10.2026 16:06:20');
  rl.close();

  const targetMs = targetAt.getTime();
  const targetDT = targetAt.toLocaleString('tr-TR');

  log('BOT', `Log dosyası: ${LOG_FILE}`);

  const client    = makeClient();
  const smsHelper = new SmsHelper(twilioSid, twilioToken, twilioFrom, LOG_FILE);

  // İlk login
  await login(client, tcNo, sifre);
  await getSeansPage(client, sporAdi);

  let booked = false;

  async function doBook(source, prefetchedHtml = null) {
    const result = await tryBook(client, targetTime, targetDate, 3, prefetchedHtml);
    if (result.sessionDrop) {
      await login(client, tcNo, sifre);
      await getSeansPage(client, sporAdi);
      return { found: false };
    }
    if (result.found) {
      booked = true;
      clearInterval(pollTimer);
      clearInterval(keepAliveTimer);
      log(source, '✅ Rezervasyon yapıldı, SMS bekleniyor...');
      await verifySms(client, result.html, smsHelper, result.sessionName);
      log('BOT', '✅ TAMAMLANDI!');
      finish(0);
    }
    return result;
  }

  // Keepalive: her 3dk
  const keepAliveTimer = setInterval(() => keepAlive(client, tcNo, sifre, sporAdi), 3 * 60 * 1000);

  // Polling: her 30sn
  const pollTimer = setInterval(async () => {
    if (booked) return;
    const now = Date.now();
    if (now >= targetMs - 10000 && now < targetMs + 10000) return; // precision timer devralır
    const label = now < targetMs ? 'POLL' : 'POLL-SONRASI';
    log(label, 'Kontrol ediliyor...');
    const r = await doBook(label);
    if (!r.found) log(label, 'Seans yok');
  }, 30 * 1000);
  timers.push(keepAliveTimer, pollTimer);

  // Precision timer
  const msLeft = targetMs - Date.now();
  if (msLeft > 0) {
    log('BOT', `Hedef: ${targetDT} | Kalan: ${Math.round(msLeft/1000)}sn`);

    waitUntilPrecise(targetMs).then(async () => {
      if (booked || stopped) return;
      log('PRECISION', '⚡ T=0');
      let attempts = 0;
      while (!booked && !stopped && attempts < 20) {
        // Önce hızlı GET dene (1 istek) — seans varsa re-navigate'e gerek yok
        const r = await doBook('PRECISION');
        if (r.found) return;

        // Seans bulunamadı — her 3 denemede bir re-navigate yap
        if (attempts % 3 === 0) {
          try {
            log('PRECISION', `Re-navigate (deneme ${attempts})...`);
            const freshHtml = await getSeansPage(client, sporAdi, 1);
            // Re-navigate'ten gelen taze HTML ile hemen dene
            const r2 = await doBook('PRECISION', freshHtml);
            if (r2.found) return;
          } catch (e) {
            log('PRECISION-ERR', `Re-navigate başarısız: ${e.message}`);
          }
        }

        await sleep(300);
        attempts++;
        log('PRECISION', `Deneme ${attempts}`);
      }
      if (!booked) log('BOT', '❌ T=0 anında seans açılmadı — polling devam ediyor...');
    });
  } else {
    log('BOT', 'Hedef zaman geçmiş — polling modu aktif');
  }

  log('BOT', 'Hazır. Polling ve keepalive aktif.');
})();
