'use strict';

/*
 * Buyer Log — MASAÜSTÜ BARINDIRICI (Electron ana süreci)
 *
 * ÖNCE:  START.cmd → node-portable → backend → localhost → harici Edge/Chrome → arayüz
 * SONRA: BuyerLog.exe → (aynı) backend → localhost → gömülü Chromium → (aynı) arayüz
 *
 * Bu dosya bir BARINDIRICIDIR. Buyer Log'un iş mantığından, veri modelinden,
 * sync semantiğinden veya arayüzünden hiçbir şey bilmez ve hiçbirini yeniden
 * uygulamaz. Yaptığı iş: yolları çözmek, veriyi taşımak, backend'i başlatıp
 * hazır olmasını beklemek, bir pencere açmak ve kapanışta arkasında süreç
 * bırakmamak.
 *
 * TASARIM KARARLARI:
 *
 * 1) BACKEND HTTP KALDI. Arayüz ile sunucu arasındaki iletişim IPC'ye
 *    çevrilmedi. ~27.500 satırlık istemci ve ~585 KB'lık sunucu aynı origin
 *    üzerinden konuşmaya devam ediyor; taşıma bir BARINDIRMA değişikliğidir,
 *    protokol değişikliği değil.
 *
 * 2) MENÜ YOK. Electron varsayılan menüsü Ctrl+Z/Ctrl+Y'yi menü hızlandırıcısı
 *    olarak yakalar ve sayfaya ulaşmadan tüketir. Collection'ın kendi
 *    geri al/yinele ve çok hücreli kopyala/yapıştır mantığı tam olarak bu
 *    tuşlara bağlı. Edge --app kipinde de menü yoktu; davranışı birebir
 *    korumanın yolu menüyü hiç kurmamak.
 *
 * 3) HARİCİ BAĞLANTILAR NORMALDE SİSTEM TARAYICISINA GİDER. Troy ve
 *    Microsoft 365 akışları kullanıcının gerçek kurumsal profiline bağlıdır.
 *    CoreNectum PLM bunun bilinçli istisnasıdır: yalnız Bearer'ı otomatik
 *    edinmek için ayrı, sandbox'lı ve kalıcı bir Electron SSO partition'ı
 *    kullanılır. Ana Buyer Log renderer'ı bu tokenı hiçbir zaman görmez.
 *
 * 4) PENCERE, BACKEND GERÇEKTEN HAZIR OLMADAN AÇILMAZ. Aksi hâlde kullanıcı
 *    beyaz bir pencereye bakar. Başarısızlıkta beyaz pencere değil, ne
 *    yapacağını söyleyen bir hata ekranı gösterilir.
 *
 * 5) GÜVENLİ VARSAYILANLAR. nodeIntegration kapalı, contextIsolation açık,
 *    sandbox açık. Renderer'a yalnız adı sabit, sayısı sınırlı birkaç IPC
 *    kanalı açılır; keyfi çalıştırma yolu yoktur.
 */

const { app, BrowserWindow, WebContentsView, Menu, dialog, shell, ipcMain, screen, session, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactSecrets } = require('../shared/secret-redaction');

const { resolvePortableRoot, desktopPaths, resolveAppUrl, readJsonFile } = require('./portable-paths');
const { BackendProcess, probeOrigin, ensureConfig, ensureDataTree } = require('./backend');
const { runFirstRunMigration, healPortableSettings, readMigrationState } = require('./first-run-migration');
const { inspectPortOwner, closePortOwner } = require('./port-owner');
const { BuyerLogUpdater } = require('./update/updater');
const { createOabAuthLifecycle } = require('./oab-auth-lifecycle');
const { createWorkspaceManager } = require('./workspace-manager');

const APP_CORE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BOUNDS = { width: 1600, height: 1000 };

let paths = null;
let backend = null;
let mainWindow = null;
let workspace = null;
let errorWindow = null;
let logStream = null;
let quitting = false;
let startupFailure = null;
let restarting = false;
let lastStartedAt = 0;
let updater = null;
let updateStartupTimer = null;
let updatePeriodicTimer = null;
let updateRelaunchRequested = false;

function activeBuyerLogWindow(contents) {
  return (workspace && contents && workspace.windowForContents(contents))
    || (workspace && workspace.focusedWindow())
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
}

function activeBuyerLogContents() {
  return (workspace && workspace.activeContents())
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
}

/* CoreNectum automatic auth — dedicated Electron corporate session.
 * No raw Bearer reaches the renderer and no user has to copy it from DevTools.
 * A random per-process bridge secret moves the captured token to the local
 * backend over loopback only. */
const CORENECTUM_AUTH_PARTITION = 'persist:buyerlog-corenectum-auth';
const CORENECTUM_HOME = 'https://corenectum.lcwaikiki.com/models-options/style-list';
const CORENECTUM_API_HOST = 'mym-api.lcwaikiki.com';
const CORENECTUM_STYLE_LIST_API = 'https://mym-api.lcwaikiki.com/lcw/live/corenectum/service/api/StyleList/GetStyleList';
const desktopBridgeSecret = crypto.randomBytes(32).toString('hex');
let coreNectumAuthWindow = null;
let coreNectumAuthInFlight = null;
let coreNectumStyleListTemplate = null;

/* OAB automatic auth — intentionally independent from CoreNectum and from the
 * user's normal Edge profile. Browser session state lives in this dedicated
 * persistent partition; raw Authorization still exists only in process/backend
 * memory and is captured only from the exact trusted PASS API host. The
 * captured Bearer is still accepted only after the loopback backend validates
 * it against the real OAB report endpoint. */
const OAB_AUTH_PARTITION = 'persist:oab';
const OAB_VIEWER_URL = 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report';
const OAB_HOME_URL = 'https://pass.lcwaikiki.com/';
const OAB_UI_HOST = 'pass.lcwaikiki.com';
const OAB_API_HOST = 'pass.prod.lcwaikiki.com';
const OAB_AUTH_CAPTURE_FILTER = { urls: [`https://${OAB_API_HOST}/pass/*`] };
const OAB_SILENT_PROBE_MS = 8000;
let oabAuthWindow = null;
let oabAuthInFlight = null;
let oabAuthFlowState = null;

/*
 * Tamamlanan indirmelerin token → gerçek yol eşlemesi. "Dosya hazır" bildirim
 * kartındaki Aç/Klasörde Göster aksiyonları renderer'dan HİÇBİR ZAMAN ham bir
 * yol almaz (bkz. preload.js §keyfi yol yok) — yalnız burada üretilen opak bir
 * token alır ve gerçek yolu ana süreç kendi belleğinden çözer. Sınırsız
 * büyümemesi için en eski girdi, sınır aşılınca atılır.
 */
const downloadRegistry = new Map();
const DOWNLOAD_REGISTRY_LIMIT = 50;
function registerDownload(filePath) {
  const token = crypto.randomBytes(8).toString('hex');
  downloadRegistry.set(token, { path: filePath });
  if (downloadRegistry.size > DOWNLOAD_REGISTRY_LIMIT) {
    downloadRegistry.delete(downloadRegistry.keys().next().value);
  }
  return token;
}

/* ------------------------------------------------------------------ log */

function timestamp() { return new Date().toISOString(); }

function log(message) {
  const line = '[' + timestamp() + '] ' + redactSecrets(message);
  /*
   * KONSOL YOKKEN stdout'a YAZMA.
   *
   * BuyerLog.exe GUI alt sisteminde derlenmistir ve cift tiklamayla
   * acildiginda bagli bir konsolu yoktur. Boyle bir surecte
   * process.stdout.write, okuyucusu olmayan bir handle'a yazip BLOKE
   * OLABILIR. Bloke olan ana surec, calistirdigi cocugun stdout borusunu
   * bosaltmayi da birakir; boru dolunca cocuk de kilitlenir.
   *
   * Canlida ilk acilis tasimasi tam olarak boyle asildi: cocuk ~10 MB
   * kopyaladi (bir boru tamponu kadar), sonra ikisi de sonsuza kadar
   * bekledi. Ekranda pencere bile acilmadi.
   *
   * Gunluk zaten dosyaya yaziliyor; konsol yalniz gelistirme kolayligi.
   */
  if (process.stdout && process.stdout.isTTY) {
    try { process.stdout.write(line + '\r\n'); } catch (_) {}
  }
  try {
    if (!logStream && paths) {
      fs.mkdirSync(paths.logsRoot, { recursive: true });
      try {
        const stat = fs.statSync(paths.desktopLogPath);
        if (stat.size > 4 * 1024 * 1024) fs.renameSync(paths.desktopLogPath, paths.desktopLogPath + '.1');
      } catch (_) { /* ilk çalıştırmada dosya yok */ }
      logStream = fs.createWriteStream(paths.desktopLogPath, { flags: 'a' });
    }
    if (logStream) logStream.write(line + '\r\n');
  } catch (_) { /* log yazılamaması uygulamayı durdurmaz */ }
}

const readJson = readJsonFile;

function appVersion() {
  const pkg = readJson(path.join(APP_CORE_ROOT, 'package.json'), {});
  return String(pkg.version || 'bilinmiyor');
}

function updaterBaseConfig() {
  const config = paths ? readJson(paths.configPath, {}) : {};
  return config && typeof config.updates === 'object' && config.updates ? config.updates : {};
}

async function verifyUpdateModerator(userId) {
  const id=String(userId||'').trim();
  if(!id||!backend||!backend.running||!backend.origin)return false;
  try{
    const response=await fetch(backend.origin+'/api/internal/desktop/update-authority',{
      method:'POST',cache:'no-store',redirect:'error',
      headers:{'Content-Type':'application/json','X-BuyerLog-Desktop-Bridge':desktopBridgeSecret},
      body:JSON.stringify({userId:id}),
    });
    const data=await response.json().catch(()=>({}));
    return Boolean(response.ok&&data.ok&&data.moderator);
  }catch(_){return false;}
}

async function currentRendererUserId() {
  const contents=activeBuyerLogContents();
  if(!contents||contents.isDestroyed())return '';
  try{return String(await contents.executeJavaScript("String((window.BL_USER_CONTEXT&&window.BL_USER_CONTEXT.id)||'')",true)||'').trim();}
  catch(_){return '';}
}

async function effectiveUpdateChannel(userId='') {
  if(!updater)return 'stable';
  const cfg=updater.config(updaterBaseConfig());
  if(cfg.channel!=='test')return 'stable';
  return await verifyUpdateModerator(userId)?'test':'stable';
}

function emitUpdateStatus(payload) {
  if(workspace){workspace.broadcast('buyerlog:update-status-changed',payload);return;}
  if(mainWindow&&!mainWindow.isDestroyed())try{mainWindow.webContents.send('buyerlog:update-status-changed',payload);}catch(_){}
}

