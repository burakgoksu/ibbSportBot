/**
 * bot_http.js → dist/ibbSporBot.exe (Node Single Executable Application)
 * ──────────────────────────────────────────────────────────────────────
 * npm run build:exe
 *
 *  1. esbuild ile tüm bağımlılıklar tek CJS dosyaya paketlenir
 *  2. Node SEA blob'u üretilir
 *  3. Mevcut node.exe kopyalanıp blob içine gömülür (postject)
 *  4. .env varsa exe'nin yanına kopyalanır
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { inject } = require('postject');

const ROOT   = path.join(__dirname, '..');
const DIST   = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'bot.cjs');
const BLOB   = path.join(DIST, 'sea-prep.blob');
const CONFIG = path.join(DIST, 'sea-config.json');
const EXE    = path.join(DIST, 'ibbSporBot.exe');

(async () => {
  fs.mkdirSync(DIST, { recursive: true });

  console.log('1/4 esbuild paketleme...');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/bot_http.js')],
    outfile:  BUNDLE,
    bundle:   true,
    platform: 'node',
    format:   'cjs',
    target:   `node${process.versions.node.split('.')[0]}`,
    charset:  'utf8',
    logLevel: 'warning',
  });

  console.log('2/4 SEA blob oluşturuluyor...');
  fs.writeFileSync(CONFIG, JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
  }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit' });

  console.log('3/4 node.exe kopyalanıp blob gömülüyor...');
  fs.copyFileSync(process.execPath, EXE);
  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  console.log('4/4 .env kopyalanıyor...');
  const envSrc = path.join(ROOT, '.env');
  if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, path.join(DIST, '.env'));
  else console.log('   .env bulunamadı — exe yanına elle koyun ya da bilgiler açılışta sorulur');

  for (const f of [BUNDLE, BLOB, CONFIG]) fs.rmSync(f, { force: true });
  console.log(`\n✅ Hazır: ${EXE}`);
})().catch(e => { console.error('❌ Derleme başarısız:', e.message); process.exit(1); });
