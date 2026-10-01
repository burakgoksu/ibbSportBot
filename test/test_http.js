/**
 * Cloudflare testi: Pure HTTP ile login olabilir miyiz?
 */
require('dotenv').config();
const axios   = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');

const BASE = 'https://online.spor.istanbul';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9',
};

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true, maxRedirects: 5, headers: HEADERS }));

function ts() { return new Date().toISOString().replace('T',' ').slice(0,23); }

(async () => {
  try {
    // ── 1. Login sayfasını al ───────────────────────────────────────────────
    console.log(`[${ts()}] GET /uyegiris...`);
    const t0 = Date.now();
    const loginPage = await client.get(`${BASE}/uyegiris`);
    console.log(`[${ts()}] → ${loginPage.status} (${Date.now()-t0}ms)`);

    // Cloudflare challenge geldi mi?
    if (loginPage.data.includes('cf-browser-verification') || loginPage.data.includes('checking your browser')) {
      console.log('❌ Cloudflare ENGEL var — browser automation şart');
      return;
    }

    // VIEWSTATE al
    const $ = cheerio.load(loginPage.data);
    const viewState = $('input[name="__VIEWSTATE"]').val();
    const vsGen    = $('input[name="__VIEWSTATEGENERATOR"]').val();

    if (!viewState) {
      console.log('❌ VIEWSTATE alınamadı — Cloudflare sayfayı vermiyor olabilir');
      console.log('Sayfa başı:', loginPage.data.substring(0, 300));
      return;
    }
    console.log(`[${ts()}] ✅ VIEWSTATE alındı (${viewState.length} karakter)`);

    // ── 2. Login POST ───────────────────────────────────────────────────────
    console.log(`[${ts()}] POST /uyegiris...`);
    const t1 = Date.now();
    const loginResp = await client.post(`${BASE}/uyegiris`,
      new URLSearchParams({
        '__EVENTTARGET': '',
        '__EVENTARGUMENT': '',
        '__VIEWSTATE': viewState,
        '__VIEWSTATEGENERATOR': vsGen,
        'txtTCPasaport': process.env.TC_NO,
        'txtSifre': process.env.SIFRE,
        'btnGirisYap': 'Giriş Yap',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE}/uyegiris` } }
    );
    console.log(`[${ts()}] → ${loginResp.status} (${Date.now()-t1}ms) URL: ${loginResp.request?.res?.responseUrl}`);

    const finalUrl = loginResp.request?.res?.responseUrl || '';
    if (finalUrl.includes('anasayfa') || finalUrl.includes('uyespor')) {
      console.log('✅ Login BAŞARILI — Cloudflare geçildi, HTTP modu mümkün!');
    } else if (finalUrl.includes('uyegiris')) {
      console.log('❌ Login başarısız — hatalı bilgi veya Cloudflare engeli');
    } else {
      console.log('⚠️ Belirsiz sonuç, URL:', finalUrl);
      console.log('Sayfa başı:', loginResp.data.substring(0, 500));
    }

  } catch (e) {
    console.error('❌ HATA:', e.message);
    if (e.response) console.log('Status:', e.response.status, '\nData:', e.response.data?.substring(0,300));
  }
})();