async function updateStatusFor(userId='') {
  if(!updater)return {enabled:false,state:'IDLE',currentVersion:appVersion(),channel:'stable',moderator:false};
  const moderator=await verifyUpdateModerator(userId);
  const configured=updater.config(updaterBaseConfig());
  const channel=(configured.channel==='test'&&moderator)?'test':'stable';
  return {...updater.status(updaterBaseConfig(),channel),moderator,configuredChannel:configured.channel};
}

async function runUpdateCheck(options={}) {
  if(!updater)return {ok:false,disabled:true,reason:'updater-unavailable'};
  const userId=String(options.userId||await currentRendererUserId()||'');
  const channel=await effectiveUpdateChannel(userId);
  try{
    const result=await updater.checkAndStage({baseConfig:updaterBaseConfig(),channel,manual:options.manual===true,retryFailed:options.retryFailed===true});
    emitUpdateStatus(await updateStatusFor(userId));
    return result;
  }catch(error){emitUpdateStatus(await updateStatusFor(userId));throw error;}
}

function scheduleUpdateChecks() {
  if(!updater||!app.isPackaged)return;
  if(updateStartupTimer){clearTimeout(updateStartupTimer);updateStartupTimer=null;}
  if(updatePeriodicTimer)clearInterval(updatePeriodicTimer);
  const cfg=updater.config(updaterBaseConfig());
  // Açılış kontrolü login/renderer beklemez: uygulama ayağa kalkarken hemen
  // başlar. Ağ veya release kaynağı yavaşsa Buyer Log yine bloklanmadan açılır.
  void runUpdateCheck({manual:false}).catch(()=>{});
  updatePeriodicTimer=setInterval(()=>{void runUpdateCheck({manual:false}).catch(()=>{});},cfg.checkIntervalHours*60*60*1000);
  if(updatePeriodicTimer.unref)updatePeriodicTimer.unref();
}

/* --------------------------------------------------------- pencere durumu */

/*
 * Pencere geometrisi KULLANICI TERCİHİDİR, paylaşılan iş verisi değildir:
 * cihaza özel yerel dosyada durur, sync'e girmez.
 *
 * Ekran düzeni değişince (dizüstü dock'tan ayrılınca) eski konum artık var
 * olmayan bir monitörü gösterebilir; pencere görünmez bir yerde açılırdı.
 * Bu yüzden kayıtlı dikdörtgen, mevcut ekranlarla KESİŞMİYORSA yok sayılır.
 */
function loadWindowState() {
  const saved = readJson(paths.windowStatePath, null);
  const fallback = { ...DEFAULT_BOUNDS, maximized: false };
  if (!saved || typeof saved !== 'object') return fallback;
  const width = Math.max(800, Number(saved.width) || DEFAULT_BOUNDS.width);
  const height = Math.max(600, Number(saved.height) || DEFAULT_BOUNDS.height);
  const state = { width, height, maximized: saved.maximized === true };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    const visible = screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return saved.x < area.x + area.width && saved.x + width > area.x
        && saved.y < area.y + area.height && saved.y + height > area.y;
    });
    if (visible) { state.x = saved.x; state.y = saved.y; }
  }
  return state;
}

function saveWindowState(targetWindow = activeBuyerLogWindow()) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  try {
    const maximized = targetWindow.isMaximized();
    const bounds = maximized ? targetWindow.getNormalBounds() : targetWindow.getBounds();
    fs.mkdirSync(path.dirname(paths.windowStatePath), { recursive: true });
    fs.writeFileSync(paths.windowStatePath, JSON.stringify({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized,
    }, null, 2) + '\n', 'utf8');
  } catch (_) { /* tercih kaydedilemezse uygulama yine çalışır */ }
}

/* ------------------------------------------------------- gezinme politikası */

function isExternalScheme(target) {
  return /^(https?|mailto|tel|msteams|ms-outlook):/i.test(String(target || ''));
}

function openExternal(target) {
  if (!isExternalScheme(target)) return;
  shell.openExternal(target).catch(error => log('Harici bağlantı açılamadı: ' + error.message));
}

/*
 * Uygulama origin'i dışına çıkan her gezinme sistem tarayıcısına yönlenir (§3).
 * Buyer Log arayüzü kendi origin'inde kalır; keyfi bir sayfa Electron
 * penceresini ele geçiremez.
 */
function applyNavigationPolicy(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-attach-webview', event => event.preventDefault());
}

/*
 * Çakışmayan hedef ad: "Rapor.xlsx" → "Rapor (2).xlsx". Tarayıcıların yaptığı
 * budur; var olan bir dışa aktarımın üstüne yazmak veri kaybıdır.
 */
function uniqueDownloadPath(directory, fileName) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension) || 'indirme';
  let candidate = path.join(directory, base + extension);
  for (let index = 2; fs.existsSync(candidate) && index < 1000; index += 1) {
    candidate = path.join(directory, base + ' (' + index + ')' + extension);
  }
  return candidate;
}

/*
 * İNDİRMELER — mevcut davranış korunur.
 *
 * Edge --app kipinde Excel/PDF/Download PO çıktıları kullanıcıya sorulmadan
 * İndirilenler klasörüne düşüyordu. Electron, kaydetme yolu verilmezse bir
 * kaydetme penceresi açar; toplu dışa aktarımda bu, her dosya için kullanıcıyı
 * bekleyen bir kutu demektir — çalışan bir özelliğin sessizce ağırlaşması.
 * Bu yüzden hedef açıkça verilir: GERÇEK İndirilenler klasörü.
 *
 * Paketin resources klasörüne ASLA yazılmaz: app.getPath('downloads') gerçek
 * Windows kabuk klasörünü döndürür ve ana süreçte AppData yönlendirmesi
 * yapılmadığı için (bkz. portable-paths.js §2) bu yol doğrudur.
 */
function applyDownloadPolicy(targetSession) {
  targetSession.on('will-download', (_event, item, initiatingContents) => {
    let target = '';
    try {
      const downloads = app.getPath('downloads');
      fs.mkdirSync(downloads, { recursive: true });
      target = uniqueDownloadPath(downloads, item.getFilename());
      item.setSavePath(target);
    } catch (error) {
      // Yol belirlenemezse Electron'un kendi kaydetme penceresine düşülür:
      // indirmenin sessizce kaybolmasındansa kullanıcıya sorulsun.
      log('İndirme hedefi belirlenemedi (' + error.message + '); kaydetme penceresi açılacak.');
    }
    item.once('done', (_doneEvent, state) => {
      log('İndirme (' + state + '): ' + item.getFilename() + (target ? ' → ' + target : ''));
      /*
       * Buyer Log'un tüm istemci-taraflı dışa aktarımları (CP/Orders Excel vb.)
       * Blob URL + <a download> ile bu indirme yöneticisinden geçer; bu yüzden
       * BURASI, o dosyaların GERÇEK çakışma-güvenli son yolunu bilen TEK yerdir.
       * Yalnız başarıyla tamamlanan indirme renderer'a bildirilir — iptal/hata
       * durumunda "başarı" kartı ASLA üretilmez.
       */
      if (state === 'completed' && target) {
        const token = registerDownload(target);
        const payload = {
          token, filename: path.basename(target), path: target, success: true,
        };
        if (workspace) workspace.sendToDownloadOwner(initiatingContents, 'buyerlog:download-complete', payload);
        else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('buyerlog:download-complete', payload);
      }
    });
  });

  /*
   * İzinler açıkça yönetilir. Collection'ın çok hücreli kopyala/yapıştır
   * mantığı asenkron pano API'sini kullanıyor (navigator.clipboard.write +
   * ClipboardItem); bu izin verilmezse Excel/Word/Outlook'a yapıştırma
   * sessizce bozulur. Kamera, mikrofon, konum vb. Buyer Log'un işi değildir.
   */
  const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write', 'fullscreen']);
  targetSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  targetSession.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
}


/* ---------------------------------------------------- CoreNectum auto auth */

function normalizeBearer(value) {
  let text = String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '').trim();
  if (/^bearer\s+/i.test(text)) text = text.replace(/^bearer\s+/i, '').trim();
  return text;
}

function jwtExpiryMs(token) {
  const raw = normalizeBearer(token);
  const parts = raw.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : 0;
  } catch (_) { return 0; }
}

function usableCoreNectumToken(value) {
  const token = normalizeBearer(value);
  if (token.length < 20) return '';
  const exp = jwtExpiryMs(token);
  if (exp && exp <= Date.now() + 30000) return '';
  return token;
}

function authorizationTokenFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() !== 'authorization') continue;
    const token = usableCoreNectumToken(Array.isArray(value) ? value[0] : value);
    if (token) return token;
  }
  return '';
}

function coreNectumStyleTemplateFromRequest(details) {
  try {
    if (!details || String(details.method || '').toUpperCase() !== 'POST') return null;
    const url = new URL(String(details.url || ''));
    const expected = new URL(CORENECTUM_STYLE_LIST_API);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) return null;
    const chunks = [];
    for (const part of Array.from(details.uploadData || [])) {
      if (!part || !part.bytes) continue;
      const chunk = Buffer.from(part.bytes);
      if (chunk.length) chunks.push(chunk);
    }
    if (!chunks.length) return null;
    const body = Buffer.concat(chunks);
    if (!body.length || body.length > 256 * 1024) return null;
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

async function pushCoreNectumStyleTemplateToBackend(template) {
  if (!template || !backend || !backend.running || !backend.origin) return false;
  const response = await fetch(backend.origin + '/api/internal/desktop/corenectum-style-template', {
    method:'POST', cache:'no-store',
    headers:{
      'Content-Type':'application/json',
      'X-BuyerLog-Desktop-Bridge':desktopBridgeSecret,
    },
    body:JSON.stringify({ template }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'CoreNectum Style List istek şablonu backend’e aktarılamadı.');
  return true;
}

async function waitForCoreNectumStyleTemplate(timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!coreNectumStyleListTemplate && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return coreNectumStyleListTemplate;
}

const CORENECTUM_STORAGE_PROBE = `(()=>{try{
  const extract=value=>{const text=String(value==null?'':value).trim();if(!text)return '';
    if(/^bearer\\s+/i.test(text))return text.replace(/^bearer\\s+/i,'').trim();
    if(text[0]==='{'){try{const parsed=JSON.parse(text),candidate=parsed&&((parsed.access_token)||(parsed.accessToken));if(typeof candidate==='string'&&candidate.trim())return candidate.trim();}catch(_){}}
    return text;};
  const read=storage=>{if(!storage)return '';for(const key of ['access_token','accessToken']){try{const value=extract(storage.getItem(key));if(value)return value;}catch(_){}}
    try{for(let i=0;i<storage.length;i+=1){const key=String(storage.key(i)||'');if(!/^oidc\\.user:/i.test(key)&&!/(?:^|[._:-])access[_-]?token(?:$|[._:-])/i.test(key))continue;const raw=String(storage.getItem(key)||'').trim();if(!raw)continue;try{const parsed=JSON.parse(raw),candidate=parsed&&((parsed.access_token)||(parsed.accessToken));if(typeof candidate==='string'&&candidate.trim())return candidate.trim();}catch(_){if(!/^oidc\\.user:/i.test(key)){const value=extract(raw);if(value)return value;}}}}catch(_){}return '';};
  return read(typeof localStorage==='undefined'?null:localStorage)||read(typeof sessionStorage==='undefined'?null:sessionStorage)||'';
}catch(_){return '';}})()`;

async function validateCoreNectumToken(token) {
  const usable = usableCoreNectumToken(token);
  if (!usable) return { ok: false, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(CORENECTUM_STYLE_LIST_API, {
      method: 'POST', signal: controller.signal, cache: 'no-store', redirect: 'follow',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Authorization: 'Bearer ' + usable,
        Origin: 'https://corenectum.lcwaikiki.com',
        Referer: 'https://corenectum.lcwaikiki.com/',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pageNumber: 1,
        pageSize: 120,
        filterCriterias: [{ filterColumnName: 'plmCode', filterOperator: 10, filterValue: '999999999999999' }],
        searchCriteria: { columnNames: [], searchText: '' },
        favoriteGroupId: null,
      }),
    });
    return { ok: response.ok, status: response.status };
  } catch (_) {
    return { ok: false, status: 0 };
  } finally { clearTimeout(timer); }
}

async function pushCoreNectumTokenToBackend(token) {
  if (!backend || !backend.running || !backend.origin) throw new Error('Buyer Log backend hazır değil.');
  const response = await fetch(backend.origin + '/api/internal/desktop/corenectum-token', {
    method: 'POST', cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-BuyerLog-Desktop-Bridge': desktopBridgeSecret,
    },
    body: JSON.stringify({ token: usableCoreNectumToken(token) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'CoreNectum oturumu backend\'e aktarılamadı.');
  return data;
}

async function clearCoreNectumBackendToken() {
  if (!backend || !backend.running || !backend.origin) return;
  try {
    await fetch(backend.origin + '/api/internal/desktop/corenectum-token', {
      method: 'DELETE', cache: 'no-store',
      headers: { 'X-BuyerLog-Desktop-Bridge': desktopBridgeSecret },
    });
  } catch (_) {}
}

function coreNectumAuthSession() {
  return session.fromPartition(CORENECTUM_AUTH_PARTITION, { cache: true });
}

function isAllowedCoreNectumAuthUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'corenectum.lcwaikiki.com'
      || host === CORENECTUM_API_HOST
      || host.endsWith('.lcwaikiki.com')
      || host === 'login.microsoftonline.com'
      || host.endsWith('.microsoftonline.com')
      || host.endsWith('.windows.net')
      || host.endsWith('.windowsazure.com')
      || host.endsWith('.msauth.net')
      || host.endsWith('.msftauth.net')
      || host === 'login.live.com'
      || host.endsWith('.microsoft.com');
  } catch (_) { return false; }
}

async function acquireCoreNectumToken(options = {}) {
  if (coreNectumAuthInFlight) return coreNectumAuthInFlight;
  const interactive = options.interactive !== false;
  const request = (async () => {
    const authSession = coreNectumAuthSession();
    let authWindow = null;
    let settled = false;
    let storageTimer = null;
    let timeoutTimer = null;
    let silentTimer = null;
    let candidateBusy = false;

    const cleanup = () => {
      if (storageTimer) clearInterval(storageTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (silentTimer) clearTimeout(silentTimer);
      try { authSession.webRequest.onBeforeRequest({ urls: [CORENECTUM_STYLE_LIST_API] }, null); } catch (_) {}
      try { authSession.webRequest.onBeforeSendHeaders({ urls: ['https://mym-api.lcwaikiki.com/*'] }, null); } catch (_) {}
      if (authWindow && !authWindow.isDestroyed()) { try { authWindow.close(); } catch (_) {} }
      if (coreNectumAuthWindow === authWindow) coreNectumAuthWindow = null;
    };

    const finishWithToken = async (token, source) => {
      if (settled || candidateBusy) return null;
      const usable = usableCoreNectumToken(token);
      if (!usable) return null;
      candidateBusy = true;
      try {
        const valid = await validateCoreNectumToken(usable);
        if (!valid.ok) {
          if (valid.status === 401 || valid.status === 403) return null;
          // Network unavailable: keep the token; the real PLM request will
          // report the network condition accurately later.
        }
        await pushCoreNectumTokenToBackend(usable);
        const template = coreNectumStyleListTemplate || await waitForCoreNectumStyleTemplate(2500);
        if (template) {
          try { await pushCoreNectumStyleTemplateToBackend(template); }
          catch (error) { log('CoreNectum Style List şablonu aktarılamadı: ' + String(error && error.message || error)); }
        }
        settled = true;
        log('CoreNectum otomatik oturumu hazır (' + source + (template ? ', Style List şablonu hazır' : '') + ').');
        cleanup();
        return { ok: true, source: 'desktop-sso', capture: source };
      } finally { candidateBusy = false; }
    };

    return await new Promise((resolve) => {
      const resolveOnce = value => { if (settled && !(value && value.ok)) return; cleanup(); resolve(value); };

      authWindow = new BrowserWindow({
        width: 1120, height: 820, show: false, title: 'Buyer Log · CoreNectum Oturumu',
        parent: activeBuyerLogWindow(options.requestingContents) || undefined,
        autoHideMenuBar: true, backgroundColor: '#ffffff',
        webPreferences: {
          partition: CORENECTUM_AUTH_PARTITION,
          nodeIntegration: false, contextIsolation: true, sandbox: true,
          spellcheck: false,
        },
      });
      coreNectumAuthWindow = authWindow;

      authWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedCoreNectumAuthUrl(url)) {
          setImmediate(() => { if (authWindow && !authWindow.isDestroyed()) authWindow.loadURL(url).catch(() => {}); });
        }
        return { action: 'deny' };
      });
      authWindow.webContents.on('will-navigate', (event, url) => {
        if (isAllowedCoreNectumAuthUrl(url)) return;
        event.preventDefault();
      });
      authWindow.webContents.on('did-navigate', (_event, url) => {
        if (!interactive || settled || authWindow.isVisible()) return;
        try {
          const host = new URL(url).hostname.toLowerCase();
          if (host !== 'corenectum.lcwaikiki.com') { authWindow.show(); authWindow.focus(); }
        } catch (_) {}
      });
      authWindow.on('closed', () => {
        coreNectumAuthWindow = null;
        if (!settled) {
          settled = true;
          resolve({ ok: false, code: 'CORENECTUM_AUTH_CANCELLED', error: 'CoreNectum oturum açma işlemi kapatıldı.' });
        }
      });

      authSession.webRequest.onBeforeRequest({ urls: [CORENECTUM_STYLE_LIST_API] }, (details, callback) => {
        const template = coreNectumStyleTemplateFromRequest(details);
        if (template) coreNectumStyleListTemplate = template;
        callback({});
      });

      authSession.webRequest.onBeforeSendHeaders({ urls: ['https://mym-api.lcwaikiki.com/*'] }, (details, callback) => {
        const token = authorizationTokenFromHeaders(details.requestHeaders);
        callback({ requestHeaders: details.requestHeaders });
        if (!token || settled) return;
        void finishWithToken(token, 'network-header').then(result => { if (result && result.ok) resolve(result); });
      });

      const probeStorage = async () => {
        if (settled || candidateBusy || !authWindow || authWindow.isDestroyed()) return;
        let url = '';
        try { url = authWindow.webContents.getURL(); } catch (_) {}
        if (!/^https:\/\/corenectum\.lcwaikiki\.com\//i.test(url)) return;
        try {
          const token = await authWindow.webContents.executeJavaScript(CORENECTUM_STORAGE_PROBE, true);
          const result = await finishWithToken(token, 'session-storage');
          if (result && result.ok) resolve(result);
        } catch (_) {}
      };
      authWindow.webContents.on('did-finish-load', () => { void probeStorage(); });
      storageTimer = setInterval(() => { void probeStorage(); }, 900);

      silentTimer = setTimeout(() => {
        if (settled || !interactive || !authWindow || authWindow.isDestroyed()) return;
        authWindow.show(); authWindow.focus();
      }, 4500);
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const value = { ok: false, code: interactive ? 'CORENECTUM_AUTH_TIMEOUT' : 'CORENECTUM_SIGNIN_REQUIRED', error: interactive ? 'CoreNectum oturumu zamanında doğrulanamadı.' : 'CoreNectum oturumu gerekli.' };
        cleanup();
        resolve(value);
      }, interactive ? 180000 : 9000);

      authWindow.loadURL(CORENECTUM_HOME).catch(error => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, code: 'CORENECTUM_AUTH_NAVIGATION_FAILED', error: error && error.message ? error.message : 'CoreNectum açılamadı.' });
      });
    });
  })();
  coreNectumAuthInFlight = request;
  try { return await request; }
  finally { if (coreNectumAuthInFlight === request) coreNectumAuthInFlight = null; }
}

async function clearCoreNectumAuthSession() {
  coreNectumStyleListTemplate = null;
  await clearCoreNectumBackendToken();
  try {
    const authSession = coreNectumAuthSession();
    await authSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    await authSession.clearCache();
  } catch (_) {}
  if (coreNectumAuthWindow && !coreNectumAuthWindow.isDestroyed()) coreNectumAuthWindow.close();
  coreNectumAuthWindow = null;
  return { ok: true };
}

/* ---------------------------------------------------------- OAB auto auth */

function oabAuthSession() {
  return session.fromPartition(OAB_AUTH_PARTITION, { cache: true });
}

function isAllowedOabLoginUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === OAB_UI_HOST
      || host === OAB_API_HOST
      || host.endsWith('.lcwaikiki.com')
      || host === 'login.microsoftonline.com'
      || host.endsWith('.microsoftonline.com')
      || host.endsWith('.windows.net')
      || host.endsWith('.windowsazure.com')
      || host.endsWith('.msauth.net')
      || host.endsWith('.msftauth.net')
      || host === 'login.live.com'
      || host.endsWith('.microsoft.com');
  } catch (_) { return false; }
}

function isLikelyOabSignInUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const pathText = `${url.pathname}${url.search}`.toLowerCase();
    if (host === OAB_UI_HOST) return /\/(?:login|signin|auth)(?:\/|$)/i.test(url.pathname);
    const identityHost = /(^|[.-])(keycloak|login|signin|auth|sso|identity|idp|adfs)([.-]|$)/i.test(host);
    if (identityHost) return true;
    return /login|signin|auth|identity|sso|adfs|microsoftonline|oauth|authorize|openid-connect/i.test(`${host}${pathText}`);
  } catch (_) { return false; }
}

async function oabWindowLooksLikeSignIn(authWindow) {
  if (!authWindow || authWindow.isDestroyed()) return true;
  const currentUrl = authWindow.webContents.getURL();
  if (isLikelyOabSignInUrl(currentUrl)) return true;
  try {
    return Boolean(await authWindow.webContents.executeJavaScript(
      `Boolean(document.querySelector('input[type="password"],input[name*="password" i],input[id*="password" i],form[action*="login" i],form[action*="signin" i]'))`,
      true,
    ));
  } catch (_) { return false; }
}

/* Electron loadURL() may reject with ERR_ABORTED (-3) while an SSO redirect is
 * actually continuing successfully. PASS performs exactly this kind of redirect.
 * Treating -3 as a hard failure used to close the OAB window before the user ever
 * saw the corporate sign-in page. Real main-frame navigation failures still fail. */
function isBenignOabNavigationAbort(error) {
  const code = Number(error && (error.errno ?? error.code));
  const text = String(error && (error.code || error.message) || '');
  return code === -3 || /ERR_ABORTED/i.test(text);
}

async function pushOabAuthorizationToBackend(authorization) {
  if (!backend || !backend.running || !backend.origin) throw Object.assign(new Error('Buyer Log backend hazır değil.'), { code:'OAB_BACKEND_NOT_READY' });
  const response = await fetch(backend.origin + '/api/internal/desktop/oab-authorization', {
    method: 'POST', cache: 'no-store', redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-BuyerLog-Desktop-Bridge': desktopBridgeSecret,
    },
    body: JSON.stringify({ authorization }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || 'OAB yetkilendirmesi doğrulanamadı.');
    error.code = data.code || 'OAB_AUTH_FAILED';
    throw error;
  }
  return data;
}

async function clearOabBackendAuthorization() {
  if (!backend || !backend.running || !backend.origin) return;
  try {
    await fetch(backend.origin + '/api/internal/desktop/oab-authorization', {
      method: 'DELETE', cache: 'no-store', redirect: 'error',
      headers: { 'X-BuyerLog-Desktop-Bridge': desktopBridgeSecret },
    });
  } catch (_) {}
}

function oabAuthSelectionValue(value) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '').trim().slice(0, 200);
}

function oabViewerUrl(options = {}) {
  const url = new URL(OAB_VIEWER_URL);
  const seasonRef = oabAuthSelectionValue(options.seasonRef);
  const merchSubGroupRef = oabAuthSelectionValue(options.merchSubGroupRef);
  const buyerGroupRef = oabAuthSelectionValue(options.buyerGroupRef);
  if (seasonRef) url.searchParams.set('SeasonRef', seasonRef);
  if (merchSubGroupRef) url.searchParams.set('MerchSubGroupRef', merchSubGroupRef);
  if (buyerGroupRef) url.searchParams.set('BuyerGroupRefs', buyerGroupRef);
  return url.toString();
}

async function acquireOabAuthorization(options = {}) {
  const requestedInteractive = options.interactive !== false;
  const forceFresh = options.forceFresh === true;
  const requestedViewerUrl = oabViewerUrl(options);

  if (oabAuthInFlight) {
    if (requestedInteractive) {
      if (oabAuthFlowState) {
        oabAuthFlowState.interactive = true;
        oabAuthFlowState.viewerUrl = requestedViewerUrl;
        try { oabAuthFlowState.promoteInteractive?.({ immediate:true, reason:'interactive-join' }); } catch (_) {}
      } else if (oabAuthWindow && !oabAuthWindow.isDestroyed()) {
        try { oabAuthWindow.show(); oabAuthWindow.focus(); } catch (_) {}
      }
    }
    return oabAuthInFlight;
  }

  const flowState = {
    interactive: requestedInteractive,
    viewerUrl: requestedViewerUrl,
    promoteInteractive: null,
  };
  oabAuthFlowState = flowState;

  const request = (async () => {
    let authWindow = null;
    let settled = false;
    let timeoutTimer = null;
    let silentProbeTimer = null;
    let lifecycleTimer = null;
    let lifecycle = null;
    let resolvePromise = null;
    let fallbackTried = false;
    let navigationBusy = false;
    let freshReloadPending = false;
    let loginRequiredKnown = false;
    let networkCaptureInstalled = false;
    let authWebRequest = null;
    let networkReady = null;
    const popupWindows = new Set();

    const targetViewerUrl = () => flowState.viewerUrl || OAB_VIEWER_URL;

    const clearSilentProbe = () => {
      if (silentProbeTimer) { clearTimeout(silentProbeTimer); silentProbeTimer = null; }
    };
    const cleanupCapture = () => {
      if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
      if (lifecycle) lifecycle.stop();
      if (authWebRequest && networkCaptureInstalled) {
        try { authWebRequest.onBeforeSendHeaders(null); } catch (_) {}
      }
      networkCaptureInstalled = false;
      authWebRequest = null;
    };
    const cleanup = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      clearSilentProbe();
      cleanupCapture();
      for (const popup of popupWindows) {
        if (popup && !popup.isDestroyed()) { try { popup.close(); } catch (_) {} }
      }
      popupWindows.clear();
      if (authWindow && !authWindow.isDestroyed()) { try { authWindow.close(); } catch (_) {} }
      if (oabAuthWindow === authWindow) oabAuthWindow = null;
    };
    const finishAuthorization = async authorization => {
      if (settled || !authorization) return false;
      try {
        const pushed = await pushOabAuthorizationToBackend(authorization);
        if (!pushed || !pushed.ok) return false;
        settled = true;
        log('OAB otomatik oturumu hazır (report API Authorization doğrulandı).');
        cleanup();
        if (resolvePromise) resolvePromise({ ok:true, authenticated:true, source:'desktop-oab-sso' });
        return true;
      } catch (error) {
        // A rejected report token must not leave an older backend RAM token
        // looking authenticated while the persistent browser recovers.
        await clearOabBackendAuthorization();
        log('OAB oturum adayı doğrulanamadı: ' + (error && error.code || 'OAB_AUTH_FAILED'));
        return false;
      }
    };

    return await new Promise(resolve => {
      resolvePromise = resolve;

      const finishFailure = (code, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok:false, authenticated:false, code, error });
      };
      const showWindow = target => {
        if (!flowState.interactive || settled || !target || target.isDestroyed()) return false;
        try {
          target.show();
          target.focus();
          return true;
        } catch (_) {
          return false;
        }
      };
      const showInteractiveWindow = () => showWindow(authWindow);
      const resetOabBrowserAuthState = async reason => {
        await clearOabBackendAuthorization();
        try {
          const authSession = oabAuthSession();
          await authSession.clearStorageData({ storages:['cookies','localstorage','indexdb','serviceworkers','cachestorage'] });
          await authSession.clearCache();
        } catch (_) {}
        lifecycle?.resetForFreshViewer?.();
        log('OAB tarayıcı oturumu yeni kullanıcı girişi için sıfırlandı (' + String(reason || 'interactive') + ').');
      };
      const armHardTimeout = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const interactiveNow = flowState.interactive;
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          finishFailure(
            interactiveNow ? 'OAB_AUTH_TIMEOUT' : 'OAB_AUTH_REQUIRED',
            interactiveNow ? 'OAB oturum açma işlemi zamanında tamamlanmadı.' : 'OAB oturumu gerekli.',
          );
        }, interactiveNow ? 180000 : 12000);
        timeoutTimer.unref?.();
      };
      const promoteInteractive = ({ immediate = true } = {}) => {
        flowState.interactive = true;
        clearSilentProbe();
        armHardTimeout();
        if (immediate || loginRequiredKnown) showInteractiveWindow();
      };
      flowState.promoteInteractive = promoteInteractive;

      const loadLoginTarget = async (url, allowFallback = true) => {
        if (settled || navigationBusy || !authWindow || authWindow.isDestroyed()) return false;
        navigationBusy = true;
        try {
          await authWindow.loadURL(url);
          return true;
        } catch (error) {
          if (isBenignOabNavigationAbort(error)) {
            log('OAB SSO yönlendirmesi devam ediyor (ERR_ABORTED göz ardı edildi).');
            return true;
          }
          if (allowFallback && !fallbackTried) {
            fallbackTried = true;
            log('OAB viewer doğrudan açılamadı; PASS ana sayfası deneniyor.');
            try {
              await authWindow.loadURL(OAB_HOME_URL);
              return true;
            } catch (fallbackError) {
              if (isBenignOabNavigationAbort(fallbackError)) {
                log('OAB PASS SSO yönlendirmesi devam ediyor (fallback ERR_ABORTED göz ardı edildi).');
                return true;
              }
            }
          }
          finishFailure('OAB_AUTH_NAVIGATION_FAILED', 'OAB giriş ekranı açılamadı.');
          return false;
        } finally {
          navigationBusy = false;
          if (freshReloadPending && !settled) {
            freshReloadPending = false;
            setImmediate(() => { if (!settled) void loadLoginTarget(targetViewerUrl(), false); });
          }
        }
      };
      const markLoginRequired = (url, target = authWindow) => {
        if (!isLikelyOabSignInUrl(url)) return false;
        loginRequiredKnown = true;
        clearSilentProbe();
        if (lifecycle) void lifecycle.observe({ url, signIn:true });
        showWindow(target);
        return true;
      };
      const pulseLifecycle = async () => {
        if (settled || !lifecycle || !authWindow || authWindow.isDestroyed()) return;
        let url = '';
        try { url = authWindow.webContents.getURL(); } catch (_) { return; }
        const signIn = await oabWindowLooksLikeSignIn(authWindow);
        if (signIn) {
          markLoginRequired(url, authWindow);
          return;
        }
        await lifecycle.observe({ url, signIn:false });
      };
      const recoverStaleSilentProbe = async () => {
        if (settled || !flowState.interactive || forceFresh || loginRequiredKnown) return;
        const state = lifecycle && lifecycle.snapshot();
        if (state && state.candidateBusy) {
          silentProbeTimer = setTimeout(() => { void recoverStaleSilentProbe(); }, 1000);
          silentProbeTimer.unref?.();
          return;
        }

        // A slow PASS viewer must never be interpreted as a reason to delete the
        // persistent corporate session. Keep persist:oab intact, discard only a
        // stale backend RAM token, reveal the current page and let the bounded
        // viewer lifecycle retry once if authenticated API traffic is still absent.
        log('OAB sessiz oturum kontrolü sonuçlanmadı; mevcut kalıcı OAB oturumu korunarak görünür akışa geçiliyor.');
        await clearOabBackendAuthorization();
        lifecycle?.resetForFreshViewer?.();
        showInteractiveWindow();

        let currentUrl = '';
        try { currentUrl = authWindow.webContents.getURL(); } catch (_) {}
        if (currentUrl && isAllowedOabLoginUrl(currentUrl) && !isLikelyOabSignInUrl(currentUrl)) {
          schedulePulse(80);
          return;
        }
        if (navigationBusy) {
          freshReloadPending = true;
          try { authWindow.webContents.stop(); } catch (_) {}
          return;
        }
        await loadLoginTarget(targetViewerUrl(), false);
      };
      const armSilentProbe = () => {
        if (!flowState.interactive || forceFresh || settled || loginRequiredKnown || silentProbeTimer) return;
        silentProbeTimer = setTimeout(() => {
          silentProbeTimer = null;
          void recoverStaleSilentProbe();
        }, OAB_SILENT_PROBE_MS);
        silentProbeTimer.unref?.();
      };

      authWindow = new BrowserWindow({
        width: 1120, height: 820, show: false,
        title: 'OAB Kullanıcı Girişi',
        parent: activeBuyerLogWindow(options.requestingContents) || undefined,
        autoHideMenuBar: true, backgroundColor: '#ffffff',
        webPreferences: {
          partition: OAB_AUTH_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: false,
        },
      });
      oabAuthWindow = authWindow;

      lifecycle = createOabAuthLifecycle({
        apiHost: OAB_API_HOST,
        uiHost: OAB_UI_HOST,
        maxViewerKicks: 2,
        viewerKickIntervalMs: 6000,
        viewerSettleMs: 12000,
        onViewerKick: async ({ attempt, reason }) => {
          if (settled || navigationBusy || !authWindow || authWindow.isDestroyed()) return false;
          log('OAB viewer report isteği yeniden tetikleniyor (' + reason + ', ' + attempt + '/2).');
          return loadLoginTarget(targetViewerUrl(), false);
        },
        onAuthorization: finishAuthorization,
        onPhase: phase => {
          if (phase !== 'waiting-report-request') log('OAB auth aşaması: ' + phase);
          if (phase === 'login-required') {
            loginRequiredKnown = true;
            clearSilentProbe();
            showInteractiveWindow();
          }
        },
      });

      /*
       * Authorization is observed only inside the dedicated persist:oab
       * Electron session. webRequest is installed before the first viewer
       * navigation, so no external browser, debugging port or DevTools
       * protocol connection is involved.
       */
      try {
        authWebRequest = oabAuthSession().webRequest;
        authWebRequest.onBeforeSendHeaders(OAB_AUTH_CAPTURE_FILTER, (details, callback) => {
          if (!settled && lifecycle) void lifecycle.onNetworkRequest(details);
          callback({ requestHeaders: details.requestHeaders });
        });
        networkCaptureInstalled = true;
        networkReady = Promise.resolve(true);
      } catch (error) {
        finishFailure('OAB_AUTH_CAPTURE_UNAVAILABLE', 'OAB ağ isteği yakalama başlatılamadı.');
        return;
      }

      authWindow.once('ready-to-show', () => {
        // Do not reveal the PASS viewer shell merely because the user selected
        // "OAB Kullanıcı Girişi". The actual sign-in surface can be a child
        // SSO window; showing this parent early is what produced the blank page.
        if (loginRequiredKnown) showInteractiveWindow();
      });

      const schedulePulse = delay => {
        const timer = setTimeout(() => { void pulseLifecycle(); }, Math.max(0, Number(delay) || 0));
        timer.unref?.();
      };
      const handleAllowedMainFrameNavigation = url => {
        if (!isAllowedOabLoginUrl(url)) return;
        if (markLoginRequired(url, authWindow)) return;
        schedulePulse(80);
      };

      authWindow.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
        if (!isMainFrame) return;
        handleAllowedMainFrameNavigation(url);
      });
      authWindow.webContents.on('will-redirect', (_event, url, _inPlace, isMainFrame) => {
        if (!isMainFrame) return;
        handleAllowedMainFrameNavigation(url);
      });
      authWindow.webContents.on('did-navigate', (_event, url) => handleAllowedMainFrameNavigation(url));
      authWindow.webContents.on('did-finish-load', () => schedulePulse(60));
      authWindow.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (isMainFrame === false) return;
        handleAllowedMainFrameNavigation(url);
      });
      authWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _validatedURL, isMainFrame) => {
        if (!isMainFrame || settled || Number(errorCode) === -3) return;
        log('OAB giriş sayfası main-frame yükleme hatası: ' + Number(errorCode));
        finishFailure('OAB_AUTH_NAVIGATION_FAILED', 'OAB giriş ekranı yüklenemedi.');
      });
      authWindow.webContents.on('render-process-gone', (_event, details) => {
        if (settled) return;
        log('OAB giriş renderer süreci kapandı: ' + String(details && details.reason || 'unknown'));
        finishFailure('OAB_AUTH_RENDERER_FAILED', 'OAB giriş ekranı çalıştırılamadı.');
      });
      authWindow.webContents.on('page-title-updated', event => {
        event.preventDefault();
        if (!authWindow.isDestroyed()) authWindow.setTitle('OAB Kullanıcı Girişi');
      });
      authWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url !== 'about:blank' && !isAllowedOabLoginUrl(url)) return { action:'deny' };
        if (url !== 'about:blank' && isLikelyOabSignInUrl(url)) {
          loginRequiredKnown = true;
          clearSilentProbe();
          if (lifecycle) void lifecycle.observe({ url, signIn:true });
          // The popup itself is revealed in did-create-window. Showing the
          // parent here exposes an empty PASS shell before Electron gives us
          // the child BrowserWindow.
        }
        return {
          action:'allow',
          overrideBrowserWindowOptions: {
            show:false,
            parent:authWindow,
            autoHideMenuBar:true,
            backgroundColor:'#ffffff',
            webPreferences: {
              partition: OAB_AUTH_PARTITION,
              nodeIntegration:false,
              contextIsolation:true,
              sandbox:true,
              spellcheck:false,
            },
          },
        };
      });
      authWindow.webContents.on('did-create-window', popup => {
        popupWindows.add(popup);
        try { popup.setMenu(null); } catch (_) {}

        const handlePopupNavigation = url => {
          if (!isAllowedOabLoginUrl(url)) return;
          if (markLoginRequired(url, popup)) return;
          if (loginRequiredKnown) showWindow(popup);
        };

        popup.webContents.on('will-navigate', (event, url) => {
          if (url === 'about:blank' || isAllowedOabLoginUrl(url)) {
            if (url !== 'about:blank') handlePopupNavigation(url);
            return;
          }
          event.preventDefault();
          try { popup.close(); } catch (_) {}
        });
        popup.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
          if (!isMainFrame) return;
          handlePopupNavigation(url);
        });
        popup.webContents.on('will-redirect', (_event, url, _inPlace, isMainFrame) => {
          if (!isMainFrame) return;
          handlePopupNavigation(url);
        });
        popup.webContents.on('did-navigate', (_event, url) => handlePopupNavigation(url));
        popup.once('ready-to-show', () => {
          let url = '';
          try { url = popup.webContents.getURL(); } catch (_) {}
          // Microsoft/Keycloak can create an about:blank child and populate or
          // redirect it afterwards. For a user-triggered interactive auth flow,
          // the child is the usable sign-in surface and must never stay hidden.
          if (flowState.interactive || loginRequiredKnown || isLikelyOabSignInUrl(url)) showWindow(popup);
        });
        popup.webContents.on('did-finish-load', () => {
          if (flowState.interactive && !settled) showWindow(popup);
        });
        popup.webContents.on('did-fail-load', (_event, errorCode, _description, _validatedURL, isMainFrame) => {
          if (!isMainFrame || settled || Number(errorCode) === -3) return;
          log('OAB SSO penceresi yükleme hatası: ' + Number(errorCode));
          finishFailure('OAB_AUTH_NAVIGATION_FAILED', 'OAB kurumsal giriş ekranı yüklenemedi.');
        });
        popup.on('closed', () => {
          popupWindows.delete(popup);
          if (!settled) setImmediate(() => { void loadLoginTarget(targetViewerUrl(), false); });
        });

        let currentPopupUrl = '';
        try { currentPopupUrl = popup.webContents.getURL(); } catch (_) {}
        if (currentPopupUrl && currentPopupUrl !== 'about:blank') handlePopupNavigation(currentPopupUrl);
      });
      authWindow.webContents.on('will-navigate', (event, url) => {
        if (isAllowedOabLoginUrl(url)) {
          markLoginRequired(url, authWindow);
          return;
        }
        event.preventDefault();
      });
      authWindow.on('closed', () => {
        oabAuthWindow = null;
        clearSilentProbe();
        cleanupCapture();
        for (const popup of popupWindows) {
          if (popup && !popup.isDestroyed()) { try { popup.close(); } catch (_) {} }
        }
        popupWindows.clear();
        if (!settled) {
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve({ ok:false, authenticated:false, code:'OAB_AUTH_CANCELLED', error:'OAB kullanıcı girişi iptal edildi.' });
        }
      });

      lifecycleTimer = setInterval(() => { void pulseLifecycle(); }, 500);
      lifecycleTimer.unref?.();
      armHardTimeout();

      void Promise.resolve(networkReady)
        .then(async () => {
          if (settled) return false;
          // Normal interactive authentication always reuses persist:oab.
          // A destructive browser-session reset is reserved for an explicit
          // forceFresh request; the ordinary user-menu action and Get OAB must
          // see exactly the same corporate session.
          if (forceFresh) await resetOabBrowserAuthState('force-fresh-login');
          if (settled) return false;
          armSilentProbe();
          return loadLoginTarget(targetViewerUrl(), true);
        })
        .catch(() => {
          if (!settled) finishFailure('OAB_AUTH_CAPTURE_UNAVAILABLE', 'OAB ağ isteği yakalama başlatılamadı.');
        });
    });
  })();

  oabAuthInFlight = request;
  try {
    return await request;
  } finally {
    if (oabAuthInFlight === request) oabAuthInFlight = null;
    if (oabAuthFlowState === flowState) oabAuthFlowState = null;
  }
}

async function clearOabAuthSession() {
  const pending = oabAuthInFlight;
  if (oabAuthWindow && !oabAuthWindow.isDestroyed()) {
    try { oabAuthWindow.close(); } catch (_) {}
  }
  if (pending) {
    await Promise.race([
      Promise.resolve(pending).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
  }

  await clearOabBackendAuthorization();
  try {
    const authSession = oabAuthSession();
    await authSession.clearStorageData({ storages:['cookies','localstorage','indexdb','serviceworkers','cachestorage'] });
    await authSession.clearCache();
  } catch (_) {}
  oabAuthWindow = null;
  return { ok:true, authenticated:false };
}

/* ------------------------------------------------------------- pencereler */

function createMainWindow(origin) {
  workspace = createWorkspaceManager({
    BrowserWindow,
    WebContentsView,
    dialog,
    screen,
    path,
    crypto,
    origin,
    nativeTheme,
    shellFile: path.join(__dirname, 'workspace.html'),
    shellPreload: path.join(__dirname, 'workspace-preload.js'),
    contentPreload: path.join(__dirname, 'preload.js'),
    iconPath: path.join(APP_CORE_ROOT, 'buyerlog.ico'),
    loadWindowState,
    saveWindowState,
    applyNavigationPolicy,
    log,
    onFirstRendererReady: () => {
      try {
        if (typeof global.__buyerLogLauncherHealthReady === 'function') {
          global.__buyerLogLauncherHealthReady({
            version: appVersion(),
            backendReady: Boolean(backend && backend.running),
            localDbPath: paths && paths.localDbPath || '',
            localDbReady: Boolean(paths && paths.localDbPath && fs.existsSync(paths.localDbPath)),
            rendererReady: true,
          });
        }
      } catch (error) { log('Updater health ready bildirimi başarısız: ' + error.message); }
    },
  });
  log('Çoklu sekme çalışma alanı yükleniyor: ' + origin);
  const state = workspace.createWindow({ module: 'overview' });
  mainWindow = state.window; // eski hata/teşhis yolları için ilk pencere başvurusu
  return mainWindow;
}

/*
 * BAŞLATMA HATASI EKRANI (§4). CMD penceresi artık yok; yığın izi göstermek
 * yerine kullanıcının yapabileceği üç şey sunulur: Tekrar Dene, Teşhis, Çıkış.
 */
function showStartupError(detail) {
  startupFailure = detail;
  log('BAŞLATMA HATASI: ' + detail.message);
  if (errorWindow && !errorWindow.isDestroyed()) { errorWindow.focus(); return; }
  errorWindow = new BrowserWindow({
    width: 720, height: 560, show: false, title: 'Buyer Log', resizable: true,
    icon: path.join(APP_CORE_ROOT, 'buyerlog.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  errorWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  errorWindow.once('ready-to-show', () => errorWindow.show());
  errorWindow.on('closed', () => { errorWindow = null; });
  errorWindow.loadFile(path.join(__dirname, 'startup-error.html'));
}

function closeErrorWindow() {
  if (errorWindow && !errorWindow.isDestroyed()) errorWindow.close();
  errorWindow = null;
  startupFailure = null;
}

/*
 * Backend AÇILDIKTAN SONRA öldüyse. Gözetmen normal çökmeleri kendi
 * toparlıyor (server/watchdog.js); buraya düşmek, gözetmenin de pes ettiği
 * anlamına gelir. O noktada pencere hâlâ açıktır ama arkasında sunucu yoktur:
 * kullanıcı tıklar, hiçbir şey olmaz. Sessiz kalmak yerine ne olduğu söylenir.
 */
function handleBackendLoss() {
  const parent = activeBuyerLogWindow();
  if (quitting || !parent || parent.isDestroyed()) return;
  dialog.showMessageBox(parent, {
    type: 'error',
    title: 'Buyer Log',
    message: 'Buyer Log sunucusu durdu.',
    detail: 'Sunucu beklenmedik şekilde kapandı ve kendiliğinden toparlanamadı. '
      + 'Kaydedilmemiş ekran değişiklikleri gönderilemeyebilir.\n\nGünlük: '
      + path.join(paths.logsRoot, 'backend.log'),
    buttons: ['Yeniden Başlat', 'Kapat'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then(async result => {
    if (result.response !== 0) return;
    restarting = true;
    try {
      if (backend) { try { await backend.stop(); } catch (_) {} backend = null; }
      if (workspace) { workspace.destroyAllWindows(); workspace = null; }
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      mainWindow = null;
      await startBuyerLog();
    } finally { restarting = false; }
  }).catch(error => log('Sunucu kaybı iletişim kutusu gösterilemedi: ' + error.message));
}

/* ------------------------------------------------------------ başlatma akışı */

async function startBuyerLog() {
  lastStartedAt = Date.now();
  try {
    ensureDataTree(paths);
  } catch (error) {
    showStartupError({
      message: 'Veri klasörü oluşturulamadı.',
      detail: paths.dataRoot + '\n' + error.message,
      hint: 'Buyer Log klasörünü YAZILABİLİR bir yere taşıyın (örn. C:\\BuyerLog). Program Files ve salt okunur ağ klasörleri çalışmaz.',
    });
    return false;
  }

  const migration = await runFirstRunMigration({ paths, appCoreRoot: APP_CORE_ROOT, log });
  if (migration.state === 'failed') {
    showStartupError({
      message: 'Eski Buyer Log verisi taşınamadı.',
      detail: (migration.detail && migration.detail.reason) || 'Bilinmeyen taşıma hatası.',
      hint: 'ESKİ KURULUMUNUZA DOKUNULMADI; olduğu gibi çalışmaya devam ediyor. '
        + 'Yarım kalan kopya data\\.staging klasöründe bekletiliyor ve silinmedi. '
        + 'Tekrar Dene ile yeniden deneyebilir, Teşhis ile ayrıntıyı görebilirsiniz.',
      migration: migration.detail,
    });
    return false;
  }

  /*
   * Taşıma yalnız bir kez çalışır; klasör `data/` ile kopyalanırsa atlanır ve
   * eski bilgisayara ait mutlak localDbPath geride kalır. Bu, her açılışta
   * çalışan emniyet ağıdır — yalnız dış yol MEVCUT DEĞİLKEN düzeltir, yani
   * hiçbir koşulda var olan veriden uzaklaşmaz.
   */
  try { healPortableSettings(paths, log); }
  catch (error) { log('UYARI: ayar onarımı atlandı: ' + error.message); }

  /*
   * Portu başkası tutuyorsa SESSİZCE ONA BAĞLANMA (bkz. backend.js →
   * probeOrigin). Bu kontrol sunucu başlatılmadan önce yapılır.
   */
  const address = resolveAppUrl(readJson(paths.configPath, {}));
  const probe = await probeOrigin(address.origin);
  if (probe.occupied) {
    showStartupError({
      message: 'Bu bilgisayarda Buyer Log zaten çalışıyor.',
      detail: address.origin + ' adresini başka bir Buyer Log kopyası kullanıyor (HTTP ' + probe.status + ').',
      hint: 'Masaüstü sürümü, kendi verisi yerine o kopyanın verisini göstermemek için açılmadı. '
        + 'Çalışan kopyayı buradan kapatabilirsiniz; kapanınca Buyer Log kendiliğinden açılır.',
      kind: 'port-occupied',
      origin: address.origin,
      port: address.port,
    });
    return false;
  }

  backend = new BackendProcess({
    paths,
    appCoreRoot: APP_CORE_ROOT,
    desktopBridgeSecret,
    log,
    onUnexpectedExit: info => {
      if (quitting) return;
      log('Backend beklenmedik şekilde kapandı: ' + JSON.stringify(info));
      handleBackendLoss();
    },
  });

  let bound;
  try {
    bound = backend.start();
  } catch (error) {
    showStartupError({
      message: 'Buyer Log sunucusu başlatılamadı.',
      detail: error.message,
      hint: 'Paket eksik kopyalanmış olabilir. Klasörün tamamını yeniden çıkarın.',
    });
    return false;
  }

  log('Sunucunun hazır olması bekleniyor: ' + bound.origin);
  const ready = await backend.waitUntilReady();
  if (!ready.ready) {
    const exit = backend.lastExit;
    showStartupError({
      message: 'Buyer Log sunucusu yanıt vermedi.',
      detail: 'Adres: ' + bound.origin
        + (exit ? '\nSunucu çıkış kodu: ' + exit.code + (exit.signal ? ' / ' + exit.signal : '') : '\nZaman aşımı.'),
      hint: 'Ayrıntılı sunucu günlüğü: ' + path.join(paths.logsRoot, 'backend.log')
        + '\nBaşka bir Buyer Log kopyası ' + address.port + ' portunu kullanıyor olabilir.',
    });
    await backend.stop();
    backend = null;
    return false;
  }

  log('Sunucu hazır (HTTP ' + ready.status + '). Pencere açılıyor.');
  closeErrorWindow();
  createMainWindow(bound.origin);
  return true;
}

/* --------------------------------------------------------------- kapanış */

async function shutdown() {
  log('Buyer Log kapatılıyor.');
  if (updateStartupTimer) { clearTimeout(updateStartupTimer); updateStartupTimer = null; }
  if (updatePeriodicTimer) { clearInterval(updatePeriodicTimer); updatePeriodicTimer = null; }
  try { saveWindowState(); } catch (_) {}
  // Backend Authorization is process memory and may be cleared. The dedicated
  // OAB browser partition is deliberately preserved across normal restarts.
  try { await clearOabBackendAuthorization(); } catch (_) {}
  if (backend) {
    try { await backend.stop(); } catch (error) { log('Backend durdurulurken hata: ' + error.message); }
    backend = null;
  }
  log('Kapanış tamamlandı.');
  await new Promise(resolve => {
    if (!logStream) { resolve(); return; }
    logStream.end(resolve);
    logStream = null;
  });
}

/* ------------------------------------------------------------------- IPC */

function diagnostics() {
  const address = resolveAppUrl(readJson(paths.configPath, {}));
  const migration = readMigrationState(paths);
  let dbBytes = 0;
  try { dbBytes = fs.statSync(paths.localDbPath).size; } catch (_) { dbBytes = 0; }
  let electronProcesses = [];
  try {
    electronProcesses = app.getAppMetrics().map(metric => ({
      pid: Number(metric && metric.pid) || 0,
      type: String(metric && metric.type || 'Unknown'),
      cpuPercent: Number(metric && metric.cpu && metric.cpu.percentCPUUsage) || 0,
      idleWakeupsPerSecond: Number(metric && metric.cpu && metric.cpu.idleWakeupsPerSecond) || 0,
      memoryWorkingSetKb: Number(metric && metric.memory && metric.memory.workingSetSize) || 0,
      memoryPeakWorkingSetKb: Number(metric && metric.memory && metric.memory.peakWorkingSetSize) || 0,
      memoryPrivateKb: Number(metric && metric.memory && metric.memory.privateBytes) || 0,
    }));
  } catch (_) {
    electronProcesses = [];
  }
  return {
    /* Kimlik bilgisi, oturum anahtarı veya token BURAYA KOYULMAZ. */
    buyerLogVersion: appVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform + ' ' + process.arch,
    portableRoot: paths.portableRoot,
    dataRoot: paths.dataRoot,
    appCoreRoot: APP_CORE_ROOT,
    configPath: paths.configPath,
    backendRunning: Boolean(backend && backend.running),
    backendPid: backend ? backend.pid : 0,
    backendOrigin: backend && backend.origin ? backend.origin : address.origin,
    backendPort: backend && backend.port ? backend.port : address.port,
    localDbPath: paths.localDbPath,
    localDbBytes: dbBytes,
    logsRoot: paths.logsRoot,
    desktopLog: paths.desktopLogPath,
    backendLog: path.join(paths.logsRoot, 'backend.log'),
    migrationVersion: migration ? migration.schemaVersion : null,
    migrationState: migration ? migration.state : 'not-run',
    migrationReason: migration ? (migration.reason || '') : '',
    startupFailure: startupFailure ? {
      message: startupFailure.message, detail: startupFailure.detail, hint: startupFailure.hint,
      kind: startupFailure.kind || '',
    } : null,
    uptimeSeconds: lastStartedAt ? Math.round((Date.now() - lastStartedAt) / 1000) : 0,
    electronProcesses,
    workspace: workspace && typeof workspace.diagnosticsSnapshot === 'function'
      ? workspace.diagnosticsSnapshot()
      : null,
    updater: updater ? updater.status(updaterBaseConfig()) : null,
    activeAppCoreRoot: APP_CORE_ROOT,
    bootstrapAppCoreRoot: String(process.env.BUYER_LOG_BOOTSTRAP_APP_CORE || ''),
  };
}

function trustedBuyerLogIpcSender(event) {
  if (!event || !event.sender || event.sender.isDestroyed()) return false;
  if (workspace && !workspace.tabForContents(event.sender)) return false;
  if (!workspace && (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents)) return false;
  try {
    const source = new URL(String(event.senderFrame && event.senderFrame.url || event.sender.getURL() || ''));
    const expected = new URL(String(backend && backend.origin || resolveAppUrl(readJson(paths.configPath, {})).origin));
    return source.origin === expected.origin;
  } catch (_) { return false; }
}

function registerIpc() {
  ipcMain.handle('buyerlog:workspace-snapshot', event => {
    if (!workspace || !workspace.windowForShellContents(event.sender)) return null;
    return workspace.shellSnapshot(event);
  });
  ipcMain.handle('buyerlog:workspace-show-module-menu', event => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    if (!state) return false;
    const openModules = new Set(workspace.snapshot(state).tabs.map(tab => tab.module));
    const template = Object.entries(workspace.MODULES).map(([moduleId, labels]) => ({
      label: labels.tr,
      type: 'checkbox',
      checked: openModules.has(moduleId),
      click: () => workspace.openModule(state.window.id, moduleId),
    }));
    Menu.buildFromTemplate(template).popup({ window:state.window });
    return true;
  });
  ipcMain.handle('buyerlog:workspace-activate', (event, tabId) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    return Boolean(state && workspace.activateTab(state.window.id, tabId));
  });
  ipcMain.handle('buyerlog:workspace-open-module', (event, moduleId) => {
    if (!workspace || !trustedBuyerLogIpcSender(event)) return null;
    const shellState = workspace.windowForShellContents(event.sender);
    const contentWindow = workspace.windowForContents(event.sender);
    const targetState = shellState || (contentWindow ? workspace.stateForWindow(contentWindow.id) : null);
    if (!targetState || !targetState.window || targetState.window.isDestroyed()) return null;
    const tab = workspace.openModule(targetState.window.id, moduleId, { forceNew:true });
    return tab ? { ok:true, tabId:tab.id, module:tab.module } : null;
  });
  ipcMain.handle('buyerlog:workspace-show-module-context-menu', (event, payload = {}) => {
    if (!workspace || !trustedBuyerLogIpcSender(event)) return false;
    const contentWindow = workspace.windowForContents(event.sender);
    const targetState = contentWindow ? workspace.stateForWindow(contentWindow.id) : null;
    if (!targetState || !targetState.window || targetState.window.isDestroyed()) return false;
    const moduleId = String(payload.moduleId || '');
    const language = String(payload.language || '').toLowerCase() === 'en' ? 'en' : 'tr';
    const template = [{
      label: language === 'en' ? 'Open in new tab' : 'Yeni sekmede aç',
      click: () => workspace.openModule(targetState.window.id, moduleId, { forceNew:true }),
    }];
    Menu.buildFromTemplate(template).popup({ window:targetState.window });
    return true;
  });
  ipcMain.handle('buyerlog:workspace-set-module', (event, moduleId) => {
    if (!workspace || !trustedBuyerLogIpcSender(event)) return false;
    return workspace.updateTabModule(event.sender, moduleId);
  });
  ipcMain.handle('buyerlog:workspace-theme', (event, theme) => {
    if (!workspace || !trustedBuyerLogIpcSender(event)) return false;
    return workspace.setTheme(theme);
  });
  ipcMain.handle('buyerlog:workspace-move-tab', (event, payload = {}) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    return Boolean(state && workspace.moveTab(payload.tabId, state.window.id, payload.index));
  });
  ipcMain.handle('buyerlog:workspace-receive-tab', (event, payload = {}) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    return Boolean(state && workspace.moveTab(payload.tabId, state.window.id, payload.index));
  });
  ipcMain.handle('buyerlog:workspace-detach-tab', (event, payload = {}) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    if (!state || state.window.id !== Number(payload.sourceWindowId)) return false;
    return workspace.detachTab(payload.tabId, state.window.id, payload.point || {});
  });
  ipcMain.handle('buyerlog:workspace-finish-tab-drag', (event, payload = {}) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    if (!state || state.window.id !== Number(payload.sourceWindowId)) return false;
    return workspace.finishTabDrag(payload.tabId, state.window.id, payload.point || {});
  });
  ipcMain.handle('buyerlog:workspace-reattach-tab', (event, payload = {}) => {
    const state = workspace && workspace.windowForShellContents(event.sender);
    if (!state || state.window.id !== Number(payload.sourceWindowId)) return false;
    return workspace.reattachTab(payload.tabId, state.window.id);
  });
  ipcMain.handle('buyerlog:workspace-close-tab', async (event, tabId) => {
    const activeWorkspace = workspace;
    const state = activeWorkspace && activeWorkspace.windowForShellContents(event.sender);
    const requested = state && state.tabs.includes(String(tabId || ''));
    return Boolean(requested && await activeWorkspace.closeTab(tabId));
  });

  ipcMain.handle('buyerlog:diagnostics', () => diagnostics());
  ipcMain.handle('buyerlog:startup-failure', () => startupFailure);
  ipcMain.handle('buyerlog:open-logs', () => {
    shell.openPath(paths.logsRoot);
    return true;
  });
  /*
   * "Çalışan Kopyayı Kapat" — hata ekranındaki düğme.
   *
   * Doğrulama ve sonlandırma electron/port-owner.js'te; oradaki kural şudur:
   * yalnız portu GERÇEKTEN tutan, görüntü adı bilinen ve Buyer Log gibi cevap
   * veren süreç kapatılır. Doğrulanamayan hiçbir şeye dokunulmaz.
   *
   * Kapanma başarılıysa açılış kendiliğinden yeniden denenir: kullanıcıdan
   * ikinci bir tıklama beklemek, çözülmüş bir sorunu çözülmemiş göstermek olur.
   */
  ipcMain.handle('buyerlog:inspect-port', async () => {
    const address = resolveAppUrl(readJson(paths.configPath, {}));
    return inspectPortOwner(address.origin, address.port);
  });

  ipcMain.handle('buyerlog:close-other', async () => {
    const address = resolveAppUrl(readJson(paths.configPath, {}));
    const result = await closePortOwner(address.origin, address.port, log);
    if (!result.ok) return { ...result, started: false };
    restarting = true;
    try {
      closeErrorWindow();
      const started = await startBuyerLog();
      return { ...result, started };
    } finally { restarting = false; }
  });

  ipcMain.handle('buyerlog:retry', async () => {
    restarting = true;
    try {
      if (backend) { try { await backend.stop(); } catch (_) {} backend = null; }
      closeErrorWindow();
      return await startBuyerLog();
    } finally { restarting = false; }
  });
  ipcMain.handle('buyerlog:quit', () => { app.quit(); return true; });

  ipcMain.handle('buyerlog:update-status', async (event, payload = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    return { ok:true, ...(await updateStatusFor(String(payload.userId || ''))) };
  });
  ipcMain.handle('buyerlog:update-check', async (event, options = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    try {
      return await runUpdateCheck({ ...options, manual:true, userId:String(options.userId || '') });
    } catch (error) {
      return { ok:false, code:error && error.code || 'UPDATE_CHECK_FAILED', error:'Güncelleme kaynağına şu anda ulaşılamıyor. Buyer Log mevcut sürümle çalışmaya devam edecek.', detail:String(error && error.message || '').slice(0,300), ...(await updateStatusFor(String(options.userId || ''))) };
    }
  });
  ipcMain.handle('buyerlog:update-configure', async (event, options = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    const userId=String(options.userId || '');
    if (!(await verifyUpdateModerator(userId))) return { ok:false, code:'UPDATE_ADMIN_REQUIRED', error:'Bu ayar yalnız moderator tarafından değiştirilebilir.' };
    try {
      const patch={};
      if(Object.prototype.hasOwnProperty.call(options,'enabled'))patch.enabled=options.enabled!==false;
      if(Object.prototype.hasOwnProperty.call(options,'releaseSource'))patch.releaseSource=String(options.releaseSource || '');
      if(Object.prototype.hasOwnProperty.call(options,'channel'))patch.channel=String(options.channel || 'stable');
      const config=updater.configure(patch,updaterBaseConfig());
      scheduleUpdateChecks();
      emitUpdateStatus(await updateStatusFor(userId));
      return {ok:true,config,...(await updateStatusFor(userId))};
    } catch (error) { return {ok:false,code:error && error.code || 'UPDATE_CONFIG_FAILED',error:String(error && error.message || error)}; }
  });
  ipcMain.handle('buyerlog:update-choose-source', async (event, payload = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    const userId=String(payload.userId || '');
    if (!(await verifyUpdateModerator(userId))) return { ok:false, code:'UPDATE_ADMIN_REQUIRED' };
    const result=await dialog.showOpenDialog(activeBuyerLogWindow(event.sender),{title:'Buyer Log release klasörünü seçin',properties:['openDirectory']});
    if(result.canceled||!Array.isArray(result.filePaths)||!result.filePaths[0])return {ok:false,cancelled:true};
    return {ok:true,path:path.resolve(String(result.filePaths[0]))};
  });
  ipcMain.handle('buyerlog:update-retry', async (event, options = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    const userId=String(options.userId || '');
    if (!(await verifyUpdateModerator(userId))) return {ok:false,code:'UPDATE_ADMIN_REQUIRED'};
    try {
      const version=String(options.version || (updater && updater.state().latestVersion) || '');
      if(version)updater.markRetry(version);
      return await runUpdateCheck({manual:true,retryFailed:true,userId});
    } catch(error){return {ok:false,code:error && error.code || 'UPDATE_RETRY_FAILED',error:String(error && error.message || error)};}
  });
  ipcMain.handle('buyerlog:update-restart', async event => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    if(!updater||!updater.state().pending||!updater.state().pending.ready)return {ok:false,code:'UPDATE_NOT_READY'};
    updateRelaunchRequested=true;
    /* BrowserWindow.close() deliberately uses the existing beforeunload/dirty-state
       protection. If renderer vetoes the close, the flag is cleared below. */
    if(workspace&&workspace.hasWindows())workspace.closeAllWindows();
    else if(mainWindow&&!mainWindow.isDestroyed())mainWindow.close();
    else app.quit();
    setTimeout(()=>{if(workspace&&workspace.hasWindows())updateRelaunchRequested=false;},1500).unref?.();
    return {ok:true};
  });

  ipcMain.handle('buyerlog:choose-shared-hub-folder', async event => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    const result = await dialog.showOpenDialog(activeBuyerLogWindow(event.sender), {
      title: 'Buyer Log Shared Hub klasörünü seçin',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return { ok:false, cancelled:true };
    return { ok:true, path:String(result.filePaths[0]) };
  });
  ipcMain.handle('buyerlog:choose-database-workbook', async event => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'IPC_FORBIDDEN' };
    const result = await dialog.showOpenDialog(activeBuyerLogWindow(event.sender), {
      title: 'Database bağlantı bilgisini içeren Excel dosyasını seçin',
      properties: ['openFile'],
      filters: [{ name: 'Excel Workbooks', extensions: ['xlsx', 'xlsm'] }],
    });
    if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) return { ok:false, cancelled:true };
    const selectedPath = path.resolve(String(result.filePaths[0]));
    const proofPayload = selectedPath.toLowerCase();
    const proof = crypto.createHmac('sha256', desktopBridgeSecret).update(proofPayload, 'utf8').digest('hex');
    return { ok:true, path:selectedPath, name:path.basename(selectedPath), proof };
  });

  /* CoreNectum automatic SSO. The raw Bearer never crosses IPC: Electron main
     captures it and writes it straight to the local backend through the
     per-process loopback bridge. Renderer receives only success/error state. */
  ipcMain.handle('buyerlog:corenectum-auth', async (event, options = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'CORENECTUM_IPC_FORBIDDEN', error:'CoreNectum yetkilendirme isteği reddedildi.' };
    try { return await acquireCoreNectumToken({ interactive: options && options.interactive !== false, requestingContents:event.sender }); }
    catch (error) { return { ok:false, code:error && error.code || 'CORENECTUM_AUTH_FAILED', error:error && error.message || String(error) }; }
  });
  ipcMain.handle('buyerlog:corenectum-auth-clear', async event => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'CORENECTUM_IPC_FORBIDDEN' };
    try { return await clearCoreNectumAuthSession(); }
    catch (error) { return { ok:false, code:'CORENECTUM_AUTH_CLEAR_FAILED', error:error && error.message || String(error) }; }
  });

  /* OAB SSO is independent from CoreNectum. Only the trusted Buyer Log renderer
     may request the flow; the external OAB/Microsoft pages have no preload and
     therefore cannot invoke these channels. Raw Authorization never crosses IPC. */
  ipcMain.handle('buyerlog:oab-auth', async (event, options = {}) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, authenticated:false, code:'OAB_IPC_FORBIDDEN', error:'OAB yetkilendirme isteği reddedildi.' };
    try {
      return await acquireOabAuthorization({
        interactive:options && options.interactive !== false,
        forceFresh:options && options.forceFresh === true,
        seasonRef:options && options.seasonRef,
        merchSubGroupRef:options && options.merchSubGroupRef,
        buyerGroupRef:options && options.buyerGroupRef,
        requestingContents:event.sender,
      });
    }
    catch (error) { return { ok:false, authenticated:false, code:error && error.code || 'OAB_AUTH_FAILED', error:'OAB yetkilendirmesi başarısız oldu.' }; }
  });
  ipcMain.handle('buyerlog:oab-auth-clear', async event => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, code:'OAB_IPC_FORBIDDEN' };
    try { return await clearOabAuthSession(); }
    catch (_) { return { ok:false, code:'OAB_AUTH_CLEAR_FAILED', error:'OAB oturumu temizlenemedi.' }; }
  });

  /*
   * "Dosya hazır" bildirim kartının Aç/Klasörde Göster aksiyonları. Argüman
   * yalnız registerDownload'ın ürettiği opak bir token'dır — renderer'dan asla
   * ham bir dosya yolu alınmaz/çalıştırılmaz. Token bilinmiyorsa (uygulama
   * yeniden başladı, kayıt sınırdan düştü) ya da dosya o andan beri
   * silinmiş/taşınmışsa çökmeden kontrollü bir hata döner.
   */
  ipcMain.handle('buyerlog:open-download', (event, token) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, error:'forbidden' };
    const entry = downloadRegistry.get(String(token || ''));
    if (!entry || !fs.existsSync(entry.path)) return { ok: false, error: 'not-found' };
    const error = shell.openPath(entry.path);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('buyerlog:reveal-download', (event, token) => {
    if (!trustedBuyerLogIpcSender(event)) return { ok:false, error:'forbidden' };
    const entry = downloadRegistry.get(String(token || ''));
    if (!entry || !fs.existsSync(entry.path)) return { ok: false, error: 'not-found' };
    shell.showItemInFolder(entry.path);
    return { ok: true };
  });
}

/* ------------------------------------------------------------ uygulama */

function bootstrap() {
  app.setName('Buyer Log');
  app.setAppUserModelId('com.lcw.buyerlog');

  paths = desktopPaths(resolvePortableRoot({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: APP_CORE_ROOT,
  }));

  try {
    updater = new BuyerLogUpdater({
      currentVersion: appVersion(),
      updaterVersion: String(process.env.BUYER_LOG_UPDATER_VERSION || '1.0.0'),
      appCoreRoot: APP_CORE_ROOT,
      portableRoot: paths.portableRoot,
      localDataRoot: paths.localDataRoot,
      packaged: app.isPackaged,
      log,
    });
  } catch (error) {
    updater = null;
    if (process.stdout && process.stdout.isTTY) process.stdout.write('Updater hazırlanamadı: ' + error.message + '\r\n');
  }

  /*
   * Electron'un KENDİ profili açıkça data\electron-profile'a alınır.
   * app.asar/resources içine yazma yapılmaz ve kurumsal Edge/Chrome profili
   * ile hiçbir şekilde karışmaz (bkz. portable-paths.js §2, §3).
   */
  try {
    fs.mkdirSync(paths.electronProfileRoot, { recursive: true });
    app.setPath('userData', paths.electronProfileRoot);
    app.setPath('sessionData', paths.electronProfileRoot);
  } catch (error) {
    // Yol ayarlanamazsa uygulama yine açılmalı; hata başlatma akışında raporlanır.
    // Konsol yokken stdout bloke olabilir (bkz. log()).
    if (process.stdout && process.stdout.isTTY) process.stdout.write('Electron profil klasörü ayarlanamadı: ' + error.message + '\r\n');
  }

  /*
   * TEK KOPYA. İki kopya iki veritabanı yazıcısı, iki sync motoru ve port
   * çakışması demektir. İkinci çalıştırma var olan pencereyi öne getirir.
   */
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', () => {
    const window = activeBuyerLogWindow() || errorWindow;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  /* Son pencere kapanınca uygulama kapanır — AMA yeniden başlatma sırasında
     değil. Yeniden başlatma eski pencereyi yıkıp yenisini kuruyor; aradaki
     pencerede bu olay tetiklenirse uygulama tam da toparlanırken kapanırdı. */
  app.on('window-all-closed', () => {
    if (restarting) return;
    if (updateRelaunchRequested) { try { app.relaunch(); } catch (_) {} }
    app.quit();
  });

  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    shutdown().finally(() => app.exit(0));
  });

  app.whenReady().then(async () => {
    log('Buyer Log masaüstü ' + appVersion() + ' · Electron ' + process.versions.electron
      + ' · Chromium ' + process.versions.chrome + ' · Node ' + process.versions.node);
    log('Portable kök: ' + paths.portableRoot);
    log('Veri kökü   : ' + paths.dataRoot);

    Menu.setApplicationMenu(null); // §2
    applyDownloadPolicy(session.defaultSession);
    registerIpc();

    try {
      ensureConfig(paths, APP_CORE_ROOT);
    } catch (error) {
      log('config.json hazırlanamadı: ' + error.message);
    }

    // Güncelleme kontrolü backend/login akışından bağımsızdır. Böylece kullanıcı
    // giriş ekranını görmeden önce bile STABLE manifest kontrolü başlamış olur.
    scheduleUpdateChecks();

    const started = await startBuyerLog();
    if (!started) log('Başlatma tamamlanamadı; hata ekranı gösteriliyor.');
  });

  process.on('uncaughtException', error => {
    log('Yakalanmamış hata: ' + (error && error.stack ? error.stack : error));
    if ((!workspace || !workspace.hasWindows()) && !mainWindow && !errorWindow) {
      try {
        dialog.showErrorBox('Buyer Log', 'Beklenmeyen bir hata oluştu:\n\n' + (error && error.message));
      } catch (_) {}
    }
  });
  process.on('unhandledRejection', reason => {
    log('Yakalanmamış promise hatası: ' + (reason && reason.stack ? reason.stack : reason));
  });
}

bootstrap();
