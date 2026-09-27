const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const { redactSecrets } = require('../shared/secret-redaction');
const zlib = require('zlib');
const os = require('os');
const { APP_VERSION, DISPLAY_VERSION } = require('./lib/app-version');
const { DEFAULT_CONFIG, loadRuntimeConfig } = require('./lib/runtime-config');
const { createStaticGzip } = require('./lib/static-gzip');
const { spawnSync } = require('child_process');
const { once } = require('events');
const BLBusinessRules = require('../public/business-rules');
const BLFreight = require('../public/freight-calc');
const canonicalFields = require('./lib/canonical-fields');
// Excel tarih kancaları süreç açılışında kurulur: tembel getXLSX() çağrılarını
// beklemeden, xlsx modülünü hangi yol kullanırsa kullansın okuma ve yazma aynı
// takvim gününü versin (v5.81).
try { require('../public/excel-date-utils').installSheetJsHooks(require('xlsx')); }
catch (err) { console.warn('Excel tarih kancaları kurulamadı:', err && err.message); }
const { runExcelTask, getExcelWorkerStats } = require('./excel-worker-client');
const {
  CONFIG_PATH, MODEL_FILES_ROOT, LOGS_ROOT, TEMP_ROOT, EMAIL_DRAFT_ROOT, LOCAL_DATA_ROOT, LOCAL_DB_FILE, SERVER_DATA_ROOT, APP_DATA_ROOT,
  getUserDataInventory, exportBackupToFile,
  saveCollectionImage, replaceCollectionImage, collectionImageOptimizationStatus, completeCollectionImageOptimization,
  getModelImageSettings, saveModelImageSettings,
  getCollectionImage, deleteCollectionImage, deleteAllCollectionImages, purgeExpiredModelFiles, resolveStoredFile, atomicWriteJson, atomicWriteBuffer,
} = require('./user-data');
const { createLocalDb, offloadLegacyAssets, sweepWriteDebris } = require('./lib/local-db');
const { createSyncSettings } = require('./lib/sync-settings');
const { createSharedHub } = require('./lib/shared-hub');
const sharedSyncPolicy = require('./lib/shared-sync-policy');
const { filterCollectionWorkspaceDeltas, quarantineLegacyCollectionDeltas, createCollectionReplication } = require('./lib/collection-replication');
const { createCollectionPermissionsStore } = require('./lib/collection-permissions-store');
const { resolveBuyerLogDataRoots } = require('./lib/data-roots');
const { createDataMaintenance } = require('./lib/data-maintenance');
const { createBackupService } = require('./lib/backup-service');
const { runBackupRestore } = require('./lib/backup-restore-worker-client');
const { inspectBackupArchive, extractBackupArchive } = require('./lib/backup-archive');
const prewipeMasterRecovery = require('./lib/prewipe-master-recovery');
const { createSharedPersonalBackupService } = require('./lib/shared-personal-backup');
const { createUserRestoreService } = require('./lib/user-restore-service');
const { createFullRestoreService, recoverInterruptedRestoresSync } = require('./lib/full-restore-service');
const { isClientRequestAborted } = require('./lib/http-errors');
// v7.81: normalizeHorizonGroups artık kullanılmıyor — Horizon grupları kaldırıldı.

const SERVER_BOOT_STARTED_AT = Date.now();
const startupPerformanceLog = [];
function markStartup(name, detail = null) {
  const entry = { name: String(name), at: new Date().toISOString(), elapsedMs: Date.now() - SERVER_BOOT_STARTED_AT, detail };
  startupPerformanceLog.push(entry); while (startupPerformanceLog.length > 80) startupPerformanceLog.shift();
  if (process.env.NODE_ENV !== 'test') {
    const clientReported=detail&&Number.isFinite(Number(detail.clientElapsedMs));
    const timing=clientReported
      ?` · server received +${entry.elapsedMs}ms · client +${Math.round(Number(detail.clientElapsedMs))}ms`
      :` +${entry.elapsedMs}ms`;
    const durationMs=detail&&Number.isFinite(Number(detail.durationMs))?` · duration ${Math.round(Number(detail.durationMs))}ms`:'';
    console.log(`[PERF] ${entry.name}${timing}${durationMs}`);
  }
  return entry;
}
markStartup('APP_BOOT_START');

// Local-first bootstrap. The retired whole-folder legacy import is deliberately
// not part of startup; business data remains in the local DB + delta registry.
const localDb = createLocalDb(LOCAL_DB_FILE);
function sharedHubDeltaFilter(direction) {
  return deltas => sharedSyncPolicy.filterDeltas(filterCollectionWorkspaceDeltas(deltas), direction);
}
const syncSettings = createSyncSettings({
  localDataRoot: LOCAL_DATA_ROOT,
  localDb,
  trace: markStartup,
  filterIncomingDeltas: sharedHubDeltaFilter('incoming'),
  filterOutgoingDeltas: sharedHubDeltaFilter('outgoing'),
});
const sharedHub = createSharedHub({ localDataRoot: LOCAL_DATA_ROOT, appVersion: APP_VERSION, networkTimeoutMs: 15000 });
const dataRoots = resolveBuyerLogDataRoots({ projectRoot: path.join(__dirname, '..'), serverDataRoot: SERVER_DATA_ROOT, appDataRoot: APP_DATA_ROOT, localDataRoot: LOCAL_DATA_ROOT, localDbPath: LOCAL_DB_FILE });
const dataMaintenance = createDataMaintenance({ roots: dataRoots, localDb, syncSettings });
/* Ortak iş verisinin delta motoruna taşınması. Faz config.json'daki
   deltaStoreMode ya da BL_DELTA_STORE_MODE ile ilerletilir; varsayılan
   "shadow" üretimde hiçbir davranışı değiştirmez. Faz sözleşmesi ve neden
   tek adımda geçilmediği: server/lib/delta-store.js. */
const { createDeltaStore } = require('./lib/delta-store');
const deltaStore = createDeltaStore({
  localDb,
  mode: process.env.BL_DELTA_STORE_MODE || (loadRuntimeConfig(CONFIG_PATH).config || {}).deltaStoreMode,
  onError: (stage, error) => logRuntimeFailure(`deltaStore:${stage}`, error),
});
const LOCAL_DB_MAINTENANCE_DELAY_MS = 4000;
async function runLocalDbMaintenance() {
  const dbFolder = path.dirname(localDb.getFile());
  try {
    const offloaded = await offloadLegacyAssets(localDb);
    if (offloaded.moved) markStartup('LOCAL_DB_ASSETS_OFFLOADED', { count: offloaded.moved });
  } catch (error) { logRuntimeFailure('localDbAssetOffload', error); }
  try {
    // Mevcut ortak veriyi bir kez delta motoruna tohumla. Shadow fazında bu
    // yalnız bir ayna kopyadır; eski JSON yetkili kalmaya devam eder.
    const seeded = await deltaStore.seedOnce(plmStyleLinks.COLLECTION, loadPlmStyleLinks().links);
    if (seeded.seeded) markStartup('DELTA_STORE_SEEDED', { collection: plmStyleLinks.COLLECTION, count: seeded.seeded });
    // saveRevisioned üzerinden yazan ortak store'lar tek koleksiyonda, veri
    // köküne göreli yol kimliğiyle tutulur.
    const db = require('./db');
    // Kayıt bazlı: sonradan taşınan bir store, koleksiyona konmuş eski bir
    // işaret yüzünden tohumsuz kalmaz; hâlihazırda taşınmış olanlar da
    // yeniden yazılmaz.
    const { toDocumentRecord } = require('./lib/delta-store');
    const payload = db.deltaSeedPayload();
    // Kendi yazma yolu olan store'lar da aynı koleksiyonda, aynı yol
    // kimliğiyle tohumlanır. Collection çalışma alanları BİLEREK burada
    // değildir: sahibine göre yetkili replikasyon yolundan taşınırlar.
    const emailGroups = require('./lib/email-groups-store');
    const quotations = require('./lib/quotations-store');
    const endeksmatik = require('./lib/endeksmatik');
    try { if (fs.existsSync(emailGroups.FILE)) payload['email-groups.json'] = toDocumentRecord(emailGroups.loadStore()); } catch (_) {}
    try {
      const quotationsFile = path.join(SERVER_DATA_ROOT, 'quotations.json');
      if (fs.existsSync(quotationsFile)) payload['quotations.json'] = toDocumentRecord(quotations.loadStore());
    } catch (_) {}
    const seededStores = await deltaStore.seedMissing(db.DELTA_STORE_COLLECTION, payload);
    if (seededStores.seeded) markStartup('DELTA_STORE_SEEDED', { collection: db.DELTA_STORE_COLLECTION, count: seededStores.seeded, ids: seededStores.ids });
    const seededEndeksmatik = await endeksmatik.seedMissing(deltaStore);
    if (seededEndeksmatik.seeded) markStartup('DELTA_STORE_SEEDED', { collection: endeksmatik.COLLECTION, count: seededEndeksmatik.seeded, ids: seededEndeksmatik.ids });
    const workspaces = require('./lib/collection-workspaces');
    const quarantine = await quarantineLegacyCollectionDeltas({
      localDb,
      workspaceFileForOwner: workspaces.workspaceFile,
      onTrace: markStartup,
    });
    if (quarantine.inspected) markStartup('COLLECTION_LEGACY_DELTA_TRANSITION', quarantine);
    // Çalışan kümeyi belleğe al: delta yetkili fazlarda okumalar buradan gelir.
    const loaded = await deltaStore.hydrate();
    if (loaded.ok) markStartup('DELTA_STORE_HYDRATED', { collections: loaded.collections, records: loaded.records });
  } catch (error) { logRuntimeFailure('deltaStoreSeed', error); }
  for (const folder of new Set([dbFolder, LOCAL_DATA_ROOT, path.join(dbFolder, '.buyerlog-db-recovery')])) {
    try {
      const swept = await sweepWriteDebris(folder);
      if (swept.removed) markStartup('LOCAL_DB_DEBRIS_SWEPT', { folder, files: swept.removed, bytes: swept.bytes });
    } catch (error) { logRuntimeFailure('localDbDebrisSweep', error); }
  }
}
let localDbMaintenancePromise = null;
function ensureLocalDbMaintenanceReady() {
  if (!localDbMaintenancePromise) {
    localDbMaintenancePromise = localDbReadyPromise
      .then(() => runLocalDbMaintenance())
      .catch(error => {
        localDbMaintenancePromise = null;
        throw error;
      });
  }
  return localDbMaintenancePromise;
}

const localDbReadyPromise = (async () => {
  try {
    const configuredSync = await syncSettings.read();
    const configuredLocalDbPath = path.resolve(configuredSync.localDbPath || localDb.getFile());
    markStartup('LOCAL_DB_CONFIG_PATH', { path: configuredLocalDbPath });
    markStartup('SHARED_SYNC_ROOT', { path: configuredSync.sharedSyncRoot || '' });
    if (configuredLocalDbPath !== path.resolve(localDb.getFile())) localDb.setFolder(path.dirname(configuredLocalDbPath));
    await localDb.ensure();
    const activeLocalDbPath = path.resolve(localDb.getFile());
    if (configuredLocalDbPath !== activeLocalDbPath) throw new Error(`Local DB config/active connection mismatch: ${configuredLocalDbPath} != ${activeLocalDbPath}`);
    markStartup('LOCAL_DB_ACTIVE_CONNECTION', { path: activeLocalDbPath });
    markStartup('LOCAL_DB_READY');
    markStartup('LOCAL_STATE_READY');
    // Bakım işleri açılış kritik yolunun DIŞINDA kalır: yalnız bir kez çalışan
    // asset boşaltımı ve yetim temp süpürmesi UI'ı bekletmez, hata verirse de
    // yalnız kendi sınırında kalır.
    setTimeout(() => { void ensureLocalDbMaintenanceReady().catch(error => logRuntimeFailure('localDbMaintenance', error)); }, LOCAL_DB_MAINTENANCE_DELAY_MS).unref?.();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    markStartup('LOCAL_DB_READY_FAILED', { error: message });
    console.error('BuyerLogLocal.db local setup failed:', message);
  }
})();
// Runtime failures are persisted before the watchdog restarts the process.
const RUNTIME_LOG_ROOT = LOGS_ROOT;
const RUNTIME_ERROR_LOG = path.join(RUNTIME_LOG_ROOT, 'server-error.log');
let fatalExitScheduled = false;
function logRuntimeFailure(kind, error) {
  const detail = redactSecrets(error && error.stack ? error.stack : String(error));
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}`;
  console.error(line);
  try {
    fs.mkdirSync(RUNTIME_LOG_ROOT, { recursive: true });
    fs.appendFileSync(RUNTIME_ERROR_LOG, line + os.EOL, 'utf8');
  } catch (_) { /* crash logging must not create another crash */ }
}
/* Gözetmenle paylaşılan çıkış kodu: "bu kopyanın çalışmasına gerek yok,
   yeniden başlatma". Kod server/watchdog.js içinde de aynı değerle tanımlıdır. */
const EXIT_ALREADY_RUNNING = 3;
function scheduleFatalRestart(kind, error) {
  logRuntimeFailure(kind, error);
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  // Exit deliberately so server/watchdog.js can create a clean process.
  // .unref() KULLANILMAZ: bağlanma başarısız olduğunda geriye kalan bütün
  // handle'lar unref'li olduğu için Node bu zamanlayıcı ateşlenmeden kendi
  // kendine ve KOD 0 ile çıkıyordu. Gözetmen de temiz bir kapanış görüp
  // yeniden başlatıyordu; loglarda 229 EADDRINUSE ve 26 restart/dakika
  // bunun izidir. Zamanlayıcı artık olay döngüsünü ayakta tutar.
  setTimeout(() => process.exit(1), 150);
}
process.on('uncaughtException', error => scheduleFatalRestart('uncaughtException', error));
/* v7.85 — ARKA PLAN HATASI UYGULAMAYI ÇÖKERTMEZ.
   Yakalanmamış bir reddedilme, kimsenin beklemediği bir promise'in hata
   vermesidir; senkron durum bozulmamıştır ve HTTP sunucusu isteklere yanıt
   vermeye devam edebilir. Bunu process.exit(1) ile karşılamak, arka plan
   sync'inde sync-settings.json'ın geçici bir Windows rename kilidine takılması
   yüzünden BÜTÜN sunucunun düşmesine yol açıyordu (log: EPERM rename →
   unhandledRejection → exit code=1). Hata artık tam yığın izleyle kalıcı
   olarak kaydedilir; süreç yaşamaya devam eder. Beklenen operasyonel hatalar
   yine de kendi async sınırlarında yakalanmalıdır — bu yalnız son savunmadır. */
process.on('unhandledRejection', error => logRuntimeFailure('unhandledRejection', error));

const { findLatestSourceFiles } = require('./lib/findFiles');
const { refreshExcelFile } = require('./lib/refreshExcel');
const { refreshSourceWorkbooks, computeParseTimeoutMs, computeRefreshTimeoutMs } = require('./lib/source-refresh');
const { chooseFolderDialog } = require('./lib/chooseFolder');
const modelQuery = require('./lib/modelQuery');
const modelHorizon = require('./lib/modelHorizon');
const { inspectSourceFilterReadiness, readinessMessage: sourceFilterReadinessMessage } = require('./lib/source-filter-readiness');
// Veri Yönetimi ekranının okuduğu projeksiyon. Saf ve salt-okunur: modelConnections
// kaydını okur, veritabanına hiç bağlanmaz. Bu yüzden kaynak erişilemezken de açılır.
const dataManagementReadModel = require('./lib/data-domain/read-model');
const dataManagementBindingWriter = require('./lib/data-domain/binding-writer');
const refreshGroupRules = require('./lib/data-domain/refresh-groups');
// Kaynak başına yapılandırma sürümü: eşzamanlılık kontrolü bunu kullanır.
const dataManagementAdapter = require('./lib/data-domain/legacy-adapter');
const dataManagementFilterWriter = require('./lib/data-domain/filter-writer');
const dataManagementSourceWriter = require('./lib/data-domain/source-writer');
const dataManagementSourceProfiles = require('./lib/data-domain/source-profiles');
const excelConnectionDiscovery = require('./lib/excel-connection-discovery');
const databaseConnector = require('./lib/database-connector');
const databaseCredentialStore = require('./lib/database-credential-store');
const corporateIntegrationLab = require('./lib/corporate-integration-lab');
const modelFields = require('./lib/model-fields');
const filterValueTypes = require('./lib/filter-value-types');
const { loadFromModelConnections, ensureConnectionMapping, alignHorizonWithMapping, validateAntrepoIntegrity, resolveColumnTypes, effectiveScopes, buildConnectionQuery } = require('./lib/model-refresh');
const {
  POWER_BI_IMPORT_DASHBOARD_URL, PowerBiImportDashboardConnector,
  dashboardAntrepoMatchRule, normalizeDashboardRows, uniqueOrderCodes, createDashboardCheckpointStore,
} = require('./lib/power-bi-import-dashboard');
const { saveModelSnapshotAsync, loadModelSnapshot, loadModelSnapshotAsync, SNAPSHOT_ROOT } = require('./lib/model-snapshot');
const pageProjectionCache = require('./lib/page-projection-cache');
const { runProjectionWorker } = require('./lib/projection-worker-client');
const { SharedRevisionStore } = require('./lib/shared-revision-store');
const platform = require('./lib/platform');
const { buildCPRowsFromASAS, buildOrdersRowsFromASAS, buildSharedOrderProjectionRowsFromASAS, buildOverviewSummaryRowsFromASAS, buildOrderSummaryRowsFromASAS, buildBacklogGrouped, buildBacklogDetailRows, buildBacklogTemplateRows, deriveOperationalStatus, findAntrepoHit, applyDateOverrides } = require('./lib/parse');
const { withFabricDimensions, attachModelImageIdentities } = require('./lib/lfl');
const parseLib = require('./lib/parse');
const modelImageIdentityResolver = require('./lib/model-image-identity-resolver');
const { resolveUsablePlmImage } = require('./lib/plm-image-availability');
/* KANONİK PLM GÖRSEL BORUSU — canlı CoreNectum senkronu ve hazır
   BUYERLOG_IMPORT paketi AYNI alım yolundan geçer (bkz. plm-image-ingest.js). */
const coreNectumStyleApi = require('./lib/corenectum-style-api');
const coreNectumApiClient = require('./lib/corenectum-api-client');
const coreNectumApiSettings = require('./lib/corenectum-api-settings');
const coreNectumAttachmentIndex = require('./lib/corenectum-attachment-index');
const plmImageIngestLib = require('./lib/plm-image-ingest');
const plmImageOwnership = require('./lib/plm-image-ownership');
const plmImagePackage = require('./lib/plm-image-package');
const plmImageJobStore = require('./lib/plm-image-job-store');
const plmImageSyncService = require('./lib/plm-image-sync-service');
/* YEREL-ÖNCELİKLİ DAĞITIM — görsel baytları artık kullanıcılar arasında
   taşınır. Sıra LOCAL → SHARED → ASAS/PLM'dir; ağ yalnız taşıma bandıdır,
   tablo hiçbir zaman ağdan okumaz. */
const sharedImageStoreLib = require('./lib/shared-image-store');
const modelImageDistributionLib = require('./lib/model-image-distribution');
const collectionImageSyncPolicy = require('./lib/collection-image-sync-policy');
const refreshHistoryDiff = require('./lib/refresh-history-diff');
const backlogPlanActual = require('./lib/backlog-plan-actual');
const modelImageRegistry = require('./lib/model-image-registry');
// Ajan kaynaklı yazmaların audit etiketi (bkz. copilot-provenance).
const copilotProvenance = require('./lib/copilot-provenance');
// Octopus çıktısı: cevabın dayandığı satırları Excel'e çevirir.
const { createExportStore } = require('./lib/octopus-export-store');
const octopusExports = createExportStore();
// Eylem listesi istemciyle TEK kaynaktan paylaşılır (bkz. agent-tool-registry).
const copilotActions = require('../public/copilot-actions.js');
const {
  loadOverrides, saveOverrides, replacePricingRules, replaceTransitRules, replaceNonDtrManufacturers, replaceLandedMultipliers, replaceFreightRates, replaceAntrepoMatchRule, replaceAntrepoSourceMode, replaceAsasSourceMode, replaceLflSourceMode, replaceNoteColumnDefs, patchOrderOverride, patchOrderOverrides, patchPlmImageLinks, clearAllModelImageLinks, patchSuppFobOverrides, clearDeliveryOverrides, clearDeliveryOverridesForOrders, getUserSourceFolder, setUserSourceFolder,
  loadViews, addView, updateView, deleteView, setFavoriteView, markUsedView,
  loadFilterProfiles, addFilterProfile, updateFilterProfile, deleteFilterProfile, setFavoriteFilterProfile, markUsedFilterProfile,
  loadShipping, addShippingRows, patchShippingRow, deleteShippingRows,
  loadOpenCostings, createOpenCosting, updateOpenCosting, deleteOpenCosting,
  loadFx, saveFx, fxMonthResolved,
  loadRefreshHistory, addRefreshHistory, deleteRefreshHistory, clearRefreshHistory,
  loadModelConnections, replaceModelConnections, recordModelConnectionRun,
  loadRefreshGroups, replaceRefreshGroups,
  loadHorizonTemplates, addHorizonTemplate, deleteHorizonTemplate,
} = require('./db');

const loadedConfig = loadRuntimeConfig(CONFIG_PATH);
let config = loadedConfig.config;
markStartup('LOCAL_CONFIG_READY');
if (!loadedConfig.found) {
  console.warn('config.json bulunamadı, varsayılan ayarlarla başlatılıyor. config.example.json\'u kopyalayıp düzenleyebilirsin (opsiyonel).');
} else if (loadedConfig.warning) {
  logRuntimeFailure('configLoad', loadedConfig.error || loadedConfig.warning);
  console.warn(loadedConfig.warning);
}
const SHARED_DATA_ROOT = path.resolve(config.sharedDataRoot || path.join(LOCAL_DATA_ROOT, 'shared-data'));
const sharedRevisionStore = new SharedRevisionStore(SHARED_DATA_ROOT);
// Sync Hub yalnız delta dosyaları taşır; BuyerLogLocal.db daima yerel diskte kalır.
const BACKGROUND_SYNC_DELAY_MS = 2500;
let uiReadySignaled = false, backgroundServicesTimer = null;
function scheduleBackgroundServices() {
  if (!uiReadySignaled || backgroundServicesTimer) return;
  backgroundServicesTimer = setTimeout(() => {
    backgroundServicesTimer = null;
    markStartup('BACKGROUND_SYNC_START');
    void hydrateBusinessCheckpointIfNeeded()
      .catch(error=>{logRuntimeFailure('businessCheckpointHydrate',error);return null;})
      .then(()=>syncSettings.read())
      .then(state => state.syncPeriodMinutes === 'manual' ? null : syncSettings.syncOnce())
      // Uzak delta uygulandıysa bellekteki çalışan küme bayatlamıştır.
      .then(() => deltaStore.hydrate())
      .catch(error => logRuntimeFailure('backgroundSync', error));
    void syncFxFromKurWorkbook('moderator', true).catch(error => logRuntimeFailure('backgroundFxSync', error));
  }, BACKGROUND_SYNC_DELAY_MS);
  backgroundServicesTimer.unref?.();
}
setInterval(() => { void syncSettings.read().then(state => {
  if (!uiReadySignaled) return;
  if (state.syncPeriodMinutes === 'manual') return;
  const last = Date.parse(state.lastSync || state.lastAttempt || 0);
  if (!last || Date.now() - last >= Number(state.syncPeriodMinutes || 5) * 60000) return syncSettings.syncOnce().then(() => deltaStore.hydrate());
}).catch(error => logRuntimeFailure('scheduledSync', error)); }, 30000).unref();
/* PAYLAŞILAN MODEL GÖRSELİ DAĞITIMI — arka plan turu.
   Açılışı BLOKE ETMEZ: uygulama kullanılabilir olduktan sonra çalışır, her
   turda yalnız delta okur ve yalnız değişen nesneleri indirir. Ağ yoksa tur
   sessizce boş döner; tablolar zaten yerel depodan çizilir. */
setInterval(() => {
  if (!uiReadySignaled) return;
  // LOCAL-CACHE-FIRST: background turu yalnız yerelde başarıyla üretilmiş
  // görselleri Shared Hub'a yayımlar. Shared Hub'daki bütün yeni görselleri
  // körlemesine indirmek, uzun yaşayan bir istemcide zamanla tüm arşivi local
  // diske çekiyordu. Byte hydration artık yalnız görünür/istenen model
  // kimlikleri için on-demand endpoint üzerinden yapılır.
  void syncSharedModelImagesOnce({ hydrate: false }).catch(error => logRuntimeFailure('sharedModelImageSync', error));
}, 120000).unref();
// TPs/model dosyaları yüklenme tarihinden itibaren 1 yıl saklanır.
// Koleksiyon/CP görselleri bu temizliğin kapsamı dışındadır ve kalıcıdır.
try {
  const result = purgeExpiredModelFiles();
  if (result.deletedFiles) console.log(`TP saklama süresi dolan ${result.deletedFiles} dosya temizlendi.`);
} catch (err) { logRuntimeFailure('modelFilesRetention', err); }
setInterval(() => {
  try {
    const result = purgeExpiredModelFiles();
    if (result.deletedFiles) console.log(`TP saklama süresi dolan ${result.deletedFiles} dosya temizlendi.`);
  } catch (err) { logRuntimeFailure('modelFilesRetention', err); }
}, 24 * 60 * 60 * 1000).unref();

// v2.92: Kaynak klasör kullanıcı bazında settings.json/sourceFolders altında tutulur.
// config.sourceFolder yalnız ilk Moderatör kurulumu ve eski yedekler için geri dönüş değeridir.

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// ---- Kimlik doğrulama (varsayılan KAPALI; bir parola yapılandırılınca açılır) ----
// bkz. lib/auth. Kapalıyken requireAuth bir geçiştir → yerel/localhost kullanımı etkilenmez.
const { buildAuth } = require('./lib/auth');
const auth = buildAuth(config);
if (auth.enabled) {
  console.log('Kimlik doğrulama etkin (oturum tabanlı).');
  if (auth.ephemeralSecret) {
    console.warn('UYARI: Oturum imza anahtarı yapılandırılmamış; geçici bir anahtar üretildi. '
      + 'Yeniden başlatınca tüm oturumlar geçersizleşir. config.auth.sessionSecret veya BL_SESSION_SECRET ayarlayın.');
  }
}
app.get('/login', auth.loginPageHandler);
app.post('/api/login', express.json({ limit: '64kb' }), auth.loginHandler);
app.post('/api/logout', auth.logoutHandler);
app.get('/api/auth-status', auth.statusHandler);
// Giriş ekranının ortak stili, dış parola veya kullanıcı oturumu kurulmadan önce de
// erişilebilir olmalıdır. Statik dosya katmanı güvenlik geçitlerinden sonra yer aldığı
// için bu tek dosyayı açık bir rota üzerinden güvenli biçimde sunuyoruz.
app.get('/giris.css', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('text/css').sendFile(path.join(__dirname, '..', 'public', 'giris.css'));
});

/* Desktop-only CoreNectum credential bridge.
 * Electron main captures the Bearer from its dedicated, sandboxed corporate
 * sign-in session and sends it over loopback. The random bridge secret exists
 * only in the Electron main process + backend environment for this app run;
 * it is never exposed to the renderer or written to disk. These routes sit
 * before the ordinary Buyer Log auth gate because Electron main is not a web
 * user session. */
const DESKTOP_BRIDGE_SECRET = String(process.env.BUYER_LOG_DESKTOP_BRIDGE_SECRET || '');
function desktopBridgeAuthorized(req) {
  if (!DESKTOP_BRIDGE_SECRET) return false;
  const supplied = String(req.headers['x-buyerlog-desktop-bridge'] || '');
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(DESKTOP_BRIDGE_SECRET).digest();
  return supplied.length > 0 && crypto.timingSafeEqual(a, b);
}
app.post('/api/internal/desktop/corenectum-token', express.json({ limit:'32kb' }), (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  try {
    const status = coreNectumApiSettings.setDesktopToken(req.body && req.body.token);
    return res.set('Cache-Control','no-store').json({ ok:true, status });
  } catch (err) {
    return res.status(Number(err.statusCode)||400).set('Cache-Control','no-store').json({ ok:false, code:err.code||'CORENECTUM_API_TOKEN_INVALID_FORMAT', error:err.message||'Token alınamadı.' });
  }
});
app.delete('/api/internal/desktop/corenectum-token', (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  const status = coreNectumApiSettings.clearDesktopToken();
  return res.set('Cache-Control','no-store').json({ ok:true, status });
});
app.post('/api/internal/desktop/corenectum-style-template', express.json({ limit:'320kb' }), (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  try {
    const template = coreNectumApiSettings.setDesktopStyleListTemplate(req.body && req.body.template);
    return res.set('Cache-Control','no-store').json({ ok:true, template });
  } catch (err) {
    return res.status(Number(err && err.statusCode) || 400).set('Cache-Control','no-store').json({
      ok:false,
      code:err && err.code || 'CORENECTUM_STYLE_TEMPLATE_INVALID',
      error:err && err.message || 'CoreNectum Style List istek şablonu alınamadı.'
    });
  }
});
// Desktop-only OAB credential bridge. Authorization exists only in process memory.
// The renderer can neither submit nor read the raw value; Electron main owns capture.
app.post('/api/internal/desktop/oab-authorization', express.json({ limit:'16kb' }), async (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  try {
    oabAuthState.setAuthorization(req.body && req.body.authorization);
    await oabApiClient.validateAuthorization();
    return res.set('Cache-Control','no-store').json({ ok:true, status:oabAuthState.status() });
  } catch (err) {
    oabAuthState.clear();
    return res.status(Number(err && err.statusCode) || 400).set('Cache-Control','no-store').json({
      ok:false, code:err && err.code || 'OAB_AUTH_INVALID', error:'OAB yetkilendirmesi başarısız oldu.'
    });
  }
});
app.delete('/api/internal/desktop/oab-authorization', (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  const status = oabAuthState.clear();
  return res.set('Cache-Control','no-store').json({ ok:true, status });
});
// Desktop-only updater authority check. The renderer supplies only its selected
// Buyer Log user id; backend resolves the canonical local IAM profile. This keeps
// TEST-channel permission outside renderer trust while exposing no credential data.
app.post('/api/internal/desktop/update-authority', express.json({ limit:'8kb' }), (req, res) => {
  if (!desktopBridgeAuthorized(req)) return res.status(403).json({ ok:false, code:'DESKTOP_BRIDGE_FORBIDDEN' });
  try {
    const userId = String(req.body && req.body.userId || '').trim();
    const access = require('./lib/user-access');
    const store = access.readStore();
    const profiles = [store && store.moderator, ...(store && Array.isArray(store.users) ? store.users : [])].filter(Boolean);
    const profile = profiles.find(item => String(item && item.id || '') === userId) || null;
    const moderator = Boolean(profile && (String(profile.systemRole || '').toLowerCase() === 'moderator' || String(profile.role || '').toLowerCase() === 'moderator'));
    return res.set('Cache-Control','no-store').json({ ok:true, userId, moderator });
  } catch (error) {
    return res.status(500).set('Cache-Control','no-store').json({ ok:false, code:'UPDATE_AUTHORITY_FAILED' });
  }
});
// Geçit: bu noktadan sonra tanımlanan her rota (backup/restore, tüm /api, statik dosyalar)
// auth etkinse geçerli oturum ister. Login/logout/auth-status/login sayfası muaftır.
app.use(auth.requireAuth);

// ---- Manuel kullanıcı hesabı, hiyerarşi ve satır yetkilendirmesi ----
// Dış parola geçidi (varsa) aşıldıktan sonra kullanıcı adı ve şifreyle giriş yapılır.
// Kullanıcı hesapları kaynak dosyadan türetilmez; yetkili yöneticiler tarafından oluşturulur.
const { buildUserAccess, ACCESS_FILE } = require('./lib/user-access');
const collectionWorkspaces = require('./lib/collection-workspaces');
const cpSharedStore = require('./lib/cp-shared-store');
const { loadWorkspace, saveWorkspace, saveWorkspaceAsync } = collectionWorkspaces;
const collectionSaveWorker = require('./lib/collection-save-worker-client');
const collectionRecycleBin = require('./lib/collection-recycle-bin');
const userPreferences = require('./lib/user-preferences');
const { loadPlmTranslations, publicRules: publicPlmTranslations, upsertPlmTranslations } = require('./lib/plm-translations');
const plmStyleLinks = require('./lib/plm-style-links');
const { loadPlmStyleLinks, publicLinks: publicPlmStyleLinks, upsertPlmStyleLinks } = plmStyleLinks;
/* Ortak iş verisini tutan her store delta motoruna bağlanır. Bağlama tek
   yerde toplanır ki yeni bir store taşındığında atlanması mümkün olmasın. */
for (const store of [plmStyleLinks, require('./db'), require('./lib/email-groups-store'),
  require('./lib/quotations-store')]) {
  store.attachDeltaStore(deltaStore);
}
// Collection joins the generic delta channel only for the canonical
// shared-collection document. Legacy owner workspaces remain compatibility
// evidence and are filtered by collection-replication.js.
collectionWorkspaces.attachDeltaStore(deltaStore);
markStartup('DELTA_STORE_MODE', { mode: deltaStore.mode });
const quotationStore = require('./lib/quotations-store');
const overrideScope = require('./lib/override-scope');
const quotationVisibility = require('./lib/quotation-visibility').createQuotationVisibility({
  canEdit: quotationStore.canEdit,
  collectionAccessLevel: (profile, ownerId) => userAccess.collectionAccessLevel(profile, ownerId),
  hasPermission: (profile, key) => userAccess.hasPermission(profile, key),
  authoritativeOrderRows: code => userAccess.authoritativeOrderRows(code),
  canEditOrder: (profile, order) => userAccess.canEditOrder(profile, order),
});
function quotationsVisibleTo(profile, options = {}) {
  return quotationStore.requestsForUser(profile, { ...options, canView: request => quotationVisibility.visibleTo(profile, request) });
}
function quotationVisibleById(profile, id) {
  return quotationsVisibleTo(profile, { includeHidden: true }).requests.some(request => request.id === String(id || ''));
}
const emailGroupsStore = require('./lib/email-groups-store');
const agentWorkflowStore = require('./lib/agent-workflow-store');
const automationRecipeStore = require('./lib/automation-recipe-store');
const aiCapabilityRegistry = require('./lib/ai-capability-registry');
const automationLanguage = require('./lib/automation-language');
const aiGuideGenerator = require('./lib/ai-guide-generator');
const aiAutomationCompiler = require('./lib/ai-automation-compiler');
const aiAutomationCompatibility = require('./lib/ai-automation-compatibility');
const backlogAutomation = require('./lib/backlog-automation');
const cpAutomation = require('./lib/cp-automation');
const automationEmail = require('./lib/automation-email');
const { createToolRegistry, filterRows } = require('./lib/agent-tool-registry');
const { createPolicyEngine } = require('./lib/agent-policy-engine');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { architectureTemplate, validateWorkflow, nodeCatalog } = require('./lib/agent-graph');
const agentAi = require('./lib/agent-ai-provider');
const copilotAgent = require('./lib/copilot-agent');
const agentBrowserSettings = require('./lib/agent-browser-settings');
const agentBrowserConnector = require('./lib/agent-browser-connector');
const browserDebugService = require('./lib/browser-debug-service');
const { createBrowserIntegrationManager } = require('./lib/browser-integration-manager');
const browserIntegrationManager = createBrowserIntegrationManager({ connector:agentBrowserConnector });
const troyOrderService = require('./lib/troy-order-service');
const troyPoService = require('./lib/troy-po-service');
const { normalizePlmId } = require('./lib/plm-id');
const { createJobRegistry } = require('./lib/job-registry');
/* PLM iş kaydı: her işin kendi kimliği ve KAPSAMI var. Eskiden ilerleme
   kullanıcı başına tek slotta tutulduğu için bir sayfanın işi diğerinde
   görünüyordu (bkz. job-registry.js başındaki not). */
const plmJobs = createJobRegistry();
const asasTechnicalImages = require('./lib/asas-technical-images');
const webScriptStore = require('./lib/web-script-store');
const webScriptRegistry = require('./lib/web-script-registry');
const liveEvents = require('./lib/live-events');
syncSettings.onStateChange(status => liveEvents.notifySyncStatus(status, entry => {
  try {
    const profile = entry && entry.req ? userAccess.sessionProfile(entry.req) : null;
    return Boolean(profile && userAccess.hasArea(profile, 'source'));
  } catch (_) { return false; }
}));
const qtxStore = require('./lib/qtx-store');
const oabStore = require('./lib/oab-store');
const oabSessionStore = require('./lib/oab-session-store');
const horizonFields = require('./lib/horizon-fields');
const horizonFilterMapping = require('./lib/horizon-filter-mapping');
const { resolveHorizonValueSource, resolveDynamicHorizonValueSource, selectConnection } = require('./lib/horizon-value-source');
const oabStaticMetadata = require('./lib/oab-static-metadata');
const oabBatch = require('./lib/oab-batch');
const oabAuthState = require('./lib/oab-auth-state');
const oabApiClient = require('./lib/oab-api-client');
const intakeReport = require('./lib/intake-report');
const intakeStore = require('./lib/intake-store');
const intakeConnectionSelector = require('./lib/intake-connection');
const technicalSheetOwnership = require('./lib/plm-technical-sheet-ownership');
const { createOutlookGraphService } = require('./lib/outlook-graph');
const { createOutlookLocalService } = require('./lib/outlook-local');
const { createOutlookHybridService } = require('./lib/outlook-hybrid');
const mailIntelligence = require('./lib/mail-intelligence');
const { createOutlookIntelligenceService } = require('./lib/outlook-intelligence-service');
const outlookSetupSettings = require('./lib/outlook-setup-settings');
// v6.44 — istemci hangi sekmenin yazdığını bu başlıkla bildirir; SSE broadcast'i
// bu sekmenin kendi event'ini ayırt edebilsin diye (kendi optimistic update'i
// zaten var, kendine yenileme tetiklemesine gerek yok).
function requestClientId(req){ return String((req.headers && req.headers['x-client-id']) || '').slice(0,80); }
// Ortak master veriler aynı olayla aktif istemcileri ve ayrı süreçlerdeki
// shared-revision fallback'ini günceller. Metadata yalnız kimlik/cihaz izi taşır.
function publishSharedMasterChange(entity, req, detail = null) {
  const actor = req && req.currentUser || {};
  const clientId = requestClientId(req || {});
  void sharedRevisionStore.update(entity, { actorId: String(actor.id || ''), deviceId: clientId })
    .catch(error => logRuntimeFailure('sharedRevision', error));
  liveEvents.notifyChange(entity, clientId, detail);
  scheduleMasterCheckpointPublish(String(actor.id || ''));
}
const endeksmatik = require('./lib/endeksmatik');
endeksmatik.attachDeltaStore(deltaStore);
const userAccess = buildUserAccess({
  onIamApplied: () => liveEvents.notifyChange('iam', null),
  ensureDataLoaded: userId => ensureDataLoaded(userId || 'moderator'),
  getOrders: userId => { const runtime = cacheForUser(userId || 'moderator'); return Array.isArray(runtime.asasOrders) ? runtime.asasOrders : []; },
});
const collectionPermissions = createCollectionPermissionsStore({
  file: path.join(LOCAL_DATA_ROOT, 'collection-permissions.json'),
  getProfiles: () => userAccess.collectionAccessMigrationProfiles(),
  getSharedSyncRoot: async () => (await syncSettings.read()).sharedSyncRoot,
});
// İzin önbelleği geçişini tamamlayana kadar eski açık inbound grantler yalnız
// geçici kaynak olarak kullanılır. Hazır olduğunda hesap yalnız owner→grantee
// deposundan yapılır; rol/hiyerarşi hiçbir kayıt açmaz.
userAccess.setCollectionAccessResolver(profile => collectionPermissions.isReady() ? collectionPermissions.effectiveOwners(profile.id) : null);
const collectionReplication = createCollectionReplication({
  workspaces: require('./lib/collection-workspaces'),
  permissions: collectionPermissions,
  getSharedSyncRoot: async () => (await syncSettings.read()).sharedSyncRoot,
  stateFile: path.join(LOCAL_DATA_ROOT, 'collection-replication-state.json'),
  onTrace: markStartup,
});
const collectionPermissionsReady = (async () => {
  await collectionPermissions.ensure();
  try { await collectionPermissions.sync(); } catch (error) { markStartup('COLLECTION_PERMISSION_SYNC_DEFERRED', { error: error && error.code || error && error.message || String(error) }); }
  const migrated = await collectionPermissions.migrateLegacyInboundAccess(userAccess.collectionAccessMigrationProfiles());
  markStartup('COLLECTION_PERMISSION_MIGRATION', migrated);
  return migrated;
})().catch(error => { logRuntimeFailure('collectionPermissionMigration', error); return null; });

const SHARED_COLLECTION_OWNER = collectionWorkspaces.SHARED_COLLECTION_OWNER;
let sharedHubBootstrapInFlight = null;
let sharedHubStartupSettled = false;
const userBootstrapReady = new Set();
let sharedHubBootstrapProgress = {
  configured:false, validated:false, loginAllowed:userAccess.canLoginLocally(), moderatorLoginAllowed:userAccess.canLoginLocally(), bootstrapRequired:!userAccess.hasLocalLoginSnapshot(),
  setupRecommended:false, status:'starting', offline:false, phase:'starting',
  message:'Buyer Log hazırlanıyor…',
  steps:{
    hub:{ status:'pending', label:'Shared Hub' },
    users:{ status:'pending', label:'Kullanıcılar ve yetkiler' },
    master:{ status:'pending', label:'Sistem ayarları' },
    business:{ status:'pending', label:'Ortak iş verileri' },
    collections:{ status:'pending', label:'Koleksiyonlar' },
  },
};
function setBootstrapStep(id, patch = {}) {
  sharedHubBootstrapProgress = {
    ...sharedHubBootstrapProgress,
    steps:{
      ...sharedHubBootstrapProgress.steps,
      [id]:{ ...(sharedHubBootstrapProgress.steps[id] || {}), ...patch },
    },
  };
}
function setBootstrapProgress(patch = {}) {
  sharedHubBootstrapProgress = { ...sharedHubBootstrapProgress, ...patch };
  return sharedHubBootstrapProgress;
}
function bootstrapStatusSnapshot(extra = {}) {
  return JSON.parse(JSON.stringify({
    ...sharedHubBootstrapProgress,
    moderatorLoginAllowed:userAccess.canLoginLocally(),
    ...extra,
  }));
}
function plainRecordPatch(record) {
  const out = {};
  for (const [key, value] of Object.entries(record && typeof record === 'object' ? record : {})) if (!key.startsWith('_')) out[key] = value;
  return out;
}
function checkpointRecords(snapshot) {
  return snapshot && snapshot.envelope && snapshot.envelope.payload
    && snapshot.envelope.payload.records && typeof snapshot.envelope.payload.records === 'object'
    ? snapshot.envelope.payload.records : {};
}
function checkpointUnaccountedIds(remoteRecords, localRecords, tombstones) {
  const local = localRecords && typeof localRecords === 'object' ? localRecords : {};
  const deleted = tombstones && typeof tombstones === 'object' ? tombstones : {};
  return Object.keys(remoteRecords && typeof remoteRecords === 'object' ? remoteRecords : {})
    .filter(id => !Object.hasOwn(local, id) && !Object.hasOwn(deleted, id));
}
function checkpointDocumentRevision(record) {
  const value = Number(record && record.storeRevisionMeta && record.storeRevisionMeta.revision);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function checkpointRecordClock(id, record) {
  const documentRevision = checkpointDocumentRevision(record);
  if (documentRevision != null) return { kind:'document', value:documentRevision };
  if (/^endeksmatik:/.test(String(id || ''))) {
    const snapshot = record && record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : record;
    const stamp = Date.parse(snapshot && (snapshot.generatedAt || snapshot.sourceUpdatedAt || snapshot.updatedAt) || '');
    if (Number.isFinite(stamp) && stamp > 0) return { kind:'time', value:stamp };
  }
  return { kind:'engine', value:Math.max(0, Number(record && record._revision) || 0) };
}
function checkpointRemoteAheadIds(remoteRecords, localRecords, tombstones) {
  const remote = remoteRecords && typeof remoteRecords === 'object' ? remoteRecords : {};
  const local = localRecords && typeof localRecords === 'object' ? localRecords : {};
  const deleted = tombstones && typeof tombstones === 'object' ? tombstones : {};
  const out = [];
  for (const [id, remoteRecord] of Object.entries(remote)) {
    if (Object.hasOwn(deleted, id) || !Object.hasOwn(local, id)) continue;
    const remoteClock = checkpointRecordClock(id, remoteRecord);
    const localClock = checkpointRecordClock(id, local[id]);
    if (remoteClock.kind === localClock.kind && remoteClock.value > localClock.value) out.push(id);
    else if (remoteClock.kind === 'document' && localClock.kind !== 'document' && remoteClock.value > 0) out.push(id);
    else if (remoteClock.kind === 'time' && localClock.kind !== 'time' && remoteClock.value > 0) out.push(id);
  }
  return out;
}
function checkpointRecoverableIds(remoteRecords, localRecords, tombstones) {
  return [...new Set([
    ...checkpointUnaccountedIds(remoteRecords, localRecords, tombstones),
    ...checkpointRemoteAheadIds(remoteRecords, localRecords, tombstones),
  ])];
}
async function guardCheckpointPublish(area, root, state, localRecords) {
  const read = area === 'master' ? sharedHub.readMaster : sharedHub.readBusiness;
  const remote = await read(root, null);
  if (!remote || remote.unchanged) return { safe:true, missing:[], stale:[], remoteRecords:0 };
  const remoteRecords = checkpointRecords(remote);
  const missing = checkpointUnaccountedIds(remoteRecords, localRecords, state && state.tombstones);
  const stale = checkpointRemoteAheadIds(remoteRecords, localRecords, state && state.tombstones);
  return { safe:missing.length === 0 && stale.length === 0, missing, stale, remoteRecords:Object.keys(remoteRecords).length, head:remote.head };
}
function changedMasterEntities(remoteRecords, localRecords, ids) {
  const remote = remoteRecords && typeof remoteRecords === 'object' ? remoteRecords : {};
  const local = localRecords && typeof localRecords === 'object' ? localRecords : {};
  const changed = new Set();
  const different = (a, b) => JSON.stringify(a == null ? null : a) !== JSON.stringify(b == null ? null : b);
  for (const id of Array.isArray(ids) ? ids : []) {
    const before = local[id], after = remote[id];
    if (id === 'store:overrides.json') {
      for (const field of ['pricingRules','transitRules','nonDtrManufacturers','landedMultipliers','freightRates','antrepoSourceMode','asasSourceMode','lflSourceMode','noteColumnDefs']) {
        if (different(before && before[field], after && after[field])) changed.add(field);
      }
      if (
        different(before && before.antrepoMatchRule, after && after.antrepoMatchRule) ||
        different(before && before.antrepoMatchConfig, after && after.antrepoMatchConfig) ||
        different(before && before.antrepoMatchConfigVersion, after && after.antrepoMatchConfigVersion)
      ) changed.add('antrepoMatchRule');
    } else if (id === 'store:fx-rates.json') changed.add('fx');
    else if (id === 'store:email-groups.json') changed.add('emailGroups');
    else if (id === 'store:settings.json') {
      changed.add('systemSettings');
      if (different(before && before.modelConnections, after && after.modelConnections)) changed.add('modelConnections');
    } else if (/^endeksmatik:/.test(String(id || ''))) changed.add('endeksmatik');
  }
  return [...changed];
}
function announceRecoveredMasterEntities(entities) {
  for (const entity of Array.isArray(entities) ? entities : []) {
    void sharedRevisionStore.update(entity, { actorId:'shared-hub-sync', deviceId:'sync' })
      .catch(error => logRuntimeFailure('sharedRevisionRecoveredMaster', error));
    liveEvents.notifyChange(entity, null, { source:'shared-hub-sync' });
  }
}

async function applyMissingCheckpointRecords(area, root, hub, state, remote) {
  if (!remote || remote.unchanged) return { applied:0, missing:0, stale:0, head:remote && remote.head || null, remoteRecords:0 };
  const remoteRecords = checkpointRecords(remote);
  const localRecords = area === 'master'
    ? sharedSyncPolicy.masterRecordsFromState(state)
    : sharedSyncPolicy.businessRecordsFromState(state);
  const missingIds = checkpointUnaccountedIds(remoteRecords, localRecords, state && state.tombstones);
  const staleIds = checkpointRemoteAheadIds(remoteRecords, localRecords, state && state.tombstones);
  const recoverIds = [...new Set([...missingIds, ...staleIds])];
  if (!recoverIds.length) return { applied:0, missing:0, stale:0, head:remote.head, remoteRecords:Object.keys(remoteRecords).length };
  const recoveredMasterEntities = area === 'master' ? changedMasterEntities(remoteRecords, localRecords, recoverIds) : [];
  // Recovery is a cache repair, not a new local edit. Copy the authoritative
  // checkpoint record directly so it does not create an outgoing journal item
  // that would simply echo the same recovery data back to Shared Hub.
  await localDb.transaction(async next => {
    next.records = next.records && typeof next.records === 'object' ? next.records : {};
    next.tombstones = next.tombstones && typeof next.tombstones === 'object' ? next.tombstones : {};
    for (const id of recoverIds) {
      // Ortak ayar kopyası yalnız ortak alanları taşır: yerel kayda birleşir
      // (cihaz/iş alanları korunur). İş kaydı checkpoint'in tam kopyasıdır.
      next.records[id] = area === 'master'
        ? sharedSyncPolicy.mergeCheckpointRecord(next.records[id], remoteRecords[id])
        : JSON.parse(JSON.stringify(remoteRecords[id]));
      next.revision = Math.max(Number(next.revision) || 0, sharedSyncPolicy.checkpointRecordRevision(remoteRecords[id]));
      delete next.tombstones[id];
    }
    next.causalKnowledge = sharedSyncPolicy.mergeKnowledge(next.causalKnowledge, sharedSyncPolicy.checkpointWriterKnowledge(Object.fromEntries(recoverIds.map(id => [id, remoteRecords[id]]))));
    return { recovered:recoverIds.length };
  });
  await deltaStore.hydrate();
  const after = await localDb.read();
  const afterRecords = area === 'master'
    ? sharedSyncPolicy.masterRecordsFromState(after)
    : sharedSyncPolicy.businessRecordsFromState(after);
  const remaining = checkpointRecoverableIds(remoteRecords, afterRecords, after.tombstones);
  if (remaining.length) {
    throw Object.assign(new Error(`Shared Hub ${area} checkpoint verisi yerel önbelleğe geri yüklenemedi.`), {
      code:'SHARED_HUB_DATA_INCOMPLETE', statusCode:503,
      details:{ area, remaining:remaining.slice(0,50) },
    });
  }
  if (area === 'master' && recoveredMasterEntities.length) announceRecoveredMasterEntities(recoveredMasterEntities);
  markStartup('SHARED_CHECKPOINT_REPAIRED', {
    area,
    records:recoverIds.length,
    missing:missingIds.length,
    stale:staleIds.length,
    revision:remote.head && remote.head.revision || 0,
  });
  return {
    applied:recoverIds.length,
    missing:missingIds.length,
    stale:staleIds.length,
    head:remote.head,
    remoteRecords:Object.keys(remoteRecords).length,
  };
}
async function reconcileSharedCheckpointCoverage(root, hub) {
  const state = await localDb.read();
  const [masterRemote, businessRemote] = await Promise.all([
    sharedHub.readMaster(root, null),
    sharedHub.readBusiness(root, null),
  ]);
  const master = await applyMissingCheckpointRecords('master', root, hub, state, masterRemote);
  const stateAfterMaster = master.applied ? await localDb.read() : state;
  const business = await applyMissingCheckpointRecords('business', root, hub, stateAfterMaster, businessRemote);
  return { master, business };
}
async function readJsonIfPresent(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch (_) { return null; }
}
async function findVerifiedPrewipeRecovery(root, hub) {
  const prewipeRoot = path.join(root, 'system-backups', 'prewipe');
  let entries = [];
  try { entries = await fs.promises.readdir(prewipeRoot, { withFileTypes:true }); } catch (_) { return null; }
  const folders = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  for (const folder of folders) {
    const recoveryRoot = path.join(prewipeRoot, folder);
    const [report, ready] = await Promise.all([
      readJsonIfPresent(path.join(recoveryRoot, 'critical-state.json')),
      readJsonIfPresent(path.join(recoveryRoot, 'DELETE-READY.json')),
    ]);
    if (!report || report.status !== 'DELETE_READY' || !ready || ready.status !== 'DELETE_READY') continue;
    if (report.sharedHub && report.sharedHub.hubId && String(report.sharedHub.hubId) !== String(hub.hubId)) continue;
    const expectedMaster = Math.max(0, Number(report.master && report.master.records) || 0);
    const expectedBusiness = Math.max(0, Number(report.business && report.business.records) || 0);
    if (!expectedMaster) continue;
    const filename = String(report.fullSystemBackup && report.fullSystemBackup.filename || '');
    if (!filename || path.basename(filename) !== filename) continue;
    const backupFile = path.join(recoveryRoot, filename);
    if (!fs.existsSync(backupFile)) continue;
    return { recoveryRoot, backupFile, report, expectedMaster, expectedBusiness };
  }
  return null;
}
async function loadPrewipeRecoveryRecords(candidate) {
  const info = await inspectBackupArchive(candidate.backupFile, { requireType:'full', validateData:true });
  const expectedSha = String(candidate.report.fullSystemBackup && candidate.report.fullSystemBackup.sha256 || '').toLowerCase();
  if (expectedSha && String(info.archiveSha256 || '').toLowerCase() !== expectedSha) {
    throw Object.assign(new Error('Pre-wipe Full System Backup SHA256 doğrulaması başarısız.'), { code:'PREWIPE_BACKUP_SHA_MISMATCH', statusCode:503 });
  }
  const tempRoot = await fs.promises.mkdtemp(path.join(TEMP_ROOT, 'buyerlog-prewipe-recovery-'));
  try {
    await extractBackupArchive(candidate.backupFile, tempRoot, { requireType:'full', preflight:info });
    const dbCandidates = [
      path.join(tempRoot, 'system', 'local-data', 'BuyerLogLocal.db'),
      path.join(tempRoot, 'system', 'local', 'BuyerLogLocal.db'),
    ];
    const dbFile = dbCandidates.find(file => fs.existsSync(file));
    const recoveredState = dbFile ? await createLocalDb(dbFile).read() : {};
    // Full backup sadece delta DB'yi değil, aynı anın legacy server-data
    // dosyalarını da taşır. Eski kurulumlarda Master kayıtlarının bir kısmı
    // yalnız settings/overrides/fx/email/endeksmatik dosyalarında olabilir.
    // İki kaynağı birleştirerek verified pre-wipe snapshot'ı yeniden kur.
    const masterRecords = prewipeMasterRecovery.loadMasterRecordsFromExtractedBackup(tempRoot, recoveredState);
    const businessRecords = prewipeMasterRecovery.loadBusinessRecordsFromExtractedBackup(tempRoot, recoveredState);
    return {
      masterRecords,
      businessRecords,
      syncHeads:recoveredState.syncCheckpoints || {},
      masterCoverage:prewipeMasterRecovery.masterCoverage(masterRecords),
      businessCoverage:prewipeMasterRecovery.businessCoverage(businessRecords),
      localDbFound:Boolean(dbFile),
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive:true, force:true }).catch(()=>{});
  }
}
function masterCheckpointInventory(snapshot) {
  const payload = snapshot && snapshot.envelope && snapshot.envelope.payload;
  return payload && payload.inventory && typeof payload.inventory === 'object' ? payload.inventory : null;
}
function masterCheckpointRecovery(snapshot) {
  const payload = snapshot && snapshot.envelope && snapshot.envelope.payload;
  return payload && payload.recovery && typeof payload.recovery === 'object' ? payload.recovery : null;
}
function prewipeRecoveryAlreadyDeepScanned(snapshot, candidate) {
  const recovery = masterCheckpointRecovery(snapshot);
  const expectedSha = String(candidate && candidate.report && candidate.report.fullSystemBackup && candidate.report.fullSystemBackup.sha256 || '').toLowerCase();
  return Boolean(
    recovery &&
    Number(recovery.schemaVersion || 0) >= 3 &&
    recovery.businessCoverage && typeof recovery.businessCoverage === 'object' &&
    expectedSha &&
    String(recovery.backupSha256 || '').toLowerCase() === expectedSha
  );
}
function masterCoverageMissing(expected, actual) {
  if (!expected || typeof expected !== 'object') return [];
  const current = actual && typeof actual === 'object' ? actual : {};
  const fields = [
    'records','modelConnections','royaltyRules','transitRules','nonDtrManufacturers',
    'landedMultipliers','freightRates','emailGroups','emailCountries','fxKeys','endeksmatikRecords',
  ];
  return fields.filter(field => Number(expected[field] || 0) > Number(current[field] || 0));
}
async function verifySharedMasterBootstrap(root) {
  const remote = await sharedHub.readMaster(root, null);
  const remoteRecords = checkpointRecords(remote);
  const state = await localDb.read();
  const localRecords = sharedSyncPolicy.masterRecordsFromState(state);
  const missing = checkpointRecoverableIds(remoteRecords, localRecords, state.tombstones);
  const expectedInventory = masterCheckpointInventory(remote);
  const localInventory = prewipeMasterRecovery.masterCoverage(localRecords);
  const coverageMissing = masterCoverageMissing(expectedInventory, localInventory);
  if (missing.length || coverageMissing.length) {
    throw Object.assign(new Error('Shared Hub sistem ayarları yerel önbelleğe eksiksiz alınamadı.'), {
      code:'SHARED_HUB_MASTER_INCOMPLETE',
      statusCode:503,
      details:{
        missingRecords:missing.slice(0,50),
        coverageMissing,
        remoteRecords:Object.keys(remoteRecords).length,
        localRecords:Object.keys(localRecords).length,
        expectedInventory,
        localInventory,
      },
    });
  }
  return {
    remoteRecords:Object.keys(remoteRecords).length,
    localRecords:Object.keys(localRecords).length,
    inventory:localInventory,
    head:remote && remote.head || null,
  };
}
const SHARED_BOOTSTRAP_INTEGRITY_ERRORS = new Set([
  'PREWIPE_BACKUP_SHA_MISMATCH',
  'PREWIPE_MASTER_INCOMPLETE',
  'SHARED_HUB_DATA_INCOMPLETE',
  'SHARED_HUB_MASTER_INCOMPLETE',
  'SHARED_HUB_PENDING_CHANGES',
]);

async function recoverEmptySharedHubFromPrewipe(root, hub) {
  const [masterRemote, businessRemote] = await Promise.all([
    sharedHub.readMaster(root, null),
    sharedHub.readBusiness(root, null),
  ]);
  const currentMaster = checkpointRecords(masterRemote);
  const currentBusiness = checkpointRecords(businessRemote);
  const currentMasterCount = Object.keys(currentMaster).length;
  const currentBusinessCount = Object.keys(currentBusiness).length;
  const candidate = await findVerifiedPrewipeRecovery(root, hub);
  if (!candidate) return { recovered:false, reason:'verified-prewipe-not-found', currentMasterCount, currentBusinessCount };
  const expectedMaster = Math.max(0, Number(candidate.expectedMaster) || 0);
  const publishedInventory = masterCheckpointInventory(masterRemote);
  if (prewipeRecoveryAlreadyDeepScanned(masterRemote, candidate)) {
    return { recovered:false, reason:'verified-prewipe-deep-scan-complete', currentMasterCount, currentBusinessCount, masterCoverage:publishedInventory };
  }

  // Record count alone is NOT enough. The real incident had three Master
  // records but overrides had already been emptied and Endeksmatik was absent.
  // The verified Full System Backup must be deeply inspected once against the
  // current Hub before we can declare recovery complete.
  const recovered = await loadPrewipeRecoveryRecords(candidate);
  const masterRecoverIds = prewipeMasterRecovery.masterRecoveryIds(recovered.masterRecords, currentMaster);
  // Collection kişisel restore ile ayrıca yönetilir. Pre-wipe recovery mevcut
  // Shared Collection'ı ASLA geri sarmaz. CP/Sipariş business kayıtlarında ise
  // sadece mevcut Shared Hub kaydında eksik/boş kalan alanlar tamamlanır:
  // yeni not/alt üretici/tarih değerleri backup tarafından ezilemez.
  const localRecoveryState = await localDb.read();
  const recoveredBusinessNoCollection = Object.fromEntries(
    Object.entries(recovered.businessRecords || {})
      .filter(([id]) => !/shared-collection/.test(String(id)))
  );
  const businessRecovery = prewipeMasterRecovery.mergeRecoveredBusinessRecords(
    currentBusiness,
    recoveredBusinessNoCollection,
    localRecoveryState.tombstones || {}
  );
  const businessRecoverIds = businessRecovery.ids;

  // Verified DELETE_READY raporu, wipe öncesinde Shared Master'ın kaç kayıt
  // taşıdığını söyler. Hub o sayının altındaysa veya legacy/full-backup içinde
  // daha zengin bir Master kaydı varsa bu normal bir "boş kurulum" değildir;
  // otomatik kurtarma gerekir.
  const masterShort = expectedMaster > 0 && currentMasterCount < expectedMaster;
  const recoveryScanNeedsPublish = !prewipeRecoveryAlreadyDeepScanned(masterRemote, candidate);
  if (!masterShort && !masterRecoverIds.length && !businessRecoverIds.length && !recoveryScanNeedsPublish) {
    return {
      recovered:false,
      reason:'checkpoint-complete',
      currentMasterCount,
      currentBusinessCount,
      recoveredCoverage:recovered.masterCoverage,
    };
  }

  await localDb.transaction(async next => {
    next.records = next.records && typeof next.records === 'object' ? next.records : {};
    next.tombstones = next.tombstones && typeof next.tombstones === 'object' ? next.tombstones : {};
    for (const id of masterRecoverIds) {
      next.records[id] = JSON.parse(JSON.stringify(recovered.masterRecords[id]));
      delete next.tombstones[id];
    }
    for (const id of businessRecoverIds) {
      next.records[id] = JSON.parse(JSON.stringify(businessRecovery.changed[id]));
    }
    return { master:masterRecoverIds.length, business:businessRecoverIds.length, businessFields:businessRecovery.fieldsAdded };
  });
  await deltaStore.hydrate();

  const state = await localDb.read();
  const masterRecords = sharedSyncPolicy.masterRecordsFromState(state);
  const businessRecords = sharedSyncPolicy.businessRecordsFromState(state);
  const finalCoverage = prewipeMasterRecovery.masterCoverage(masterRecords);
  const finalBusinessCoverage = prewipeMasterRecovery.businessCoverage(businessRecords);
  if (expectedMaster > 0 && Object.keys(masterRecords).length < expectedMaster) {
    throw Object.assign(new Error('Verified pre-wipe Master Data tam olarak geri yüklenemedi.'), {
      code:'PREWIPE_MASTER_INCOMPLETE',
      statusCode:503,
      details:{
        expected:expectedMaster,
        actual:Object.keys(masterRecords).length,
        recovered:Object.keys(recovered.masterRecords).length,
        coverage:finalCoverage,
      },
    });
  }

  const masterHead = await sharedHub.readMasterHead(root);
  const savedMaster = await sharedHub.publishMaster(root, {
    records:masterRecords,
    inventory:finalCoverage,
    recovery:{
      schemaVersion:3,
      source:path.basename(candidate.recoveryRoot),
      verifiedAt:candidate.report && candidate.report.verifiedAt || null,
      backupSha256:String(candidate.report && candidate.report.fullSystemBackup && candidate.report.fullSystemBackup.sha256 || '').toLowerCase(),
      coverage:finalCoverage,
      businessCoverage:finalBusinessCoverage,
      recoveredBusinessRecords:businessRecoverIds.length,
      recoveredBusinessFields:businessRecovery.fieldsAdded,
    },
  }, {
    actorId:'prewipe-auto-recovery',
    previousRevision:masterHead && masterHead.revision || 0,
  });

  let savedBusiness = null;
  if (businessRecoverIds.length) {
    const businessHead = await sharedHub.readBusinessHead(root);
    savedBusiness = await sharedHub.publishBusiness(root, { records:businessRecords, syncHeads:recovered.syncHeads }, {
      actorId:'prewipe-auto-recovery',
      previousRevision:businessHead && businessHead.revision || 0,
    });
  }

  markStartup('SHARED_PREWIPE_RECOVERED', {
    source:path.basename(candidate.recoveryRoot),
    master:masterRecoverIds.length,
    business:businessRecoverIds.length,
    businessFields:businessRecovery.fieldsAdded,
    masterCoverage:finalCoverage,
    businessCoverage:finalBusinessCoverage,
  });
  return {
    recovered:true,
    source:path.basename(candidate.recoveryRoot),
    masterRecords:masterRecoverIds.length,
    businessRecords:businessRecoverIds.length,
    businessFields:businessRecovery.fieldsAdded,
    masterCoverage:finalCoverage,
    businessCoverage:finalBusinessCoverage,
    masterHead:savedMaster && (savedMaster.head || savedMaster),
    businessHead:savedBusiness && (savedBusiness.head || savedBusiness),
  };
}
function portableDataRootForRecovery() {
  const explicit = String(process.env.BUYER_LOG_PORTABLE_DATA_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  const serverRoot = path.resolve(SERVER_DATA_ROOT);
  return path.basename(serverRoot).toLowerCase() === 'server' ? path.dirname(serverRoot) : null;
}
async function localLegacyDataBackupCandidates() {
  const dataRoot = portableDataRootForRecovery();
  if (!dataRoot) return [];
  const parent = path.dirname(dataRoot);
  let entries = [];
  try { entries = await fs.promises.readdir(parent, { withFileTypes:true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^data[-_ ]?backup(?:[-_ ].*)?$/i.test(entry.name)) continue;
    const root = path.join(parent, entry.name);
    if (path.resolve(root) === path.resolve(dataRoot)) continue;
    const serverRoot = path.join(root, 'server');
    const localDbFile = path.join(root, 'local', 'BuyerLogLocal.db');
    if (!fs.existsSync(serverRoot) && !fs.existsSync(localDbFile)) continue;
    let mtimeMs = 0;
    try { mtimeMs = Number((await fs.promises.stat(root)).mtimeMs) || 0; } catch (_) {}
    out.push({ root, name:entry.name, serverRoot, localDbFile, mtimeMs });
  }
  return out.sort((a,b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name, 'en'));
}
async function readLegacyDataBackupState(candidate) {
  if (!candidate || !candidate.localDbFile || !fs.existsSync(candidate.localDbFile)) return {};
  const tempRoot = await fs.promises.mkdtemp(path.join(TEMP_ROOT, 'buyerlog-legacy-data-recovery-'));
  try {
    const targetDb = path.join(tempRoot, 'BuyerLogLocal.db');
    await fs.promises.copyFile(candidate.localDbFile, targetDb);
    for (const suffix of ['-wal','-shm']) {
      const source = candidate.localDbFile + suffix;
      if (fs.existsSync(source)) await fs.promises.copyFile(source, targetDb + suffix);
    }
    return await createLocalDb(targetDb).read();
  } catch (error) {
    markStartup('LOCAL_DATA_BACKUP_DB_READ_FAILED', { source:candidate.name, error:String(error && error.message || error) });
    return {};
  } finally {
    await fs.promises.rm(tempRoot, { recursive:true, force:true }).catch(()=>{});
  }
}
function masterCoverageValue(coverage) {
  const c = coverage && typeof coverage === 'object' ? coverage : {};
  return (
    Number(c.modelConnections||0) * 5 +
    Number(c.royaltyRules||0) * 20 +
    Number(c.transitRules||0) * 5 +
    Number(c.nonDtrManufacturers||0) * 3 +
    Number(c.emailGroups||0) * 20 +
    Number(c.emailCountries||0) * 3 +
    Number(c.fxKeys||0) * 10 +
    Math.min(1000, Number(c.endeksmatikRecords||0)) +
    Number(c.records||0)
  );
}
async function loadLocalLegacyMasterCandidate(candidate) {
  const recoveredState = await readLegacyDataBackupState(candidate);
  const records = prewipeMasterRecovery.loadMasterRecordsFromLegacyDataRoot(candidate.root, recoveredState);
  return {
    ...candidate,
    records,
    coverage:prewipeMasterRecovery.masterCoverage(records),
  };
}
function masterCoverageIsCatastrophicallySparse(coverage) {
  const c = coverage && typeof coverage === 'object' ? coverage : {};
  const critical = [
    Number(c.modelConnections||0),
    Number(c.royaltyRules||0),
    Number(c.emailGroups||0),
    Number(c.fxKeys||0),
    Number(c.endeksmatikRecords||0),
  ];
  return critical.filter(value => value <= 0).length >= 4;
}
async function recoverSharedMasterFromLocalDataBackup(root) {
  const remote = await sharedHub.readMaster(root, null);
  const currentMaster = checkpointRecords(remote);
  const currentCoverage = prewipeMasterRecovery.masterCoverage(currentMaster);
  const catastrophicMaster = masterCoverageIsCatastrophicallySparse(currentCoverage);
  const emailId = 'store:email-groups.json';
  const currentEmail = currentMaster[emailId] || null;

  /* data-BACKUP-* normalde yalnız katastrofik boş Master için otomatik
     kaynaktır. E-posta rehberi tek başına kaybolduğunda ise diğer sağlıklı
     Master aileleri bu kapıyı kapatıyordu. Bu nedenle ikinci, dar bir yol var:
     sadece e-posta belgesi kendi revizyonu ve kapsamıyla açıkça daha zenginse
     geri alınır. Başka hiçbir Master ailesi bu dar yoldan değiştirilemez. */
  const candidates = await localLegacyDataBackupCandidates();
  if (!candidates.length) return { recovered:false, reason:'local-data-backup-not-found', currentCoverage };

  let selected = null;
  for (const candidate of candidates.slice(0, 12)) {
    const loaded = await loadLocalLegacyMasterCandidate(candidate);
    let ids = [];
    let recoveredEmail = null;
    if (catastrophicMaster) {
      ids = prewipeMasterRecovery.masterRecoveryIds(loaded.records, currentMaster);
    } else {
      const candidateEmail = loaded.records && loaded.records[emailId];
      if (prewipeMasterRecovery.safeFocusedEmailRecovery(candidateEmail, currentEmail)) {
        ids = [emailId];
        recoveredEmail = prewipeMasterRecovery.mergeEmailDirectoryRecovery(currentEmail, candidateEmail);
      }
    }
    if (!ids.length) continue;
    const emailStats = prewipeMasterRecovery.emailDirectoryStats(recoveredEmail || loaded.records[emailId]);
    const score = catastrophicMaster
      ? masterCoverageValue(loaded.coverage)
      : emailStats.records * 20 + emailStats.recipients * 10 + emailStats.countries * 3 + emailStats.types * 3;
    if (!selected || score > selected.score || (score === selected.score && loaded.mtimeMs > selected.mtimeMs)) {
      selected = { ...loaded, ids, score, recoveredEmail };
    }
  }
  if (!selected) {
    return {
      recovered:false,
      reason:catastrophicMaster ? 'local-data-backup-has-no-richer-master' : 'local-data-backup-has-no-richer-email-directory',
      currentCoverage,
      candidates:candidates.length,
    };
  }

  await localDb.transaction(async next => {
    next.records = next.records && typeof next.records === 'object' ? next.records : {};
    next.tombstones = next.tombstones && typeof next.tombstones === 'object' ? next.tombstones : {};
    for (const id of selected.ids) {
      const value = id === emailId && selected.recoveredEmail ? selected.recoveredEmail : selected.records[id];
      next.records[id] = JSON.parse(JSON.stringify(value));
      delete next.tombstones[id];
    }
    return { recovered:selected.ids.length };
  });
  await deltaStore.hydrate();

  const state = await localDb.read();
  const masterRecords = sharedSyncPolicy.masterRecordsFromState(state);
  const finalCoverage = prewipeMasterRecovery.masterCoverage(masterRecords);
  const head = await sharedHub.readMasterHead(root);
  const saved = await sharedHub.publishMaster(root, {
    records:masterRecords,
    inventory:finalCoverage,
    recovery:{
      source:'local-data-backup:' + selected.name,
      recoveredAt:new Date().toISOString(),
      coverage:finalCoverage,
    },
  }, {
    actorId:'local-data-backup-auto-recovery',
    previousRevision:head && head.revision || 0,
  });
  markStartup('SHARED_LOCAL_DATA_BACKUP_RECOVERED', {
    source:selected.name,
    records:selected.ids.length,
    ids:selected.ids,
    coverage:finalCoverage,
  });
  return {
    recovered:true,
    source:selected.name,
    masterRecords:selected.ids.length,
    masterCoverage:finalCoverage,
    ids:selected.ids,
    head:saved && (saved.head || saved),
  };
}

async function publishMasterCheckpoint(actorId = '') {
  const settings = await syncSettings.read();
  if (!settings.sharedSyncRoot) return { published:false, reason:'not-configured' };
  const checked = await sharedHub.validate(settings.sharedSyncRoot, { requireWrite:true });
  const state = await localDb.read();
  const records = sharedSyncPolicy.masterRecordsFromState(state);
  const head = await sharedHub.readMasterHead(checked.root);
  const guard = head ? await guardCheckpointPublish('master', checked.root, state, records) : { safe:true, missing:[] };
  if (!guard.safe) {
    markStartup('SHARED_CHECKPOINT_PUBLISH_PROTECTED', { area:'master', missing:guard.missing.length, stale:guard.stale.length, localRecords:Object.keys(records).length, remoteRecords:guard.remoteRecords });
    return { published:false, protected:true, reason:'local-master-incomplete', head, hub:checked.manifest, records:Object.keys(records).length, missingRecords:guard.missing.slice(0,50), staleRecords:guard.stale.slice(0,50) };
  }
  const saved = await sharedHub.publishMaster(checked.root, {
    records,
    inventory:prewipeMasterRecovery.masterCoverage(records),
  }, { actorId, previousRevision: head && head.revision || 0 });
  return { published:true, unchanged:saved && saved.unchanged === true, head:saved, hub:checked.manifest, records:Object.keys(records).length };
}
let masterCheckpointTimer = null;
let masterCheckpointPending = false;
let masterCheckpointActor = '';
function scheduleMasterCheckpointPublish(actorId = '', delayMs = 1500) {
  masterCheckpointPending = true;
  if (actorId) masterCheckpointActor = String(actorId).slice(0,160);
  if (masterCheckpointTimer) return;
  masterCheckpointTimer = setTimeout(async () => {
    masterCheckpointTimer = null;
    if (!masterCheckpointPending) return;
    masterCheckpointPending = false;
    const actor = masterCheckpointActor; masterCheckpointActor = '';
    try {
      if (typeof deltaStore.flush === 'function') await deltaStore.flush();
      await syncSettings.syncOnce().catch(()=>null);
      await deltaStore.hydrate();
      await publishMasterCheckpoint(actor);
    } catch (error) {
      if (error && error.code === 'MASTER_REVISION_CONFLICT') {
        try {
          if (typeof deltaStore.flush === 'function') await deltaStore.flush();
          await syncSettings.syncOnce().catch(()=>null);
          await deltaStore.hydrate();
          await publishMasterCheckpoint(actor);
          return;
        } catch (retryError) { error = retryError; }
      }
      masterCheckpointPending = true;
      logRuntimeFailure('masterCheckpointBackground', error);
      if (!masterCheckpointTimer) {
        masterCheckpointTimer = setTimeout(() => { masterCheckpointTimer = null; scheduleMasterCheckpointPublish('', 250); }, 30000);
        masterCheckpointTimer.unref?.();
      }
    }
  }, Math.max(250, Number(delayMs)||1500));
  masterCheckpointTimer.unref?.();
}
async function readSharedSyncHeads(root) {
  const changesRoot=path.join(root,'BUYER_LOG_SYNC','changes'),out={};
  let entries=[];try{entries=await fs.promises.readdir(changesRoot,{withFileTypes:true});}catch(_){return out;}
  for(const entry of entries.slice(0,500)){
    if(!entry.isDirectory())continue;
    let deviceId='';try{deviceId=decodeURIComponent(entry.name);}catch(_){deviceId=entry.name;}
    try{
      const head=JSON.parse(await fs.promises.readFile(path.join(changesRoot,entry.name,'_head.json'),'utf8'));
      const seq=Math.max(0,Number(head&&head.latestSequence)||0);if(deviceId&&seq)out[deviceId]=seq;
    }catch(_){}
  }
  return out;
}
async function publishBusinessCheckpoint(actorId='') {
  const settings=await syncSettings.read();
  if(!settings.sharedSyncRoot)return {published:false,reason:'not-configured'};
  const checked=await sharedHub.validate(settings.sharedSyncRoot,{requireWrite:true});
  const state=await localDb.read(),records=sharedSyncPolicy.businessRecordsFromState(state),syncHeads=await readSharedSyncHeads(checked.root);
  const head=await sharedHub.readBusinessHead(checked.root);
  const guard=head?await guardCheckpointPublish('business',checked.root,state,records):{safe:true,missing:[]};
  if(!guard.safe){
    markStartup('SHARED_CHECKPOINT_PUBLISH_PROTECTED',{area:'business',missing:guard.missing.length,stale:guard.stale.length,localRecords:Object.keys(records).length,remoteRecords:guard.remoteRecords});
    return {published:false,protected:true,reason:'local-business-incomplete',head,hub:checked.manifest,records:Object.keys(records).length,syncHeads:Object.keys(syncHeads).length,missingRecords:guard.missing.slice(0,50),staleRecords:guard.stale.slice(0,50)};
  }
  const saved=await sharedHub.publishBusiness(checked.root,{records,syncHeads},{actorId,previousRevision:head&&head.revision||0});
  return {published:true,unchanged:saved&&saved.unchanged===true,head:saved,hub:checked.manifest,records:Object.keys(records).length,syncHeads:Object.keys(syncHeads).length};
}
let businessCheckpointTimer=null;
function scheduleBusinessCheckpointPublish(actorId='',delayMs=5000){
  if(businessCheckpointTimer)return;
  businessCheckpointTimer=setTimeout(async()=>{
    businessCheckpointTimer=null;
    try{await publishBusinessCheckpoint(actorId);}catch(error){logRuntimeFailure('businessCheckpointBackground',error);}
  },Math.max(1000,Number(delayMs)||5000));
  businessCheckpointTimer.unref?.();
}
async function hydrateBusinessCheckpointIfNeeded(){
  const settings=await syncSettings.read();if(!settings.sharedSyncRoot)return {applied:0,reason:'not-configured'};
  const checked=await sharedHub.validate(settings.sharedSyncRoot,{requireWrite:false});
  const localState=sharedHub.readLocalState();if(!localState||localState.hubId!==checked.manifest.hubId)return {applied:0,reason:'hub-not-bootstrapped'};
  const head=await sharedHub.readBusinessHead(checked.root);if(!head)return {applied:0,reason:'not-initialized'};
  if((Number(localState.businessRevision)||0)===head.revision)return {applied:0,unchanged:true,head};
  if((await localDb.pendingCount())>0)return {applied:0,deferred:true,reason:'pending-local-changes'};
  const snapshot=await sharedHub.readBusiness(checked.root,Number(localState.businessRevision)||0);
  if(!snapshot||snapshot.unchanged)return {applied:0,unchanged:true,head:snapshot&&snapshot.head||head};
  const payload=snapshot.envelope&&snapshot.envelope.payload||{},syncHeads=payload.syncHeads&&typeof payload.syncHeads==='object'?payload.syncHeads:{};

  // A checkpoint is a recovery accelerator, not permission to roll local
  // business state backwards. syncOnce() has already applied field deltas
  // before this point, so a freshly deleted note can legitimately be newer
  // than the last published checkpoint. Recover only records that are absent
  // locally or whose checkpoint clock is actually newer. Never delete local
  // business records merely because an older snapshot does not contain them.
  const before=await localDb.read();
  const repair=await applyMissingCheckpointRecords('business',checked.root,checked.manifest,before,snapshot);
  await localDb.transaction(async next=>{
    next.syncCheckpoints=next.syncCheckpoints&&typeof next.syncCheckpoints==='object'?next.syncCheckpoints:{};
    for(const [deviceId,seq] of Object.entries(syncHeads))next.syncCheckpoints[deviceId]=Math.max(Number(next.syncCheckpoints[deviceId])||0,Number(seq)||0);
    return {syncHeads:Object.keys(syncHeads).length};
  });
  await sharedHub.markBootstrap({root:checked.root,hubId:checked.manifest.hubId,masterRevision:localState.masterRevision||0,businessRevision:snapshot.head.revision,iamRevision:localState.iamRevision||0,completed:true});
  if(repair.applied){try{liveEvents.notifyChange('collection-workspaces',null);liveEvents.notifyChange('orders',null);liveEvents.notifyChange('overrides',null);}catch(_){}}
  return {applied:repair.applied||0,removed:0,head:snapshot.head,recoveredFrom:snapshot.recoveredFrom||null};
}
async function applyMasterCheckpoint(root, hub, localState) {
  const currentRevision = localState && localState.hubId === hub.hubId ? Number(localState.masterRevision) || 0 : 0;
  const result = await sharedHub.readMaster(root, currentRevision);
  if (!result) throw Object.assign(new Error('Shared Hub Master Data checkpoint bulunamadı.'), { code:'MASTER_NOT_INITIALIZED', statusCode:409 });
  if (result.unchanged) return { applied:0, head:result.head };
  const records = result.envelope && result.envelope.payload && result.envelope.payload.records || {};
  const sourceDeviceId = `shared-hub-master-${hub.hubId}`;
  const events = Object.entries(records).map(([id, record], index) => ({
    id, entityType:String(id).split(':')[0] || 'store', patch:plainRecordPatch(record),
    revision:Math.max(1, Number(result.head.revision) || 1), baseRevision:0,
    deviceId:sourceDeviceId, localSequence:index + 1,
    eventId:`master:${hub.hubId}:${result.head.revision}:${crypto.createHash('sha256').update(id).digest('hex').slice(0,20)}`,
    origin:'shared-master-bootstrap',
  }));
  const applied = await localDb.applyDeltas(events);
  await deltaStore.hydrate();
  return { applied:applied.applied, conflicts:applied.conflicts.length, head:result.head };
}
async function activateSharedHubRuntime({ migrateCollection = true, actorId = '' } = {}) {
  deltaStore.setMode('delta');
  await deltaStore.hydrate();
  // Existing CP maps are split once into row-level shared records. The legacy
  // overrides projection remains in place for renderer/business compatibility.
  const cpSeed = await cpSharedStore.seedFromOverrides(loadOverrides(), { actor: { id: actorId } });
  if (cpSeed && cpSeed.seeded) markStartup('CP_SHARED_SEEDED', { rows: cpSeed.seeded });
  if (migrateCollection) {
    // Shared Hub is a TRANSPORT for Collection owner workspaces, not a new
    // owner. Permissions/replication remain owner-scoped; the historical
    // shared-collection file is retained only as recovery evidence.
    markStartup('COLLECTION_OWNER_REPLICATION_READY', { mode:'owner-scoped', actorId:String(actorId || '') });
  }
}
async function bootstrapSharedHub({ force = false } = {}) {
  if (sharedHubBootstrapInFlight && !force) return sharedHubBootstrapInFlight;
  const gateThisRun = force || !sharedHubStartupSettled;
  if (gateThisRun) {
    sharedHubStartupSettled = false;
    sharedHubBootstrapProgress = {
      configured:false, validated:false, loginAllowed:userAccess.canLoginLocally(), moderatorLoginAllowed:userAccess.canLoginLocally(), bootstrapRequired:!userAccess.hasLocalLoginSnapshot(),
      setupRecommended:false, status:'syncing', offline:false, phase:'hub',
      message:'Buyer Log hazırlanıyor…',
      steps:{
        hub:{ status:'active', label:'Shared Hub' },
        users:{ status:'pending', label:'Kullanıcılar ve yetkiler' },
        master:{ status:'pending', label:'Sistem ayarları' },
        business:{ status:'pending', label:'Ortak iş verileri' },
        collections:{ status:'pending', label:'Koleksiyonlar' },
      },
    };
  }
  sharedHubBootstrapInFlight = (async () => {
    const settings = await syncSettings.read();
    const hadLocalLoginSnapshot = userAccess.hasLocalLoginSnapshot();
    const localLoginAllowed = userAccess.canLoginLocally();
    const localState = sharedHub.readLocalState();

    if (!settings.sharedSyncRoot) {
      const result = {
        configured:false,
        loginAllowed:localLoginAllowed,
        moderatorLoginAllowed:localLoginAllowed,
        bootstrapRequired:!hadLocalLoginSnapshot,
        setupRecommended:true,
        status:'not-configured',
        offline:false,
        phase:'hub',
        message:localLoginAllowed
          ? 'Shared Hub henüz ayarlanmadı. Mevcut yerel hesapla giriş yapılabilir.'
          : 'İlk kullanım için Buyer Log Shared Hub klasörünü seçin.',
      };
      sharedHubStartupSettled = true;
      setBootstrapProgress(result);
      setBootstrapStep('hub', { status:'waiting', detail:'Klasör seçimi bekleniyor' });
      return bootstrapStatusSnapshot();
    }

    // Only a configured Shared Hub needs the legacy→delta seed pass as a
    // bootstrap prerequisite. Local-only/test sessions keep the existing fast
    // login path and let maintenance remain background work.
    await ensureLocalDbMaintenanceReady();

    try {
      setBootstrapProgress({ configured:true, status:'syncing', phase:'hub', loginAllowed:localLoginAllowed, moderatorLoginAllowed:localLoginAllowed, bootstrapRequired:!hadLocalLoginSnapshot, message:'Shared Hub doğrulanıyor… · Girişe engel değil' });
      const checked = await sharedHub.validate(settings.sharedSyncRoot, { requireWrite:false });
      setBootstrapProgress({ validated:true, hub:{ hubId:checked.manifest.hubId, schemaVersion:checked.manifest.schemaVersion } });
      setBootstrapStep('hub', { status:'done', detail:'Bağlandı' });

      setBootstrapProgress({ phase:'users', message:'Kullanıcılar ve yetkiler eşitleniyor…' });
      setBootstrapStep('users', { status:'active' });
      userAccess.enableCentralIam();
      const sameCompletedHub = localState && localState.completed === true && localState.hubId === checked.manifest.hubId;
      const iam = await userAccess.refreshIam({ allowBootstrapPlaceholderReplace:!sameCompletedHub, timeoutMs:30000 });
      const iamHealth = userAccess.centralIamHealth();
      if (!iam && !sameCompletedHub && !userAccess.hasLocalLoginSnapshot()) {
        throw Object.assign(new Error('Kullanıcı verileri Shared Hub’dan alınamadı.'), { code:iamHealth.lastError || 'IAM_BOOTSTRAP_FAILED', statusCode:503 });
      }
      const profiles = userAccess.allPublicProfiles();
      const activeProfiles = profiles.filter(profile => profile && profile.enabled !== false);
      setBootstrapStep('users', { status:'done', current:profiles.length, total:profiles.length, detail:`${profiles.length} kullanıcı · ${activeProfiles.length} aktif` });

      setBootstrapProgress({ phase:'master', message:'Sistem ayarları eşitleniyor…' });
      setBootstrapStep('master', { status:'active' });
      let master = { applied:0, head:null };
      const firstHubBootstrap = !sameCompletedHub;
      if (firstHubBootstrap) {
        const pendingBeforeBootstrap = await localDb.pendingCount();
        if (pendingBeforeBootstrap > 0) {
          // A verified same-Hub pre-wipe recovery is a special clean-install
          // case: local pending events must be PRESERVED and synced, not used to
          // lock the user out forever before the recovery code can even run.
          // Without recovery evidence the original fail-closed guard remains.
          const recoveryCandidate = await findVerifiedPrewipeRecovery(checked.root, checked.manifest);
          if (!recoveryCandidate) {
            throw Object.assign(new Error('İlk Shared Hub eşitlemesinden önce bekleyen yerel değişiklikler var.'), { code:'SHARED_HUB_PENDING_CHANGES', statusCode:409 });
          }
          markStartup('SHARED_HUB_PENDING_CHANGES_RECOVERY_CONTINUE', {
            pending:pendingBeforeBootstrap,
            source:path.basename(recoveryCandidate.recoveryRoot),
          });
          setBootstrapStep('master', {
            status:'active',
            detail:`${pendingBeforeBootstrap} yerel değişiklik korunuyor · doğrulanmış recovery ile devam`,
          });
        }
        master = await applyMasterCheckpoint(checked.root, checked.manifest, localState);
      }
      let masterHead = master.head || await sharedHub.readMasterHead(checked.root);
      setBootstrapStep('master', { status:'done', current:masterHead && masterHead.revision || 0, total:masterHead && masterHead.revision || 0, detail:masterHead ? `rev ${masterHead.revision}` : 'Yerel veri kullanılıyor' });

      const businessHead = await sharedHub.readBusinessHead(checked.root);
      await activateSharedHubRuntime({ migrateCollection:!businessHead, actorId:'bootstrap' });

      const provisionalIam = userAccess.centralIamHealth();
      await sharedHub.markBootstrap({
        root:checked.root,
        hubId:checked.manifest.hubId,
        masterRevision:masterHead && masterHead.revision || localState && localState.masterRevision || 0,
        businessRevision:localState && localState.businessRevision || 0,
        iamRevision:provisionalIam.localRevision || userAccess.localIamRevision(),
        completed:false,
      });

      setBootstrapProgress({ phase:'business', message:'Ortak iş verileri eşitleniyor…' });
      setBootstrapStep('business', { status:'active' });
      const syncResult = await syncSettings.syncOnce();
      if (!syncResult || syncResult.online !== true || (await localDb.pendingCount()) !== 0) {
        throw Object.assign(new Error('Shared Hub iş verisi senkronizasyonu tamamlanmadı.'), { code:'SHARED_HUB_SYNC_INCOMPLETE', statusCode:503 });
      }
      await deltaStore.hydrate();
      // If the current Hub checkpoint was accidentally reduced to an empty
      // Master snapshot during clean-install bootstrap, recover the exact
      // verified DELETE_READY pre-wipe snapshot before business hydration can
      // replace richer recovery data with the sparse remote checkpoint.
      const prewipeRecovery = await recoverEmptySharedHubFromPrewipe(checked.root, checked.manifest);
      if (prewipeRecovery.recovered) masterHead = await sharedHub.readMasterHead(checked.root);
      // Eski temiz kurulum akışında yerel veri klasörü data-BACKUP-* adıyla
      // korunmuş olabilir. Verified pre-wipe paketi yoksa veya eksikse bu
      // klasör yalnız Master Data için güvenli ikinci kaynak olur. Collection
      // bu yola hiç dahil edilmez.
      const localDataRecovery = await recoverSharedMasterFromLocalDataBackup(checked.root);
      if (localDataRecovery.recovered) masterHead = await sharedHub.readMasterHead(checked.root);
      const business = await hydrateBusinessCheckpointIfNeeded();
      // Revision metadata alone is not proof that the local cache actually
      // contains the checkpoint payload. Repair any remote records that are
      // absent locally (unless a local tombstone proves an intentional delete).
      const checkpointRepair = await reconcileSharedCheckpointCoverage(checked.root, checked.manifest);
      const masterVerification = await verifySharedMasterBootstrap(checked.root);
      const verifiedState = await localDb.read();
      const verifiedMasterRecords = sharedSyncPolicy.masterRecordsFromState(verifiedState);
      const verifiedBusinessRecords = sharedSyncPolicy.businessRecordsFromState(verifiedState);
      setBootstrapStep('master', {
        status:'done',
        current:masterVerification.localRecords,
        total:masterVerification.remoteRecords,
        detail:`rev ${masterHead && masterHead.revision || 0} · ${masterVerification.localRecords}/${masterVerification.remoteRecords} kayıt · Royalty ${masterVerification.inventory.royaltyRules} · E-mail ${masterVerification.inventory.emailGroups} · FX ${masterVerification.inventory.fxKeys} · Endeksmatik ${masterVerification.inventory.endeksmatikRecords}`,
      });
      const businessAfter = sharedHub.readLocalState();
      setBootstrapStep('business', {
        status:'done',
        current:businessAfter && businessAfter.businessRevision || business && business.head && business.head.revision || 0,
        total:businessAfter && businessAfter.businessRevision || business && business.head && business.head.revision || 0,
        detail:businessAfter && businessAfter.businessRevision
          ? `rev ${businessAfter.businessRevision} · geri yüklenen ${Number(checkpointRepair.master.applied||0)+Number(checkpointRepair.business.applied||0)+Number(prewipeRecovery.masterRecords||0)+Number(prewipeRecovery.businessRecords||0)+Number(localDataRecovery.masterRecords||0)} kayıt · local M/B ${Object.keys(verifiedMasterRecords).length}/${Object.keys(verifiedBusinessRecords).length}`
          : 'Güncel',
      });

      setBootstrapProgress({ phase:'collections', message:'Koleksiyon izinleri eşitleniyor…' });
      setBootstrapStep('collections', { status:'active' });
      await collectionPermissionsReady;
      const permissionSync = await collectionPermissions.sync();
      const permissionState = permissionSync && permissionSync.state || await collectionPermissions.read();
      setBootstrapStep('collections', {
        status:'done',
        current:Array.isArray(permissionState && permissionState.grants) ? permissionState.grants.length : 0,
        total:Array.isArray(permissionState && permissionState.grants) ? permissionState.grants.length : 0,
        detail:`${Array.isArray(permissionState && permissionState.grants) ? permissionState.grants.length : 0} paylaşım yetkisi`,
      });

      const finalIam = userAccess.centralIamHealth();
      const currentBootstrap = sharedHub.readLocalState();
      const marked = await sharedHub.markBootstrap({
        root:checked.root,
        hubId:checked.manifest.hubId,
        masterRevision:masterHead && masterHead.revision || currentBootstrap && currentBootstrap.masterRevision || 0,
        businessRevision:currentBootstrap && currentBootstrap.businessRevision || businessHead && businessHead.revision || 0,
        iamRevision:finalIam.localRevision || userAccess.localIamRevision(),
        completed:true,
      });
      const result = {
        configured:true,
        validated:true,
        loginAllowed:userAccess.canLoginLocally(),
        bootstrapRequired:false,
        setupRecommended:false,
        status:'ready',
        phase:'ready',
        message:'Senkronizasyon tamamlandı · Buyer Log hazır',
        hub:{ hubId:checked.manifest.hubId, schemaVersion:checked.manifest.schemaVersion },
        masterRevision:marked.masterRevision,
        businessRevision:marked.businessRevision,
        iamRevision:marked.iamRevision,
        dataInventory:{
          localMasterRecords:Object.keys(verifiedMasterRecords).length,
          localBusinessRecords:Object.keys(verifiedBusinessRecords).length,
          remoteMasterRecords:Number(checkpointRepair.master.remoteRecords)||0,
          remoteBusinessRecords:Number(checkpointRepair.business.remoteRecords)||0,
          repairedMasterRecords:Number(checkpointRepair.master.applied)||0,
          repairedBusinessRecords:Number(checkpointRepair.business.applied)||0,
          staleMasterRecords:Number(checkpointRepair.master.stale)||0,
          staleBusinessRecords:Number(checkpointRepair.business.stale)||0,
          prewipeRecovered:Boolean(prewipeRecovery.recovered),
          prewipeRecoverySource:prewipeRecovery.source || null,
          prewipeRecoveredMasterRecords:Number(prewipeRecovery.masterRecords)||0,
          prewipeRecoveredBusinessRecords:Number(prewipeRecovery.businessRecords)||0,
          localDataBackupRecovered:Boolean(localDataRecovery.recovered),
          localDataBackupRecoverySource:localDataRecovery.source || null,
          localDataBackupRecoveredMasterRecords:Number(localDataRecovery.masterRecords)||0,
          masterCoverage:masterVerification.inventory,
        },
        offline:false,
      };
      sharedHubStartupSettled = true;
      setBootstrapProgress(result);
      return bootstrapStatusSnapshot();
    } catch (error) {
      const completed = localState && localState.completed === true && hadLocalLoginSnapshot;
      const integrityFailure = SHARED_BOOTSTRAP_INTEGRITY_ERRORS.has(String(error && error.code || ''));
      if (completed && localLoginAllowed && !integrityFailure) {
        await activateSharedHubRuntime({ migrateCollection:false }).catch(()=>{});
        const result = {
          configured:true, validated:false, loginAllowed:true, bootstrapRequired:false,
          setupRecommended:true, status:'offline', phase:'offline', offline:true,
          errorCode:error && error.code || 'SHARED_HUB_UNAVAILABLE',
          message:'Shared Hub’a ulaşılamıyor. Son doğrulanmış yerel verilerle çevrimdışı çalışabilirsiniz.',
          lastBootstrap:localState && localState.completedAt || null,
        };
        sharedHubStartupSettled = true;
        setBootstrapProgress(result);
        return bootstrapStatusSnapshot();
      }
      const result = {
        configured:true, validated:false, loginAllowed:localLoginAllowed, moderatorLoginAllowed:localLoginAllowed, bootstrapRequired:!hadLocalLoginSnapshot,
        status:'error', phase:'error', offline:false,
        errorCode:error && error.code || 'SHARED_HUB_BOOTSTRAP_FAILED',
        message:(error && error.message || 'Shared Hub bootstrap tamamlanamadı.') + (localLoginAllowed ? ' · Yerel hesapla giriş yapılabilir; eşitleme daha sonra devam eder.' : ''),
      };
      sharedHubStartupSettled = true;
      setBootstrapProgress(result);
      return bootstrapStatusSnapshot();
    }
  })().finally(() => { sharedHubBootstrapInFlight = null; });
  return sharedHubBootstrapInFlight;
}

// Local auth starts first. Shared-folder I/O is asynchronous and never sits on
// the ordinary authorization path. A configured Hub is reconciled in the
// background; a first-run device is gated by the pre-login bootstrap endpoint.
setImmediate(() => { void bootstrapSharedHub().then(result => markStartup('SHARED_HUB_BOOTSTRAP', { status:result.status, loginAllowed:result.loginAllowed })).catch(error => logRuntimeFailure('sharedHubBootstrap', error)); });
const iamPollTimer = setInterval(() => { void bootstrapSharedHub().catch(()=>{}); }, 45000);
iamPollTimer.unref();
// Generic Master Data stores are written through several existing routes. This
// low-frequency safety net keeps the bootstrap checkpoint fresh without turning
// normal sync into network polling; unchanged payloads are content-deduplicated.
const masterCheckpointReconcileTimer = setInterval(() => scheduleMasterCheckpointPublish('', 750), 300000);
masterCheckpointReconcileTimer.unref();
syncSettings.onStateChange(state => {
  if (state && state.lastSync && !state.progress) {
    void bootstrapSharedHub().catch(()=>{});
    scheduleBusinessCheckpointPublish('',5000);
  }
});
const backupService = createBackupService({ appVersion: APP_VERSION, userAccess, syncSettings, localDb });
const sharedPersonalBackupService = createSharedPersonalBackupService({ backupService, syncSettings, sharedHub, retentionCount: 30 });
const userRestoreService = createUserRestoreService();
const userRestoreUploads = new Map(), userRestoreJobs = new Map();
// Full System Restore state is intentionally separate from ordinary backup jobs:
// upload/inspect can run without a write lock, while the apply phase gates all
// restore-aware writes and Central IAM refreshes.
const systemRestoreState = { writeLocked: false, fullRestoreLocked:false, legacyRestoreLocked:false, commitStarted: false, restoreId: null };
function refreshSystemRestoreWriteLock() {
  systemRestoreState.writeLocked = Boolean(systemRestoreState.fullRestoreLocked || systemRestoreState.legacyRestoreLocked);
  return systemRestoreState.writeLocked;
}
const fullRestoreUploads = new Map(), fullRestoreJobs = new Map();
const fullRestoreRoots = {
  ...dataRoots,
  localDbFile: LOCAL_DB_FILE,
  configPath: CONFIG_PATH,
  qtxFilesRoot: path.join(LOCAL_DATA_ROOT, 'qtx-files'),
};
const fullRestoreService = createFullRestoreService({
  appVersion: APP_VERSION, roots: fullRestoreRoots, localDb, syncSettings, userAccess, backupService, securityFile: ACCESS_FILE,
  onWriteLockState: (locked, restoreId) => {
    systemRestoreState.fullRestoreLocked = Boolean(locked); refreshSystemRestoreWriteLock(); systemRestoreState.restoreId = locked ? restoreId : null;
    const job = fullRestoreJobs.get(restoreId); if (job) job.writeLocked = Boolean(locked);
  },
  onCommitState: (committing, restoreId) => {
    systemRestoreState.commitStarted = Boolean(committing);
    const job = fullRestoreJobs.get(restoreId); if (job) job.commitStarted = Boolean(committing);
  },
});
const restoreRecoveryPromise = localDbReadyPromise.then(() => {
  try {
    const recovered = recoverInterruptedRestoresSync({ roots: fullRestoreRoots, onEvent: (name, detail) => markStartup(name, detail) });
    if (recovered.recovered || recovered.failures.length) markStartup('RESTORE_RECOVERY', recovered);
    return recovered;
  } catch (error) { logRuntimeFailure('restoreRecovery', error); return { recovered: 0, cleaned: 0, failures: [{ error: error.message }] }; }
});
// Full restore owns the write boundary. Read-only pages and restore progress
// remain available, but unrelated mutations cannot race the commit/rollback.
app.use((req, res, next) => {
  if (!systemRestoreState.writeLocked || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || String(req.path || '').startsWith('/api/backups/restore/')) return next();
  return res.status(409).json({ error: 'Full System Restore uygulanıyor; yazma işlemleri geçici olarak kilitlendi.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
});
const outlookRuntime = outlookSetupSettings.applyToRuntime(config, process.env);
const outlookGraph = createOutlookGraphService({ config:outlookRuntime.config, env:outlookRuntime.env, dataRoot: LOCAL_DATA_ROOT, writeJson: atomicWriteJson });
const outlookLocal = createOutlookLocalService();
const outlookMail = createOutlookHybridService({ graph: outlookGraph, local: outlookLocal });
const outlookV2 = createOutlookIntelligenceService({
  graph: outlookMail, dataRoot: LOCAL_DATA_ROOT, writeJson: atomicWriteJson, config:outlookRuntime.config, env:outlookRuntime.env,
  saveWorkspacePreference: (userId,key,value) => userPreferences.merge(userId,{[key]:{value:JSON.stringify(value),updatedAt:new Date().toISOString()}}),
  canAccessEntity: (profile, entityType, entityId, write) => {
    if (!profile) return false;
    if (entityType === 'ORDER' || entityType === 'PO') return write ? canUserEditOrderCode(profile, entityId) : (userAccess.hasCapability(profile, 'ORDERS.VIEW') || userAccess.hasPermission(profile, 'manageAllOrders'));
    if (entityType === 'COLLECTION') return userAccess.hasCapability(profile, write ? 'COLLECTIONS.EDIT' : 'COLLECTIONS.VIEW');
    return userAccess.hasCapability(profile, write ? 'ORDERS.EDIT' : 'ORDERS.VIEW');
  },
  applyBusinessChange: async (profile, candidate) => {
    const orderCode = Number(candidate.entityId);
    if (!Number.isFinite(orderCode) || !canUserEditOrderCode(profile, orderCode)) throw Object.assign(new Error('Sipariş değişikliği yetkisi bulunmuyor.'), { code:'ORDER_FORBIDDEN', statusCode:403 });
    if (candidate.ambiguous) throw Object.assign(new Error('Belirsiz mail değeri otomatik uygulanamaz.'), { code:'CHANGE_VALUE_AMBIGUOUS', statusCode:422 });
    let patch;
    if (candidate.type === 'DELIVERY_DATE_CHANGE') patch = { dates:{ retailDate:candidate.newValue } };
    else if (candidate.type === 'PRICE_CHANGE' && candidate.currency && Number.isFinite(Number(candidate.newValue))) patch = { suppFob:Number(candidate.newValue) };
    else throw Object.assign(new Error('Bu değişiklik tipi mevcut Buyer Log güncelleme akışına güvenli biçimde bağlanamıyor.'), { code:'CHANGE_APPLY_UNSUPPORTED', statusCode:422 });
    const saved = patchOrderOverride(orderCode, patch, null, null, { actor: noteActorOf(profile) });
    userAccess.appendAudit(profile, 'ORDER_UPDATE', String(orderCode), { fields:Object.keys(patch), source:'MAIL_INTELLIGENCE', candidateId:candidate.id });
    liveEvents.notifyChange('orders', 'mail-intelligence', { rowPatches: liveRowPatchesFor([{ orderCode, patch }]) });
    return saved;
  },
  resolveEntities: async (message) => {
    await ensureDataLoaded('moderator');
    const rows = cacheForUser('moderator').asasOrders || [], configState = outlookV2.store.load().config, candidates = [];
    for (const row of rows.slice(0, 250000)) {
      const raw = row && row._sourceFields || {};
      const context = {
        orderNo: row && (row.ocode ?? raw['Order Code'] ?? raw['Sipariş Kod']),
        poNo: raw['PO No'] ?? raw.PO, plmCode: row && (row.plmId ?? raw['PLM ID'] ?? raw.PLM),
        styleId: raw['Style ID'], modelCode: raw['Model Code'], modelName: row && (row.model ?? raw['Model Name']),
        colourCode: row && (row.ccode ?? raw['Colour Code'] ?? raw['C.Code']), manufacturer: row && (row.manufacturer ?? raw.Manufacturer), supplier: raw.Supplier,
      };
      const match = mailIntelligence.matchContext(message, context, configState);
      if (match.score >= configState.confirmationThreshold && !match.falsePositiveProtected) {
        const buyer=String(row&&row.buyer||raw.Buyer||raw['Buyer Name']||'').trim().toLocaleUpperCase('tr-TR'),profiles=userAccess.allPublicProfiles(),owner=profiles.find(profile=>String(profile.displayName||profile.username||'').trim().toLocaleUpperCase('tr-TR')===buyer),manager=owner&&profiles.find(profile=>profile.id===(owner.managerId||owner.supervisorId));
        candidates.push({ entityType:'ORDER', entityId:String(context.orderNo || ''), confidence:match.score, decision:match.decision, reasons:match.reasons, userIds:[owner&&owner.id,manager&&manager.id].filter(Boolean) });
      }
    }
    return candidates.filter(item=>item.entityId).sort((a,b)=>b.confidence-a.confidence).slice(0,3);
  },
});
function sendUserSelectionPage(_req, res) {
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, '..', 'public', 'select-user.html'));
}
// Keep the extensionless route for old shortcuts and add an explicit HTML route
// so user switching cannot fall through to Express' "Cannot GET" response.
app.get('/select-user', sendUserSelectionPage);
app.get(['/select-user/', '/select-user.html'], sendUserSelectionPage);
app.get('/api/shared-hub/bootstrap-status', async (_req, res) => {
  // sync-settings.json yerel ve kalici source-of-truth'tur. Bootstrap daha yeni
  // basliyor olsa bile kayitli klasoru once okuyup "configured" bilgisini seed
  // ederiz; aksi halde login ekraninin ilk status istegi gecici configured:false
  // gorup her acilista klasor seciciyi yeniden aciyordu.
  const savedSettings = await syncSettings.read();
  const savedRoot = String(savedSettings && savedSettings.sharedSyncRoot || '').trim();
  if (!sharedHubStartupSettled && !sharedHubBootstrapInFlight) {
    void bootstrapSharedHub().catch(error => logRuntimeFailure('sharedHubBootstrapStatus', error));
  }
  // bootstrapSharedHub() senkron baslangic adiminda progress'i gecici olarak
  // configured:false'a cekebilir. HTTP cevabinda kalici ayar daha guclu kanittir;
  // boylece her poll kayitli klasoru deterministik olarak "configured" gorur.
  const snapshot = bootstrapStatusSnapshot();
  res.set('Cache-Control','no-store').json({
    ...snapshot,
    configured:Boolean(savedRoot) || snapshot.configured === true,
    root:savedRoot || null,
  });
});
app.post('/api/shared-hub/configure', express.json({ limit:'32kb' }), async (req, res) => {
  try {
    const root = String(req.body && req.body.root || '').trim();
    // Pre-login setup may select only an already initialized Buyer Log Hub.
    // Creating a new authoritative company Hub remains an authenticated
    // moderator action below.
    const checked = await sharedHub.validate(root, { requireWrite:true });
    const before = await syncSettings.read();
    const localState = sharedHub.readLocalState();
    if (before.sharedSyncRoot && localState && localState.completed && localState.hubId && localState.hubId !== checked.manifest.hubId) {
      if ((await localDb.pendingCount()) > 0) return res.status(409).json({ error:'Bekleyen local değişiklikler varken farklı Shared Hub seçilemez.', code:'SHARED_HUB_PENDING_CHANGES' });
      // A path move/mapped-drive change is safe only when the Hub identity is
      // the same. Silently switching to a different authoritative workspace
      // would mix old Collection/CP records into another company Hub.
      return res.status(409).json({ error:'Seçilen klasör farklı bir Buyer Log Shared Hub’a ait. Veri karışmasını önlemek için Hub kimliği değiştirilemez.', code:'SHARED_HUB_IDENTITY_MISMATCH', currentHubId:localState.hubId, selectedHubId:checked.manifest.hubId });
    }
    await syncSettings.save(checked.root);
    sharedHubStartupSettled = false;
    setBootstrapProgress({ configured:true, validated:true, loginAllowed:userAccess.canLoginLocally(), moderatorLoginAllowed:userAccess.canLoginLocally(), bootstrapRequired:!userAccess.hasLocalLoginSnapshot(), status:'syncing', phase:'hub', message:'Buyer Log eşitleniyor… · Girişe engel değil' });
    void bootstrapSharedHub({ force:true }).catch(error => logRuntimeFailure('sharedHubConfigureBootstrap', error));
    res.status(202).set('Cache-Control','no-store').json({ ok:true, ...bootstrapStatusSnapshot(), root:checked.root });
  } catch (err) { res.status(err.statusCode || 503).json({ error:err.message, code:err.code || 'SHARED_HUB_CONFIGURE_FAILED' }); }
});
app.post('/api/shared-hub/bootstrap-retry', express.json({ limit:'8kb' }), (_req, res) => {
  sharedHubStartupSettled = false;
  setBootstrapProgress({ loginAllowed:userAccess.canLoginLocally(), moderatorLoginAllowed:userAccess.canLoginLocally(), bootstrapRequired:!userAccess.hasLocalLoginSnapshot(), status:'syncing', phase:'hub', message:'Senkronizasyon yeniden başlatılıyor… · Girişe engel değil' });
  void bootstrapSharedHub({ force:true }).catch(error => logRuntimeFailure('sharedHubBootstrapRetry', error));
  res.status(202).set('Cache-Control','no-store').json(bootstrapStatusSnapshot());
});
app.get('/api/user-profiles', userAccess.listHandler);
app.get('/api/user-suggestions', userAccess.suggestHandler); // legacy alias
app.get('/api/auth/users/suggest', userAccess.suggestHandler);
app.post('/api/user-login', express.json({ limit: '64kb' }), (req, res, next) => {
  const loginName = String(req.body && req.body.username || '').trim().toLocaleLowerCase('tr-TR');
  const loginProfile = userAccess.allPublicProfiles().find(profile =>
    [profile && profile.username, profile && profile.displayName]
      .some(value => String(value || '').trim().toLocaleLowerCase('tr-TR') === loginName)
  );
  if (loginProfile && loginProfile.id) userBootstrapReady.delete(String(loginProfile.id));

  // Authentication and Shared Sync are intentionally independent. A valid
  // locally cached account may enter Buyer Log while Shared Hub is starting,
  // offline, retrying or carrying pending local changes. Sync state must never
  // turn a valid password into a login failure; userAccess remains the sole
  // authentication/authorization authority for this request.
  return userAccess.loginHandler(req, res, next);
});
app.post('/api/user-logout', userAccess.logoutHandler);
app.get('/api/current-user', userAccess.currentHandler);
// SameSite=Strict kullanıcı cookie'si Microsoft'tan gelen cross-site callback'te
// bulunmayabilir. Callback yalnız sunucudaki tek kullanımlık PKCE state kaydına
// güvenir ve bağlantıyı state içinde kayıtlı gerçek Buyer Log user ID'ye bağlar.
app.get('/api/outlook/callback', async (req, res) => {
  let userId = null;
  try {
    const result = await outlookGraph.handleCallback(req.query || {}); userId = result.userId;
    const actor = userAccess.allPublicProfiles().find(item => item.id === userId) || { id: userId };
    const maskedEmail = result.email ? String(result.email).replace(/^(.).+(@.*)$/,'$1***$2') : '';
    userAccess.appendAudit(actor, 'OUTLOOK_CONNECTED', 'microsoft365', { email: maskedEmail, tenant: outlookGraph.config.tenantId }, req);
    res.type('html').set('Cache-Control','no-store').send('<!doctype html><meta charset="utf-8"><title>Buyer Log</title><script>try{window.opener&&window.opener.postMessage({type:"BUYER_LOG_OUTLOOK_AUTH",ok:true},location.origin);}catch(e){}window.close();</script><p>Outlook bağlantısı tamamlandı. Bu pencereyi kapatabilirsiniz.</p>');
  } catch (err) {
    userId = err && err.userId || userId;
    const actor = userId && userAccess.allPublicProfiles().find(item => item.id === userId);
    if (actor) userAccess.appendAudit(actor, 'OUTLOOK_AUTH_FAILED', 'microsoft365', { code: err.code || 'OUTLOOK_AUTH_FAILED' }, req);
    res.status(Number(err && err.statusCode) || 400).type('html').set('Cache-Control','no-store').send('<!doctype html><meta charset="utf-8"><title>Buyer Log</title><script>try{window.opener&&window.opener.postMessage({type:"BUYER_LOG_OUTLOOK_AUTH",ok:false,message:"Microsoft bağlantısı tamamlanamadı."},location.origin);}catch(e){}window.close();</script><p>Microsoft bağlantısı tamamlanamadı.</p>');
  }
});
// Graph webhook'ları kullanıcı cookie'si taşımaz. Güvenlik; validationToken,
// clientState, registry, idempotency ve Graph'tan yeniden fetch katmanlarında
// uygulanır. Webhook yalnız sinyaldir, doğrudan business update yapmaz.
const outlookWebhookRate = new Map();
function outlookWebhookAllowed(req) {
  const key = String(req.ip || req.socket && req.socket.remoteAddress || 'unknown'), time = Date.now();
  let row = outlookWebhookRate.get(key); if (!row || time > row.resetAt) row = { count:0, resetAt:time + 60000 };
  row.count += 1; outlookWebhookRate.set(key,row); return row.count <= 300;
}
function outlookValidationResponse(req, res) {
  const token = String(req.query && req.query.validationToken || '');
  if (!token || token.length > 4096) return false;
  res.status(200).type('text/plain').set('Cache-Control','no-store').send(token); return true;
}
app.get(['/api/outlook/webhook','/api/outlook/lifecycle'], (req,res) => {
  if (!outlookWebhookAllowed(req)) return res.status(429).end();
  if (outlookValidationResponse(req,res)) return;
  res.status(400).json({ error:'validationToken zorunludur.', code:'VALIDATION_TOKEN_REQUIRED' });
});
app.post('/api/outlook/webhook', express.json({ limit:'256kb', type:['application/json','text/json'] }), (req,res) => {
  if (!outlookWebhookAllowed(req)) return res.status(429).end();
  if (outlookValidationResponse(req,res)) return;
  try { const result=outlookV2.subscriptions.acceptNotifications(req.body||{}); res.status(202).json({ ok:true,...result }); }
  catch(err){ apiError(res,err,'Graph bildirimi doğrulanamadı.'); }
});
app.post('/api/outlook/lifecycle', express.json({ limit:'256kb', type:['application/json','text/json'] }), (req,res) => {
  if (!outlookWebhookAllowed(req)) return res.status(429).end();
  if (outlookValidationResponse(req,res)) return;
  try { const result=outlookV2.subscriptions.acceptLifecycle(req.body||{}); res.status(202).json({ ok:true,...result }); }
  catch(err){ apiError(res,err,'Graph lifecycle bildirimi doğrulanamadı.'); }
});
app.use(userAccess.requireSelection);
// Sipariş bazlı düzenlemeler yalnız kullanıcının veri kapsamındaki siparişler
// için döner (bkz. override-scope.js). Güvenlik ağı: override belgesi taşıyan
// HER yanıt burada kırpılır; yeni bir uç eklendiğinde atlanması mümkün olmaz.
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (body && typeof body === 'object' && !Array.isArray(body) && body.overrides && typeof body.overrides === 'object' && req.currentUser) {
      body = { ...body, overrides: overridesForViewer(req.currentUser, body.overrides) };
    }
    return json(body);
  };
  next();
});
app.post('/api/shared-hub/user-bootstrap', express.json({ limit:'8kb' }), async (req, res) => {
  const userId = String(req.currentUser.id);
  // Credentials have already been verified by requireSelection. From this point
  // on every synchronization operation is best-effort and non-blocking.
  userBootstrapReady.add(userId);
  try {
    const gate = bootstrapStatusSnapshot();
    if (gate.status === 'offline') {
      return res.set('Cache-Control','no-store').json({ ok:true, ready:true, offline:true, syncDeferred:true, message:'Çevrimdışı · son doğrulanmış yerel veri kullanılıyor', collectionImages:{ status:'offline', blocking:false, requested:0, installed:0, reused:0, missing:0 } });
    }
    if (gate.status !== 'ready') {
      markStartup('USER_SYNC_DEFERRED', { userId, status:gate.status, phase:gate.phase, errorCode:gate.errorCode || null });
      return res.set('Cache-Control','no-store').json({
        ok:true, ready:true, offline:false, syncDeferred:true, bootstrap:gate,
        message:'Oturum açıldı · Shared Sync arka planda devam ediyor.',
        collectionImages:{ status:'deferred', blocking:false, requested:0, installed:0, reused:0, missing:0 },
      });
    }

    // Koleksiyon görselleri de giriş için kritik değildir; kullanıcı ana ekrana
    // hemen geçer, görseller LOCAL → SHARED akışında arka planda tamamlanır.
    void syncAuthorizedCollectionImages(userId).then(collectionImages => {
      const failedOwners = (collectionImages.results || []).filter(item => item && item.error);
      const missingImages = Number(collectionImages.missing) || 0;
      markStartup(
        failedOwners.length || missingImages > 0 ? 'COLLECTION_IMAGE_SYNC_DEFERRED' : 'COLLECTION_IMAGE_SYNC_READY',
        {
          userId,
          requested:Number(collectionImages.requested)||0,
          installed:Number(collectionImages.installed)||0,
          reused:Number(collectionImages.reused)||0,
          missing:missingImages,
          failedOwners:failedOwners.length,
        }
      );
    }).catch(error => {
      markStartup('COLLECTION_IMAGE_SYNC_DEFERRED', {
        userId,
        error:error && error.code || error && error.message || String(error),
      });
    });

    return res.set('Cache-Control','no-store').json({
      ok:true, ready:true, offline:false, syncDeferred:false,
      message:'Oturum hazır · Koleksiyon görselleri arka planda eşitleniyor.',
      collectionImages:{ status:'deferred', blocking:false, requested:0, installed:0, reused:0, missing:0 },
    });
  } catch (error) {
    markStartup('USER_SYNC_DEFERRED', { userId, error:error && error.code || error && error.message || String(error) });
    return res.set('Cache-Control','no-store').json({
      ok:true, ready:true, offline:false, syncDeferred:true,
      warning:error.message || 'Kullanıcı senkronizasyonu arka plana ertelendi.',
      collectionImages:{ status:'deferred', blocking:false, requested:0, installed:0, reused:0, missing:0 },
    });
  }
});
app.post('/api/shared-hub/initialize', userAccess.requireModerator, express.json({ limit:'32kb' }), async (req, res) => {
  try {
    if (!req.body || req.body.confirmCritical !== true) return res.status(400).json({ error:'Shared Hub oluşturmak için açık onay gerekir.', code:'CRITICAL_CONFIRMATION_REQUIRED' });
    const root = String(req.body.root || '').trim();
    const created = await sharedHub.initialize(root, { createdBy:req.currentUser.id, allowNonEmpty:false });
    await syncSettings.save(created.root);
    userAccess.enableCentralIam();
    let iam;
    try { iam = await userAccess.initializeCentralIam(req.currentUser); }
    catch (err) {
      // Existing central IAM is valid; a second init should refresh rather than
      // rebuild the authority directory.
      if (err && err.code === 'IAM_ALREADY_INITIALIZED') iam = await userAccess.refreshIam(); else throw err;
    }
    await activateSharedHubRuntime({ migrateCollection:true, actorId:req.currentUser.id });
    const master = await publishMasterCheckpoint(req.currentUser.id);
    await syncSettings.syncOnce();
    const business=await publishBusinessCheckpoint(req.currentUser.id);
    const state = await sharedHub.markBootstrap({ root:created.root, hubId:created.manifest.hubId, masterRevision:master.head && master.head.revision || 0, businessRevision:business.head&&business.head.revision||0, iamRevision:userAccess.centralIamHealth().localRevision || iam && iam._revision || 0, completed:true });
    res.json({ ok:true, hub:created.manifest, bootstrap:state, master:master.head, business:business.head, iam:userAccess.centralIamHealth() });
  } catch (err) { res.status(err.statusCode || 503).json({ error:err.message, code:err.code || 'SHARED_HUB_INITIALIZE_FAILED' }); }
});
app.post('/api/shared-hub/publish-master', userAccess.requireModerator, express.json({ limit:'8kb' }), async (req, res) => {
  try {
    const result = await publishMasterCheckpoint(req.currentUser.id);
    if (result.published) {
      const settings = await syncSettings.read();
      const current = sharedHub.readLocalState();
      await sharedHub.markBootstrap({ root:settings.sharedSyncRoot, hubId:result.hub.hubId, masterRevision:result.head.revision, iamRevision:userAccess.centralIamHealth().localRevision || userAccess.localIamRevision(), completed:true });
    }
    res.json({ ok:true, ...result });
  } catch (err) { res.status(err.statusCode || 503).json({ error:err.message, code:err.code || 'MASTER_PUBLISH_FAILED' }); }
});
app.get('/user-context.js', (req, res) => {
  const profile = userAccess.publicProfile(req.currentUser);
  const initials = String(profile.displayName || '?').trim().split(/\s+/).slice(0,2).map(v=>v[0]).join('').toLocaleUpperCase('tr-TR');
  res.type('application/javascript').set('Cache-Control','no-store').send(`window.BL_USER_CONTEXT=${JSON.stringify({ ...profile, initials })};`);
});
app.get('/api/users/admin', userAccess.requireUserAdmin, userAccess.adminListHandler);
app.get('/api/iam/health', userAccess.iamHealthHandler);
app.post('/api/iam/refresh', userAccess.requireUserAdmin, userAccess.iamRefreshHandler);
app.get('/api/iam/migration/dry-run', userAccess.requireModerator, userAccess.iamDryRunHandler);
app.post('/api/iam/initialize', userAccess.requireModerator, express.json({ limit: '16kb' }), userAccess.iamInitializeHandler);
app.post('/api/iam/users/bulk', userAccess.requireUserAdmin, express.json({ limit: '2mb' }), userAccess.adminBulkHandler);
app.post('/api/users', userAccess.requireUserAdmin, express.json({ limit: '2mb' }), userAccess.adminCreateHandler);
app.put('/api/users/:id', userAccess.requireUserAdmin, express.json({ limit: '2mb' }), userAccess.adminUpdateHandler);
app.put('/api/iam/roles', userAccess.requireCapability('ROLE.MANAGE'), express.json({ limit: '2mb' }), userAccess.roleMatrixUpdateHandler);
app.put('/api/iam/workspace-templates/:roleId', userAccess.requireCapability('ROLE.MANAGE'), express.json({ limit: '2mb' }), userAccess.workspaceTemplateUpdateHandler);
app.delete('/api/iam/workspace-templates/:roleId', userAccess.requireCapability('ROLE.MANAGE'), express.json({ limit: '256kb' }), userAccess.workspaceTemplateResetHandler);
app.post('/api/iam/permissions/copy', userAccess.requireCapability('USER.GRANT'), express.json({ limit: '2mb' }), userAccess.permissionCopyHandler);
app.post('/api/iam/profile-copy/preview', userAccess.requireCapability('USER.PROFILE_COPY'), express.json({ limit: '2mb' }), userAccess.profileCopyPreviewHandler);
app.post('/api/iam/profile-copy', userAccess.requireCapability('USER.PROFILE_COPY'), express.json({ limit: '2mb' }), userAccess.profileCopyHandler);
app.post('/api/iam/users/:id/temporary-grants', userAccess.requireCapability('USER.GRANT'), express.json({ limit: '256kb' }), userAccess.temporaryGrantHandler);
app.delete('/api/iam/users/:id/temporary-grants/:grantId', userAccess.requireCapability('USER.GRANT'), express.json({ limit: '64kb' }), userAccess.temporaryGrantRevokeHandler);
app.get('/api/iam/audit', userAccess.requireCapability('AUDIT.VIEW'), userAccess.auditListHandler);

// ---- Microsoft 365 / Outlook route'ları (delegated Mail.Read + Mail Intelligence V2) → server/routes/outlook-routes.js ----
require('./routes/outlook-routes')(app, {
  LOCAL_DATA_ROOT,
  apiError,
  atomicWriteJson,
  cleanupOrphanExcel,
  createOutlookGraphService,
  crypto,
  express,
  logRuntimeFailure,
  outlookGraph,
  outlookLocal,
  outlookMail,
  outlookSetupSettings,
  outlookV2,
  userAccess,
  getConfig: () => config,
});

// ---- Agent Workflow Platform ------------------------------------------------
// v5.46: Eski scheduler/web-recorder Agent sistemi tamamen kaldırıldı. Yeni
// platform deklaratif workflow graph + deterministic policy/tool execution kullanır.
// LLM yalnız plan üretebilir; execution hiçbir zaman LLM'in doğrudan kontrolünde değildir.
const AGENT_ALLOWED_CONNECTOR_HOSTS = String(process.env.BUYER_LOG_AGENT_ALLOWED_HOSTS || '')
  .split(/[\n,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean);

function agentPlatformError(res, err, fallback) {
  res.status(Number(err && err.statusCode) || 500).json({ error: err && err.message || fallback, code: err && err.code || 'AGENT_PLATFORM_ERROR', details: err && err.details || undefined });
}
function agentDatasetArea(source) {
  return ({ cp:'cp', orders:'orders', backlog:'backlog', lfl:'lfl', collection:'koleksiyon', asas:'cp', ias:'cp' })[String(source || '').toLowerCase()] || '';
}
function agentRowOrderCode(row) {
  return row && (row['Order Code'] ?? row.orderCode ?? row['Sipariş Kod'] ?? row['Sipariş Kodu']);
}
function agentVisibleRows(profile, rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const orderCode = agentRowOrderCode(row);
    return orderCode == null || orderCode === '' || canUserEditOrderCode(profile, orderCode);
  });
}
async function agentPlatformDataset(ownerId, profile, source) {
  const normalized = String(source || '').trim().toLowerCase(), area = agentDatasetArea(normalized);
  if (!area) throw Object.assign(new Error('Desteklenmeyen Agent dataset kaynağı.'), { code:'DATASET_INVALID', statusCode:400 });
  if (!userAccess.hasArea(profile, area)) throw Object.assign(new Error(`${area} veri alanına erişim yetkisi bulunmuyor.`), { code:'AREA_FORBIDDEN', statusCode:403 });
  if (normalized === 'collection') return agentVisibleRows(profile, loadWorkspace(ownerId).rows || []);
  await ensureDataLoaded(ownerId);
  const active = cacheForUser(ownerId), overrides = effectiveOverridesForUser(ownerId);
  if (normalized === 'lfl') return agentVisibleRows(profile, active.lflRows || []);
  if (normalized === 'asas') {
    const rows=ordersForTarget(active,'cp',overrides);
    return rows.filter(order=>{
      const code=order&&(order.ocode??order._matchOcode);
      return code==null||code===''||canUserEditOrderCode(profile,code);
    }).map(order=>{
      const raw=order&&order._sourceFields&&typeof order._sourceFields==='object'?order._sourceFields:{};
      return Object.fromEntries(Object.entries(raw).filter(([name])=>name&&!String(name).startsWith('__')));
    });
  }
  if (normalized === 'ias') {
    const map=antrepoForTarget(active,'cp'),entries=[];
    if(map&&typeof map.values==='function')for(const value of map.values())(Array.isArray(value)?value:[value]).forEach(row=>entries.push(row));
    else if(map&&typeof map==='object')Object.keys(map).filter(key=>key!=='__antrepoMeta').forEach(key=>(Array.isArray(map[key])?map[key]:[map[key]]).forEach(row=>entries.push(row)));
    return entries.filter(row=>{
      const code=row&&(row.ocode??row._matchOcode??(row._sourceFields&&row._sourceFields['Sipariş Kod']));
      return code==null||code===''||canUserEditOrderCode(profile,code);
    }).map(row=>{
      const raw=row&&row._sourceFields&&typeof row._sourceFields==='object'?row._sourceFields:{};
      return Object.fromEntries(Object.entries(raw).filter(([name])=>name&&!String(name).startsWith('__')));
    });
  }
  if (normalized === 'orders') return agentVisibleRows(profile, buildOrdersRowsFromASAS(ordersForTarget(active, 'orders', overrides), antrepoForTarget(active, 'orders'), overrides));
  if (normalized === 'backlog') return agentVisibleRows(profile, buildBacklogTemplateRows(ordersForTarget(active, 'backlog', overrides), antrepoForTarget(active, 'backlog'), overrides, {}));
  return agentVisibleRows(profile, buildCPRowsFromASAS(ordersForTarget(active, 'cp', overrides), antrepoForTarget(active, 'cp'), overrides));
}
function agentPlatformOrderPatchSnapshot(row, patch) {
  const before = {};
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'subManufacturer')) before.subManufacturer = row && (row['Sub-Manufacturer'] ?? row.SubManufacturer ?? '');
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'licensor')) before.licensor = row && row.Licensor || '';
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'delType')) before.delType = row && (row['Del. Type'] ?? row.DelType ?? '');
  if (patch && patch.notes && typeof patch.notes === 'object') {
    before.notes = {};
    if (Object.prototype.hasOwnProperty.call(patch.notes, 'Notes')) before.notes.Notes = row && row.Notes || '';
    if (Object.prototype.hasOwnProperty.call(patch.notes, 'EkNot')) before.notes.EkNot = row && (row.EkNot ?? row['Ek Not'] ?? '');
  }
  if (patch && patch.dates && typeof patch.dates === 'object') {
    before.dates = {};
    if (Object.prototype.hasOwnProperty.call(patch.dates, 'exFactory')) before.dates.exFactory = row && row['Ex-factory'] || '';
    if (Object.prototype.hasOwnProperty.call(patch.dates, 'retailDate')) before.dates.retailDate = row && row['Retail Date'] || '';
    if (Object.prototype.hasOwnProperty.call(patch.dates, 'inStoreDate')) before.dates.inStoreDate = row && (row['In-Store'] ?? row['In-Store Date'] ?? '');
  }
  if (patch && patch.model) before.model = patch.model;
  if (patch && patch.ccode) before.ccode = patch.ccode;
  return before;
}
function agentIsoDateOnly(value) {
  if (!value) return '';
  // dateOnlyISO takvim gününü yerel bileşenlerden okur; toISOString() UTC'ye
  // çevirdiği için UTC+X saat dilimlerinde bir gün geriye kayıyordu.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dateOnlyISO(value) || '';
  const text = String(value).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : (dateOnlyISO(date) || '');
}
function agentNormalizeRestorePatch(before) {
  const patch = { ...(before || {}) };
  if (patch.dates) patch.dates = Object.fromEntries(Object.entries(patch.dates).map(([key,value]) => [key, agentIsoDateOnly(value)]));
  return patch;
}
async function agentPlatformHttpRequest(args) {
  const url = new URL(String(args && args.url || ''));
  const method = String(args && args.method || 'GET').toUpperCase();
  if (!['GET','POST','PUT','PATCH'].includes(method)) throw Object.assign(new Error('Connector method yalnız GET/POST/PUT/PATCH olabilir.'), { code:'CONNECTOR_METHOD_BLOCKED', statusCode:400 });
  const headers = {};
  for (const [key,value] of Object.entries(args && args.headers && typeof args.headers === 'object' ? args.headers : {})) {
    const name = String(key || '').trim().toLowerCase();
    if (!name || ['authorization','cookie','proxy-authorization','host','content-length'].includes(name)) continue;
    headers[name] = String(value == null ? '' : value).slice(0,4000);
  }
  let body;
  if (method !== 'GET' && args && Object.prototype.hasOwnProperty.call(args, 'body')) {
    if (typeof args.body === 'string') body = args.body.slice(0, 128 * 1024);
    else { body = JSON.stringify(args.body); headers['content-type'] = headers['content-type'] || 'application/json'; }
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect:'manual' });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 2 * 1024 * 1024) throw Object.assign(new Error('Connector yanıtı 2 MB güvenlik sınırını aşıyor.'), { code:'CONNECTOR_RESPONSE_TOO_LARGE', statusCode:413 });
    const contentType = String(response.headers.get('content-type') || '');
    const raw = buffer.toString('utf8'); let data = raw;
    if (/json/i.test(contentType)) { try { data = JSON.parse(raw); } catch (_) {} }
    return { ok: response.ok, status: response.status, contentType, data };
  } finally { clearTimeout(timer); }
}

const agentToolRegistry = createToolRegistry({
  // Modul kesif araclari yetki suzmesini burada yapar: ajan erisemeyecegi bir
  // modulu hic gormemeli, yoksa "yapabilirim" deyip 403 alir.
  userAccess,
  listDatasets: async (_ownerId, profile) => ['cp','orders','backlog','lfl','collection','asas','ias'].map(source => ({
    id:source, area:agentDatasetArea(source), allowed:userAccess.hasArea(profile, agentDatasetArea(source)),
  })),
  getDataContext: async (ownerId, _profile, source) => {
    const normalized=String(source||'').trim().toLowerCase();
    if(normalized==='collection'){
      const workspace=loadWorkspace(ownerId);
      return {source:normalized,refreshedAt:workspace.updatedAt||null,rowCount:Array.isArray(workspace.rows)?workspace.rows.length:0};
    }
    const active=cacheForUser(ownerId);
    return {source:normalized,refreshedAt:normalized==='lfl'?(active.lflLoadedAt||active.loadedAt||null):(active.loadedAt||null),dataSource:active.sources&&active.sources[normalized]||null};
  },
  getDataset: agentPlatformDataset,
  refresh: async (ownerId, profile, targets) => performRefresh(ownerId, profile, targets),
  snapshotOrder: async (ownerId, profile, orderCode, patch) => {
    const rows = await agentPlatformDataset(ownerId, profile, 'cp');
    const wantedModel = String(patch && patch.model || '').trim(), wantedColour = String(patch && patch.ccode || '').trim();
    const row = rows.find(item => Number(agentRowOrderCode(item)) === Number(orderCode)
      && (!wantedModel || String(item && item['Model Name'] || '').trim() === wantedModel)
      && (!wantedColour || String(item && item['C.Code'] || '').trim() === wantedColour));
    if (!row) throw Object.assign(new Error('Rollback snapshot için sipariş satırı bulunamadı.'), { code:'ORDER_NOT_FOUND', statusCode:404 });
    return agentPlatformOrderPatchSnapshot(row, patch);
  },
  updateOrder: async (_ownerId, profile, orderCode, patch) => {
    if (!canUserEditOrderCode(profile, orderCode)) throw Object.assign(new Error('Bu siparişi değiştirme yetkiniz yok.'), { code:'ORDER_FORBIDDEN', statusCode:403 });
    const saved = patchOrderOverride(Number(orderCode), patch || {}, null, null, { actor: noteActorOf(profile) });
    userAccess.appendAudit(profile, 'AGENT_ORDER_UPDATE', String(orderCode), { fields:Object.keys(patch || {}) });
    return { ok:true, updated:saved.updated || 1, revision:saved.revision };
  },
  restoreOrder: async (_ownerId, profile, orderCode, before) => {
    if (!canUserEditOrderCode(profile, orderCode)) throw Object.assign(new Error('Bu siparişi rollback etme yetkiniz yok.'), { code:'ORDER_FORBIDDEN', statusCode:403 });
    const patch = agentNormalizeRestorePatch(before || {}), saved = patchOrderOverride(Number(orderCode), patch, null, null, { actor: noteActorOf(profile) });
    userAccess.appendAudit(profile, 'AGENT_ORDER_ROLLBACK', String(orderCode), { fields:Object.keys(patch) });
    return { ok:true, restored:true, revision:saved.revision };
  },
  httpRequest: agentPlatformHttpRequest,
  browserRun: async (args, ctx) => agentBrowserConnector.run(ctx.ownerId, args, ctx),
});
const agentPolicyEngine = createPolicyEngine({ userAccess, allowedConnectorHosts: AGENT_ALLOWED_CONNECTOR_HOSTS, getAllowedBrowserHosts: () => agentBrowserSettings.loadSettings().allowedHosts });
const agentRuntime = createAgentRuntime({ store:agentWorkflowStore, toolRegistry:agentToolRegistry, policyEngine:agentPolicyEngine, auditFn:(profile,action,target,detail)=>userAccess.appendAudit(profile,action,target,detail) });

function agentPlatformState(ownerId, profile = null) {
  const state = agentWorkflowStore.stateForOwner(ownerId), ai = agentAi.providerStatus();
  return {
    ...state,
    ai: { ...ai, canConfigure:Boolean(profile && String(profile.role || '').trim().toLowerCase() === 'moderator') },
    browser: { ...agentBrowserSettings.publicSettings(), canConfigure:Boolean(profile && String(profile.role || '').trim().toLowerCase() === 'moderator'), managedPort:agentBrowserConnector.managedCdpPort() },
    connectors: { allowedHosts: agentPolicyEngine.allowedConnectorHosts, browserAllowedHosts:agentBrowserSettings.loadSettings().allowedHosts },
    nodeCatalog: nodeCatalog(agentToolRegistry.catalog()),
    toolCatalog: agentToolRegistry.catalog(),
    architectureTemplate: architectureTemplate(),
  };
}
app.get('/api/agent-platform', userAccess.requireArea('agents'), (req,res) => {
  res.set('Cache-Control','no-store').json(agentPlatformState(req.currentUser.id, req.currentUser));
});
app.get('/api/agent-platform/browser/status', userAccess.requireArea('agents'), async (req,res) => {
  try {
    const status = await agentBrowserConnector.status(req.currentUser.id);
    res.set('Cache-Control','no-store').json({ ok:true, status:{ ...status, canConfigure:String(req.currentUser.role || '').trim().toLowerCase() === 'moderator' } });
  } catch (err) { agentPlatformError(res,err,'Browser Automation durumu okunamadı.'); }
});
// "Remote debugging açık ama bağlanmıyor" durumunda nerede takıldığını adım adım
// raporlar (v5.88): Edge bulundu mu, hangi profil klasörlerine bakıldı,
// DevToolsActivePort var mı, portta CDP cevap veriyor mu.
app.get('/api/agent-platform/browser/diagnose', userAccess.requireArea('agents'), async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ ok:true, report: await agentBrowserConnector.diagnose() }); }
  catch (err) { agentPlatformError(res,err,'Edge bağlantı tanılaması yapılamadı.'); }
});
app.get('/api/automations/browser/diagnose', userAccess.requireArea('automations'), async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ ok:true, report: await agentBrowserConnector.diagnose() }); }
  catch (err) { automationError(res,err,'Edge bağlantı tanılaması yapılamadı.'); }
});
app.post('/api/agent-platform/browser/prepare-existing-edge', userAccess.requireArea('agents'), async (req,res) => {
  try {
    const result=agentBrowserConnector.openExistingEdgeDebugSetup();
    userAccess.appendAudit(req.currentUser,'AGENT_BROWSER_EXISTING_EDGE_SETUP','edge',{userDataDir:result.userDataDir});
    res.json({ok:true,result,status:await agentBrowserConnector.status(req.currentUser.id)});
  } catch(err){ agentPlatformError(res,err,'Mevcut Edge profili bağlantı ekranı açılamadı.'); }
});
app.post('/api/agent-platform/browser/settings', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), (req,res) => {
  try {
    const saved = agentBrowserSettings.saveSettings(req.body || {}, req.currentUser);
    userAccess.appendAudit(req.currentUser, 'AGENT_BROWSER_SETTINGS_UPDATE', 'browser', { allowedHosts:saved.allowedHosts });
    res.json({ ok:true, browser:{ ...saved, canConfigure:true, managedPort:agentBrowserConnector.managedCdpPort() }, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Browser Automation ayarları kaydedilemedi.'); }
});
// Browser & Remote Debugging is device-local configuration. It uses the same
// authenticated Buyer Log session/IAM boundary as the existing browser
// automation routes, but is intentionally separate from the shared Agent
// allowlist settings above.
const browserDebugAccess = userAccess.requireAnyArea('agents', 'automations');
app.get('/api/browser-debug/status', browserDebugAccess, async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok:true, status:await browserDebugService.getRuntimeStatus() }); }
  catch (err) { agentPlatformError(res, err, 'Browser ve Remote Debugging durumu okunamadı.'); }
});
app.get('/api/browser-debug/browsers', browserDebugAccess, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok:true, browsers:browserDebugService.detectInstalledBrowsers() });
});
app.get('/api/browser-debug/profiles', browserDebugAccess, (req, res) => {
  const browser = String(req.query.browser || '').toLowerCase();
  if (!browserDebugService.BROWSERS.includes(browser)) return res.status(400).json({ ok:false, error:'Desteklenmeyen tarayıcı.', code:'BROWSER_INVALID' });
  res.set('Cache-Control', 'no-store').json({ ok:true, browser, profiles:browserDebugService.listBrowserProfiles(browser) });
});
app.post('/api/browser-debug/configuration', browserDebugAccess, express.json({limit:'16kb'}), (req, res) => {
  try {
    const saved = browserDebugService.saveConfiguration(req.body || {});
    userAccess.appendAudit(req.currentUser, 'BROWSER_DEBUG_CONFIGURATION_UPDATE', 'browser', { preferredBrowser:saved.preferredBrowser, selectedEdgeProfileDirectory:saved.selectedEdgeProfileDirectory, preferredPort:saved.preferredPort, enabled:saved.enabled });
    res.json({ ok:true, configuration:saved });
  } catch (err) { agentPlatformError(res, err, 'Browser ayarları kaydedilemedi.'); }
});
app.post('/api/browser-debug/enable', browserDebugAccess, express.json({limit:'16kb'}), async (req, res) => {
  try {
    const result = await browserDebugService.enableAndLaunch(req.body || {});
    if (!result.ok) return res.status(result.status === 'Blocked by organization' ? 403 : 409).json({ ok:false, result });
    userAccess.appendAudit(req.currentUser, 'BROWSER_DEBUG_ENABLE_LAUNCH', result.resolved.resolvedBrowser, { profileMode:result.endpoint.profileMode, port:result.endpoint.port });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res, err, 'Browser Remote Debugging başlatılamadı.'); }
});
app.post('/api/browser-debug/restart', browserDebugAccess, express.json({limit:'16kb'}), async (req, res) => {
  try {
    const result = await browserDebugService.restartWithRemoteDebugging(req.body || {});
    if (!result.ok) return res.status(result.status === 'Blocked by organization' ? 403 : 409).json({ ok:false, result });
    userAccess.appendAudit(req.currentUser, 'BROWSER_DEBUG_RESTART', result.resolved.resolvedBrowser, { profileMode:result.endpoint.profileMode, port:result.endpoint.port });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res, err, 'Browser Remote Debugging yeniden başlatılamadı.'); }
});
app.post('/api/browser-debug/test', browserDebugAccess, async (req, res) => {
  try { res.set('Cache-Control','no-store').json({ ok:true, result:await browserDebugService.testConnection() }); }
  catch (err) { agentPlatformError(res, err, 'CDP bağlantısı test edilemedi.'); }
});
app.post('/api/browser-debug/disable', browserDebugAccess, async (req, res) => {
  try { userAccess.appendAudit(req.currentUser, 'BROWSER_DEBUG_DISABLE', 'browser'); res.json(await browserDebugService.disable()); }
  catch (err) { agentPlatformError(res, err, 'Browser Remote Debugging devre dışı bırakılamadı.'); }
});
app.post('/api/agent-platform/browser/open', userAccess.requireArea('agents'), express.json({limit:'32kb'}), async (req,res) => {
  try {
    const result = await agentBrowserConnector.openConnection(req.currentUser.id, String(req.body && req.body.url || ''));
    userAccess.appendAudit(req.currentUser, 'AGENT_BROWSER_OPEN', result.url, { openMode:result.openMode });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res,err,'Browser Automation sekmesi açılamadı.'); }
});
app.post('/api/agent-platform/browser/record/start', userAccess.requireArea('agents'), express.json({limit:'32kb'}), async (req,res) => {
  try {
    const recording = await agentBrowserConnector.startRecording(req.currentUser.id, String(req.body && req.body.url || ''));
    userAccess.appendAudit(req.currentUser, 'AGENT_BROWSER_RECORD_START', recording.id, { url:recording.url });
    res.json({ ok:true, recording });
  } catch (err) { agentPlatformError(res,err,'Browser Automation kaydı başlatılamadı.'); }
});
app.get('/api/agent-platform/browser/record/:id', userAccess.requireArea('agents'), async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ ok:true, recording:await agentBrowserConnector.recordingState(req.currentUser.id, req.params.id) }); }
  catch (err) { agentPlatformError(res,err,'Browser Automation kaydı okunamadı.'); }
});
app.post('/api/agent-platform/browser/record/:id/stop', userAccess.requireArea('agents'), async (req,res) => {
  try {
    const recording = await agentBrowserConnector.stopRecording(req.currentUser.id, req.params.id);
    userAccess.appendAudit(req.currentUser, 'AGENT_BROWSER_RECORD_STOP', recording.id, { url:recording.url, steps:recording.steps.length });
    res.json({ ok:true, recording });
  } catch (err) { agentPlatformError(res,err,'Browser Automation kaydı durdurulamadı.'); }
});
app.post('/api/agent-platform/ai-settings', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), (req,res) => {
  try {
    const saved = agentAi.saveSettings(req.body || {});
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_SETTINGS_UPDATE', 'openai', { model:saved.model, source:saved.source, configured:saved.configured, keyChanged:Boolean(req.body && (req.body.apiKey || req.body.clearKey)) });
    res.json({ ok:true, ai:{ ...saved, canConfigure:true } });
  } catch (err) { agentPlatformError(res,err,'AI sağlayıcı ayarları kaydedilemedi.'); }
});
app.post('/api/agent-platform/ai-settings/test', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), async (req,res) => {
  try {
    const result = await agentAi.testConnection(req.body || {});
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_CONNECTION_TEST', 'openai', { model:result.model, source:result.source, ok:true });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res,err,'AI sağlayıcı bağlantısı test edilemedi.'); }
});
function agentAiRequestOptions(body) {
  const input = body && typeof body === 'object' ? body : {};
  return {
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint || input.baseUrl,
  };
}
app.get('/api/agent-platform/ai/models', userAccess.requireArea('agents'), async (req,res) => {
  try {
    const result = await agentAi.discoverModels();
    res.set('Cache-Control','no-store').json({ ok:true, ...result });
  } catch (err) { agentPlatformError(res,err,'AI modelleri keşfedilemedi.'); }
});
app.post('/api/agent-platform/ai/models/pull', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), async (req,res) => {
  const streaming = String(req.query && req.query.stream || '') === '1' || String(req.headers.accept || '').includes('application/x-ndjson');
  try {
    const model = String(req.body && req.body.model || '').trim();
    if (!model) return res.status(400).json({ error:'Model adı zorunludur.', code:'AI_MODEL_REQUIRED' });
    let lastProgress = null;
    if (streaming) { res.status(200).set({ 'Cache-Control':'no-store', 'Content-Type':'application/x-ndjson; charset=utf-8' }); res.flushHeaders?.(); }
    const result = await agentAi.pullModel(model, agentAiRequestOptions(req.body), progress => {
      lastProgress = progress;
      if (streaming && !res.writableEnded) res.write(`${JSON.stringify({ progress })}\n`);
    });
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_MODEL_PULL', model, { provider:result.provider || agentAi.providerStatus().provider, status:result.status });
    if (streaming) { res.write(`${JSON.stringify({ ok:true, result, progress:lastProgress })}\n`); return res.end(); }
    res.json({ ok:true, result, progress:lastProgress });
  } catch (err) {
    if (streaming && res.headersSent) { if (!res.writableEnded) res.write(`${JSON.stringify({ ok:false, error:err && err.message || 'AI modeli indirilemedi.', code:err && err.code || 'AGENT_PLATFORM_ERROR' })}\n`); return res.end(); }
    agentPlatformError(res,err,'AI modeli indirilemedi.');
  }
});
app.post('/api/agent-platform/ai/models/update', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), async (req,res) => {
  try {
    const model = String(req.body && req.body.model || '').trim();
    if (!model) return res.status(400).json({ error:'Model adı zorunludur.', code:'AI_MODEL_REQUIRED' });
    const result = await agentAi.pullModel(model, agentAiRequestOptions(req.body));
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_MODEL_UPDATE', model, { provider:result.provider || agentAi.providerStatus().provider, status:result.status });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res,err,'AI modeli güncellenemedi.'); }
});
app.post('/api/agent-platform/ai/models/update-all', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), async (req,res) => {
  try {
    const result = await agentAi.updateAll(agentAiRequestOptions(req.body));
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_MODEL_UPDATE_ALL', result.provider, { count:result.results.length });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res,err,'AI modelleri güncellenemedi.'); }
});
app.post('/api/agent-platform/ai/models/remove', userAccess.requireArea('agents'), userAccess.requireModerator, express.json({limit:'32kb'}), async (req,res) => {
  try {
    const model = String(req.body && req.body.model || '').trim();
    const current = agentAi.providerStatus();
    if (!model) return res.status(400).json({ error:'Model adı zorunludur.', code:'AI_MODEL_REQUIRED' });
    if (current.provider === (req.body && req.body.provider ? String(req.body.provider).trim().toLowerCase() : current.provider) && current.model === model) {
      return res.status(409).json({ error:'Aktif model silinemez; önce başka bir model seçin.', code:'AI_ACTIVE_MODEL' });
    }
    const result = await agentAi.removeModel(model, agentAiRequestOptions(req.body));
    userAccess.appendAudit(req.currentUser, 'AGENT_AI_MODEL_DELETE', model, { provider:result.provider || current.provider });
    res.json({ ok:true, result });
  } catch (err) { agentPlatformError(res,err,'AI modeli silinemedi.'); }
});
app.post('/api/agent-platform/plan', userAccess.requireArea('agents'), express.json({limit:'128kb'}), async (req,res) => {
  try {
    const planned = await agentAi.planTask(String(req.body && req.body.task || ''), agentToolRegistry);
    userAccess.appendAudit(req.currentUser, 'AGENT_PLAN_CREATED', 'draft', { provider:planned.provider, task:String(req.body && req.body.task || '').slice(0,300) });
    res.json({ ok:true, plan:planned });
  } catch (err) { agentPlatformError(res,err,'Agent planı oluşturulamadı.'); }
});
app.post('/api/agent-platform/workflows', userAccess.requireArea('agents'), express.json({limit:'512kb'}), (req,res) => {
  try {
    const validation = validateWorkflow(req.body || {}, agentToolRegistry);
    if (!validation.valid) return res.status(400).json({ error:'Workflow doğrulaması başarısız.', code:'WORKFLOW_INVALID', validation });
    const saved = agentWorkflowStore.createWorkflow(req.currentUser.id, req.body || {});
    userAccess.appendAudit(req.currentUser, 'AGENT_WORKFLOW_CREATE', saved.result.id, { name:saved.result.name, nodes:saved.result.nodes.length });
    res.status(201).json({ ok:true, workflow:saved.result, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Workflow oluşturulamadı.'); }
});
app.put('/api/agent-platform/workflows/:id', userAccess.requireArea('agents'), express.json({limit:'512kb'}), (req,res) => {
  try {
    const validation = validateWorkflow(req.body || {}, agentToolRegistry);
    if (!validation.valid) return res.status(400).json({ error:'Workflow doğrulaması başarısız.', code:'WORKFLOW_INVALID', validation });
    const saved = agentWorkflowStore.updateWorkflow(req.currentUser.id, req.params.id, req.body || {});
    userAccess.appendAudit(req.currentUser, 'AGENT_WORKFLOW_UPDATE', saved.result.id, { name:saved.result.name, nodes:saved.result.nodes.length });
    res.json({ ok:true, workflow:saved.result, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Workflow güncellenemedi.'); }
});
app.delete('/api/agent-platform/workflows/:id', userAccess.requireArea('agents'), (req,res) => {
  try {
    const saved = agentWorkflowStore.deleteWorkflow(req.currentUser.id, req.params.id);
    userAccess.appendAudit(req.currentUser, 'AGENT_WORKFLOW_DELETE', saved.result.id, { name:saved.result.name });
    res.json({ ok:true, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Workflow silinemedi.'); }
});
app.post('/api/agent-platform/workflows/:id/run', userAccess.requireArea('agents'), express.json({limit:'128kb'}), async (req,res) => {
  try {
    const workflow = agentWorkflowStore.workflowForOwner(req.currentUser.id, req.params.id);
    if (!workflow) return res.status(404).json({ error:'Workflow bulunamadı.', code:'WORKFLOW_NOT_FOUND' });
    const result = await agentRuntime.execute({ ownerId:req.currentUser.id, profile:req.currentUser, workflow, input:{ task:String(req.body && req.body.task || ''), variables:req.body && req.body.variables && typeof req.body.variables==='object'?req.body.variables:{} }, dryRun:Boolean(req.body && req.body.dryRun) });
    res.json({ ok:true, result, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Workflow çalıştırılamadı.'); }
});
app.post('/api/agent-platform/runs/:id/approval', userAccess.requireArea('agents'), express.json({limit:'32kb'}), async (req,res) => {
  try {
    const result = await agentRuntime.resumeApproval({ ownerId:req.currentUser.id, profile:req.currentUser, runId:req.params.id, approved:req.body && req.body.approved === true });
    res.json({ ok:true, result, state:agentPlatformState(req.currentUser.id, req.currentUser) });
  } catch (err) { agentPlatformError(res,err,'Workflow onayı işlenemedi.'); }
});
app.get('/api/agent-platform/runs/:id', userAccess.requireArea('agents'), (req,res) => {
  const run = agentWorkflowStore.runForOwner(req.currentUser.id, req.params.id);
  if (!run) return res.status(404).json({ error:'Agent çalışması bulunamadı.', code:'RUN_NOT_FOUND' });
  res.set('Cache-Control','no-store').json({ run });
});

// ---- Buyer Log Automations --------------------------------------------------
// v5.57: Automation Recipes is a general, no-code deterministic automation layer.
// Browser recording is one supported job type, not the whole product. Users choose
// the job goal first (web, e-mail/report, analysis, Buyer Log actions or mixed).
function automationError(res, err, fallback) {
  const message = redactSecrets(err && err.message || fallback);
  let details;
  if (err && err.details && typeof err.details === 'object') {
    try { details = JSON.parse(redactSecrets(JSON.stringify(err.details))); } catch (_) { details = undefined; }
  }
  res.status(Number(err && err.statusCode) || 500).json({ error: message, code: err && err.code || 'AUTOMATION_ERROR', details });
}

function automationNormalizeBinding(raw){
  const item=raw&&typeof raw==='object'?raw:{},mode=String(item.mode||'').trim().toLowerCase();
  return {mode:mode==='field'?'field':'fixed',field:mode==='field'?String(item.field||'').trim().slice(0,240):''};
}
function automationNormalizePayload(value, ownerId='') {
  const source=value&&typeof value==='object'?value:{};
  const recipe = automationRecipeStore.normalizeRecipe(source, ownerId);
  recipe.steps = (recipe.steps || []).map((step,index) => {
    const normalized=agentBrowserConnector.normalizeStep(step,index);
    normalized.binding=automationNormalizeBinding(step&&step.binding);
    return normalized;
  });
  if (recipe.steps.length > 250) throw Object.assign(new Error('Bir otomasyonda en fazla 250 browser adımı olabilir.'), { code:'AUTOMATION_STEP_LIMIT', statusCode:413 });
  /* v6.36 — ALICI DOĞRULAMASI KAYIT ANINDA.
     Alıcısı çözülemeyen bir otomasyon kaydedilirse hata ancak Pazartesi 09:00'da,
     e-posta gelmeyince fark edilir. Bu yüzden eksiklik kaydetme anında kesilir:
     alan kipinde alan adı zorunlu, grup kipinde grup zorunlu. */
  if (['email','mixed'].includes(recipe.purpose)) {
    const email = recipe.email || {};
    if (email.recipientMode === 'field') {
      if (!String(email.recipientField || '').trim()) throw Object.assign(new Error('Alıcıyı belirleyen alanı seçin.'), { code:'AUTOMATION_RECIPIENT_FIELD_REQUIRED', statusCode:400 });
    } else if (!String(email.groupId || '').trim()) {
      throw Object.assign(new Error('E-posta grubu seçin.'), { code:'AUTOMATION_EMAIL_GROUP_REQUIRED', statusCode:400 });
    }
  }
  if (recipe.ai && recipe.ai.origin === 'ai_import') {
    let parsed;
    try { parsed = automationLanguage.parse(recipe.ai.sourceCode); }
    catch (error) { error.statusCode = 400; error.code = error.code || 'AI_AUTOMATION_SOURCE_INVALID'; throw error; }
    const validation = automationLanguage.validate(parsed, aiCapabilityRegistry.getCapabilityModel());
    if (!validation.ok) throw Object.assign(new Error('AI otomasyon taslağı güncel capability kaydıyla doğrulanamadı.'), { code:'AI_AUTOMATION_VALIDATION_FAILED', statusCode:422, details:{validation} });
    const compatibility = aiAutomationCompatibility.check(recipe);
    if (!compatibility.compatible) throw Object.assign(new Error('AI otomasyon taslağı güncel değil; gözden geçirilmesi gerekiyor.'), { code:'AI_AUTOMATION_NEEDS_REVIEW', statusCode:409, details:compatibility });
    recipe.ai = { ...recipe.ai, status: recipe.enabled ? 'active' : 'draft', capabilityHash: validation.capabilityHash };
  }
  return recipe;
}
function automationPublicFieldName(name){
  const text=String(name==null?'':name).trim();
  return text&&!text.startsWith('_')&&!text.startsWith('__')?text:'';
}
function automationFieldValue(row,field){
  const key=String(field||'').trim();if(!key||!row)return undefined;
  if(Object.prototype.hasOwnProperty.call(row,key))return row[key];
  const wanted=key.toLocaleLowerCase('tr-TR');const found=Object.keys(row).find(name=>String(name).toLocaleLowerCase('tr-TR')===wanted);
  return found?row[found]:undefined;
}
function automationComparableValue(value){
  if(value instanceof Date)return Number.isNaN(value.getTime())?'':value.toISOString();
  if(value==null)return'';
  if(typeof value==='object')return JSON.stringify(value);
  return String(value);
}
function automationRowIdentity(row,index=0){
  const pick=(...names)=>{for(const name of names){const value=automationFieldValue(row,name);if(value!=null&&String(value).trim()!=='')return String(value).trim();}return'';};
  const parts=[
    pick('Order Code','Sipariş Kod','Sipariş Kodu','orderCode','ocode'),
    pick('PLM ID','Plm Kod','plmId','plm'),
    pick('Model Name','Model Adı','Ürün Adı','modelName','modelKod','model'),
    pick('C.Code','Renk Kod','Colour Code','ccode'),
    pick('İthalat Dosya No','Import File','importFile'),
    pick('Konteyner No','Container No','containerNo'),
  ].filter(Boolean);
  const explicit=pick('id','_id');if(explicit)parts.unshift(`id:${explicit}`);
  if(parts.length)return crypto.createHash('sha1').update(parts.join('\u001f')).digest('hex');
  const stable=Object.keys(row||{}).filter(name=>automationPublicFieldName(name)).sort().slice(0,30).map(name=>`${name}:${automationComparableValue(row[name])}`).join('\u001f');
  return crypto.createHash('sha1').update(stable||`row:${index}`).digest('hex');
}
function automationChangedRules(recipe){return(recipe&&Array.isArray(recipe.filters)?recipe.filters:[]).filter(rule=>String(rule&&rule.operator||'').toLowerCase()==='changed'&&String(rule&&rule.field||'').trim());}
function automationBuildChangeBaseline(rows,recipe){
  const rules=automationChangedRules(recipe),fields={};if(!rules.length)return null;
  for(const rule of rules){const field=String(rule.field).trim(),values={};(Array.isArray(rows)?rows:[]).forEach((row,index)=>{values[automationRowIdentity(row,index)]=automationComparableValue(automationFieldValue(row,field));});fields[field]=values;}
  return{schemaVersion:1,fields,capturedAt:new Date().toISOString()};
}
function automationNextChangeBaseline(rows,recipe,baseline,processedRows,baselineReady){
  const current=automationBuildChangeBaseline(rows,recipe);if(!current||!baselineReady)return current;
  const processed=new Set((Array.isArray(processedRows)?processedRows:[]).map((row,index)=>automationRowIdentity(row,index))),previous=baseline&&baseline.fields&&typeof baseline.fields==='object'?baseline.fields:{},fields={};
  for(const [field,currentValues] of Object.entries(current.fields||{})){
    const old=previous[field]&&typeof previous[field]==='object'?{...previous[field]}:{};
    for(const [key,value] of Object.entries(currentValues||{})){if(!Object.prototype.hasOwnProperty.call(old,key)||processed.has(key))old[key]=value;}
    fields[field]=old;
  }
  return{schemaVersion:1,fields,capturedAt:new Date().toISOString()};
}
/* ===================================================================
   GÖRELİ TARİH BELİRTEÇLERİ

   Otomasyon filtreleri statik metin tutuyor. "Teslim tarihi geçmiş siparişler"
   gibi bir kural kurulurken bugünün tarihi değere GÖMÜLÜYORDU — planlayıcı da
   bunu yapıyor (agent-ai-provider: value: calendarDayISO(new Date())).

   Sonuç sessiz bir yanlıştı: haftalık çalışan bir otomasyon, kurulduğu günden
   sonra geciken siparişleri hiç görmez. Rapor her hafta biraz daha eksilir ve
   bunu kimse fark etmez.

   Çözüm, değeri ÇALIŞMA ANINDA çözülen bir belirteç olarak saklamak. Statik
   tarihler aynen çalışmaya devam eder; yalnız @today ile başlayanlar çözülür. */
const AUTOMATION_DATE_TOKEN=/^@today(?:\s*([+-])\s*(\d{1,4})d)?$/i;
function automationResolveFilterValue(value){
  const match=AUTOMATION_DATE_TOKEN.exec(String(value==null?'':value).trim());
  if(!match)return value;
  const days=match[1]?(match[1]==='-'?-1:1)*Number(match[2]||0):0;
  const at=new Date();
  at.setDate(at.getDate()+days);
  const pad=n=>String(n).padStart(2,'0');
  // Yerel takvim günü: toISOString UTC'ye çevirip UTC+3'te günü geri kaydırırdı.
  return `${at.getFullYear()}-${pad(at.getMonth()+1)}-${pad(at.getDate())}`;
}
function automationResolveFilters(rules){
  return (Array.isArray(rules)?rules:[]).map(rule=>{
    const resolved=automationResolveFilterValue(rule&&rule.value);
    return resolved===(rule&&rule.value)?rule:{...rule,value:resolved};
  });
}

function automationApplyFilters(rows,recipe,baseline){
  const rules=Array.isArray(recipe&&recipe.filters)?recipe.filters:[],changed=rules.filter(rule=>String(rule&&rule.operator||'').toLowerCase()==='changed'),normal=rules.filter(rule=>String(rule&&rule.operator||'').toLowerCase()!=='changed');
  let matched=filterRows(Array.isArray(rows)?rows:[],automationResolveFilters(normal));
  const fieldMaps=baseline&&baseline.fields&&typeof baseline.fields==='object'?baseline.fields:{};
  const ready=changed.length>0&&changed.every(rule=>fieldMaps[String(rule.field||'').trim()]&&typeof fieldMaps[String(rule.field||'').trim()]==='object');
  if(changed.length){
    matched=ready?matched.filter((row,index)=>changed.every(rule=>{const field=String(rule.field||'').trim(),map=fieldMaps[field]||{},key=automationRowIdentity(row,index);return Object.prototype.hasOwnProperty.call(map,key)&&String(map[key])!==automationComparableValue(automationFieldValue(row,field));})):[];
  }
  return{matched,change:{configured:Boolean(changed.length),baselineReady:ready,fields:changed.map(rule=>String(rule.field||'').trim()).filter(Boolean)}};
}
/* v6.39 — İKİ KAYNAĞI SİPARİŞ KODUNDAN ZİNCİRLEME.
   Eşleşme anahtarı orderCodeKey'den geçirilir. Bu şart: model CSV metin
   döndürüyor ve "1.234.569" gibi bir kod Number() ile NaN oluyor (v4.09
   Antrepo eşleşme sagasının kök nedeni buydu). İki taraf da aynı
   normalleştirmeden geçmezse eşleşme sessizce tutmaz.
   Bir sipariş kodunun ikinci kaynakta birden çok satırı olabilir (parsiyeller);
   bu durumda İLK satır bağlanır ve kaç satırın çoklandığı raporlanır — sessizce
   ilkini seçip susmak bu zincirdeki klasik hatadır. */
const AUTOMATION_JOIN_ORDER_HEADERS=['Sipariş Kod','Siparis Kod','Order Code','ocode'];
function automationJoinKeyOf(row){
  if(!row||typeof row!=='object')return '';
  for(const header of AUTOMATION_JOIN_ORDER_HEADERS){
    if(Object.prototype.hasOwnProperty.call(row,header)){
      const key=parseLib.orderCodeKey(row[header]);
      if(key)return key;
    }
  }
  return '';
}
function automationJoinPrefix(recipe){
  const join=(recipe&&recipe.join)||{};
  const explicit=String(join.prefix||'').trim();
  if(explicit)return explicit;
  return `${String(join.source||'').toUpperCase()} · `;
}
// Birincil satırlara ikinci kaynağın alanlarını ÖNEKLİ olarak ekler.
// Önek şart: iki tabloda aynı adlı başlıklar var (ör. "Sipariş Kod") ve
// öneksiz birleştirme birini sessizce ezerdi.
function automationJoinRows(primaryRows,joinRows,recipe){
  const join=(recipe&&recipe.join)||{};
  if(!join.source)return {rows:primaryRows,meta:null};
  const prefix=automationJoinPrefix(recipe);
  const index=new Map();
  let duplicates=0;
  for(const row of (Array.isArray(joinRows)?joinRows:[])){
    const key=automationJoinKeyOf(row);
    if(!key)continue;
    if(index.has(key)){duplicates+=1;continue;}
    index.set(key,row);
  }
  const out=[];
  let matchedCount=0,unmatchedCount=0,keylessCount=0;
  for(const row of (Array.isArray(primaryRows)?primaryRows:[])){
    const key=automationJoinKeyOf(row);
    if(!key)keylessCount+=1;
    const hit=key?index.get(key):null;
    if(hit)matchedCount+=1;else unmatchedCount+=1;
    if(join.mode==='match'&&!hit)continue;
    if(join.mode==='missing'){ if(hit)continue; out.push({...row}); continue; }
    const merged={...row};
    if(hit)for(const [name,value] of Object.entries(hit)){
      if(!name||String(name).startsWith('__'))continue;
      merged[`${prefix}${name}`]=value;
    }
    out.push(merged);
  }
  return {rows:out,meta:{source:join.source,mode:join.mode,prefix,matched:matchedCount,unmatched:unmatchedCount,keyless:keylessCount,duplicates,joinRows:(joinRows||[]).length}};
}
/* v9.47 — OTOMASYONUN GÖRDÜĞÜ SATIRLAR.
   Backlog otomasyonu teslimat riskini KENDİ hesaplamaz: Backlog Intelligence
   motorunun (public/backlog-delivery-engine.js) çıktısı satırlara düz alan
   olarak eklenir; filtre, gruplama, alan seçici ve e-posta raporu hep bu
   alanlar üzerinden çalışır. Böylece ekranda görünen risk ile mailde giden
   risk aynı motordan gelir.
   Alan seçici (`/dataset-fields`) ile çalıştırma AYNI fonksiyondan geçmeli;
   ayrışırlarsa kullanıcı filtre kurabildiği ama çalışmada var olmayan bir
   alan görürdü. */
async function automationIntakeRows(ownerId) {
  const snapshot = intakeStore.loadSnapshot(ownerId);
  try {
    const found = await intakeLiveFields();
    const saved = intakeStoredView(ownerId);
    const viewConfig = intakeReport.reconcileViewConfig(saved || (snapshot && snapshot.viewConfig) || null, found.fields);
    const horizon = intakeHorizon();
    const built = intakeReport.buildIntakeQuery({ fields: found.fields, viewConfig, horizon });
    const queryKey = intakeQueryKey(built.viewConfig, found.connection, horizon);
    const cached = intakeStore.get(queryKey);
    if (cached && cached.fresh) return cached.rows;
    const result = await modelQuery.runModelRows({
      server: found.connection.server, catalog: found.connection.catalog,
      query: built.query, headerMap: built.headerMap, generated: true,
      maxRows: built.maxRows, timeoutMs: 180000,
    });
    const rows = intakeReport.normalizeRows(result.rows, built.viewConfig);
    const fetchedAt = new Date().toISOString();
    intakeStore.set(queryKey, { rows, fields: found.fields, viewConfig: built.viewConfig, fetchedAt });
    intakeSaveView(ownerId, built.viewConfig);
    intakeStore.saveSnapshot(ownerId, { queryKey, rows, fields: found.fields, viewConfig: built.viewConfig, fetchedAt });
    return rows;
  } catch (error) {
    if (snapshot && Array.isArray(snapshot.rows)) return snapshot.rows;
    throw Object.assign(new Error(intakeSafeSourceMessage()), { code: 'INTAKE_SOURCE_UNAVAILABLE', statusCode: 503, cause: error });
  }
}

async function automationSourceRows(ownerId, profile, source, recipe) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'intake') {
    if (!userAccess.hasArea(profile, 'overview') || !userAccess.hasCapability(profile, 'OAB.VIEW')) {
      throw Object.assign(new Error('INTAKE verisine erişim yetkiniz bulunmuyor.'), { code: 'AREA_FORBIDDEN', statusCode: 403 });
    }
    return automationIntakeRows(ownerId);
  }
  const rows = await agentPlatformDataset(ownerId, profile, source);
  const list = Array.isArray(rows) ? rows : [];
  /* v9.50 — CP otomasyonu da ekrandaki analizi görür. Aynı ilke: hesap
     public/cp-readiness-engine.js'te, burada yalnız düz alana çevriliyor.
     Kontrol listesi cevapları kullanıcının tarayıcısında kişiye özel durduğu
     için sunucu onları göremez; alanlar bunu "Öncelik Kaynağı" ile açıkça
     söyler (bkz. server/lib/cp-automation.js). */
  if (source === 'cp') {
    const settings = (recipe && recipe.backlog) || {};
    const overrides = effectiveOverridesForUser(ownerId);
    return cpAutomation.enrichRows(list, {
      transitRules: (overrides && overrides.transitRules) || [],
      settings: { targetType: settings.targetType || 'retail', requireTransitRule: settings.requireTransitRule !== false },
    });
  }
  if (source !== 'backlog') return list;
  const settings = (recipe && recipe.backlog) || {};
  const routing = settings.routing && Object.keys(settings.routing).length
    ? { ...backlogAutomation.DEFAULT_OWNER_ROUTING, ...settings.routing } : null;
  return backlogAutomation.enrichRows(list, {
    settings: { targetType: settings.targetType || 'retail', requireTransitRule: settings.requireTransitRule !== false },
    routing,
  });
}
async function automationDataset(ownerId, profile, recipe) {
  if (!recipe || recipe.source === 'manual') return { total:1, matched:1, items:null, sample:[], change:{configured:false,baselineReady:false,fields:[]}, changeBaseline:null };
  let rows = await automationSourceRows(ownerId, profile, recipe.source, recipe);
  let joinMeta = null;
  const joinSource = recipe.join && recipe.join.source;
  if (joinSource) {
    // Zincirlenen kaynak da aynı yetki kontrolünden geçer; birleştirme,
    // kullanıcının göremediği bir alana arka kapı olmamalı.
    const joinRows = await automationSourceRows(ownerId, profile, joinSource, recipe);
    const joined = automationJoinRows(rows, joinRows, recipe);
    rows = joined.rows;
    joinMeta = joined.meta;
  }
  const baseline=automationRecipeStore.changeBaselineForRecipe(ownerId,recipe.id),filtered=automationApplyFilters(rows,recipe,baseline);
  const aiDefinition = recipe.ai && recipe.ai.definition && typeof recipe.ai.definition === 'object' ? recipe.ai.definition : null;
  const aiMatched = aiDefinition && Array.isArray(aiDefinition.conditions) && aiDefinition.conditions.length
    ? filtered.matched.filter(row => automationLanguage.evaluateConditions(aiDefinition.conditions, row, aiDefinition.source || recipe.source))
    : filtered.matched;
  const items = aiMatched.slice(0, Math.max(1, Math.min(200, Number(recipe.limit) || 50)));
  return { total:rows.length, matched:aiMatched.length, items, sample:items.slice(0,5), join:joinMeta, change:filtered.change, changeBaseline:automationNextChangeBaseline(rows,recipe,baseline,items,filtered.change.baselineReady) };
}
const AUTOMATION_EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function automationEmailGroupId(name,email){
  return `prepare_${crypto.createHash('sha1').update(`${String(name).toLocaleLowerCase('tr-TR')}|${email}`).digest('hex').slice(0,16)}`;
}
/* v6.36 — ADRES DEFTERİ İKİ KAYNAĞIN BİRLEŞİMİ.
   "Prepaire E-Mail" penceresindeki liste tek bir yerde durmuyor: üretici
   adresleri çalışma alanındaki kolManufacturers'ta, kullanıcının elle eklediği
   diğer adresler (ör. ihracat ekipleri) ise lcw.prodstatus.mails.* tercihinde.
   Bu fonksiyon eskiden YALNIZ birincisini okuyordu; ikinci listedeki bir adrese
   kurulan planlı otomasyon, Pazartesi 09:00'da alıcıyı bulamayıp SESSİZCE boş
   alıcıyla kalıyordu — kullanıcı bunu ancak e-posta gelmeyince fark ederdi.
   Artık ikisi birleştiriliyor; aynı ad iki kaynakta varsa çalışma alanı kazanır
   ve kaydın hangi kaynaktan geldiği origin alanında taşınıyor. */
function automationAddressBookEntries(ownerId){
  const out=new Map();
  const add=(name,email,origin)=>{
    const cleanName=String(name||'').trim();
    const cleanEmail=String(email||'').trim().toLowerCase();
    if(!cleanName||!AUTOMATION_EMAIL_RE.test(cleanEmail))return;
    const key=cleanName.toLocaleLowerCase('tr-TR');
    if(out.has(key))return; // ilk kaynak (çalışma alanı) kazanır
    out.set(key,{id:automationEmailGroupId(cleanName,cleanEmail),name:cleanName,to:[cleanEmail],cc:[],bcc:[],source:'prepare_email',origin,readOnly:true});
  };
  try{
    const workspace=loadWorkspace(ownerId);
    const manufacturers=Array.isArray(workspace&&workspace.manufacturers)?workspace.manufacturers:[];
    for(const item of manufacturers)add(item&&item.name,item&&item.email,'workspace');
  }catch(_){}
  try{
    const store=userPreferences.load(ownerId),entries=(store&&store.entries)||{};
    for(const [key,value] of Object.entries(entries)){
      if(String(key).indexOf('lcw.prodstatus.mails.')!==0)continue;
      let parsed=value;
      if(typeof parsed==='string'){try{parsed=JSON.parse(parsed);}catch(_){continue;}}
      if(!parsed||typeof parsed!=='object')continue;
      for(const [name,email] of Object.entries(parsed))add(name,email,'preferences');
    }
  }catch(_){}
  return [...out.values()];
}
function automationPrepareEmailGroups(ownerId){
  return automationAddressBookEntries(ownerId);
}
function automationEmailGroupsForOwner(ownerId){
  const persisted=automationRecipeStore.stateForOwner(ownerId).emailGroups.map(group=>({...group,source:'automation',readOnly:false})),prepare=automationPrepareEmailGroups(ownerId),seen=new Set(persisted.map(group=>`${String(group.name).toLocaleLowerCase('tr-TR')}|${(group.to||[]).join(';').toLowerCase()}`));
  for(const group of prepare){const key=`${String(group.name).toLocaleLowerCase('tr-TR')}|${(group.to||[]).join(';').toLowerCase()}`;if(!seen.has(key)){seen.add(key);persisted.push(group);}}
  return persisted;
}
const automationPreviewCache=new Map();
function automationPreviewCachePut(ownerId,recipe,data){
  const now=Date.now();for(const [token,item] of automationPreviewCache){if(!item||item.expiresAt<=now)automationPreviewCache.delete(token);}
  while(automationPreviewCache.size>=60)automationPreviewCache.delete(automationPreviewCache.keys().next().value);
  const token=crypto.randomBytes(16).toString('hex');automationPreviewCache.set(token,{ownerId:String(ownerId||''),recipeId:String(recipe&&recipe.id||''),revision:Number(recipe&&recipe.revision)||0,data,expiresAt:now+120000});return token;
}
function automationPreviewCacheTake(token,ownerId,recipe){
  const key=String(token||'').trim(),item=automationPreviewCache.get(key);if(!key||!item)return null;automationPreviewCache.delete(key);
  if(item.expiresAt<=Date.now()||item.ownerId!==String(ownerId||'')||item.recipeId!==String(recipe&&recipe.id||'')||item.revision!==(Number(recipe&&recipe.revision)||0))return null;
  return item.data;
}
function automationState(ownerId, profile=null) {
  const state = automationRecipeStore.stateForOwner(ownerId), browser = agentBrowserSettings.publicSettings(), capabilityModel = aiCapabilityRegistry.getCapabilityModel();
  state.recipes = state.recipes.map(recipe => ({ ...recipe, aiCompatibility: aiAutomationCompatibility.check(recipe, capabilityModel) }));
  state.emailGroups=automationEmailGroupsForOwner(ownerId);
  return { ...state, capabilities: { appVersion: capabilityModel.appVersion, automationLanguageVersion: capabilityModel.automationLanguageVersion, capabilitySchemaVersion: capabilityModel.capabilitySchemaVersion, capabilityHash: capabilityModel.capabilityHash }, canConfigure:Boolean(profile && String(profile.role || '').trim().toLowerCase() === 'moderator'), browser:{ ...browser, canConfigure:Boolean(profile && String(profile.role || '').trim().toLowerCase() === 'moderator'), managedPort:agentBrowserConnector.managedCdpPort() } };
}
function automationSteps(recipe) {
  const steps=(recipe.steps||[]).map((step,index)=>{
    const copy={...step};
    if(step&&step.binding&&step.binding.mode==='field'&&step.binding.field) copy.value=`{{item.${step.binding.field}}}`;
    return agentBrowserConnector.normalizeStep(copy,index);
  });
  if (String(recipe.terminalCode||'').trim()) steps.push(agentBrowserConnector.normalizeStep({ id:'terminal_code', action:'script', value:recipe.terminalCode, description:'Düzenlenebilir terminal kodunu çalıştır' }, steps.length));
  if (recipe.successText) steps.push(agentBrowserConnector.normalizeStep({ id:'verify_text', action:'assert_text', value:recipe.successText, description:'Başarı metnini doğrula' }, steps.length));
  return steps;
}
function automationEmailGroup(recipe,ownerId){
  const id=String(recipe&&recipe.email&&recipe.email.groupId||'').trim();
  const group=automationEmailGroupsForOwner(ownerId).find(item=>item.id===id);
  if(!group)throw Object.assign(new Error('E-posta grubu seçin.'),{code:'AUTOMATION_EMAIL_GROUP_REQUIRED',statusCode:400});
  if(!(group.to||[]).length)throw Object.assign(new Error('Seçili e-posta grubunda To alıcısı bulunmuyor.'),{code:'AUTOMATION_EMAIL_GROUP_EMPTY',statusCode:400});
  return group;
}
/* v6.36 — ALANA GÖRE BÖLÜNMÜŞ ALICILAR.
   Satırlar recipientField değerine göre gruplanır ve her değer adres defterinde
   AYNI ADLA aranır ("Üretici" değeri = adres defterindeki üretici adı, "Ülke"
   değeri = ihracat ekibi kaydının adı). Her grup kendi satırlarıyla ayrı bir
   e-posta olur.
   Karşılığı bulunamayan değerler ATILMAZ, unresolved olarak döner: sessizce
   eksik göndermek, bu zincirdeki en pahalı hata türüdür (v4.09 dersi). */
function automationSplitRecipients(rows,recipe,ownerId){
  const field=String(recipe&&recipe.email&&recipe.email.recipientField||'').trim();
  if(!field)throw Object.assign(new Error('Alıcıyı belirleyen alanı seçin.'),{code:'AUTOMATION_RECIPIENT_FIELD_REQUIRED',statusCode:400});
  const book=automationEmailGroupsForOwner(ownerId);
  const byName=new Map(book.map(group=>[String(group.name||'').trim().toLocaleLowerCase('tr-TR'),group]));
  const buckets=new Map();
  for(const row of (Array.isArray(rows)?rows:[])){
    const value=automationComparableValue(automationFieldValue(row,field)).trim();
    const key=value.toLocaleLowerCase('tr-TR');
    if(!buckets.has(key))buckets.set(key,{value,rows:[]});
    buckets.get(key).rows.push(row);
  }
  const resolved=[],unresolved=[];
  for(const bucket of buckets.values()){
    const group=bucket.value?byName.get(bucket.value.toLocaleLowerCase('tr-TR')):null;
    if(group&&(group.to||[]).length)resolved.push({value:bucket.value,group,rows:bucket.rows});
    else unresolved.push({value:bucket.value||'(boş)',rows:bucket.rows.length});
  }
  resolved.sort((a,b)=>a.value.localeCompare(b.value,'tr-TR',{sensitivity:'base'}));
  return {field,resolved,unresolved};
}
function automationAnalyze(rows,config={}){
  const list=Array.isArray(rows)?rows:[],groupBy=String(config.groupBy||'').trim(),valueField=String(config.valueField||'').trim(),op=String(config.operation||'count').trim().toLowerCase(),topN=Math.max(1,Math.min(50,Number(config.topN)||15));
  if(!groupBy)return {operation:'count',total:list.length,groups:[]};
  const groups=new Map();
  for(const row of list){const key=String(row&&row[groupBy]==null?'(boş)':row[groupBy]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const calc=items=>{if(op==='count'||!valueField)return items.length;const nums=items.map(row=>Number(row&&row[valueField])).filter(Number.isFinite);if(!nums.length)return 0;if(op==='sum')return nums.reduce((a,b)=>a+b,0);if(op==='avg')return nums.reduce((a,b)=>a+b,0)/nums.length;if(op==='min')return Math.min(...nums);if(op==='max')return Math.max(...nums);return items.length;};
  const result=[...groups.entries()].map(([key,items])=>({key,count:items.length,value:calc(items)})).sort((a,b)=>Number(b.value)-Number(a.value)||b.count-a.count).slice(0,topN);
  return {operation:op,groupBy,valueField,total:list.length,groups:result};
}
async function automationRunAppActions(ownerId,profile,recipe,dryRun){
  const uiActions=[],results=[];
  for(const action of recipe.appActions||[]){
    if(action.action==='open_page'){uiActions.push({action:'open_page',page:action.page});results.push({action:'open_page',page:action.page,dryRun});continue;}
    if(action.action==='refresh_source'){
      if(dryRun){results.push({action:'refresh_source',source:action.source,dryRun:true});continue;}
      const target=action.source||recipe.source;if(!['cp','orders','backlog','lfl','priceanalysis'].includes(target))throw Object.assign(new Error('Yenileme için CP / Orders / Backlog / LFL / Price & Supplier Analysis seçin.'),{code:'AUTOMATION_REFRESH_SOURCE_INVALID',statusCode:400});
      await performRefresh(ownerId,profile,[target]);results.push({action:'refresh_source',source:target,ok:true});continue;
    }
    results.push({action:'show_report',ok:true});
  }
  return {results,uiActions};
}
async function automationExecute(ownerId,profile,recipe,{dryRun=false,trigger='manual',dataset=null}={}){
  const data=dataset||await automationDataset(ownerId,profile,recipe),items=data.items||[],rows=data.items||[];
  const purpose=recipe.purpose||'browser',result={purpose,total:data.total,matched:data.matched,willProcess:data.items?data.items.length:1,sample:data.sample,processed:0,failed:0};if(data.join)result.join=data.join;
  if(data.change&&data.change.configured){result.change=data.change;if(!data.matched){result.processed=0;result.skipped=data.change.baselineReady?'no_change':'baseline_created';return result;}}
  if(['analysis','app','email','mixed'].includes(purpose)) result.analysis=automationAnalyze(rows,recipe.analysis||{});
  if(['app','mixed'].includes(purpose)) Object.assign(result,await automationRunAppActions(ownerId,profile,recipe,dryRun));
  if(['browser','mixed'].includes(purpose)){
    const steps=automationSteps(recipe);if(!steps.length)throw Object.assign(new Error('Önce web adımlarını kaydedin veya Terminal Kodu yazın.'),{code:'AUTOMATION_STEPS_EMPTY',statusCode:400});
    const browser=await agentBrowserConnector.run(ownerId,{url:recipe.url,steps,items:data.items||undefined,timeoutMs:recipe.timeoutMs,continueOnError:recipe.continueOnError},{dryRun});
    result.browser=browser;result.processed=Number(browser.processed)||0;result.failed=Number(browser.failed)||0;result.steps=browser.actions||[];
  } else result.processed=data.items?data.items.length:1;
  if(['email','mixed'].includes(purpose)){
    const email=recipe.email||{},fields=(email.reportFields||[]).filter(Boolean);
    const baseSubject=email.subject||recipe.name;
    // Tek gönderimi yürüten ortak yol: iki kip de buradan geçer, böylece taslak
    // ve Outlook davranışı ayrışamaz.
    /* v9.47 — Bir grubun yazışma dili. 'auto' kipinde karar satırların kendi
       verisinden gelir; grup içinde karışıklık varsa çoğunluk kazanır (bir
       üreticinin tek bir maili olacak, iki dilde yazılamaz). İngilizce metin
       tanımlı değilse Türkçesi kullanılır. */
    const groupLanguage=mailRows=>{
      if(email.languageMode==='tr'||email.languageMode==='en')return email.languageMode;
      if(email.languageMode!=='auto')return 'tr';
      let en=0,tr=0;
      for(const row of (mailRows||[]))(backlogAutomation.resolveCommunicationLanguage(row)==='en'?en++:tr++);
      return en>tr?'en':'tr';
    };
    const deliver=async(group,subjectBase,mailRows,langRows)=>{
      const lang=groupLanguage(langRows||mailRows);
      const useEn=lang==='en'&&(email.subjectEn||email.bodyEn);
      const subject=useEn&&email.subjectEn?String(subjectBase).replace(baseSubject,email.subjectEn):subjectBase;
      const body=useEn&&email.bodyEn?email.bodyEn:email.body;
      const entry={groupId:group.id,groupName:group.name,to:group.to,cc:group.cc,bcc:group.bcc,subject,rows:mailRows.length,deliveryMode:email.deliveryMode,language:lang};
      if(dryRun)return entry;
      if(email.deliveryMode==='outlook_send'){
        const sent=await automationEmail.sendWithOutlook({name:recipe.name,to:group.to,cc:group.cc,bcc:group.bcc,subject,body,rows:mailRows,fields});
        if(!sent.ok)throw Object.assign(new Error(sent.error||'Outlook gönderimi başarısız.'),{code:'AUTOMATION_EMAIL_SEND_FAILED',statusCode:502});
        return {...entry,...sent};
      }
      const open=trigger==='manual'&&email.openDraftOnManual!==false;
      const draft=automationEmail.createDraft({name:recipe.name,to:group.to,cc:group.cc,bcc:group.bcc,subject,body,rows:mailRows,fields,open});
      return {...entry,filename:draft.filename,opened:draft.opened,draftUrl:`/api/automations/mail-drafts/${encodeURIComponent(draft.filename)}`};
    };
    if(email.recipientMode==='field'){
      const split=automationSplitRecipients(rows,recipe,ownerId);
      if(!split.resolved.length)throw Object.assign(new Error(`"${split.field}" alanındaki hiçbir değer adres defterinde bulunamadı; e-posta gönderilmedi.`),{code:'AUTOMATION_RECIPIENTS_UNRESOLVED',statusCode:400});
      const messages=[];
      // Outlook COM automation is serialized deliberately; concurrent PowerShell
      // senders contend for the same desktop Outlook profile. Awaiting each child
      // keeps the server event loop free without introducing that race.
      for(const part of split.resolved)messages.push(await deliver(part.group,`${baseSubject} · ${part.value}`,email.includeReport===false?[]:part.rows,part.rows));
      result.emails=messages;
      result.email={...messages[0],split:true,messageCount:messages.length,recipientField:split.field};
      // Çözülemeyen değerler sonuçta AÇIKÇA raporlanır; kullanıcı hangi
      // üretici/ülke için e-posta gitmediğini görmeden devam etmemeli.
      if(split.unresolved.length)result.unresolvedRecipients=split.unresolved;
    }else{
      const group=automationEmailGroup(recipe,ownerId);
      result.email=await deliver(group,baseSubject,email.includeReport===false?[]:rows,rows);
    }
  }
  return result;
}
function automationAiRequest(code) {
  const raw = String(code == null ? '' : code);
  if (raw.length > 120000) throw Object.assign(new Error('Automation Code 120000 karakter sınırını aşamaz.'), { code: 'AI_AUTOMATION_CODE_TOO_LARGE', statusCode: 413 });
  let parsed;
  try { parsed = automationLanguage.parse(raw); }
  catch (error) { error.statusCode = Number(error.statusCode) || 400; throw error; }
  const validation = automationLanguage.validate(parsed, aiCapabilityRegistry.getCapabilityModel());
  if (!validation.ok) {
    const error = Object.assign(new Error('Automation Code doğrulama hataları içeriyor.'), { code: 'AI_AUTOMATION_VALIDATION_FAILED', statusCode: 422 });
    error.details = { validation };
    throw error;
  }
  return { parsed, validation };
}
function automationAiPreviewRows(rows, parsed, validation) {
  const list = Array.isArray(rows) ? rows : [];
  const matched = list.filter(row => automationLanguage.evaluateConditions(parsed.conditions, row, parsed.source));
  const safeRows = matched.slice(0, 20).map(row => Object.fromEntries(Object.entries(row || {}).filter(([key]) => automationPublicFieldName(key)).slice(0, 40).map(([key, value]) => [key, value == null || ['string','number','boolean'].includes(typeof value) ? value : String(value)])));
  return { source: parsed.source, total: list.length, matched: matched.length, sample: safeRows, requiredInputs: validation.requiredInputs, actions: parsed.actions.map(action => action.type) };
}
function automationAiPreviewSourceRows(ownerId, profile, source) {
  const timeoutMs = String(source || '').toLowerCase() === 'intake' ? 180000 : 30000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Kaynak verisi ön izleme için zamanında yanıt vermedi. Bağlantıyı veya mevcut önbelleği kontrol edin.'), { code: 'AI_AUTOMATION_PREVIEW_TIMEOUT', statusCode: 504 })), timeoutMs);
  });
  return Promise.race([automationSourceRows(ownerId, profile, source, null), timeout]).finally(() => clearTimeout(timer));
}
app.get('/api/automations', userAccess.requireArea('automations'), (req,res) => res.set('Cache-Control','no-store').json(automationState(req.currentUser.id, req.currentUser)));
app.get('/api/automations/ai/capabilities', userAccess.requireArea('automations'), (req,res) => {
  const model = aiCapabilityRegistry.getCapabilityModel();
  res.set('Cache-Control','no-store').json({ ok:true, model });
});
app.get('/api/automations/ai/guide', userAccess.requireArea('automations'), (req,res) => {
  const model = aiCapabilityRegistry.getCapabilityModel();
  res.type('text/markdown').set('Content-Disposition','attachment; filename="Buyer-Log-AI-Guide.md"').send(aiGuideGenerator.generateGuide(model));
});
app.post('/api/automations/ai/analyze', userAccess.requireArea('automations'), express.json({limit:'256kb'}), (req,res) => {
  try {
    const { parsed, validation } = automationAiRequest(req.body && req.body.code);
    res.json({ ok:true, parsed, validation, capabilities:{ appVersion:APP_VERSION, capabilityHash:validation.capabilityHash } });
  } catch (err) { automationError(res,err,'Automation Code analiz edilemedi.'); }
});
app.post('/api/automations/ai/preview', userAccess.requireArea('automations'), express.json({limit:'256kb'}), async (req,res) => {
  try {
    const { parsed, validation } = automationAiRequest(req.body && req.body.code);
    const rows = await automationAiPreviewSourceRows(req.currentUser.id, req.currentUser, parsed.source);
    res.json({ ok:true, preview:automationAiPreviewRows(rows, parsed, validation) });
  } catch (err) { automationError(res,err,'Automation Code ön izlemesi oluşturulamadı.'); }
});
app.post('/api/automations/ai/import', userAccess.requireArea('automations'), express.json({limit:'256kb'}), (req,res) => {
  try {
    const { parsed, validation } = automationAiRequest(req.body && req.body.code);
    const resolutions = req.body && req.body.resolutions && typeof req.body.resolutions === 'object' ? req.body.resolutions : {};
    const requestedGroup = String(resolutions.emailGroupId || '').trim();
    if (validation.requiredInputs.includes('EMAIL_GROUP')) {
      const group = automationEmailGroupsForOwner(req.currentUser.id).find(item => item.id === requestedGroup);
      if (!group) {
        const error = Object.assign(new Error('Taslağı oluşturmak için bir e-posta grubu seçin.'), { code:'AI_AUTOMATION_INPUT_REQUIRED', statusCode:422 });
        error.details = { requiredInputs:validation.requiredInputs, emailGroups:automationEmailGroupsForOwner(req.currentUser.id).map(group => ({ id:group.id, name:group.name })) };
        throw error;
      }
    }
    const compiled = aiAutomationCompiler.compile(parsed, validation, { sourceCode:String(req.body && req.body.code || ''), emailGroupId:requestedGroup });
    const normalized = automationNormalizePayload(compiled, req.currentUser.id);
    const saved = automationRecipeStore.createRecipe(req.currentUser.id, normalized);
    userAccess.appendAudit(req.currentUser,'AUTOMATION_AI_IMPORT',saved.result.id,{name:saved.result.name,source:saved.result.source,actions:parsed.actions.map(action => action.type),enabled:false});
    res.status(201).json({ ok:true, recipe:saved.result, state:automationState(req.currentUser.id,req.currentUser) });
  } catch (err) { automationError(res,err,'AI otomasyon taslağı oluşturulamadı.'); }
});
app.get('/api/automations/dataset-fields', userAccess.requireArea('automations'), async (req,res) => {
  try {
    const source=String(req.query&&req.query.source||'').trim().toLowerCase();
    const supported=['cp','orders','backlog','lfl','collection','asas','ias','intake'];
    if(!supported.includes(source))return res.json({source,rows:0,fields:[]});
    if(source==='intake'){
      const fields=aiCapabilityRegistry.sourceSpecificFields('intake').filter(field=>field.role==='dimension').map(field=>field.id);
      const snapshot=intakeStore.loadSnapshot(req.currentUser.id);
      return res.set('Cache-Control','no-store').json({source,rows:Array.isArray(snapshot&&snapshot.rows)?snapshot.rows.length:0,fields,metadata:aiCapabilityRegistry.sourceSpecificFields('intake')});
    }
    const joinSource=String(req.query&&req.query.join||'').trim().toLowerCase();const joinPrefixRaw=String(req.query&&req.query.joinPrefix||'').trim();let rows=await automationSourceRows(req.currentUser.id,req.currentUser,source,null);if(supported.includes(joinSource)&&joinSource!=='intake'){const joinRows=await automationSourceRows(req.currentUser.id,req.currentUser,joinSource,null);rows=automationJoinRows(rows,joinRows,{join:{source:joinSource,mode:'optional',prefix:joinPrefixRaw}}).rows;}const sample=rows.slice(0,400);const fields=[...new Set(sample.flatMap(row=>Object.keys(row||{}).map(automationPublicFieldName).filter(Boolean)))].sort((a,b)=>a.localeCompare(b,'tr-TR',{numeric:true,sensitivity:'base'}));res.set('Cache-Control','no-store').json({source,rows:rows.length,fields});
  }catch(err){automationError(res,err,'Dataset alanları okunamadı.');}
});
app.get('/api/automations/dataset-values', userAccess.requireArea('automations'), async (req,res) => {
  try{const source=String(req.query&&req.query.source||'').trim().toLowerCase(),field=String(req.query&&req.query.field||'').trim();if(!['cp','orders','backlog','lfl','collection','asas','ias','intake'].includes(source)||!automationPublicFieldName(field))return res.json({source,field,values:[]});const rows=await automationSourceRows(req.currentUser.id,req.currentUser,source,null),seen=new Set(),values=[];for(const row of rows){const raw=automationFieldValue(row,field),value=automationComparableValue(raw).trim();if(!value||seen.has(value))continue;seen.add(value);values.push(value);if(values.length>=300)break;}values.sort((a,b)=>a.localeCompare(b,'tr-TR',{numeric:true,sensitivity:'base'}));res.set('Cache-Control','no-store').json({source,field,values,truncated:seen.size>=300});}catch(err){automationError(res,err,'Alan değerleri okunamadı.');}
});
app.post('/api/automations/recipes', userAccess.requireArea('automations'), express.json({limit:'2mb'}), (req,res) => {try{const value=automationNormalizePayload(req.body||{},req.currentUser.id),saved=automationRecipeStore.createRecipe(req.currentUser.id,value);userAccess.appendAudit(req.currentUser,'AUTOMATION_CREATE',saved.result.id,{name:saved.result.name,purpose:saved.result.purpose,source:saved.result.source,steps:saved.result.steps.length});res.status(201).json({ok:true,recipe:saved.result,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'Otomasyon oluşturulamadı.');}});
app.put('/api/automations/recipes/:id', userAccess.requireArea('automations'), express.json({limit:'2mb'}), (req,res) => {try{const value=automationNormalizePayload(req.body||{},req.currentUser.id),saved=automationRecipeStore.updateRecipe(req.currentUser.id,req.params.id,value);userAccess.appendAudit(req.currentUser,'AUTOMATION_UPDATE',saved.result.id,{name:saved.result.name,purpose:saved.result.purpose,source:saved.result.source,steps:saved.result.steps.length});res.json({ok:true,recipe:saved.result,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'Otomasyon güncellenemedi.');}});
app.delete('/api/automations/recipes/:id', userAccess.requireArea('automations'), (req,res) => {try{const saved=automationRecipeStore.deleteRecipe(req.currentUser.id,req.params.id);userAccess.appendAudit(req.currentUser,'AUTOMATION_DELETE',saved.result.id,{name:saved.result.name});res.json({ok:true,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'Otomasyon silinemedi.');}});
app.post('/api/automations/email-groups', userAccess.requireArea('automations'), userAccess.requireModerator, express.json({limit:'512kb'}), (req,res) => {try{const saved=automationRecipeStore.replaceEmailGroups(req.body&&req.body.groups,req.currentUser);userAccess.appendAudit(req.currentUser,'AUTOMATION_EMAIL_GROUPS_UPDATE','email-groups',{groups:saved.result.length});res.json({ok:true,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'E-posta grupları kaydedilemedi.');}});
app.get('/api/automations/mail-drafts/:filename', userAccess.requireArea('automations'), (req,res) => {const full=automationEmail.draftPath(req.params.filename);if(!full)return res.status(404).json({error:'E-posta taslağı bulunamadı.',code:'AUTOMATION_DRAFT_NOT_FOUND'});res.download(full,path.basename(full));});
app.get('/api/automations/browser/status', userAccess.requireArea('automations'), async (req,res) => {try{res.set('Cache-Control','no-store').json({ok:true,status:await agentBrowserConnector.status(req.currentUser.id)});}catch(err){automationError(res,err,'Edge bağlantı durumu okunamadı.');}});
app.post('/api/automations/browser/prepare-existing-edge', userAccess.requireArea('automations'), async (req,res) => {try{const result=agentBrowserConnector.openExistingEdgeDebugSetup();userAccess.appendAudit(req.currentUser,'AUTOMATION_BROWSER_EXISTING_EDGE_SETUP','edge',{userDataDir:result.userDataDir});res.json({ok:true,result,status:await agentBrowserConnector.status(req.currentUser.id)});}catch(err){automationError(res,err,'Mevcut Edge profili bağlantı ekranı açılamadı.');}});
app.post('/api/automations/browser/open', userAccess.requireArea('automations'), express.json({limit:'32kb'}), async (req,res) => {try{const result=await agentBrowserConnector.openConnection(req.currentUser.id,String(req.body&&req.body.url||''));userAccess.appendAudit(req.currentUser,'AUTOMATION_BROWSER_OPEN',result.url,{openMode:result.openMode});res.json({ok:true,result});}catch(err){automationError(res,err,'Web sekmesi açılamadı.');}});
app.post('/api/automations/browser/record/start', userAccess.requireArea('automations'), express.json({limit:'32kb'}), async (req,res) => {try{const recording=await agentBrowserConnector.startRecording(req.currentUser.id,String(req.body&&req.body.url||''));userAccess.appendAudit(req.currentUser,'AUTOMATION_RECORD_START',recording.id,{url:recording.url});res.json({ok:true,recording});}catch(err){automationError(res,err,'Otomasyon kaydı başlatılamadı.');}});
app.get('/api/automations/browser/record/:id', userAccess.requireArea('automations'), async (req,res) => {try{res.set('Cache-Control','no-store').json({ok:true,recording:await agentBrowserConnector.recordingState(req.currentUser.id,req.params.id)});}catch(err){automationError(res,err,'Otomasyon kaydı okunamadı.');}});
app.post('/api/automations/browser/record/:id/stop', userAccess.requireArea('automations'), async (req,res) => {try{const recording=await agentBrowserConnector.stopRecording(req.currentUser.id,req.params.id);userAccess.appendAudit(req.currentUser,'AUTOMATION_RECORD_STOP',recording.id,{url:recording.url,steps:recording.steps.length});res.json({ok:true,recording});}catch(err){automationError(res,err,'Otomasyon kaydı durdurulamadı.');}});
app.post('/api/automations/browser/settings', userAccess.requireArea('automations'), userAccess.requireModerator, express.json({limit:'32kb'}), (req,res) => {try{const saved=agentBrowserSettings.saveSettings(req.body||{},req.currentUser);userAccess.appendAudit(req.currentUser,'AUTOMATION_BROWSER_SETTINGS_UPDATE','browser',{allowedHosts:saved.allowedHosts});res.json({ok:true,browser:{...saved,canConfigure:true,managedPort:agentBrowserConnector.managedCdpPort()},state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'Browser ayarları kaydedilemedi.');}});
app.post('/api/automations/recipes/:id/preview', userAccess.requireArea('automations'), async (req,res) => {
  try{const recipe=automationRecipeStore.recipeForOwner(req.currentUser.id,req.params.id);if(!recipe)return res.status(404).json({error:'Otomasyon bulunamadı.',code:'AUTOMATION_NOT_FOUND'});const data=await automationDataset(req.currentUser.id,req.currentUser,recipe);if(recipe.source!=='manual'&&!data.matched&&!(data.change&&data.change.configured))throw Object.assign(new Error('Filtrelere uyan kayıt bulunamadı.'),{code:'AUTOMATION_NO_MATCH',statusCode:409});const run=automationRecipeStore.createRun(req.currentUser.id,recipe,{dryRun:true,source:recipe.source,matched:data.matched}).result;const result=await automationExecute(req.currentUser.id,req.currentUser,recipe,{dryRun:true,trigger:'manual',dataset:data});automationRecipeStore.updateRun(req.currentUser.id,run.id,{status:'dry_run',processed:result.willProcess||0,failed:0,result,message:'Dry Run başarılı.',finishedAt:new Date().toISOString()});userAccess.appendAudit(req.currentUser,'AUTOMATION_DRY_RUN',recipe.id,{name:recipe.name,purpose:recipe.purpose,source:recipe.source,matched:data.matched});const previewToken=automationPreviewCachePut(req.currentUser.id,recipe,data);res.json({ok:true,preview:result,previewToken,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){automationError(res,err,'Otomasyon ön izlemesi oluşturulamadı.');}
});
app.post('/api/automations/recipes/:id/run', userAccess.requireArea('automations'), express.json({limit:'16kb'}), async (req,res) => {
  let run=null,recipe=null;try{recipe=automationRecipeStore.recipeForOwner(req.currentUser.id,req.params.id);if(!recipe)return res.status(404).json({error:'Otomasyon bulunamadı.',code:'AUTOMATION_NOT_FOUND'});if(recipe.enabled===false)throw Object.assign(new Error('Otomasyon devre dışı.'),{code:'AUTOMATION_DISABLED',statusCode:409});const cached=automationPreviewCacheTake(req.body&&req.body.previewToken,req.currentUser.id,recipe),data=cached||await automationDataset(req.currentUser.id,req.currentUser,recipe);if(recipe.source!=='manual'&&!data.matched&&!(data.change&&data.change.configured))throw Object.assign(new Error('Filtrelere uyan kayıt bulunamadı.'),{code:'AUTOMATION_NO_MATCH',statusCode:409});run=automationRecipeStore.createRun(req.currentUser.id,recipe,{dryRun:false,source:recipe.source,matched:data.matched,trigger:'manual'}).result;userAccess.appendAudit(req.currentUser,'AUTOMATION_RUN_START',recipe.id,{name:recipe.name,purpose:recipe.purpose,source:recipe.source,matched:data.matched});const result=await automationExecute(req.currentUser.id,req.currentUser,recipe,{dryRun:false,trigger:'manual',dataset:data});if(data.changeBaseline&&!result.failed)automationRecipeStore.setChangeBaseline(req.currentUser.id,recipe.id,data.changeBaseline);const finished=automationRecipeStore.updateRun(req.currentUser.id,run.id,{status:result.failed?'failed':'completed',processed:Number(result.processed)||0,failed:Number(result.failed)||0,result,message:result.failed?`${result.failed} kayıt başarısız.`:'Otomasyon tamamlandı.',finishedAt:new Date().toISOString()}).result;userAccess.appendAudit(req.currentUser,'AUTOMATION_RUN_FINISH',recipe.id,{runId:run.id,processed:finished.processed,failed:finished.failed,status:finished.status});res.json({ok:!result.failed,result,run:finished,state:automationState(req.currentUser.id,req.currentUser)});}catch(err){if(run){try{automationRecipeStore.updateRun(req.currentUser.id,run.id,{status:'failed',message:err.message,failed:1,finishedAt:new Date().toISOString(),result:err.details||null});}catch(err2){logRuntimeFailure('automationUpdateRunFailed',err2);}userAccess.appendAudit(req.currentUser,'AUTOMATION_RUN_FAIL',recipe&&recipe.id||'',{runId:run.id,error:err.message,code:err.code||'AUTOMATION_FAILED'});}automationError(res,err,'Otomasyon çalıştırılamadı.');}
});

/* v6.36 — Kaçırılan tetik uçları. Açılışta istemci pending-triggers'ı sorar;
   kullanıcı çalıştır ya da atla der. Sessiz geç gönderim yok. */
/* v6.41 — YERLEŞİK WEB BETİKLERİ.
   Dış sitelerle konuşan gömülü akışlar (PLM görsel indirme/küçültme, QTX
   indirme) artık Terminal'den düzenlenebiliyor. Yetki MODERATÖR: bu kod dış
   sitelerde oturum açmış tarayıcıda çalışır, Terminal'in kendisiyle aynı
   sınırda olmalı. */
app.get('/api/web-scripts', userAccess.requireModerator, (req,res) => {
  try{
    res.set('Cache-Control','no-store').json({
      ok:true,
      scripts:webScriptRegistry.publicList(),
      maxBytes:webScriptStore.MAX_CODE_BYTES,
    });
  }catch(err){ automationError(res,err,'Web betikleri okunamadı.'); }
});
app.post('/api/web-scripts/:id', userAccess.requireModerator, express.json({limit:'1mb'}), (req,res) => {
  try{
    const entry=webScriptRegistry.byId(req.params.id);
    if(!entry)return res.status(404).json({error:'Web betiği bulunamadı.',code:'WEB_SCRIPT_NOT_FOUND'});
    const saved=webScriptStore.saveOverride(entry.id,req.body&&req.body.code,req.currentUser);
    userAccess.appendAudit(req.currentUser,'WEB_SCRIPT_SAVE',entry.id,{revision:saved&&saved.revision});
    res.json({ok:true,scripts:webScriptRegistry.publicList()});
  }catch(err){ automationError(res,err,'Web betiği kaydedilemedi.'); }
});
// Fabrika koduna dönüş. Kullanıcının yazdığı sürüm silinir; koddaki fabrika
// hâli hiç değişmediği için bu her zaman çalışır.
app.post('/api/web-scripts/:id/reset', userAccess.requireModerator, (req,res) => {
  try{
    const entry=webScriptRegistry.byId(req.params.id);
    if(!entry)return res.status(404).json({error:'Web betiği bulunamadı.',code:'WEB_SCRIPT_NOT_FOUND'});
    const cleared=webScriptStore.clearOverride(entry.id);
    userAccess.appendAudit(req.currentUser,'WEB_SCRIPT_RESET',entry.id,{cleared});
    res.json({ok:true,cleared,scripts:webScriptRegistry.publicList()});
  }catch(err){ automationError(res,err,'Web betiği sıfırlanamadı.'); }
});
// Kaydetmeden önce sözdizimi denetimi. Bozuk betik kaydedilirse hata ancak dış
// siteye gidildiğinde ortaya çıkar ve akış sessizce bozulur.
app.post('/api/web-scripts/:id/validate', userAccess.requireModerator, express.json({limit:'1mb'}), (req,res) => {
  try{
    const check=webScriptStore.validateCode(req.body&&req.body.code);
    res.json({ok:true,valid:check.ok,error:check.ok?'':check.error});
  }catch(err){ automationError(res,err,'Web betiği doğrulanamadı.'); }
});

app.get('/api/automations/pending-triggers', userAccess.requireArea('automations'), (req,res) => {
  try{ res.set('Cache-Control','no-store').json({ok:true,pending:automationMissedTriggers(req.currentUser.id)}); }
  catch(err){ automationError(res,err,'Bekleyen otomasyon tetikleri okunamadı.'); }
});
app.post('/api/automations/pending-triggers/skip', userAccess.requireArea('automations'), express.json({limit:'32kb'}), (req,res) => {
  try{
    const wanted=new Set((Array.isArray(req.body&&req.body.recipeIds)?req.body.recipeIds:[]).map(v=>String(v)));
    const skipped=[];
    for(const item of automationMissedTriggers(req.currentUser.id)){
      if(wanted.size&&!wanted.has(item.recipeId))continue;
      // Atlamak = o tetiği çalışmış saymak; böylece bir daha sorulmaz.
      automationRecipeStore.markSchedule(req.currentUser.id,item.recipeId,item.key);
      skipped.push(item.recipeId);
    }
    userAccess.appendAudit(req.currentUser,'AUTOMATION_MISSED_SKIP','pending',{recipes:skipped});
    res.json({ok:true,skipped,pending:automationMissedTriggers(req.currentUser.id)});
  }catch(err){ automationError(res,err,'Bekleyen tetikler atlanamadı.'); }
});
app.post('/api/automations/pending-triggers/run', userAccess.requireArea('automations'), express.json({limit:'32kb'}), async (req,res) => {
  try{
    const wanted=new Set((Array.isArray(req.body&&req.body.recipeIds)?req.body.recipeIds:[]).map(v=>String(v)));
    const results=[];
    for(const item of automationMissedTriggers(req.currentUser.id)){
      if(wanted.size&&!wanted.has(item.recipeId))continue;
      const recipe=automationRecipeStore.recipeForOwner(req.currentUser.id,item.recipeId);
      if(!recipe)continue;
      // Tetik ÖNCE işaretlenir: çalışma hata verse bile aynı tetik döngüye
      // girip tekrar tekrar denenmemeli.
      automationRecipeStore.markSchedule(req.currentUser.id,recipe.id,item.key);
      let run=null;
      try{
        const data=await automationDataset(req.currentUser.id,req.currentUser,recipe);
        if(recipe.source!=='manual'&&!data.matched&&!(data.change&&data.change.configured)){results.push({recipeId:recipe.id,name:recipe.name,status:'skipped',message:'Filtrelere uyan kayıt yok.'});continue;}
        run=automationRecipeStore.createRun(req.currentUser.id,recipe,{dryRun:false,source:recipe.source,matched:data.matched,trigger:'missed',scheduleKey:item.key}).result;
        const result=await automationExecute(req.currentUser.id,req.currentUser,recipe,{dryRun:false,trigger:'schedule',dataset:data});
        if(data.changeBaseline&&!result.failed)automationRecipeStore.setChangeBaseline(req.currentUser.id,recipe.id,data.changeBaseline);
        automationRecipeStore.updateRun(req.currentUser.id,run.id,{status:result.failed?'failed':'completed',processed:Number(result.processed)||0,failed:Number(result.failed)||0,result,message:'Kaçırılan tetik kullanıcı onayıyla çalıştırıldı.',finishedAt:new Date().toISOString()});
        results.push({recipeId:recipe.id,name:recipe.name,status:result.failed?'failed':'completed',processed:Number(result.processed)||0});
      }catch(err){
        if(run)try{automationRecipeStore.updateRun(req.currentUser.id,run.id,{status:'failed',failed:1,message:err.message,finishedAt:new Date().toISOString()});}catch(err2){logRuntimeFailure('automationUpdateRunFailed',err2);}
        results.push({recipeId:recipe.id,name:recipe.name,status:'failed',message:err.message});
      }
    }
    userAccess.appendAudit(req.currentUser,'AUTOMATION_MISSED_RUN','pending',{results:results.map(r=>({id:r.recipeId,status:r.status}))});
    res.json({ok:true,results,pending:automationMissedTriggers(req.currentUser.id),state:automationState(req.currentUser.id,req.currentUser)});
  }catch(err){ automationError(res,err,'Kaçırılan tetikler çalıştırılamadı.'); }
});

function automationScheduleKey(recipe,now=new Date()){
  const schedule=recipe&&recipe.schedule||{};if(!recipe||recipe.enabled===false||schedule.enabled!==true||recipe.purpose!=='email')return'';
  const hhmm=String(schedule.time||'09:00'),[hh,mm]=hhmm.split(':').map(Number);const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if(schedule.mode==='daily'){if(now.getHours()*60+now.getMinutes()<hh*60+mm)return'';return`daily:${today}:${hhmm}`;}
  if(schedule.mode==='weekly'){if(!(schedule.weekdays||[]).includes(now.getDay())||now.getHours()*60+now.getMinutes()<hh*60+mm)return'';return`weekly:${today}:${hhmm}`;}
  if(schedule.mode==='interval'){const last=schedule.lastRunAt?new Date(schedule.lastRunAt):null;if(last&&!Number.isNaN(last.getTime())&&now-last<Math.max(1,Number(schedule.intervalHours)||24)*3600000)return'';return`interval:${Math.floor(now.getTime()/60000)}`;}
  return'';
}
/* ===================================================================
   v6.36 — KAÇIRILAN TETİKLER (zamanlama kararı "B+C")
   Sunucu son pencere kapanınca kendini kapattığı için (AUTO_EXIT), planlı bir
   otomasyonun saatinde uygulama açık olmayabilir. Eski davranış TUTARSIZDI:
   aynı gün geç açılırsa tetik SESSİZCE geç çalışıyor (Pazartesi 23:50'de
   09:00'ın e-postası gidiyordu), farklı gün açılırsa SESSİZCE kayboluyordu.
   İkisi de kötü: geç gönderim kullanıcıyı habersiz yakalar, kayıp gönderim ise
   hiç fark edilmez.
   Yeni davranış: kısa bir tolerans penceresi içinde kalan tetik normal çalışır;
   penceresi geçmiş tetik ÇALIŞTIRILMAZ, "kaçırıldı" olarak işaretlenir ve
   kullanıcıya açılışta sorulur (çalıştır / atla).
   =================================================================== */
const AUTOMATION_GRACE_MINUTES = 90;
const AUTOMATION_MISSED_LOOKBACK_DAYS = 14;
// Bir tarifin ŞU ANA KADAR gerçekleşmiş olması gereken EN SON tetiğini bulur.
// Geriye doğru gün gün bakar; interval kipi kendi son çalışmasına göre işlediği
// için burada kapsam dışıdır (kaçırma kavramı orada anlamsız).
function automationDueOccurrence(recipe, now = new Date()) {
  const schedule = (recipe && recipe.schedule) || {};
  if (!recipe || recipe.enabled === false || schedule.enabled !== true || recipe.purpose !== 'email') return null;
  if (!['daily', 'weekly'].includes(schedule.mode)) return null;
  const hhmm = String(schedule.time || '09:00');
  const [hh, mm] = hhmm.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  for (let back = 0; back <= AUTOMATION_MISSED_LOOKBACK_DAYS; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hh, mm, 0, 0);
    if (day > now) continue;
    if (schedule.mode === 'weekly' && !weekdays.includes(day.getDay())) continue;
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    return { key: `${schedule.mode}:${stamp}:${hhmm}`, dueAt: day, lateMinutes: Math.floor((now - day) / 60000) };
  }
  return null;
}
function automationIsWithinGrace(occurrence) {
  return Boolean(occurrence) && occurrence.lateMinutes <= AUTOMATION_GRACE_MINUTES;
}
// Sahibi için bekleyen (kaçırılmış) tetikleri listeler.
function automationMissedTriggers(ownerId, now = new Date()) {
  const out = [];
  for (const recipe of automationRecipeStore.allRecipes()) {
    if (String(recipe.ownerId || '') !== String(ownerId || '')) continue;
    const occurrence = automationDueOccurrence(recipe, now);
    if (!occurrence) continue;
    if (recipe.schedule && recipe.schedule.lastKey === occurrence.key) continue;
    if (automationIsWithinGrace(occurrence)) continue; // birazdan normal akışta çalışacak
    out.push({
      recipeId: recipe.id,
      name: recipe.name,
      key: occurrence.key,
      dueAt: occurrence.dueAt.toISOString(),
      lateMinutes: occurrence.lateMinutes,
    });
  }
  return out.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}
let automationSchedulerBusy=false;
async function runScheduledAutomations(){
  if(automationSchedulerBusy)return;automationSchedulerBusy=true;try{const now=new Date(),profiles=userAccess.allPublicProfiles();for(const recipe of automationRecipeStore.allRecipes()){const key=automationScheduleKey(recipe,now);if(!key||recipe.schedule&&recipe.schedule.lastKey===key)continue;
    // v6.36 — tolerans penceresi geçmiş tetik burada ÇALIŞTIRILMAZ; kullanıcıya
    // açılışta sorulmak üzere bekletilir. Geç bir e-postayı habersiz göndermek,
    // sormaktan daha kötüdür.
    const occurrence=automationDueOccurrence(recipe,now);
    if(occurrence&&occurrence.key===key&&!automationIsWithinGrace(occurrence))continue;const profile=profiles.find(p=>p.id===recipe.ownerId&&p.enabled!==false);if(!profile)continue;automationRecipeStore.markSchedule(recipe.ownerId,recipe.id,key);let run=null;try{const data=await automationDataset(recipe.ownerId,profile,recipe);if(recipe.source!=='manual'&&!data.matched&&!(data.change&&data.change.configured))continue;run=automationRecipeStore.createRun(recipe.ownerId,recipe,{dryRun:false,source:recipe.source,matched:data.matched,trigger:'schedule',scheduleKey:key}).result;const result=await automationExecute(recipe.ownerId,profile,recipe,{dryRun:false,trigger:'schedule',dataset:data});if(data.changeBaseline&&!result.failed)automationRecipeStore.setChangeBaseline(recipe.ownerId,recipe.id,data.changeBaseline);automationRecipeStore.updateRun(recipe.ownerId,run.id,{status:result.failed?'failed':'completed',processed:Number(result.processed)||0,failed:Number(result.failed)||0,result,message:'Planlı otomasyon tamamlandı.',finishedAt:new Date().toISOString()});userAccess.appendAudit(profile,'AUTOMATION_SCHEDULE_RUN',recipe.id,{runId:run.id,key,status:result.failed?'failed':'completed'});}catch(err){if(run)try{automationRecipeStore.updateRun(recipe.ownerId,run.id,{status:'failed',failed:1,message:err.message,finishedAt:new Date().toISOString()});}catch(err2){logRuntimeFailure('automationUpdateRunFailed',err2);}userAccess.appendAudit(profile,'AUTOMATION_SCHEDULE_FAIL',recipe.id,{key,error:err.message});}}}finally{automationSchedulerBusy=false;}
}

// ---- Shared quotation records ----
// Every signed-in user can view every quotation. Editing is limited to the
// owner, explicitly assigned editors, and the Moderator. The server is the
// authority; browser localStorage is used only as a migration/fallback cache.
/* ===================================================================
   ÜRETİCİ E-POSTA GRUPLARI (v7.32) — ORTAK ALAN

   Veri tüm kullanıcılara açıktır (talep: "herkesin girdiği veri ortak alanda
   görünür durumda olsun"). Değiştirme yalnız Moderatörün verdiği ortak ayar
   yetkisiyle (manageBusinessRules) yapılır. Yazma işlemleri KAYIT BAZLI KİLİTLE korunur ve
   kilit SUNUCUDA doğrulanır (§32): istemcinin kendini kilit sahibi ilan
   etmesi yeterli değildir.
   =================================================================== */
function emailGroupsActor(req) {
  const profile = req.currentUser || {};
  return { id: String(profile.id || ''), name: String(profile.displayName || profile.username || '') };
}
function emailGroupsRespond(res, payload) {
  res.set('Cache-Control', 'no-store').json({ ok: true, ...payload, ...emailGroupsStore.publicStore() });
}
app.get('/api/email-groups', (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok: true, currentUserId: emailGroupsActor(req).id, ...emailGroupsStore.publicStore() }); }
  catch (err) { apiError(res, err, 'E-posta grupları okunamadı.'); }
});
app.put('/api/email-groups/headings/:kind', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    emailGroupsStore.replaceHeadings(req.params.kind, body.items, body.expectedRevision);
    userAccess.appendAudit(req.currentUser, 'EMAIL_GROUP_HEADINGS_UPDATED', String(req.params.kind), { count: (body.items || []).length });
    publishSharedMasterChange('emailGroups', req);
    emailGroupsRespond(res, {});
  } catch (err) { apiError(res, err, 'Başlıklar kaydedilemedi.'); }
});
app.post('/api/email-groups/records', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const result = emailGroupsStore.createRecord(body.record, emailGroupsActor(req), body.expectedRevision);
    userAccess.appendAudit(req.currentUser, 'EMAIL_GROUP_RECORD_CREATED', result.record.id, { manufacturer: result.record.manufacturer });
    publishSharedMasterChange('emailGroups', req);
    emailGroupsRespond(res, { record: result.record });
  } catch (err) { apiError(res, err, 'E-posta kaydı eklenemedi.'); }
});
/* v7.35 — Prepare E-Mail kayıtlarının ortak alana taşınması. Aday listesi
   istemciden gelir (kullanıcının kendi çalışma alanında durur, sunucu okuyamaz);
   birleştirme kararını SUNUCU verir ve tek yazma işleminde uygular. */
app.post('/api/email-groups/import', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '4mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const result = emailGroupsStore.importRecords(body.records, emailGroupsActor(req), body.expectedRevision);
    userAccess.appendAudit(req.currentUser, 'EMAIL_GROUP_RECORDS_IMPORTED', 'prepare-email', {
      added: result.summary.added.length, filled: result.summary.filled.length,
      conflicts: result.summary.conflicts.length, locked: result.summary.locked.length,
      unchanged: result.summary.unchanged.length,
    });
    if (result.summary.added.length || result.summary.filled.length) publishSharedMasterChange('emailGroups', req);
    emailGroupsRespond(res, { summary: result.summary });
  } catch (err) { apiError(res, err, 'Prepare E-Mail kayıtları taşınamadı.'); }
});
app.put('/api/email-groups/records/:id', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '1mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const result = emailGroupsStore.updateRecord(req.params.id, body.record, emailGroupsActor(req), body.expectedRevision);
    userAccess.appendAudit(req.currentUser, 'EMAIL_GROUP_RECORD_UPDATED', req.params.id, { manufacturer: result.record.manufacturer });
    publishSharedMasterChange('emailGroups', req);
    emailGroupsRespond(res, { record: result.record });
  } catch (err) { apiError(res, err, 'E-posta kaydı kaydedilemedi.'); }
});
app.delete('/api/email-groups/records/:id', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '256kb' }), (req, res) => {
  try {
    emailGroupsStore.deleteRecord(req.params.id, emailGroupsActor(req), (req.body || {}).expectedRevision);
    userAccess.appendAudit(req.currentUser, 'EMAIL_GROUP_RECORD_DELETED', req.params.id, {});
    publishSharedMasterChange('emailGroups', req);
    emailGroupsRespond(res, { deleted: true });
  } catch (err) { apiError(res, err, 'E-posta kaydı silinemedi.'); }
});
/* Kilit al / tazele. Aynı uç kalp atışı olarak da kullanılır: düzenleme
   penceresi açık kaldıkça kilit tazelenir, kapanınca kendiliğinden düşer. */
app.post('/api/email-groups/records/:id/lock', userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '256kb' }), (req, res) => {
  try {
    const result = emailGroupsStore.acquireLock(req.params.id, emailGroupsActor(req));
    liveEvents.notifyChange('emailGroups', requestClientId(req), null);
    emailGroupsRespond(res, { record: result.record });
  } catch (err) { apiError(res, err, 'Kayıt düzenlemeye alınamadı.'); }
});
/* Tarayıcı kapanırken navigator.sendBeacon YALNIZ POST gönderebilir; kilidi
   bırakmanın son şansı budur. Ulaşmazsa sunucudaki kilit süresi zaten düşürür. */
app.post('/api/email-groups/records/:id/lock-release', (req, res) => {
  try { emailGroupsStore.releaseLock(req.params.id, emailGroupsActor(req)); res.json({ ok: true }); }
  catch (_) { res.json({ ok: false }); }
});
app.delete('/api/email-groups/records/:id/lock', express.json({ limit: '256kb' }), (req, res) => {
  try {
    const result = emailGroupsStore.releaseLock(req.params.id, emailGroupsActor(req));
    liveEvents.notifyChange('emailGroups', requestClientId(req), null);
    emailGroupsRespond(res, { record: result.record });
  } catch (err) { apiError(res, err, 'Kilit bırakılamadı.'); }
});

app.get('/api/quotations', userAccess.requireCapability('QUOTATIONS.VIEW'), (req, res) => {
  const store = quotationsVisibleTo(req.currentUser);
  const profiles = userAccess.allPublicProfiles().filter(profile => profile.enabled !== false).map(profile => ({
    id: profile.id, displayName: profile.displayName, username: profile.username, role: profile.role,
  }));
  res.json({ requests: store.requests, revision: store._revision, profiles, currentUserId: req.currentUser.id });
});
app.post('/api/quotations/import', userAccess.requireCapability('QUOTATIONS.CREATE'), express.json({ limit: '100mb' }), (req, res) => {
  try {
    // Her kullanıcının eski tarayıcı önbelleği yalnız o kullanıcıya ait kayıtlar
    // içerir. Ortak depoya geçişte bunları mevcut kayıtlara güvenli biçimde ekle;
    // importLegacy sahipliği oturumdaki kullanıcıya sabitler ve aynı ID'yi atlar.
    const result = quotationStore.importLegacy(req.currentUser, req.body && req.body.requests);
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_IMPORT', 'quotations', { imported: result.imported });
    res.json({ ok: true, imported: result.imported, requests: quotationsVisibleTo(req.currentUser).requests });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_IMPORT_FAILED' });
  }
});
app.post('/api/quotations', userAccess.requireCapability('QUOTATIONS.CREATE'), express.json({ limit: '100mb' }), (req, res) => {
  try {
    const source = req.body && req.body.source === 'cp' ? 'cp' : 'collection';
    if (!userAccess.hasArea(req.currentUser, source === 'cp' ? 'cp' : 'koleksiyon')) return res.status(403).json({ error: 'Bu quotation kaynağına erişim yetkiniz bulunmuyor.', code: 'ACCESS_AREA_REQUIRED' });
    const request = quotationStore.createRequest(req.currentUser, req.body || {});
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_CREATE', request.id, { source: request.source, items: request.items.length });
    res.status(201).json({ ok: true, request });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_CREATE_FAILED' });
  }
});
app.put('/api/quotations/:id', userAccess.requireCapability('QUOTATIONS.EDIT'), express.json({ limit: '100mb' }), (req, res) => {
  try {
    const request = quotationStore.updateRequest(req.currentUser, req.params.id, req.body || {});
    if (!request) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_UPDATE', request.id, { items: request.items.length });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_UPDATE_FAILED' });
  }
});
app.patch('/api/quotations/:id/status', userAccess.requireCapability('QUOTATIONS.EDIT'), express.json({ limit: '64kb' }), (req, res) => {
  try {
    const request = quotationStore.setStatus(req.currentUser, req.params.id, req.body && req.body.status);
    if (!request) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_STATUS', request.id, { status: request.status });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_STATUS_FAILED' });
  }
});
app.patch('/api/quotations/:id/editors', userAccess.requireCapability('QUOTATIONS.EDIT'), express.json({ limit: '256kb' }), (req, res) => {
  try {
    const validUserIds = userAccess.allPublicProfiles().filter(profile => profile.enabled !== false).map(profile => profile.id);
    const request = quotationStore.setEditors(req.currentUser, req.params.id, req.body && req.body.editorIds, validUserIds);
    if (!request) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_EDITORS', request.id, { editorIds: request.editorIds });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_EDITORS_FAILED' });
  }
});
app.post('/api/quotations/merge', userAccess.requireCapability('QUOTATIONS.EDIT'), express.json({ limit: '64kb' }), (req, res) => {
  try {
    const result = quotationStore.mergeRequests(req.currentUser, req.body && req.body.sourceId, req.body && req.body.targetId);
    if (!result) return res.status(404).json({ error: 'Birleştirilecek quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_MERGE', result.request.id, { removedId: result.removedId, items: result.request.items.length });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_MERGE_FAILED' });
  }
});
app.delete('/api/quotations/:id', userAccess.requireCapability('QUOTATIONS.DELETE'), (req, res) => {
  try {
    if (!quotationVisibleById(req.currentUser, req.params.id)) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    const request = quotationStore.hideRequest(req.currentUser, req.params.id);
    if (!request) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_HIDE', request.id, { source: request.source });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_HIDE_FAILED' });
  }
});
app.post('/api/quotations/:id/restore', userAccess.requireCapability('QUOTATIONS.DELETE'), (req, res) => {
  try {
    if (!quotationVisibleById(req.currentUser, req.params.id)) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    const request = quotationStore.restoreRequest(req.currentUser, req.params.id);
    if (!request) return res.status(404).json({ error: 'Quotation kaydı bulunamadı.', code: 'QUOTATION_NOT_FOUND' });
    void sharedRevisionStore.update('quotation',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'QUOTATION_RESTORE_VISIBILITY', request.id, { source: request.source });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'QUOTATION_RESTORE_FAILED' });
  }
});

async function refreshCollectionPermissionScope() {
  await collectionPermissionsReady;
  try { await collectionPermissions.sync(); } catch (_) { /* doğrulanmış yerel izin önbelleği çevrimdışında geçerlidir */ }
}
function sharedCollectionModeEnabled() {
  // Kept as a compatibility probe for old diagnostics. Collection ownership is
  // NEVER collapsed merely because Shared Hub is configured.
  return false;
}
function canonicalCollectionOwner(ownerId) {
  return String(ownerId || '');
}
function collectionWorkspaceEditAllowed(profile, ownerId) {
  const level = userAccess.collectionAccessLevel(profile, ownerId);
  if (level !== 'edit') return false;
  // Sahip kendi alanını düzenler; başkasının alanında EDIT grantine ek olarak
  // global Collection EDIT yetkisi de gerekir.
  return String(profile && profile.id || '') === String(ownerId || '') || userAccess.hasCapability(profile, 'COLLECTIONS.EDIT');
}
async function afterSharedCollectionSave() {
  // Legacy call sites remain harmless. Owner workspaces publish through
  // collectionReplication below; Shared Hub itself never owns Collection rows.
  return false;
}
function collectionReplicationError(error) {
  return {
    ok:false, state:Number(error && error.statusCode) === 409 ? 'conflict' : 'error',
    code:String(error && error.code || 'COLLECTION_REPLICA_FAILED'),
    message:String(error && error.message || 'Koleksiyon ağ paylaşımına gönderilemedi.'),
    localRevision:Number(error && error.localRevision) || 0,
    remoteRevision:Number(error && error.remoteRevision) || 0,
  };
}
async function publishCollectionReplica(ownerId, traceName = 'collectionReplicaPublish') {
  try {
    const result = await collectionReplication.publishOwner(ownerId);
    // Başka cihazın eşzamanlı değişikliği birleştirildi: kaydeden istemci dahil
    // açık ekranlar birleşik sayfayı yeniden yükler.
    if (result && result.merged) liveEvents.notifyChange('collection', null, { ownerId, revision:result.revision, source:'shared-hub-merge' });
    return { ok:true, ...result, ...(result && result.conflicts ? await collectionReplication.status(ownerId) : {}) };
  }
  catch (error) { logRuntimeFailure(traceName, error); return collectionReplicationError(error); }
}
/* KOLEKSİYON CANLI EŞİTLEME. Başka bir cihazdaki düzenleyicinin kaydı, açık
   Koleksiyon ekranına sayfa yeniden açılmadan ulaşır: uzak kopya dosyası
   değiştiyse (mtime+boyut) eşitlenir/birleştirilir ve canlı olay yayılır.
   Yalnız bu cihazda Koleksiyon kullanan (son 12 saat) kullanıcılar için. */
const collectionLiveUsers = new Map();
function touchCollectionLiveUser(userId) { if (userId) collectionLiveUsers.set(String(userId), Date.now()); }
let collectionLivePollBusy = false;
async function pollCollectionReplicas() {
  if (collectionLivePollBusy) return [];
  collectionLivePollBusy = true;
  try {
    await collectionPermissionsReady;
    const changed = [];
    for (const [userId, seenAt] of [...collectionLiveUsers]) {
      if (Date.now() - seenAt > 12 * 3600 * 1000) { collectionLiveUsers.delete(userId); continue; }
      const ownerIds = collectionPermissions.effectiveOwners(userId).map(item => item.ownerId);
      for (const item of await collectionReplication.pollOwners(userId, ownerIds)) {
        changed.push(item);
        if (String(item.ownerId) !== String(userId)) void syncCollectionWorkspaceImagesForUser(userId, item.ownerId).catch(error => logRuntimeFailure('collectionLiveImageSync', error));
        liveEvents.notifyChange('collection', null, { ownerId:item.ownerId, revision:item.revision, source:'shared-hub' });
      }
    }
    return changed;
  } finally { collectionLivePollBusy = false; }
}
setInterval(() => {
  if (!uiReadySignaled) return;
  void pollCollectionReplicas().catch(error => logRuntimeFailure('collectionLivePoll', error));
}, 5000).unref();
async function collectionMergeConflictsFor(profile) {
  if (!profile || !profile.id) return [];
  await collectionPermissionsReady;
  return collectionReplication.listMergeConflicts(collectionPermissions.effectiveOwners(profile.id).map(item => item.ownerId));
}
async function applyCollectionConflictChoice(profile, conflict) {
  const ownerId = String(conflict.ownerId || '');
  if (!collectionWorkspaceEditAllowed(profile, ownerId)) throw Object.assign(new Error('Bu Koleksiyon sayfasını düzenleme yetkiniz bulunmuyor.'), { code:'COLLECTION_EDIT_DENIED', statusCode:403 });
  const current = (collectionWorkspaces.loadWorkspace(ownerId).rows || []).find(row => String(row && row.id) === String(conflict.rowId));
  let change = null;
  if (conflict.field === '_deleted') {
    if (current && conflict.incoming === 'yerelde silindi') change = { deletes:[{ id:current.id, _rev:current._rev }] };
  } else if (current) {
    const row = { ...current };
    if (conflict.incoming == null) delete row[conflict.field]; else row[conflict.field] = conflict.incoming;
    change = { upserts:[row] };
  }
  if (!change) return;
  const result = await collectionWorkspaces.applyRowChangesAsync(ownerId, change);
  if (result.conflicts && result.conflicts.length) throw Object.assign(new Error('Satır bu arada değişti; çakışmayı yeniden deneyin.'), { code:'COLLECTION_ROW_CHANGED', statusCode:409 });
  if (result.changed) {
    await publishCollectionReplica(ownerId, 'collectionConflictPublish');
    liveEvents.notifyChange('collection', null, { ownerId, rowPatches:result.rowPatches, revision:result.saved && result.saved._revision });
  }
}
async function collectionReplicaStatus(ownerId, syncError = null) {
  if (syncError) return collectionReplicationError(syncError);
  try { return await collectionReplication.status(ownerId); }
  catch (error) { logRuntimeFailure('collectionReplicaStatus', error); return collectionReplicationError(error); }
}
function collectionIdentityName(value) {
  return String(value == null ? '' : value)
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function collectionProfileNames(profile) {
  return [...new Set([profile && profile.displayName, profile && profile.username]
    .map(collectionIdentityName)
    .filter(value => value && value !== 'moderator' && value !== 'moderator user'))];
}
function collectionRecoveryAliasProfiles(profile) {
  if (!profile) return [];
  const profiles = userAccess.allPublicProfiles().filter(item => item && item.enabled !== false);
  const isModerator = profile.systemRole === 'moderator' || String(profile.role || '').toLowerCase() === 'moderator';
  if (!isModerator) return profiles.filter(item => item.id === profile.id);
  const anchorNames = collectionProfileNames(profile);
  return profiles.filter(item => {
    if (item.id === profile.id) return true;
    if (item.systemRole === 'moderator' || String(item.role || '').toLowerCase() === 'moderator') return true;
    const candidateNames = collectionProfileNames(item);
    return anchorNames.some(left => candidateNames.some(right =>
      left === right || left.startsWith(right + ' ') || right.startsWith(left + ' ')
    ));
  });
}
async function ensureLegacyCollectionOwnerRecovery(profile) {
  const isModerator = profile && (profile.systemRole === 'moderator' || String(profile.role || '').toLowerCase() === 'moderator');
  if (!isModerator || !profile.id) return { recovered:false, reason:'not-moderator' };

  const aliases = collectionRecoveryAliasProfiles(profile);
  const aliasIds = new Set(aliases.map(item => String(item.id || '')).filter(Boolean));
  aliasIds.add(String(profile.id));
  const foreignOwnersWithData = userAccess.allPublicProfiles()
    .filter(item => item && item.enabled !== false && !aliasIds.has(String(item.id || '')))
    .filter(item => {
      const workspace = loadWorkspace(item.id);
      return Boolean(workspace && workspace.initialized && Array.isArray(workspace.rows) && workspace.rows.length);
    });

  // If another real user's owner workspace already contains data, only import
  // shared rows whose migration provenance points to one of this moderator's
  // aliases. With no foreign data (the current recovery case), every legacy
  // shared row can safely be claimed by the moderator.
  const result = collectionWorkspaces.recoverSharedWorkspaceIntoOwner(String(profile.id), {
    sourceOwnerIds:[...aliasIds].filter(id => id !== String(profile.id)),
    sharedSourceOwnerIds:foreignOwnersWithData.length ? [...aliasIds] : null,
  });
  if (result && (result.changed || result.markerWritten)) {
    markStartup('COLLECTION_OWNER_RECOVERED', {
      ownerId:String(profile.id), aliases:[...aliasIds], rows:result.totalRows,
      added:result.added, duplicatesMerged:result.duplicatesMerged,
      foreignOwnersSkipped:foreignOwnersWithData.map(item => item.id),
    });
    try { await collectionReplication.publishOwner(String(profile.id)); }
    catch (error) { logRuntimeFailure('collectionOwnerRecoveryPublish', error); }
    void publishCollectionWorkspaceImages(String(profile.id)).catch(error => logRuntimeFailure('collectionOwnerRecoveryImages', error));
  }
  return result;
}
app.get('/api/collection-workspaces', userAccess.requireArea('koleksiyon'), async (req, res) => {
  await refreshCollectionPermissionScope();
  // Legacy Collection recovery is forensic/manual-only. A read/list request must
  // never merge historical owner/shared workspaces into the live Collection.
  // This prevents a restart or stale delta snapshot from resurrecting old rows,
  // duplicating models, or changing image ownership merely by opening the page.
  const profiles = userAccess.allPublicProfiles();
  const access = new Map(userAccess.effectiveCollectionAccess(req.currentUser).map(item => [item.ownerId, item.level]));
  const samePersonOwnerIds = new Set(collectionRecoveryAliasProfiles(req.currentUser).map(profile => String(profile.id || '')));
  samePersonOwnerIds.delete(String(req.currentUser.id || ''));
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const workspaces = profiles.filter(profile => access.has(profile.id) && !samePersonOwnerIds.has(String(profile.id || ''))).map(profile => {
    const workspace = loadWorkspace(profile.id);
    const supervisor = profile.supervisorId ? byId.get(profile.supervisorId) : null;
    return { ownerId: profile.id, ownerName: profile.displayName, ownerRole: profile.role, supervisorName: supervisor ? (supervisor.displayName || supervisor.username || '') : '', level: access.get(profile.id), initialized: workspace.initialized, revision: workspace._revision, updatedAt: workspace._updatedAt };
  });
  res.json({ workspaces, currentOwnerId: req.currentUser.id, shared:false });
});
app.get('/api/collection-permissions', userAccess.requireArea('koleksiyon'), async (req, res) => {
  try {
    await refreshCollectionPermissionScope();
    const profiles = new Map(userAccess.allPublicProfiles().map(profile => [profile.id, profile]));
    const samePersonIds = new Set(collectionRecoveryAliasProfiles(req.currentUser).map(profile => String(profile.id || '')));
    const currentOwnerId = String(req.currentUser.id || '');
    const view = collectionPermissions.effectiveOwners(req.currentUser.id)
      .filter(item => String(item.ownerId || '') === currentOwnerId || !samePersonIds.has(String(item.ownerId || '')))
      .map(item => ({
        ...item,
        ownerName: profiles.get(item.ownerId)?.displayName || item.ownerId,
      }));
    const outgoing = collectionPermissions.outgoing(req.currentUser.id)
      .filter(item => !samePersonIds.has(String(item.granteeId || '')))
      .map(item => ({
        ...item,
        granteeName: profiles.get(item.granteeId)?.displayName || item.granteeId,
      }));
    const users = [...profiles.values()].filter(profile => profile.id !== req.currentUser.id && !samePersonIds.has(String(profile.id || ''))).map(profile => ({ id: profile.id, displayName: profile.displayName, username: profile.username, enabled: profile.enabled !== false }));
    res.set('Cache-Control', 'no-store').json({ revision: (await collectionPermissions.read()).revision, view, outgoing, users });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message || 'Koleksiyon izinleri okunamadı.', code: err.code || 'COLLECTION_PERMISSION_READ_FAILED' }); }
});
async function updateCollectionPermission(req, res, revoke = false) {
  try {
    await refreshCollectionPermissionScope();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ownerId = String(body.ownerId || req.currentUser.id || '');
    const granteeId = String(req.params.granteeId || '');
    const ownsWorkspace = ownerId === String(req.currentUser.id || '');
    if (!ownsWorkspace && !userAccess.hasCapability(req.currentUser, 'COLLECTIONS.MANAGE')) return res.status(403).json({ error: 'Başka bir kullanıcının Koleksiyon izinlerini değiştirme yetkiniz bulunmuyor.', code: 'COLLECTION_GRANT_DENIED' });
    const result = revoke
      ? await collectionPermissions.removeGrant({ ownerId, granteeId, actorId: req.currentUser.id })
      : await collectionPermissions.setGrant({ ownerId, granteeId, level: body.level, actorId: req.currentUser.id });
    userAccess.appendAudit(req.currentUser, revoke ? 'COLLECTION_PERMISSION_REVOKED' : 'COLLECTION_PERMISSION_SET', ownerId, { granteeId, level: revoke ? null : body.level, revision: result.revision });
    liveEvents.notifyChange('collection-permissions', requestClientId(req), { ownerId, granteeId, level: revoke ? null : body.level });
    if (!revoke) {
      // Grant only becomes useful when the owner's canonical workspace is also
      // available in the owner-scoped replication area. Publish data + images
      // best-effort without turning a slow SMB share into a permission UI lock.
      void collectionReplication.publishOwner(ownerId).catch(error => logRuntimeFailure('collectionWorkspacePublishOnGrant', error));
      void publishCollectionWorkspaceImages(ownerId).catch(error => logRuntimeFailure('collectionImagePublishOnGrant', error));
    }
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message || 'Koleksiyon izni güncellenemedi.', code: err.code || 'COLLECTION_PERMISSION_WRITE_FAILED', currentRevision: err.currentRevision }); }
}
app.put('/api/collection-permissions/:granteeId', userAccess.requireArea('koleksiyon'), express.json({ limit: '16kb' }), (req, res) => updateCollectionPermission(req, res, false));
app.delete('/api/collection-permissions/:granteeId', userAccess.requireArea('koleksiyon'), express.json({ limit: '16kb' }), (req, res) => updateCollectionPermission(req, res, true));
// Multi-Buyer Collection is a read-only projection.  The server intersects the
// requested owners with the caller's existing Collection permissions; it never
// grants access and it deliberately has no matching write endpoint.
app.get('/api/collection-workspaces-batch', userAccess.requireArea('koleksiyon'), async (req, res) => {
  await refreshCollectionPermissionScope();
  const requested = String(req.query.ownerIds || '').split(',').map(value => value.trim()).filter(Boolean);
  const unique = [...new Set(requested)].slice(0, 100);
  if (!unique.length) return res.status(400).json({ error: 'En az bir Koleksiyon sahibi seçilmelidir.', code: 'COLLECTION_OWNER_REQUIRED' });
  const profiles = new Map(userAccess.allPublicProfiles().map(profile => [profile.id, profile]));
  const denied = unique.filter(ownerId => !userAccess.collectionAccessLevel(req.currentUser, ownerId));
  if (denied.length) return res.status(403).json({ error: 'Seçilen Koleksiyon sayfalarından en az birine erişim yetkiniz bulunmuyor.', code: 'COLLECTION_ACCESS_DENIED' });
  const workspaces = [];
  for (const ownerId of unique) {
    const profile = profiles.get(ownerId); if (!profile) continue;
    const level = userAccess.collectionAccessLevel(req.currentUser, ownerId);
    let syncError = null;
    await collectionReplication.syncOwner(req.currentUser.id, ownerId).catch(error => { syncError=error; logRuntimeFailure('collectionReplicaDownload', error); });
    await syncCollectionWorkspaceImagesForUser(req.currentUser.id, ownerId).catch(error => logRuntimeFailure('collectionImageReplicaDownload', error));
    workspaces.push({ owner:{ id:profile.id, displayName:profile.displayName, role:profile.role }, access:{ level, canEdit:collectionWorkspaceEditAllowed(req.currentUser, ownerId) }, workspace:collectionWorkspaceWithLocalImages(ownerId), replication:await collectionReplicaStatus(ownerId, syncError) });
  }
  res.json({ workspaces, readOnly:true, shared:false });
});
app.get('/api/collection-workspaces/:ownerId', userAccess.requireArea('koleksiyon'), async (req, res) => {
  await refreshCollectionPermissionScope();
  const requestedOwnerId = String(req.params.ownerId || '');
  const ownerId = canonicalCollectionOwner(requestedOwnerId);
  const level = userAccess.collectionAccessLevel(req.currentUser, ownerId);
  if (!level) return res.status(403).json({ error:'Bu Koleksiyon sayfasına erişim yetkiniz bulunmuyor.', code:'COLLECTION_ACCESS_DENIED' });
  const profile = userAccess.allPublicProfiles().find(item => item.id === ownerId);
  if (!profile) return res.status(404).json({ error:'Koleksiyon sahibi bulunamadı.', code:'USER_NOT_FOUND' });
  touchCollectionLiveUser(req.currentUser.id);
  let syncError = null;
  await collectionReplication.syncOwner(req.currentUser.id, ownerId).catch(error => { syncError=error; logRuntimeFailure('collectionReplicaDownload', error); });
  await syncCollectionWorkspaceImagesForUser(req.currentUser.id, ownerId).catch(error => logRuntimeFailure('collectionImageReplicaDownload', error));
  res.json({ workspace:collectionWorkspaceWithLocalImages(ownerId), access:{ level, canEdit:collectionWorkspaceEditAllowed(req.currentUser, ownerId) }, owner:{ id:profile.id, displayName:profile.displayName, role:profile.role }, replication:await collectionReplicaStatus(ownerId, syncError), shared:false });
});
/* v7.21 — Koleksiyon kaydetme artık ASENKRON.

   Ölçüldü: eşzamanlı yol 50.000 satırlık bir sayfada olay döngüsünü 237 ms
   boyunca bloke ediyordu; o süre boyunca sunucu CP dahil hiçbir isteğe yanıt
   vermiyordu. Bir kullanıcının kaydı bütün ekibi durduruyordu.

   Kaydetme ayrıca DEĞİŞEN SATIRLARI döndürür; canlı olay artık "bu sayfa
   değişti" değil, "şu satırlar şöyle oldu" der. Karşı ekran sayfayı yeniden
   yüklemek zorunda kalmaz. */
/* v7.21 — Koleksiyon kaydetme AYRI BİR İŞ PARÇACIĞINDA yürür.

   Ölçüldü (50.000 satır): mevcut dosyayı okuyup ayrıştırmak 255 ms, yazma
   için JSON.stringify 84 ms, gelen gövdeyi ayrıştırmak 46 ms — hepsi CPU ve
   hepsi ana iş parçacığında. O süre boyunca sunucu CP dahil hiçbir isteğe
   yanıt veremiyordu; tek kullanıcının kaydı bütün ekibi durduruyordu.

   Gövde BURADA AYRIŞTIRILMAZ. express.raw ile ham buffer alınır ve worker'a
   verilir; ayrıştırma, okuma, doğrulama, satır farkı ve yazma orada olur.
   Ana iş parçacığına yalnız revizyon ve en fazla 500 satırlık yama döner. */
app.put('/api/collection-workspaces/:ownerId', userAccess.requireArea('koleksiyon'), express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  try {
    await refreshCollectionPermissionScope();
    const ownerId = canonicalCollectionOwner(String(req.params.ownerId || ''));
    if (!collectionWorkspaceEditAllowed(req.currentUser, ownerId)) return res.status(403).json({ error: 'Bu Koleksiyon sayfasını düzenleme yetkiniz bulunmuyor.', code: 'COLLECTION_EDIT_DENIED' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body == null ? '' : req.body), 'utf8');
    if (!body.length) return res.status(400).json({ error: 'Koleksiyon sayfası gövdesi boş.', code: 'COLLECTION_BODY_EMPTY' });
    const result = await collectionSaveWorker.runCollectionSave({
      ownerId, body, expectedRevision: null,
      env: {
        BUYER_LOG_SERVER_DATA_ROOT: process.env.BUYER_LOG_SERVER_DATA_ROOT,
        BUYER_LOG_DATA_ROOT: process.env.BUYER_LOG_DATA_ROOT,
        BUYER_LOG_LOCAL_DATA_ROOT: process.env.BUYER_LOG_LOCAL_DATA_ROOT,
        BUYER_LOG_CONFIG_PATH: process.env.BUYER_LOG_CONFIG_PATH,
        BUYER_LOG_TEMP_ROOT: process.env.BUYER_LOG_TEMP_ROOT,
        BL_DATA_DIR: process.env.BL_DATA_DIR,
      },
    });
    const replication = !(await afterSharedCollectionSave(ownerId))
      ? await publishCollectionReplica(ownerId)
      : { ok:true, published:false, reason:'shared-save' };
    void publishCollectionWorkspaceImages(ownerId).catch(error => logRuntimeFailure('collectionImagePublishOnSave', error));
    void sharedRevisionStore.update('collection',{actorId:req.currentUser.id,ownerId}).catch(error=>logRuntimeFailure('sharedRevision',error));
    userAccess.appendAudit(req.currentUser, 'COLLECTION_SAVE', ownerId, { rows: result.rowCount, revision: result.revision });
    // rowPatches null ise (sıralama/sütun değişikliği) olay yamasız gider ve
    // karşı ekran SESSİZ hafif yeniden yükleme yapar — kilit ve bildirim yok.
    liveEvents.notifyChange('collection', requestClientId(req), { ownerId, rowPatches: result.rowPatches, revision: result.revision });
    // Yanıt kasıtlı olarak KÜÇÜK: istemci zaten veriye sahip, yalnız yeni
    // revizyonu kullanıyor. 18 MB'ı geri serileştirmek kazancı geri verirdi.
    res.json({ ok: true, workspace: { _revision: result.revision, _updatedAt: result.updatedAt, rowCount: result.rowCount }, replication });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'COLLECTION_SAVE_FAILED', currentRevision: err.currentRevision });
  }
});


// ---- Shared PLM → ASAS translation dictionary -----------------------------
// New/unseen PLM values are reviewed against the live ASAS vocabulary in the
// browser. Only explicit user approvals are persisted here and reused later.
/* ---- Kişisel veriler / Not Defteri (v5.98) ----
   Bu veriler tarayıcının localStorage'ında duruyordu; localStorage TARAYICIYA
   özel olduğu için Edge'de yazılan not Chrome'da görünmüyordu. Artık kullanıcı
   kimliğine bağlı olarak sunucuda da tutulur ve her açılışta birleştirilir.
   Kimlik doğrulaması dışında ek alan yetkisi aranmaz: veri kullanıcının kendi
   verisidir ve yalnız kendi kaydına erişir. */
app.get('/api/user-preferences', (req, res) => {
  const store = userPreferences.load(req.currentUser.id);
  const roleDefaults = userAccess.roleWorkspaceEntries(req.currentUser);
  /* deletions: AÇIKÇA SİLİNMİŞ anahtarlar ve silinme zamanı. Tarayıcı bunu
     görmeden, kendi yerel kopyasını "sunucuda eksik" sanıp geri gönderiyor ve
     silinen kişisel Horizon diriliyordu. */
  res.set('Cache-Control', 'no-store').json({ ok: true, entries: store.entries, deletions: store.deletions || {}, roleDefaults, roleDefaultRole: req.currentUser.systemRole, updatedAt: store._updatedAt, syncedPrefixes: userPreferences.SYNCED_PREFIXES });
});
app.put('/api/user-preferences', express.json({ limit: '12mb' }), (req, res) => {
  try {
    const saved = userPreferences.merge(req.currentUser.id, req.body && req.body.entries);
    res.json({ ok: true, entries: saved.entries, updatedAt: saved._updatedAt, rejected: saved.rejected });
  } catch (err) { apiError(res, err, 'Kişisel veriler kaydedilemedi.'); }
});
app.post('/api/user-preferences/delete', express.json({ limit: '256kb' }), (req, res) => {
  try {
    const saved = userPreferences.removeKeys(req.currentUser.id, req.body && req.body.keys);
    res.json({ ok: true, entries: saved.entries, updatedAt: saved._updatedAt });
  } catch (err) { apiError(res, err, 'Kişisel veriler silinemedi.'); }
});
const USER_WORKSPACE_MODULES = new Set(['default','overview','cp','orders','backlog','lfl','priceanalysis','collections','oab','intake','quotations','reports','dashboard']);
function workspaceModule(req){const module=String(req.params&&req.params.module||'').toLowerCase();if(!USER_WORKSPACE_MODULES.has(module)){const error=new Error('Geçersiz çalışma alanı modülü.');error.statusCode=400;error.code='WORKSPACE_MODULE_INVALID';throw error;}return module;}
app.get('/api/user-workspace/:module',(req,res)=>{try{const module=workspaceModule(req),roleDefaults=userAccess.roleWorkspaceEntries(req.currentUser),effective=userPreferences.effectiveWorkspaceEntries(req.currentUser.id,roleDefaults);const savedHorizon=userPreferences.getHorizon(req.currentUser.id,module),appliedHorizon=userPreferences.getAppliedHorizon(req.currentUser.id,module);res.set('Cache-Control','no-store').json({ok:true,module,userId:req.currentUser.id,role:req.currentUser.systemRole,savedHorizon:savedHorizon||{},appliedHorizon:appliedHorizon||{},horizon:userPreferences.resolveHorizon(req.currentUser.id,module,null,{},roleDefaults),defaultHorizon:userPreferences.resolveHorizon(req.currentUser.id,'default',null,{},roleDefaults),entries:effective.entries,personalEntries:effective.personal,roleDefaults:effective.inherited});}catch(err){apiError(res,err,'Kişisel çalışma alanı okunamadı.');}});
/* v7.81: linkedGroupId ARTIK TAŞINMAZ (Horizon grupları kaldırıldı). Gelen
   istekteki alan yok sayılır ve kayda yazılmaz; eski bir istemci gönderse
   bile hiçbir şey bağlamaz. */
app.put('/api/user-workspace/:module/horizon',express.json({limit:'2mb'}),(req,res)=>{try{const module=workspaceModule(req),connectionId=String(req.body&&req.body.connectionId||''),role=String(req.body&&req.body.role||'');const horizon=req.body&&req.body.horizon&&typeof req.body.horizon==='object'?{...req.body.horizon}:{};delete horizon.linkedGroupId;const saved=userPreferences.saveHorizon(req.currentUser.id,module,horizon,{connectionId,role});userAccess.appendAudit(req.currentUser,'USER_WORKSPACE_HORIZON_UPDATE',req.currentUser.id,{module,connectionId,role});res.json({ok:true,module,savedHorizon:userPreferences.getHorizon(req.currentUser.id,module),appliedHorizon:userPreferences.getAppliedHorizon(req.currentUser.id,module),horizon:userPreferences.resolveHorizon(req.currentUser.id,module,null,{},userAccess.roleWorkspaceEntries(req.currentUser)),updatedAt:saved._updatedAt});}catch(err){apiError(res,err,'Kişisel Horizon kaydedilemedi.');}});
/* v7.81 — /api/horizon-groups KALDIRILDI (kullanıcı kararı).
   Adlandırılmış Horizon grupları, kullanıcının görmediği bir katman olarak
   Veri Yönetimi'ndeki ortak filtreyi eziyordu. Uç kaldırıldı; eski istemci
   çağrısı 404 alır ve sessizce boş liste sanmaz. Diskteki eski kayıt durur. */
app.post('/api/user-workspace/:module/reset',express.json({limit:'256kb'}),(req,res)=>{try{const module=workspaceModule(req),categories=req.body&&req.body.categories||userPreferences.WORKSPACE_CATEGORIES;const saved=userPreferences.resetWorkspace(req.currentUser.id,module,categories);userAccess.appendAudit(req.currentUser,'USER_WORKSPACE_RESET',req.currentUser.id,{module,categories:userPreferences.normalizeCategories(categories)});res.json({ok:true,module,updatedAt:saved._updatedAt,removedKeys:saved.removedKeys||[]});}catch(err){apiError(res,err,'Kişisel görünüm sıfırlanamadı.');}});

/* ===================================================================
   v7.26 — SAYFA UFKU EKRANININ UÇLARI

   Kullanıcı talebi: "Horizon ayarlamak excel tablosuna filtre koymak kadar
   basit bir işlem olsun. Kullanıcı istediği tablo başlıklarını ekleyip
   istediği filtrelemeyi yapabilsin." + "Horizon ayarları ekranında
   kullanıcıdan kopyala seçeneği de olsun."

   Ekran üç şeye ihtiyaç duyar: alan listesi, bir alanın GERÇEK değerleri
   (Excel'deki filtre listesi gibi) ve başka bir kullanıcının ufku.
   =================================================================== */
// ---- Sayfa Horizon'u route'ları (alanlar, değerler, önizleme, kullanıcıdan kopyalama) → server/routes/horizon-routes.js ----
require('./routes/horizon-routes')(app, {
  USER_WORKSPACE_MODULES,
  apiError,
  cacheForUser,
  express,
  horizonFields,
  horizonFilterMapping,
  intakeHorizonFields,
  intakeLiveFields,
  intakeReport,
  intakeStore,
  loadModelConnections,
  logRuntimeFailure,
  modelQuery,
  queryModelDistinctValues,
  resolveDynamicHorizonValueSource,
  resolveHorizonValueSource,
  selectConnection,
  userAccess,
  userPreferences,

});
// ---- Koleksiyon geri dönüşüm kutusu route'ları → server/routes/collection-recycle-bin-routes.js ----
require('./routes/collection-recycle-bin-routes')(app, {
  apiError,
  collectionRecycleBin,
  collectionWorkspaceEditAllowed,
  express,
  userAccess,

});
// ---- PLM → ASAS çeviri sözlüğü route'ları → server/routes/plm-translation-routes.js ----
require('./routes/plm-translation-routes')(app, {
  apiError,
  express,
  loadPlmTranslations,
  publicPlmTranslations,
  requestRevision,
  upsertPlmTranslations,
  userAccess,

});
// ---- CoreNectum PLM Code -> styleId deep-link dictionary ------------------
// CoreNectum oturum bilgileri Buyer Log'a alınmaz. Eşleşmeler CSV/Excel ile
// içe aktarılabilir veya kullanıcının giriş yaptığı mevcut Edge profilinde
// Style List sayfaları topluca taranarak bulunabilir; bütün kullanıcılar aynı doğrulanmış sözlüğü
// kullanır.
app.get('/api/plm-style-links', userAccess.requireAnyArea('source', 'koleksiyon', 'cp', 'orders', 'overview'), (_req, res) => {
  res.set('Cache-Control', 'no-store').json(publicPlmStyleLinks(loadPlmStyleLinks()));
});
app.post('/api/plm-style-links/import', userAccess.requireAnyArea('source', 'koleksiyon'), express.json({ limit: '20mb' }), (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    const saved = upsertPlmStyleLinks(items, req.currentUser);
    userAccess.appendAudit(req.currentUser, 'PLM_STYLE_LINKS_IMPORT', 'corenectum', {
      received: items.length,
      added: saved.added,
      updated: saved.updated,
      invalid: saved.invalid,
      total: saved.count,
    });
    res.json({ ok: true, ...saved });
  } catch (err) { apiError(res, err, 'PLM bağlantıları içe aktarılamadı.'); }
});
// PLM Sync and Browser & Remote Debugging MUST use the same canonical CDP
// service. The legacy PLM path opened edge://inspect in the system Edge while
// the real automation path could also launch Buyer Log's persistent Edge
// profile. One action therefore created multiple windows/tabs and still failed
// its own readiness check. These routes now expose the same state and launcher
// used by every other browser automation feature.
async function plmBrowserRuntimeStatus() {
  const status = await browserDebugService.getRuntimeStatus();
  const ready = Boolean(status && status.connectionState === 'READY' && status.endpoint);
  return {
    ...status,
    existingProfileReady: ready,
    sameWindowReady: ready,
    browserFound: Boolean(status && status.resolved && status.resolved.installed),
    browser: status && status.resolved ? status.resolved.resolvedBrowser : '',
    profileMode: status && status.strategy ? status.strategy.mode : '',
    openMode: ready ? 'canonical-cdp-ready' : 'canonical-cdp-setup-required',
  };
}
/* CoreNectum PLM direct API — no Edge/CDP/browser session required.
   The Bearer token is held only in backend process memory and disappears on
   Buyer Log restart. It is never returned to the renderer after being set.

   Contextual PLM SYNC model görseli gösteren modüllerde de çalışır. Bu
   nedenle yalnız CP/Orders/Collection kapısı yeterli değildir; erişim yine
   kullanıcının GERÇEKTEN sahip olduğu Buyer Log alanlarından biriyle
   sınırlandırılır. Browser/Remote Debugging yetkileri bu listeye eklenmez. */
const PLM_CONTEXT_IMAGE_ACCESS_AREAS = ['cp','orders','koleksiyon','priceanalysis','lfl','opencosting','backlog','shipping'];
const requirePlmContextAccess = (req,res,next) => {
  const profile=req.currentUser;
  if(profile&&PLM_CONTEXT_IMAGE_ACCESS_AREAS.some(area=>userAccess.hasArea(profile,area)))return next();
  // OAB contextual görsel sync yalnız Overview + OAB.VIEW birleşimiyle açılır;
  // sırf Overview erişimi CoreNectum/PLM API kapısını genişletmez.
  if(profile&&userAccess.hasArea(profile,'overview')&&userAccess.hasCapability(profile,'OAB.VIEW'))return next();
  return res.status(403).json({error:'Bu işlem için gerekli PLM görsel erişim alanı bulunmuyor.',code:'ACCESS_AREA_REQUIRED'});
};
const PLM_CONTEXT_SCOPE_AREA = Object.freeze({
  cp:'cp', orders:'orders', koleksiyon:'koleksiyon',
  'backlog-detail':'backlog', 'lfl-detail':'lfl', 'price-supplier-detail':'priceanalysis',
  'shipping-comparison':'shipping', 'quotations-detail':'koleksiyon',
  'pricing-history':'koleksiyon', 'pricing-history-modal':'koleksiyon',
  'open-costing':'opencosting', 'oab-drilldown':'overview',
});
function plmContextScopeAllowed(req, res){
  const scope=String(req.body&&req.body.scope||'').trim();
  const area=PLM_CONTEXT_SCOPE_AREA[scope];
  // Eski/ana akışlar yalnız kendi üç ana PLM alanında çalışmaya devam eder.
  if(!area){
    if(['cp','orders','koleksiyon'].some(key=>userAccess.hasArea(req.currentUser,key)))return true;
    res.status(403).json({error:'Bu PLM görsel kapsamına erişim yetkiniz bulunmuyor.',code:'ACCESS_AREA_REQUIRED'});
    return false;
  }
  if(!userAccess.hasArea(req.currentUser,area)){
    res.status(403).json({error:'Bu PLM görsel kapsamına erişim yetkiniz bulunmuyor.',code:'ACCESS_AREA_REQUIRED',area});
    return false;
  }
  if(scope==='oab-drilldown'&&!userAccess.hasCapability(req.currentUser,'OAB.VIEW')){
    res.status(403).json({error:'OAB verilerine erişim yetkiniz bulunmuyor.',code:'PERMISSION_REQUIRED',permission:'OAB.VIEW'});
    return false;
  }
  return true;
}
app.get('/api/corenectum-api/status', requirePlmContextAccess, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok:true, status:coreNectumApiSettings.publicSettings(req.currentUser.id) });
});
app.post('/api/corenectum-api/token', requirePlmContextAccess, express.json({ limit:'32kb' }), (req, res) => {
  try {
    const status = coreNectumApiSettings.saveToken(req.currentUser.id, req.body && req.body.token);
    userAccess.appendAudit(req.currentUser, 'CORENECTUM_API_TOKEN_SET', 'corenectum', { mode:'direct-bearer', persistence:status.persistence });
    res.set('Cache-Control', 'no-store').json({ ok:true, status });
  } catch (err) { automationError(res, err, 'CoreNectum API kimlik bilgisi kaydedilemedi.'); }
});
app.delete('/api/corenectum-api/token', requirePlmContextAccess, (req, res) => {
  try {
    const status = coreNectumApiSettings.clearToken(req.currentUser.id);
    userAccess.appendAudit(req.currentUser, 'CORENECTUM_API_TOKEN_CLEAR', 'corenectum', { mode:'direct-bearer' });
    res.set('Cache-Control', 'no-store').json({ ok:true, status });
  } catch (err) { automationError(res, err, 'CoreNectum API kimlik bilgisi temizlenemedi.'); }
});
app.post('/api/corenectum-api/test', requirePlmContextAccess, express.json({ limit:'32kb' }), async (req, res) => {
  try {
    const result = await coreNectumApiClient.testConnection(req.currentUser.id, req.body && req.body.token);
    userAccess.appendAudit(req.currentUser, 'CORENECTUM_API_TEST', 'corenectum', { ok:true, mode:'direct-bearer' });
    res.set('Cache-Control', 'no-store').json({ ok:true, result, status:coreNectumApiSettings.publicSettings(req.currentUser.id) });
  } catch (err) { automationError(res, err, 'CoreNectum API bağlantısı doğrulanamadı.'); }
});
/* Collection-only drag/drop identity resolver. The browser drag payload exposes
   the CoreNectum Attachment URL but not the PLM Code. Resolve it through the
   direct authenticated GetStyleList API; never drive Edge/CDP for this path. */
app.post('/api/corenectum-api/resolve-attachment', userAccess.requireArea('koleksiyon'), express.json({ limit:'16kb' }), async (req, res) => {
  try {
    const result = await coreNectumAttachmentIndex.resolve(req.currentUser.id, req.body && req.body.attachmentUrl, {
      language:String(req.body && req.body.language || '').toLowerCase()==='en'?'en':'tr',
    });
    userAccess.appendAudit(req.currentUser, 'PLM_DRAG_ATTACHMENT_RESOLVE', 'corenectum', {
      plmId:result.plmId, cached:Boolean(result.cached), scannedPages:result.scannedPages, scannedRows:result.scannedRows,
    });
    res.set('Cache-Control','no-store').json({ ok:true, ...result });
  } catch (err) { automationError(res, err, 'Sürüklenen PLM görseli modele bağlanamadı.'); }
});

app.get('/api/plm-style-links/browser/status', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok:true, status:await plmBrowserRuntimeStatus() }); }
  catch (err) { automationError(res, err, 'Edge bağlantı durumu okunamadı.'); }
});
app.get('/api/plm-style-links/browser/diagnose', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok:true, report:await browserDebugService.testConnection() }); }
  catch (err) { automationError(res, err, 'Edge bağlantı tanılaması yapılamadı.'); }
});
app.post('/api/plm-style-links/browser/prepare', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), async (req, res) => {
  try {
    const result = await browserDebugService.enableAndLaunch({});
    const status = await plmBrowserRuntimeStatus();
    if (result && result.ok) userAccess.appendAudit(req.currentUser, 'PLM_BROWSER_DEBUG_READY', 'edge', {
      browser: status.browser || '', profileMode: status.profileMode || '', port: Number(status.endpoint && status.endpoint.port) || 0,
    });
    res.set('Cache-Control', 'no-store').json({ ok:Boolean(result && result.ok), result, status });
  } catch (err) { automationError(res, err, 'Edge bağlantısı hazırlanamadı.'); }
});

/* v9.40 — TROY (Order Management) sağ tık işlemleri: Siparişi Kapat /
   Download PO. Kimlik doğrulama mevcut Edge oturumundan taze alınır (bkz.
   troy-session-service.js) — bu route'lar yalnız hangi siparişin
   etkilendiğini ve sonucu taşır, token'a hiç dokunmaz. */
app.post('/api/troy/orders/:orderCode/close', userAccess.requireAnyArea('cp', 'orders'), async (req, res) => {
  try {
    const result = await troyOrderService.closeOrder(req.currentUser.id, req.params.orderCode);
    userAccess.appendAudit(req.currentUser, 'TROY_ORDER_CLOSE', 'orders', { orderCode:req.params.orderCode, ok:result.ok, code:result.code });
    res.json(result);
  } catch (err) { automationError(res, err, 'Sipariş kapatılamadı.'); }
});
app.get('/api/troy/orders/:orderCode/po/status', userAccess.requireAnyArea('cp', 'orders'), (req, res) => {
  try {
    const existing = troyPoService.findExistingPoFile(req.params.orderCode, String(req.query.styleName || ''));
    res.set('Cache-Control', 'no-store').json({ exists:Boolean(existing), filePath:existing ? existing.filePath : null, fileName:existing ? existing.fileName : null });
  } catch (err) { automationError(res, err, 'PO durumu okunamadı.'); }
});
app.post('/api/troy/orders/:orderCode/po', userAccess.requireAnyArea('cp', 'orders'), async (req, res) => {
  try {
    const result = await troyPoService.downloadPO(req.currentUser.id, req.params.orderCode, { styleName:String((req.body && req.body.styleName) || '') });
    userAccess.appendAudit(req.currentUser, 'TROY_PO_DOWNLOAD', 'orders', { orderCode:req.params.orderCode, fileName:result.fileName });
    res.json(result);
  } catch (err) { automationError(res, err, 'PO indirilemedi.'); }
});
app.post('/api/troy/orders/:orderCode/po/open', userAccess.requireAnyArea('cp', 'orders'), (req, res) => {
  try {
    const existing = troyPoService.findExistingPoFile(req.params.orderCode, String((req.body && req.body.styleName) || ''));
    if (!existing) return automationError(res, Object.assign(new Error('PO dosyası bulunamadı.'), { code:'TROY_PO_NOT_FOUND', statusCode:404 }), 'PO dosyası bulunamadı.');
    platform.openPathExternallyAsync(existing.filePath);
    res.json({ ok:true });
  } catch (err) { automationError(res, err, 'PO dosyası açılamadı.'); }
});
app.post('/api/troy/po-folder/open', userAccess.requireAnyArea('cp', 'orders'), (_req, res) => {
  try { platform.openFolderExternally(troyPoService.poFolder()); res.json({ ok:true }); }
  catch (err) { automationError(res, err, 'PO klasörü açılamadı.'); }
});
// "Klasörde Göster" — indirilen PO dosyasını, tüm klasörü açmak yerine
// gezginde SEÇİLİ olarak gösterir (paylaşılan dosya-hazır bildirim kartının
// aksiyonu). PO'yu Aç/İndir route'larıyla aynı yetki ve dosya çözümlemesi.
app.post('/api/troy/orders/:orderCode/po/reveal', userAccess.requireAnyArea('cp', 'orders'), (req, res) => {
  try {
    const existing = troyPoService.findExistingPoFile(req.params.orderCode, String((req.body && req.body.styleName) || ''));
    if (!existing) return automationError(res, Object.assign(new Error('PO dosyası bulunamadı.'), { code:'TROY_PO_NOT_FOUND', statusCode:404 }), 'PO dosyası bulunamadı.');
    platform.revealFileExternally(existing.filePath);
    res.json({ ok:true });
  } catch (err) { automationError(res, err, 'PO dosyası gösterilemedi.'); }
});

/* v9.45 — "Revize Et": Orders → Filter → satır → işlem menüsü → Revize Et
   adımlarını otomatikleştirir, Troy'un gerçek revize stepper'ı açılınca durur.
   Kapat/PO route'larıyla aynı yetki kontrolü; Kapat/PO implementasyonuna
   dokunulmadı. */
app.post('/api/troy/orders/:orderCode/revise', userAccess.requireAnyArea('cp', 'orders'), async (req, res) => {
  try {
    const result = await troyOrderService.openRevision(req.currentUser.id, req.params.orderCode);
    userAccess.appendAudit(req.currentUser, 'TROY_ORDER_REVISE', 'orders', { orderCode:req.params.orderCode, ok:result.ok, state:result.state });
    res.json(result);
  } catch (err) { automationError(res, err, 'Troy revize ekranı açılamadı.'); }
});
app.post('/api/troy/login/open', userAccess.requireAnyArea('cp', 'orders'), async (req, res) => {
  try {
    const result = await troyOrderService.openTroyLogin(req.currentUser.id);
    userAccess.appendAudit(req.currentUser, 'TROY_LOGIN_OPEN', 'orders', {});
    res.json(result);
  } catch (err) { automationError(res, err, 'Troy oturum açma sekmesi açılamadı.'); }
});

const modelImageImportLocks = new Set();
const modelOperationProgress = new Map();
function setModelOperationProgress(userId, value){ modelOperationProgress.set(String(userId||'moderator'), { ...(value||{}), updatedAt:Date.now() }); }
function clearModelOperationProgress(userId){ modelOperationProgress.delete(String(userId||'moderator')); }
function modelImageMode(value){ return value === 'all' ? 'all' : 'missing'; }
function modelImageItemKey(item){ return parseLib.plmImageKey(item && item.plmId); }
function plmImageRefreshLog(event,payload={}){
  try{ console.info(`[${event}]`,JSON.stringify(payload)); }catch(_){ console.info(`[${event}]`); }
}
function plmImageHash(buffer){ return crypto.createHash('sha256').update(buffer).digest('hex'); }
function plmImageRefreshCounts(images,failedItems){
  const list=Array.isArray(images)?images:[],failures=Array.isArray(failedItems)?failedItems:[];
  const missing=failures.filter(item=>/IMAGE_URL_MISSING|IMAGE_RESPONSE_MISSING|REMOTE_MISSING/i.test(String(item&&item.code||''))).length;
  return {
    imagesDownloaded:list.filter(item=>!item.existing&&!item.unchanged).length,
    imagesReplaced:list.filter(item=>!item.existing&&!item.unchanged&&item.oldRef).length,
    imagesUnchanged:list.filter(item=>item.unchanged).length,
    imagesMissing:missing,
    imagesFailed:Math.max(0,failures.length-missing),
  };
}
/* v10.90 — SIFIRLAMA İLE GÖRSEL YAZMASININ YARIŞMASI.
   Tam sıfırlama birden fazla sahiplik katmanını sırayla temizler. Bu sırada
   bir PLM senkronu ya da manuel yükleme araya girerse, yeni görsel dosyası
   silinmiş depoya yazılır ama az sonra temizlenen imagemap onu unutur; ya da
   tersi olur. İkisi de sessiz tutarsızlık üretir. Sıfırlama boyunca bütün
   görsel YAZMA yolları 409 ile reddedilir; işlem biter bitmez (hata durumunda
   da) yeniden açılır — kalıcı kilit bırakılmaz. */
let modelImageResetInProgress = false;
function assertModelImageMutable(){
  if(!modelImageResetInProgress)return;
  const error=new Error('Model görselleri sıfırlanırken görsel kaydedilemez. İşlem bitince yeniden deneyin.');
  error.statusCode=409;error.code='MODEL_IMAGE_RESET_BUSY';throw error;
}
async function withModelImageImportLock(userId, fn){
  const key=String(userId||'moderator');
  assertModelImageMutable();
  if(modelImageImportLocks.has(key)){const error=new Error('Başka bir model görseli içe aktarma işlemi devam ediyor.');error.statusCode=409;error.code='MODEL_IMAGE_IMPORT_BUSY';throw error;}
  modelImageImportLocks.add(key);try{return await fn();}finally{modelImageImportLocks.delete(key);}
}
app.post('/api/plm-style-links/sync-links', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), express.json({ limit: '16mb' }), async (req, res) => {
  try {
    const raw=Array.isArray(req.body&&req.body.items)?req.body.items:null;
    if(!raw)return res.status(400).json({error:'items (dizi) zorunlu.',code:'VALIDATION_ERROR'});
    setModelOperationProgress(req.currentUser.id,{kind:'links',phase:'PLM linki aranıyor',current:0,total:raw.length,model:''});
    const items=raw.map(item=>({...item,needImage:false}));
    // Kapsam istemciden gelir (koleksiyon/cp/orders): iş yalnız kendi
    // ekranında görünsün diye.
    const linkRun=await withPlmJob(req,{
      kind:'plm-links', scope:plmJobScope(req), total:items.length,
      label:`Model linki · ${items.length} model`, phase:'PLM linki aranıyor',
    }, async job => agentBrowserConnector.collectCoreNectumStyleLinks(req.currentUser.id,items,{
      ...getModelImageSettings(),
      onProgress:progress=>{
        setModelOperationProgress(req.currentUser.id,{kind:'links',...progress});
        job.report({phase:progress&&progress.phase,processed:progress&&progress.current,total:(progress&&progress.total)||items.length,activeModel:progress&&progress.model});
      },
    }));
    const collected=linkRun.result;
    for(const item of collected.failed||[]) plmJobs.addFailure(req.currentUser.id,linkRun.job.id,{plmId:item&&item.plmId,model:item&&item.styleName,error:(item&&item.error)||'Model linki bulunamadı.',code:(item&&item.code)||'PLM_LINK_NOT_FOUND'});
    plmJobs.update(req.currentUser.id,linkRun.job.id,{processed:items.length,succeeded:collected.links.length});
    setModelOperationProgress(req.currentUser.id,{kind:'links',phase:'Eşleştirme / kayıt',current:collected.links.length,total:raw.length,model:collected.links.at(-1)?.plmId||''});
    const saved=upsertPlmStyleLinks(collected.links,req.currentUser);
    userAccess.appendAudit(req.currentUser,'PLM_LINK_SYNC','corenectum',{requested:collected.requested,found:collected.links.length,failed:collected.failed.length,scannedPages:collected.scannedPages,scannedRows:collected.scannedRows,added:saved.added,updated:saved.updated});
    res.json({ok:true,...saved,requested:collected.requested,found:collected.links.length,scannedPages:collected.scannedPages,scannedRows:collected.scannedRows,failedItems:collected.failed,images:[],imagesSaved:0,jobId:linkRun.job.id});
  } catch(err){automationError(res,err,'CoreNectum PLM bağlantıları otomatik alınamadı.');}
  finally { clearModelOperationProgress(req.currentUser&&req.currentUser.id); }
});
/* ===================================================================
   KANONİK MODEL GÖRSELİ ALIM YOLU — sunucu bağlantıları.

   Canlı CoreNectum senkronu ve hazır BUYERLOG_IMPORT paketi buradan AYNI
   plm-image-ingest örneğine bağlanır. İkinci bir depo/kayıt yolu yoktur:
   kimlik parse.js anahtarları, depo saveCollectionImage, kayıt
   patchPlmImageLinks, sahiplik plm-image-ownership.
   =================================================================== */
function canonicalPlmImageIngest(owner) {
  return plmImageIngestLib.createPlmImageIngest({
    owner,
    ownership: plmImageOwnership,
    getImage: ref => getCollectionImage(ref),
    saveImage: payload => saveCollectionImage(payload),
    deleteImage: ref => deleteCollectionImage(ref),
    patchLinks: links => patchPlmImageLinks(links),
    readImageBytes: found => fs.readFileSync(found.full),
  });
}
/* ===================================================================
   PAYLAŞILAN MODEL GÖRSELİ DAĞITIMI — sunucu bağlantıları.

   HARD RULE: tablo/hover/drilldown görselleri HER ZAMAN yerel
   collection-images deposundan gelir. Aşağıdaki depo yalnız bir DAĞITIM
   katmanıdır; ağ yavaş ya da kopuksa senkron gecikir, çizim gecikmez.

   Çakışma sırası dosya zaman damgasına değil, paylaşılan ve monoton bir
   sayaca dayanır. Sayaç deponun KENDİ revision.json'udur; SharedRevisionStore
   bilerek kullanılmaz çünkü o depo uygulamanın her yerinde ateşle-unut
   çağrılır ve await edilmesi o sözleşmeyi bozardı. */
const MODEL_IMAGE_SYNC_STATE_FILE = path.join(LOCAL_DATA_ROOT, 'model-image-sync-state.json');
const sharedModelImageStore = sharedImageStoreLib.createSharedImageStore({
  getSharedSyncRoot: async () => (await syncSettings.read()).sharedSyncRoot,
  getDeviceId: () => localDb.getDeviceId(),
});
const modelImageDistribution = modelImageDistributionLib.createModelImageDistribution({
  sharedStore: sharedModelImageStore,
  ownership: plmImageOwnership,
  readState: () => { try { return JSON.parse(fs.readFileSync(MODEL_IMAGE_SYNC_STATE_FILE, 'utf8')); } catch (_) { return modelImageDistributionLib.emptyState(); } },
  writeState: value => { atomicWriteJson(MODEL_IMAGE_SYNC_STATE_FILE, value); return value; },
  getImage: ref => getCollectionImage(ref),
  readImageBytes: found => fs.readFileSync(found.full),
  saveImage: payload => saveCollectionImage(payload),
  deleteImage: ref => deleteCollectionImage(ref),
  patchLinks: links => patchPlmImageLinks(links),
  onTrace: (event, detail) => plmImageRefreshLog(event, detail),
});

const LEGACY_SHARED_GLOBAL_IMAGE_MIGRATION_FILE = path.join(LOCAL_DATA_ROOT, 'collection-image-scope-migration-v1.json');
function retireLegacySharedGlobalImageRefs() {
  try {
    if (fs.existsSync(LEGACY_SHARED_GLOBAL_IMAGE_MIGRATION_FILE)) return { migrated:false, reason:'already-done' };
    const store = plmImageOwnership.loadOwnership();
    const overrides = loadOverrides();
    overrides.imagemap = overrides.imagemap && typeof overrides.imagemap === 'object' ? overrides.imagemap : {};
    const retired = [];
    for (const [key, record] of Object.entries(store.owners || {})) {
      if (!(Number(record && record.sharedRevision) > 0)) continue;
      const current = String(overrides.imagemap[key] || '').trim();
      if (!current || current !== String(record.imageRef || '').trim()) continue;
      // Empty tombstone intentionally blocks fallback to an older PLM-only
      // key until this user's own PLM flow refreshes the identity.
      overrides.imagemap[key] = '';
      retired.push(key);
    }
    if (retired.length) {
      overrides._revisions = overrides._revisions || {};
      overrides._revisions.orders = (Number(overrides._revisions.orders) || 0) + 1;
      saveOverrides(overrides, overrides._revision);
      plmImageOwnership.forget(retired);
    }
    atomicWriteJson(LEGACY_SHARED_GLOBAL_IMAGE_MIGRATION_FILE, {
      schemaVersion:1, migratedAt:new Date().toISOString(), retired:retired.length,
    });
    return { migrated:true, retired:retired.length };
  } catch (error) {
    logRuntimeFailure('legacySharedImageScopeMigration', error);
    return { migrated:false, error:error && error.code || error && error.message || String(error) };
  }
}
const legacySharedImageScopeMigration = retireLegacySharedGlobalImageRefs();
markStartup('COLLECTION_IMAGE_SCOPE_MIGRATION', legacySharedImageScopeMigration);

const COLLECTION_SHARED_IMAGE_CACHE_FILE = path.join(LOCAL_DATA_ROOT, 'collection-shared-image-cache.json');
function readCollectionSharedImageCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(COLLECTION_SHARED_IMAGE_CACHE_FILE, 'utf8'));
    return raw && raw.schemaVersion === 1 && raw.entries && typeof raw.entries === 'object'
      ? raw : { schemaVersion:1, entries:{} };
  } catch (_) { return { schemaVersion:1, entries:{} }; }
}
function writeCollectionSharedImageCache(cache) {
  const next = cache && typeof cache === 'object' ? cache : { schemaVersion:1, entries:{} };
  next.schemaVersion = 1;
  next.entries = next.entries && typeof next.entries === 'object' ? next.entries : {};
  atomicWriteJson(COLLECTION_SHARED_IMAGE_CACHE_FILE, next);
  return next;
}
function collectionImageCacheKey(ownerId, item) {
  const owner = String(ownerId || '').trim();
  const record = String(item && item.recordId || '').trim();
  const normalized = plmImageIngestLib.normalizeRequest(item || {});
  return owner + '|' + (record || normalized.key || String(item && item.imageRef || '').trim());
}
function collectionSharedFilename(item, record) {
  const mime = String(record && record.mimeType || '').toLowerCase();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  const recordId = String(item && item.recordId || 'model').replace(/[^A-Za-z0-9_-]/g, '_').slice(0,80) || 'model';
  return 'collection-shared-' + recordId + '-' + String(record && record.contentHash || '').slice(0,12) + '.' + ext;
}
async function publishCollectionWorkspaceImages(ownerId) {
  const owner = String(ownerId || '').trim();
  if (!owner) return { queued:0, published:0, reason:'owner-required' };
  const grants = collectionPermissions.outgoing(owner);
  if (!collectionImageSyncPolicy.shouldPublishOwnerImages(grants, owner)) {
    return { queued:0, published:0, reason:'not-shared' };
  }
  const workspace = loadWorkspace(owner);
  const items = collectionImageSyncPolicy.workspaceSharedImageItems(workspace);
  const entries = [];
  for (const item of items) {
    const key = collectionImageSyncPolicy.sharedImageKey(item, plmImageIngestLib.normalizeRequest(item).key);
    const found = item.imageRef ? getCollectionImage(item.imageRef) : null;
    if (!key || !found) continue;
    entries.push({
      canonicalKey: 'collection:' + owner + ':' + key,
      source: sharedImageStoreLib.SOURCE_PLM,
      plmId: item.plmId,
      colourCode: item.colourCode || '',
      colour: item.colour || '',
      imageRef: item.imageRef,
      mimeType: (found.item && found.item.mimeType) || '',
      ownership: sharedImageStoreLib.OWNERSHIP_AUTOMATIC,
      status: sharedImageStoreLib.STATUS_AVAILABLE,
      sourceIdentity: 'collection:' + owner + ':' + String(item.recordId || key),
      sourceFetchedAt: new Date().toISOString(),
    });
  }
  const queued = modelImageDistribution.queuePublish(entries);
  let published = 0, pending = Number(queued && queued.pending) || 0;
  let guard = 0;
  while (pending > 0 && guard < 100) {
    const flushed = await modelImageDistribution.flushPublish({ limit:200, sourceIdentityPrefix:'collection:', dropNonMatching:true });
    published += Number(flushed && flushed.published) || 0;
    pending = Number(flushed && flushed.pending) || 0;
    if (flushed && flushed.available === false) break;
    if (flushed && flushed.error) break;
    guard += 1;
  }
  return { queued:Number(queued && queued.queued) || 0, published, pending, ownerId:owner, images:items.length };
}
async function syncCollectionWorkspaceImagesForUser(userId, ownerId) {
  const user = String(userId || '').trim();
  const owner = String(ownerId || '').trim();
  if (!user || !owner || !collectionPermissions.accessLevel(user, owner)) {
    throw Object.assign(new Error('Bu Koleksiyon görsellerine erişim yetkiniz bulunmuyor.'), { code:'COLLECTION_ACCESS_DENIED', statusCode:403 });
  }
  const workspace = loadWorkspace(owner);
  const items = collectionImageSyncPolicy.workspaceSharedImageItems(workspace);
  if (!items.length) return { ownerId:owner, requested:0, available:0, installed:0, reused:0, missing:0, workspaceUpdated:false };

  if (!(await sharedModelImageStore.available())) {
    return { ownerId:owner, requested:items.length, available:0, installed:0, reused:0, missing:items.length, workspaceUpdated:false, offline:true };
  }

  const normalizedItems = items.map(item => ({ item, normalized:{ key:collectionImageSyncPolicy.sharedImageKey(item, plmImageIngestLib.normalizeRequest(item).key) } })).filter(entry => entry.normalized.key);
  const sharedKeys = normalizedItems.map(entry => 'collection:' + owner + ':' + entry.normalized.key);
  const records = await sharedModelImageStore.lookupMany(sharedKeys, { source:sharedImageStoreLib.SOURCE_PLM });
  const cache = readCollectionSharedImageCache();
  const replacements = new Map();
  let installed = 0, reused = 0, missing = 0, available = 0;

  for (const entry of normalizedItems) {
    const item = entry.item;
    const record = records.get('collection:' + owner + ':' + entry.normalized.key) || null;
    if (!record || record.status !== sharedImageStoreLib.STATUS_AVAILABLE) { missing += 1; continue; }
    available += 1;
    const cacheKey = collectionImageCacheKey(owner, item);
    const cached = cache.entries[cacheKey];
    let imageRef = '';
    if (cached && cached.contentHash === record.contentHash && cached.imageRef && getCollectionImage(cached.imageRef)) {
      imageRef = cached.imageRef;
      reused += 1;
    } else {
      const buffer = await sharedModelImageStore.readObject(record);
      if (!buffer) { missing += 1; continue; }
      const stored = saveCollectionImage({
        rowId:'collection-shared:' + owner + ':' + String(item.recordId || entry.normalized.key),
        filename:collectionSharedFilename(item, record),
        mimeType:record.mimeType,
        base64:buffer.toString('base64'),
      });
      imageRef = stored.id;
      cache.entries[cacheKey] = {
        ownerId:owner,
        recordId:String(item.recordId || ''),
        canonicalKey:entry.normalized.key,
        contentHash:record.contentHash,
        imageRef:stored.id,
        updatedAt:new Date().toISOString(),
      };
      installed += 1;
    }
    replacements.set(cacheKey, imageRef);
  }

  writeCollectionSharedImageCache(cache);
  return { ownerId:owner, requested:items.length, available, installed, reused, missing, workspaceUpdated:false };
}
function collectionWorkspaceWithLocalImages(ownerId, workspace = null) {
  const owner = String(ownerId || '').trim();
  const source = workspace || loadWorkspace(owner);
  const cache = readCollectionSharedImageCache();
  let changed = false;
  const rows = (Array.isArray(source && source.rows) ? source.rows : []).map(row => {
    const item = collectionImageSyncPolicy.rowSharedImageIdentity(row);
    if (!item) return row;
    const cached = cache.entries[collectionImageCacheKey(owner, item)];
    const ref = String(cached && cached.imageRef || '').trim();
    if (!ref || !getCollectionImage(ref)) return row;
    changed = true;
    return { ...row, _sharedCollectionImageUrl:'/api/collection-images/' + encodeURIComponent(ref) };
  });
  return changed ? { ...source, rows } : source;
}

async function syncAuthorizedCollectionImages(userId) {
  touchCollectionLiveUser(userId);
  await collectionPermissionsReady;
  await collectionPermissions.sync().catch(error => markStartup('COLLECTION_PERMISSION_SYNC_DEFERRED', { error:error && error.code || error && error.message || String(error) }));
  await publishCollectionWorkspaceImages(userId).catch(error => markStartup('COLLECTION_IMAGE_PUBLISH_DEFERRED', { userId, error:error && error.code || error && error.message || String(error) }));
  const owners = collectionPermissions.effectiveOwners(userId);
  const ownerIds = owners.map(item => item.ownerId);
  const replicaResults = [];
  for (const ownerId of ownerIds) {
    if (String(ownerId) === String(userId)) {
      replicaResults.push({ ownerId, synced:false, reason:'own-workspace-local-authority' });
      continue;
    }
    try { replicaResults.push(await collectionReplication.syncOwner(userId, ownerId)); }
    catch (error) { replicaResults.push({ ownerId, synced:false, error:error.code || error.message }); }
  }
  const replication = { ownerIds, results:replicaResults };
  const results = [];
  for (const ownerId of ownerIds) {
    if (String(ownerId) === String(userId)) {
      results.push({ ownerId, requested:0, available:0, installed:0, reused:0, missing:0, ownWorkspace:true });
      continue;
    }
    try { results.push(await syncCollectionWorkspaceImagesForUser(userId, ownerId)); }
    catch (error) { results.push({ ownerId, requested:0, installed:0, reused:0, missing:0, error:error.code || error.message }); }
  }

  const allowed = new Set(ownerIds);
  const cache = readCollectionSharedImageCache();
  let cacheChanged = false;
  for (const [key, value] of Object.entries(cache.entries)) {
    if (allowed.has(String(value && value.ownerId || ''))) continue;
    delete cache.entries[key];
    cacheChanged = true;
    const ref = String(value && value.imageRef || '');
    if (ref && !Object.values(cache.entries).some(entry => String(entry && entry.imageRef || '') === ref)) {
      try { deleteCollectionImage(ref); } catch (_) {}
    }
  }
  if (cacheChanged) writeCollectionSharedImageCache(cache);

  return {
    ownerIds,
    replication,
    results,
    requested:results.reduce((sum, item) => sum + (Number(item.requested) || 0), 0),
    available:results.reduce((sum, item) => sum + (Number(item.available) || 0), 0),
    installed:results.reduce((sum, item) => sum + (Number(item.installed) || 0), 0),
    reused:results.reduce((sum, item) => sum + (Number(item.reused) || 0), 0),
    missing:results.reduce((sum, item) => sum + (Number(item.missing) || 0), 0),
  };
}

/* Kanonik yazma sonuçlarını yayım kuyruğuna çevirir. Yayım ASENKRONDUR:
   kullanıcı görseli çoktan görür, ağ sonra yetişir; ağ yoksa kuyrukta bekler
   ve yerel başarı ASLA geri alınmaz. */
function queueModelImagePublish(outcomes, source, {
  ownership = sharedImageStoreLib.OWNERSHIP_AUTOMATIC,
  collectionOwnerId = '',
} = {}) {
  const owner = String(collectionOwnerId || '').trim();
  if (!owner) return { queued:0, pending:0 };
  const entries = (Array.isArray(outcomes) ? outcomes : [])
    .filter(item => item && item.imageRef && item.key
      && item.status !== plmImageIngestLib.COMMIT_FAILED && item.status !== plmImageIngestLib.COMMIT_MANUAL)
    .map(item => ({
      canonicalKey: 'collection:' + owner + ':' + item.key, source,
      plmId: item.plmId, colourCode: item.colourCode || '', colour: item.colour || '',
      imageRef: item.imageRef, contentHash: item.contentHash || '',
      mimeType: item.mimeType || '', ownership,
      status: sharedImageStoreLib.STATUS_AVAILABLE,
      sourceIdentity: 'collection:' + owner + ':' + (item.sourceIdentity || item.key),
      sourceFetchedAt: new Date().toISOString(),
    }));
  if (!entries.length) return { queued:0, pending:0 };
  const queued = modelImageDistribution.queuePublish(entries);
  // Eski sürümden kalmış genel CP/Orders kuyruğu bu sınırda temizlenir.
  void modelImageDistribution.flushPublish({
    limit:200, sourceIdentityPrefix:'collection:', dropNonMatching:true,
  }).catch(error => plmImageRefreshLog('SHARED_PUBLISH_DEFERRED', { error: (error && error.message) || String(error) }));
  return queued;
}

/* LOCAL → SHARED ön geçişi. Üst kaynağa çıkmadan ÖNCE çalışır ve yalnız
   gerçekten çözülemeyen kimlikleri geriye bırakır. Böylece bir kullanıcının
   indirdiği görsel için ekipteki kimse ASAS/PLM'i ikinci kez dövmez. */
/* MODEL ADI → PLM ID, SUNUCU TARAFINDA.
 *
 * Alt detay/rapor ekranlarının çoğunda PLM ID sütunu YOKTUR: OAB yalnız
 * "Option Adı"nı, LFL yalnız "MODEL ADI"nı bilir ve bu adlar PLM style
 * adlarıyla eşleşmez. İstemci uydurma bir kimlik üretmez; eşleşmenin doğru
 * kaynağı model ile PLM Kod'u AYNI satırda tutan ASAS sipariş kaydıdır (PLM
 * bağlantı listesi ikinci kaynak olarak kalır).
 *
 * Çözülemeyen kimlik SESSİZCE ATILMAZ: açık bir hata kalemi olarak döner,
 * böylece kullanıcı "hiçbir şey olmadı" sonucuyla karşılaşmaz. */
function resolveModelImageItemIdentities(rawItems, context = {}) {
  return modelImageIdentityResolver.resolveItems(rawItems, context);
}
function modelImageIdentityOrders(runtime) {
  return modelImageIdentityResolver.ordersFromRuntime(runtime);
}

async function resolveModelImagesLocalFirst(requests, options = {}) {
  const source = options.source === sharedImageStoreLib.SOURCE_ASAS ? sharedImageStoreLib.SOURCE_ASAS : sharedImageStoreLib.SOURCE_PLM;
  const overrides = options.overrides || loadOverrides();
  const imagemap = overrides.imagemap || {};
  let store = options.store || plmImageOwnership.loadOwnership();
  /* ASAS görselinin kanonik kimliği MODEL düzeyindedir (PLM-only anahtar):
     ASAS Teknik Görsel alanı renk taşımaz ve depo da renksiz anahtarla yazar
     (bkz. asas-technical-images.js patchLinks colourCode:''). Renk taşıyan bir
     kimlikle planlamak, var olan görseli "yok" sayıp her renk için ASAS'a
     yeniden gitmek demekti. PLM tarafında kimlik renk düzeyindedir ve
     olduğu gibi kalır. */
  const planned = source === sharedImageStoreLib.SOURCE_ASAS
    ? (Array.isArray(requests) ? requests : []).map(item => ({ ...item, colourCode: '', colour: '' }))
    : requests;
  const plan = await modelImageDistribution.plan(planned, {
    source, mode: options.mode, overwriteManual: options.overwriteManual === true,
    force: options.force === true, imagemap, store,
    allowShared: options.allowShared === true,
  });
  let installed = { outcomes: [], overrides: { imagemap }, store, installed: 0 };
  if (plan.fromShared.length) {
    installed = await modelImageDistribution.installFromShared(plan.fromShared, { imagemap, store });
    store = installed.store || store;
  }
  return { plan, installed, store, overrides: installed.overrides || overrides, source };
}

/* Üst kaynağa çıkacak kimlikler için dağıtık kira. Kirası başka bir Buyer Log
   örneğinde olan kimlik bu turda ATLANIR: o örnek bitirince sonucu paylaşılan
   depodan gelir. Kira süreli olduğu için çöken bir örnek modeli kilitlemez. */
async function leaseUpstreamImageIdentities(items, source, { concurrency = 8 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const held = [];
  const busy = [];
  if (!list.length || !(await sharedModelImageStore.available())) return { held: list, busy, release: async () => {} };
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    for (;;) {
      const index = cursor; cursor += 1;
      if (index >= list.length) return;
      const item = list[index];
      try {
        const lease = await sharedModelImageStore.acquireRefreshLease(item.key, source, { timeoutMs: 250 });
        if (lease.acquired) held.push({ item, lease });
        else busy.push(item);
      } catch (_) { held.push({ item, lease: { acquired: true, release: async () => {} } }); }
    }
  });
  await Promise.all(workers);
  return {
    held: held.map(entry => entry.item),
    busy,
    release: async () => { for (const entry of held) { try { await entry.lease.release(); } catch (_) {} } },
  };
}

/* Tek bir dağıtım turu: önce bekleyen yayımlar, sonra delta çekme.
   Tek-uçuşludur — arka plan zamanlayıcısı ile elle tetikleme birbirinin
   üstüne binmez ve paylaşılan klasöre iki kat yük binmez. */
let sharedModelImageSyncInFlight = null;
async function syncSharedModelImagesOnce({ limit = 500 } = {}) {
  if (sharedModelImageSyncInFlight) return sharedModelImageSyncInFlight;
  sharedModelImageSyncInFlight = (async () => {
    if (!(await sharedModelImageStore.available())) return { available:false, published:0, installed:0, collectionOnly:true };
    const published = await modelImageDistribution.flushPublish({
      limit:Math.min(500, Math.max(1, Number(limit) || 200)),
      sourceIdentityPrefix:'collection:',
      dropNonMatching:true,
    });
    return {
      available:true,
      published:published.published || 0,
      pendingPublish:published.pending || 0,
      installed:0, tombstones:0, scanned:0, remaining:0,
      lazy:true, collectionOnly:true,
    };
  })().finally(() => { sharedModelImageSyncInFlight = null; });
  return sharedModelImageSyncInFlight;
}

/* MANUEL SAHİPLİĞİN DAĞITIMI.
   Kullanıcı elle bir görsel bağladığında karar yalnız yerel çıkarımda değil,
   AÇIK bir kayıtta durur ve MANUAL sahiplikle paylaşılan depoya yayımlanır.
   Böylece başka bir kullanıcının "PLM'den Tümünü Yenile" işlemi bu görseli
   ezemez. Referans boşsa yayımlanan şey bir MEZAR TAŞIDIR. */
function recordManualImageOwnership(items, collectionOwnerId = '') {
  const owner = String(collectionOwnerId || '').trim();
  const manual = [];
  const publishEntries = [];
  const tombstoneKeys = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = plmImageIngestLib.canonicalKeyFor(item);
    if (!key) continue;
    const imageRef = String((item && item.imageRef) || '').trim();
    const identity = { plmId: item.plmId, colourCode: item.colourCode || '', colour: item.colour || item.color || '' };
    if (!imageRef) {
      tombstoneKeys.push(key);
      if (owner) publishEntries.push({
        canonicalKey:'collection:' + owner + ':' + key, ...identity, source:sharedImageStoreLib.SOURCE_MANUAL,
        ownership:sharedImageStoreLib.OWNERSHIP_MANUAL, status:sharedImageStoreLib.STATUS_DELETED,
        sourceIdentity:'collection:' + owner + ':' + key,
      });
      continue;
    }
    const found = getCollectionImage(imageRef);
    if (!found) continue;
    let buffer = null;
    try { buffer = fs.readFileSync(found.full); } catch (_) { continue; }
    const contentHash = plmImageHash(buffer);
    const mimeType = (found.item && found.item.mimeType) || '';
    manual.push({ key, imageRef, hash: contentHash, mimeType, bytes: buffer.length, deviceId: localDb.getDeviceId() });
    if (owner) publishEntries.push({
      canonicalKey: 'collection:' + owner + ':' + key, ...identity, source: sharedImageStoreLib.SOURCE_MANUAL,
      ownership: sharedImageStoreLib.OWNERSHIP_MANUAL, status: sharedImageStoreLib.STATUS_AVAILABLE,
      imageRef, contentHash, mimeType,
      sourceIdentity:'collection:' + owner + ':' + key,
      sourceFetchedAt:new Date().toISOString(),
    });
  }
  if (manual.length) plmImageOwnership.rememberManual(manual);
  if (tombstoneKeys.length) plmImageOwnership.forgetManual(tombstoneKeys);
  if (publishEntries.length) {
    modelImageDistribution.queuePublish(publishEntries);
    void modelImageDistribution.flushPublish({
      limit:200, sourceIdentityPrefix:'collection:', dropNonMatching:true,
    }).catch(error => plmImageRefreshLog('SHARED_PUBLISH_DEFERRED', { error:(error && error.message) || String(error) }));
  }
  return { manual: manual.length, tombstones: tombstoneKeys.length };
}

/* ASAS yazımlarının KÖKENİNİ kalıcı kılar.
   asas-technical-images.js kendi durum dosyasını tutar ama sahiplik kaydına
   hiç dokunmazdı: sonuç olarak her ASAS görseli sahiplik çıkarımında MANUEL
   görünüyordu ve hangi üst kaynaktan geldiği hiçbir yerde yazmıyordu. Dağıtım
   katmanı bu bilgiyi zorunlu kılar. */
function recordAsasImageProvenance(links) {
  const entries = [];
  const outcomes = [];
  for (const link of Array.isArray(links) ? links : []) {
    const key = parseLib.plmImageKey(link && link.plmId);
    const imageRef = String((link && link.imageRef) || '').trim();
    if (!key || !imageRef) continue;
    const found = getCollectionImage(imageRef);
    if (!found) continue;
    let buffer = null;
    try { buffer = fs.readFileSync(found.full); } catch (_) { continue; }
    const contentHash = plmImageHash(buffer);
    entries.push({
      key, owner: plmImageOwnership.OWNER_ASAS, imageRef,
      sourceType: sharedImageStoreLib.SOURCE_ASAS, sourceIdentity: contentHash,
      hash: contentHash, mimeType: (found.item && found.item.mimeType) || '', bytes: buffer.length,
      sourceFetchedAt: new Date().toISOString(),
    });
    outcomes.push({
      key, plmId: link.plmId, colourCode: link.colourCode || '', colour: link.colour || '',
      imageRef, contentHash, mimeType: (found.item && found.item.mimeType) || '',
      sourceIdentity: contentHash, status: plmImageIngestLib.COMMIT_WRITTEN,
    });
  }
  if (entries.length) plmImageOwnership.rememberAutomatic(entries);
  return outcomes;
}

/* Paylaşılandan kurulan görselleri istemcinin beklediği images[] biçimine
   çevirir; kaynak/köken bilgisi korunur. */
function sharedInstallPayload(outcomes) {
  return (Array.isArray(outcomes) ? outcomes : [])
    .filter(item => item && item.imageRef && item.status !== 'failed')
    .map(item => ({
      plmId: item.plmId, colourCode: item.colourCode || '', colour: item.colour || '',
      imageRef: item.imageRef, url: item.url || '', mimeType: item.mimeType || '', size: item.size || 0,
      sourceType: item.source || '', imageVersion: item.imageVersion || '',
      existing: item.status !== 'installed', unchanged: item.status === 'unchanged',
      oldRef: item.currentRef || '', origin: modelImageDistributionLib.ORIGIN_SHARED,
    }));
}

/* İstemcinin beklediği images[] gövdesi. Kanonik sonuçlar (outcomes) tek
   yerde çevrilir ki iki uç (canlı senkron / paket) aynı biçimi döndürsün. */
function plmImagePayload(outcomes) {
  return (Array.isArray(outcomes) ? outcomes : [])
    .filter(item => item && item.imageRef && item.status !== plmImageIngestLib.COMMIT_FAILED && item.status !== plmImageIngestLib.COMMIT_MANUAL)
    .map(item => ({
      plmId: item.plmId, colourCode: item.colourCode || '', colour: item.colour || '',
      imageRef: item.imageRef, url: item.url || '', mimeType: item.mimeType || '', size: item.size || 0,
      sourceType: item.sourceType || '', imageVersion: item.imageVersion || '',
      existing: item.status !== plmImageIngestLib.COMMIT_WRITTEN,
      unchanged: item.status === plmImageIngestLib.COMMIT_UNCHANGED,
      oldRef: item.currentRef || '',
    }));
}
/* İlerleme sayıları UYDURULMAZ: her biri gerçekten sayılan bir iştir.
   (paket sözleşmesi E maddesi) */
function plmImageJobCounts(counts) {
  const value = counts || {};
  return {
    requested: value.requested || 0, resolved: value.resolved || 0, unresolved: value.unresolved || 0,
    stylesProcessed: value.stylesProcessed || 0, optionImagesFound: value.optionImagesFound || 0,
    downloadsCompleted: value.downloadsCompleted || 0, cacheHits: value.cacheHits || 0,
    fallbacksUsed: value.fallbacksUsed || 0, manualPreserved: value.manualPreserved || 0,
    missing: value.missing || 0, failed: value.failed || 0, bytesDownloaded: value.bytesDownloaded || 0,
  };
}
app.post('/api/model-images/import-plm', requirePlmContextAccess, express.json({ limit: '16mb' }), async (req,res)=>{
  if(!plmContextScopeAllowed(req,res))return;
  const imageJobRef = { id: null };
  let apiSession = null;
  let checkpoint = null;
  try {
    const raw=Array.isArray(req.body&&req.body.items)?req.body.items:null,mode=modelImageMode(req.body&&req.body.mode);
    // "Tümünü Yenile" otomatik görselleri tazeler; kullanıcının ELLE koyduğu
    // görseli yine EZMEZ. Üzerine yazma AÇIK bir kullanıcı kararıdır.
    const overwriteManual=Boolean(req.body&&req.body.overwriteManual);
    if(!raw)return res.status(400).json({error:'items (dizi) zorunlu.',code:'VALIDATION_ERROR'});
    plmImageRefreshLog('PLM_IMAGE_REFRESH_START',{mode,requested:raw.length,overwriteManual});
    setModelOperationProgress(req.currentUser.id,{kind:'images',phase:'Download',current:0,total:raw.length,model:''});
    imageJobRef.id = plmJobs.create(req.currentUser.id, {
      kind: 'plm-images', scope: plmJobScope(req), total: raw.length,
      label: 'Model gorseli · ' + raw.length + ' model (PLM)',
      phase: 'PLM cozumleniyor',
    }).id;

    const result=await withModelImageImportLock(req.currentUser.id,async()=>{
      const before=loadOverrides(),imagemap=before.imagemap||{},styleLinks=loadPlmStyleLinks().links||{};
      // İstekler TEKİLLEŞTİRİLİR: aynı PLM+Renk iki kez API'ye gitmez.
      /* PLM ID taşımayan alt detay kalemleri önce model adı üzerinden çözülür;
         çözülemeyenler SESSİZCE ATILMAZ, hata kalemi olarak raporlanır. */
      let cachedOrders=[];try{cachedOrders=modelImageIdentityOrders(cacheForUser(req.currentUser.id));}catch(_){cachedOrders=[];}
      const identity=resolveModelImageItemIdentities(raw,{orders:cachedOrders,styleLinks});
      const seen=new Set(),requests=[];
      for(const item of identity.resolved){
        const plmId=String(item&&item.plmId||'').trim();
        if(!parseLib.plmImageKey(plmId))continue;
        const colourCode=String(item&&item.colourCode||'').trim(),colour=String(item&&item.colour||item&&item.color||'').trim();
        const key=`${coreNectumStyleApi.coreId(plmId)}|${coreNectumStyleApi.normalizeColourCode(colourCode)}|${colour.toUpperCase()}`;
        if(seen.has(key))continue;seen.add(key);
        // Style ID istemciden DEĞİL kalıcı PLM link deposundan gelir; yoksa
        // GetStyleList zaten çözer.
        const styleLink=styleLinks[plmStyleLinks.normalizeNumericId(plmId)];
        requests.push({plmId,colourCode,colour,imageRole:coreNectumStyleApi.normalizeImageRole(item&&item.imageRole),styleName:String(item&&item.styleName||'').trim(),styleId:String(styleLink&&styleLink.styleId||'')});
      }
      if(!requests.length)return {overrides:before,requested:0,images:[],imagesSaved:0,failedItems:identity.unresolved,imageFailedItems:identity.unresolved,mode,counts:plmImageJobCounts({}),status:plmImageJobStore.STATUS_COMPLETED};

      /* LOCAL → SHARED → PLM. Üst kaynağa yalnız hiçbir yerde bulunamayan
         kimlikler gider. Kaynak SIKIDIR: ASAS kökenli paylaşılan bir nesne
         bir PLM isteğini karşılayamaz. */
      const sharedForCollection = collectionImageSyncPolicy.scopeUsesSharedImages(plmJobScope(req));
      const first = await resolveModelImagesLocalFirst(requests, {
        source: sharedImageStoreLib.SOURCE_PLM, mode, overwriteManual,
        force: Boolean(req.body && req.body.force), overrides: before,
        allowShared: false,
      });
      const sharedImages = sharedInstallPayload(first.installed.outcomes);
      const upstreamLease = await leaseUpstreamImageIdentities(first.plan.upstream, sharedImageStoreLib.SOURCE_PLM);
      /* Üst kaynağa giden istek HER ZAMAN yukarıda kurulan asıl istektir.
         Plan kalemi yeniden istek gövdesine ÇEVRİLMEZ: Style ID yalnız
         kalıcı PLM link deposundan gelmelidir ve plan kaleminden yeniden
         türetmek o kuralı sessizce gevşetirdi. */
      const byKey = new Map(requests.map(request => [plmImageIngestLib.normalizeRequest(request).key, request]));
      const upstreamRequests = upstreamLease.held.map(planned => byKey.get(planned.key)).filter(Boolean);
      const distributionCounts = {
        ...first.plan.counts,
        sharedInstalled: first.installed.installed || 0,
        waitingOtherInstance: upstreamLease.busy.length,
      };
      if(!upstreamRequests.length){
        await upstreamLease.release();
        const overridesNow = first.overrides || before;
        return {
          overrides: overridesNow, requested: requests.length, images: sharedImages,
          imagesSaved: first.installed.linksUpdated || 0, failedItems: identity.unresolved, imageFailedItems: identity.unresolved, mode,
          status: plmImageJobStore.STATUS_COMPLETED, counts: plmImageJobCounts({ requested: requests.length, cacheHits: first.plan.counts.localAvailable, manualPreserved: first.plan.counts.manualProtected }),
          distribution: distributionCounts,
        };
      }

      checkpoint = plmImageJobStore.createCheckpoint({
        jobId: imageJobRef.id, userId: String(req.currentUser.id), kind: 'plm-images',
        scope: plmJobScope(req), source: 'live', mode, overwriteManual, items: upstreamRequests,
      });
      try {
      apiSession = await agentBrowserConnector.openCoreNectumStyleApiSession(req.currentUser.id, {
        isCancelled: () => plmJobs.isCancelled(req.currentUser.id, imageJobRef.id),
      });
      const run = await plmImageSyncService.runPlmImageSync({
        requests: upstreamRequests, mode, overwriteManual, checkpoint,
        imagemap: (first.overrides && first.overrides.imagemap) || imagemap, store: first.store,
        ingest: canonicalPlmImageIngest(plmImageOwnership.OWNER_PLM),
        styleListLookup: codes => apiSession.styleListLookup(codes),
        styleImagesLookup: styleId => apiSession.styleImagesLookup(styleId),
        downloadImage: (url, options) => agentBrowserConnector.downloadCoreNectumAttachment(url, options),
        styleImagesConcurrency: coreNectumStyleApi.STYLE_IMAGES_CONCURRENCY,
        downloadConcurrency: coreNectumStyleApi.IMAGE_DOWNLOAD_CONCURRENCY,
        // Eski dosya yalnız AÇIK bir tam yenilemede silinir; kısmi işlerde
        // eski bayt yerinde kalır (başka bir kimlik onu kullanıyor olabilir).
        dropOldFiles: mode==='all',
        isCancelled: () => plmJobs.isCancelled(req.currentUser.id, imageJobRef.id),
        onProgress: progress => reportImageProgress(req, imageJobRef, progress),
      });
      /* YAYIM. Yerel yazma bitti, kullanıcı görseli görebiliyor; paylaşılan
         depoya taşıma buradan sonra ve asenkron olur. Ağ yoksa kuyrukta
         bekler, yerel başarı geri ALINMAZ. */
      if (sharedForCollection) queueModelImagePublish(run.outcomes, sharedImageStoreLib.SOURCE_PLM, { collectionOwnerId:req.currentUser.id });
      /* Kaynak duyarlı "bulunamadı" belleği: PLM'in yok demesi ASAS için
         hiçbir şey söylemez. Açık bir yenileme yine deneyebilir. */
      modelImageDistribution.rememberNotFound((run.skipped || [])
        .filter(item => item && item.decision === 'missing' && item.key)
        .map(item => ({ canonicalKey: item.key, source: sharedImageStoreLib.SOURCE_PLM, code: 'PLM_IMAGE_MISSING' })));
      modelImageDistribution.clearNotFound((run.outcomes || [])
        .filter(item => item && item.imageRef && item.key)
        .map(item => ({ canonicalKey: item.key, source: sharedImageStoreLib.SOURCE_PLM })));

      const images=[...sharedImages, ...plmImagePayload(run.outcomes)];
      const failedItems=[...(run.failures||[]),...identity.unresolved];
      return {
        overrides: run.overrides||first.overrides||before,
        requested: requests.length,
        found: run.counts.resolved||0,
        images,
        imagesSaved: (run.linksUpdated||0)+(first.installed.linksUpdated||0),
        failedItems,
        imageFailedItems: failedItems,
        mode,
        status: run.status,
        counts: plmImageJobCounts({ ...run.counts, requested: requests.length, cacheHits: (run.counts.cacheHits||0)+first.plan.counts.localAvailable, manualPreserved: (run.counts.manualPreserved||0)+first.plan.counts.manualProtected }),
        distribution: distributionCounts,
        imagesDownloaded: run.counts.downloadsCompleted||0,
        imagesReplaced: images.filter(item=>!item.existing&&item.oldRef).length,
        imagesUnchanged: run.counts.cacheHits||0,
        imagesMissing: run.counts.missing||0,
        imagesFailed: failedItems.length,
        manualPreserved: run.counts.manualPreserved||0,
        batchLog: (run.resolution&&run.resolution.batchLog)||[],
        diagnostics: (apiSession&&typeof apiSession.diagnostics==='function'&&apiSession.diagnostics())||[],
        metadataCalls: run.metadataCalls||0,
        uniqueDownloads: run.uniqueDownloads||0,
      };
      } finally { await upstreamLease.release(); }
    });

    for(const item of result.imageFailedItems||[])plmJobs.addFailure(req.currentUser.id,imageJobRef.id,{plmId:item&&item.plmId,model:item&&item.styleName,error:(item&&item.error)||'PLM gorseli alinamadi.',code:(item&&item.code)||'PLM_IMAGE_MISSING'});
    plmJobs.update(req.currentUser.id,imageJobRef.id,{processed:result.requested,total:result.requested,succeeded:Math.max(0,result.requested-(result.imagesFailed||0))});
    plmImageRefreshLog('PLM_IMAGE_CACHE_INVALIDATED',{mode:result.mode,changed:result.imagesReplaced||0});
    plmImageRefreshLog('PLM_IMAGE_REFRESH_COMPLETE',{mode:result.mode,...result.counts});
    userAccess.appendAudit(req.currentUser,'PLM_IMAGE_IMPORT','corenectum',{mode:result.mode,...result.counts});
    res.json({ok:true,...result});
    finishImageJob(req, imageJobRef, result.status===plmImageJobStore.STATUS_FAILED ? new Error('PLM gorsel isi basarisiz.') : null);
  } catch(err){ if(checkpoint)try{checkpoint.finish(plmImageJobStore.STATUS_FAILED,{error:err&&err.message});}catch(_){} finishImageJob(req, imageJobRef, err); automationError(res,err,'PLM model görselleri içe aktarılamadı.');}
  finally { if(apiSession)await apiSession.close().catch(()=>{}); clearModelOperationProgress(req.currentUser&&req.currentUser.id); }
});
app.post('/api/model-images/import-asas', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), express.json({ limit: '16mb' }), async (req,res)=>{
  const imageJobRef = { id: null };
  try {
    const raw=Array.isArray(req.body&&req.body.items)?req.body.items:null,mode=modelImageMode(req.body&&req.body.mode);
    if(!raw)return res.status(400).json({error:'items (dizi) zorunlu.',code:'VALIDATION_ERROR'});
    setModelOperationProgress(req.currentUser.id,{kind:'images',phase:'Download',current:0,total:raw.length,model:''});
    // Is kaydi: kapsam istemciden gelir; gorsel isi yalniz kendi ekraninda
    // gorunur ama sayfa degisince durmaz.
    imageJobRef.id = plmJobs.create(req.currentUser.id, {
      kind: 'plm-images', scope: plmJobScope(req), total: raw.length,
      label: 'Model gorseli · ' + raw.length + ' model (ASAS)',
      phase: 'Indiriliyor',
    }).id;
    const result=await withModelImageImportLock(req.currentUser.id,async()=>{
      await ensureDataLoaded(req.currentUser.id);const runtime=cacheForUser(req.currentUser.id),overrides=loadOverrides();
      /* Kimlik önce ÇÖZÜLÜR: PLM ID taşımayan alt detay kalemleri model adı
         üzerinden ASAS kaydına bağlanır. Çözülemeyenler sessizce düşmez. */
      const identity = resolveModelImageItemIdentities(raw, { orders: modelImageIdentityOrders(runtime), styleLinks: loadPlmStyleLinks().links || {} });
      const items = identity.resolved;
      if (!items.length) {
        return { mode, candidates: [], requested: raw.length, saved: 0,
          failed: identity.unresolved.length, failedItems: identity.unresolved, images: [], overrides,
          distribution: { identities: 0, localAvailable: 0, sharedPullable: 0, remoteRequired: 0, manualProtected: 0, unavailable: 0, sharedInstalled: 0, waitingOtherInstance: 0 } };
      }
      /* LOCAL → SHARED → ASAS. Paylaşılan depoda ASAS KÖKENLİ geçerli bir
         nesne varsa ASAS'a ikinci kez gidilmez; PLM kökenli bir nesne ise bu
         işlemi KARŞILAYAMAZ (kaynak sıkılığı). */
      const sharedForCollection = collectionImageSyncPolicy.scopeUsesSharedImages(plmJobScope(req));
      const first = await resolveModelImagesLocalFirst(items, {
        source: sharedImageStoreLib.SOURCE_ASAS, mode,
        overwriteManual: Boolean(req.body && req.body.overwriteManual),
        force: Boolean(req.body && req.body.force), overrides,
        allowShared: false,
      });
      const sharedImages = sharedInstallPayload(first.installed.outcomes);
      const upstreamLease = await leaseUpstreamImageIdentities(first.plan.upstream, sharedImageStoreLib.SOURCE_ASAS);
      const keys=new Set(upstreamLease.held.map(item=>parseLib.plmImageKey(item.plmId)).filter(Boolean));
      const distributionCounts = {
        ...first.plan.counts,
        sharedInstalled: first.installed.installed || 0,
        waitingOtherInstance: upstreamLease.busy.length,
      };
      if(!keys.size){
        await upstreamLease.release();
        return { mode, candidates: first.plan.identities, requested: raw.length, saved: first.installed.linksUpdated || 0,
          failed: identity.unresolved.length, failedItems: identity.unresolved, images: sharedImages, overrides: first.overrides || overrides, distribution: distributionCounts };
      }
      try {
        // Eşleşme yalnız ASAS kaydındaki gerçek PLM Kod + Teknik Görsel alanından
        // yapılır. PLM Kodunu PIM Style ID sanarak tahmini URL üretilmez.
        const run = await asasTechnicalImages.syncAsasTechnicalImages({orders:runtime.asasOrders||[],overrides:first.overrides||overrides,mode,forceRetry:true,keys,
          getImage:ref=>getCollectionImage(ref),saveImage:payload=>saveCollectionImage(payload),deleteImage:ref=>deleteCollectionImage(ref),
          collect:items=>agentBrowserConnector.collectAsasTechnicalImages(req.currentUser.id,items,{...getModelImageSettings(),onProgress:progress=>reportImageProgress(req,imageJobRef,progress)}),patchLinks:links=>patchPlmImageLinks(links)});
        /* KÖKEN KAYDI. ASAS görselleri eskiden hiçbir sahiplik izi
           bırakmıyordu; hangi kaynaktan geldikleri hiçbir yerde yazmıyordu ve
           dağıtımda bir ASAS isteğini karşılayıp karşılayamayacakları
           bilinemezdi. Artık OTOMATİK/ASAS olarak kaydedilir ve yayımlanır. */
        const asasOutcomes = recordAsasImageProvenance(run.images || []);
        if (sharedForCollection) queueModelImagePublish(asasOutcomes, sharedImageStoreLib.SOURCE_ASAS, { collectionOwnerId:req.currentUser.id });
        modelImageDistribution.rememberNotFound((run.failedItems || [])
          .map(item => ({ canonicalKey: parseLib.plmImageKey(item && item.plmId), source: sharedImageStoreLib.SOURCE_ASAS, code: (item && item.code) || 'ASAS_TECHNICAL_IMAGE_MISSING' }))
          .filter(item => item.canonicalKey));
        modelImageDistribution.clearNotFound(asasOutcomes.map(item => ({ canonicalKey: item.key, source: sharedImageStoreLib.SOURCE_ASAS })));
        const failedItems = [...(run.failedItems || []), ...identity.unresolved];
        return { ...run, images: [...sharedImages, ...(run.images || [])], failedItems, failed: failedItems.length,
          saved: (run.saved || 0) + (first.installed.linksUpdated || 0), distribution: distributionCounts };
      } finally { await upstreamLease.release(); }
    });
    userAccess.appendAudit(req.currentUser,'ASAS_IMAGE_IMPORT','pim',{mode,requested:result.requested,saved:result.saved,failed:result.failed});res.json({ok:true,...result,images:result.images||[],imagesSaved:result.saved||0,imageFailedItems:result.failedItems||[]});
    finishImageJob(req, imageJobRef, null);
  } catch(err){ finishImageJob(req, imageJobRef, err); automationError(res,err,'ASAS model görselleri içe aktarılamadı.');}
  finally { clearModelOperationProgress(req.currentUser&&req.currentUser.id); }
});

// ---- Hazır PLM görsel paketi ve görsel iş durumu route'ları → server/routes/plm-image-package-routes.js ----
require('./routes/plm-image-package-routes')(app, {
  apiError,
  assertModelImageMutable,
  canonicalPlmImageIngest,
  express,
  finishImageJob,
  fs,
  getCollectionImage,
  loadOverrides,
  modelOperationProgress,
  path,
  plmImageJobCounts,
  plmImageJobStore,
  plmImageOwnership,
  plmImagePackage,
  plmImagePayload,
  plmImageRefreshLog,
  plmImageSyncService,
  plmJobScope,
  plmJobs,
  reportImageProgress,
  requirePlmContextAccess,
  userAccess,
  withModelImageImportLock,

});
/* ===================================================================
   PLM OPERASYON MERKEZİ — jobId bazlı iş uçları

   Kapsam (scope) süzgeci sayfalar arası karışmayı bitiren yerdir: her ekran
   yalnız kendi işlerini ister, kapsamsız istek ise operasyon merkezinin
   gördüğü tam listeyi döndürür. İşler arka planda sürdüğü için sayfa
   değişmesi bir işi durdurmaz.
   =================================================================== */
const PLM_JOB_SCOPES = ['koleksiyon', 'cp', 'orders', 'source'];

app.get('/api/plm-jobs', requirePlmContextAccess, (req, res) => {
  const scope = PLM_JOB_SCOPES.includes(String(req.query.scope || '')) ? String(req.query.scope) : '';
  const filter = { scope };
  if (req.query.running === '1') filter.running = true;
  if (req.query.running === '0') filter.running = false;
  res.set('Cache-Control', 'no-store').json({ ok: true, jobs: plmJobs.list(req.currentUser.id, filter) });
});

app.get('/api/plm-jobs/:id', requirePlmContextAccess, (req, res) => {
  const job = plmJobs.describe(req.currentUser.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'İş bulunamadı.', code: 'PLM_JOB_NOT_FOUND' });
  res.set('Cache-Control', 'no-store').json({ ok: true, job, failures: plmJobs.failures(req.currentUser.id, req.params.id) });
});

/* İptal ANINDA sonlandırmaz; yalnız bayrak koyar. Çalışan iş bunu kendi
   güvenli noktasında görüp durur, böylece yarım yazılmış veri kalmaz. */
app.post('/api/plm-jobs/:id/cancel', requirePlmContextAccess, (req, res) => {
  const job = plmJobs.requestCancel(req.currentUser.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Çalışan bir iş bulunamadı.', code: 'PLM_JOB_NOT_FOUND' });
  res.json({ ok: true, job: plmJobs.describe(req.currentUser.id, req.params.id) });
});

// "Yalnız başarısızları yeniden dene" için gereken kimlikleri döndürür;
// yeniden çalıştırmayı istemci kendi akışıyla başlatır.
app.get('/api/plm-jobs/:id/failed-ids', requirePlmContextAccess, (req, res) => {
  const job = plmJobs.describe(req.currentUser.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'İş bulunamadı.', code: 'PLM_JOB_NOT_FOUND' });
  res.json({ ok: true, scope: job.scope, kind: job.kind, plmIds: plmJobs.failedIds(req.currentUser.id, req.params.id) });
});

app.post('/api/plm-jobs/clear-finished', requirePlmContextAccess, (req, res) => {
  res.json({ ok: true, removed: plmJobs.clearFinished(req.currentUser.id) });
});

// Görsel işini sonlandırır. Hata varsa iş 'failed' olarak kapanır; böylece
// operasyon merkezinde neden bittiği görünür.
function finishImageJob(req, jobRef, error) {
  if (!jobRef || !jobRef.id) return;
  plmJobs.finish(req.currentUser.id, jobRef.id, error
    ? { status: 'failed', error: (error && error.message) || String(error) }
    : { status: 'succeeded' });
  jobRef.id = null;
}

/* Görsel rotalarında ilerleme hem eski tek slota hem de işin kendi kaydına
   yazılır. Eski uç korunuyor ki ona bakan mevcut istemci kodu bozulmasın. */
function reportImageProgress(req, jobRef, progress) {
  setModelOperationProgress(req.currentUser.id, { kind: 'images', ...progress });
  if (!jobRef || !jobRef.id) return;
  plmJobs.update(req.currentUser.id, jobRef.id, {
    phase: progress && progress.phase,
    processed: progress && progress.current,
    total: progress && progress.total,
    activeModel: progress && progress.model,
  });
}

// İstek gövdesinden/sorgusundan kapsam. Bilinmeyen değer 'genel'e düşer ki
// bir sayfa yanlışlıkla başka sayfanın kapsamını üstlenmesin.
function plmJobScope(req) {
  const raw = String((req.body && req.body.scope) || req.query.scope || '').trim();
  return PLM_JOB_SCOPES.includes(raw) ? raw : 'genel';
}

/* Bir PLM işini iş kaydıyla sarmalar. Eski setModelOperationProgress çağrıları
   KORUNUR: hâlen o uca bakan istemci kodu bozulmasın diye ikisi bir arada
   yürür; yeni arayüz jobId üzerinden okur. */
async function withPlmJob(req, meta, fn) {
  const userId = req.currentUser.id;
  const job = plmJobs.create(userId, {
    kind: meta.kind, scope: meta.scope, label: meta.label, total: meta.total, phase: meta.phase,
  });
  const report = patch => plmJobs.update(userId, job.id, patch || {});
  const fail = failure => plmJobs.addFailure(userId, job.id, failure || {});
  const cancelled = () => plmJobs.isCancelled(userId, job.id);
  try {
    const result = await fn({ id: job.id, report, fail, cancelled });
    plmJobs.finish(userId, job.id, { status: cancelled() ? 'cancelled' : 'succeeded' });
    return { job: plmJobs.describe(userId, job.id), result };
  } catch (error) {
    plmJobs.finish(userId, job.id, { status: cancelled() ? 'cancelled' : 'failed', error: (error && error.message) || String(error) });
    error.plmJobId = job.id;
    throw error;
  }
}

app.post('/api/plm-style-links/sync', userAccess.requireAnyArea('cp', 'orders', 'koleksiyon'), express.json({ limit: '16mb' }), async (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    // Incremental image lifecycle: existing usable PLM images are not fetched
    // again during a normal sync. Rebuild is an explicit advanced action.
    const beforeImages = loadOverrides();
    const existingImageMap = (beforeImages && beforeImages.imagemap) || {};
    const forceImages = Boolean(req.body && (req.body.forceImages || req.body.rebuildImageCache));
    const incrementalItems = items.map(item => {
      const plmId = String(item && item.plmId || '').trim();
      const requested = item && item.needImage !== false;
      const colourCode = String(item && item.colourCode || '').trim();
      const colourKey = colourCode ? parseLib.plmColourImageKey(plmId, colourCode) : '';
      const hasImage = colourCode ? String(existingImageMap[colourKey] || '').trim() !== '' : parseLib.plmImageUsable(existingImageMap, plmId);
      const needImage = requested && (forceImages || !hasImage);
      return { ...item, needImage };
    });
    const collected = await agentBrowserConnector.collectCoreNectumStyleLinks(req.currentUser.id, incrementalItems, {...getModelImageSettings(),forceRefreshImages:forceImages,onProgress:progress=>setModelOperationProgress(req.currentUser.id,{kind:'links',...progress})});
    const saved = upsertPlmStyleLinks(collected.links, req.currentUser);
    const storedImages = [];
    const imageLinks = [];
    const imageStorageFailed = [];
    let imageSaved = { overrides: beforeImages, updated: 0 };
    for (const link of collected.links) {
      const colourCode = String(link && link.colourCode || '').trim();
      const key = colourCode ? parseLib.plmColourImageKey(link && link.plmId, colourCode) : parseLib.plmImageKey(link && link.plmId);
      if (!key) continue;
      /* v6.38 — "zaten var mı" kontrolü artık GÖSTERİMLE aynı çözümlemeyi
         kullanıyor. Eskiden yalnız eski PLM-only anahtara bakılıyordu; silme
         mezar taşı renk anahtarında durduğu için kontrol "var" diyor, görsel
         çekilmiyordu — ya da çekilip eski anahtara yazılıyor ve mezar taşı
         tarafından gölgeleniyordu. Kullanıcı kararı: silinmiş görsel EKSİK
         sayılır ve yeniden yüklenir. */
      const map = (beforeImages && beforeImages.imagemap) || {};
      const hasImage = colourCode ? String(map[key] || '').trim() !== '' : parseLib.plmImageUsable(map, link && link.plmId);
      if (hasImage) {
        storedImages.push({ plmId: link.plmId, colourCode, imageRef: colourCode ? String(map[key] || '').trim() : parseLib.plmImageRef(map, { plm: link.plmId, ccode: '' }) || String(map[key] || '').trim(), existing: true });
        continue;
      }
      const image = link && link.image;
      if (!image || !image.base64) continue;
      try {
        const stored = saveCollectionImage({ rowId: key, filename: image.filename, mimeType: image.mimeType, base64: image.base64 });
        storedImages.push({ plmId: link.plmId, colourCode, imageRef: stored.id, url: stored.url, mimeType: stored.mimeType, size: stored.size, imageVersion: stored.updatedAt, existing: false });
        imageLinks.push({ plmId: link.plmId, colourCode, imageRef: stored.id });
      } catch (imageError) { imageStorageFailed.push({ plmId: link.plmId, colourCode, error: imageError.message, code: 'PLM_IMAGE_STORAGE_FAILED' }); }
    }
    try {
      imageSaved = imageLinks.length ? patchPlmImageLinks(imageLinks) : imageSaved;
    } catch (imageError) {
      storedImages.filter(item => !item.existing).forEach(item => { try { deleteCollectionImage(item.imageRef); } catch (_) {} });
      storedImages.splice(0, storedImages.length, ...storedImages.filter(item => item.existing));
      imageStorageFailed.push({ plmId: '', error: imageError.message, code: imageError.code || 'PLM_IMAGE_LINK_FAILED' });
      imageSaved = { overrides: beforeImages, updated: 0 };
    }
    const imageFailedItems = [...(collected.imageFailed || []), ...imageStorageFailed].filter(failure => !storedImages.some(item => String(item.plmId) === String(failure.plmId)));
    userAccess.appendAudit(req.currentUser, 'PLM_STYLE_LINKS_SYNC', 'corenectum', {
      requested: collected.requested,
      found: collected.links.length,
      failed: collected.failed.length,
      imagesFound: collected.links.filter(item => item && item.image).length,
      imagesSaved: imageSaved.updated,
      scannedPages: collected.scannedPages,
      scannedRows: collected.scannedRows,
      added: saved.added,
      updated: saved.updated,
    });
    res.json({ ok: true, ...saved, overrides: imageSaved.overrides, requested: collected.requested, found: collected.links.length, scannedPages: collected.scannedPages, scannedRows: collected.scannedRows, failedItems: collected.failed, imageFailedItems, images: storedImages, imagesSaved: imageSaved.updated });
  } catch (err) { automationError(res, err, 'CoreNectum PLM bağlantıları otomatik alınamadı.'); }
});

// ---- Koleksiyon doğrudan PLM senkronu ve QTX route'ları → server/routes/plm-sync-routes.js ----
require('./routes/plm-sync-routes')(app, {

  MODEL_FILES_ROOT,
  agentBrowserConnector,
  apiError,
  automationError,
  clearModelOperationProgress,
  crypto,
  ensureModelFilesRoot,
  express,
  fs,
  loadPlmStyleLinks,
  modelStoredFileExists,
  normalizePlmId,
  plmJobs,
  publicModelFileMeta,
  qtxStore,
  readModelFilesIndex,
  resolveStoredFile,
  safeMailFilename,
  setModelOperationProgress,
  technicalSheetOwnership,
  upsertPlmStyleLinks,
  userAccess,
  withPlmJob,
  writeModelFilesIndex,
  getModelImageSettings,
});
/* ===================================================================
   OAB (Order-Assortment-Budget) — Overview modülü.
   PASS'e (LC Waikiki intranet raporlama sistemi) bağlanıp
   OrderBudget_List_Report verisini yalnız kullanıcının seçtiği
   Season/MAG/Buyer Group kombinasyonu için çeker. Toplu/tüm-kombinasyon
   tarama mevcut OAB plan/batch katmanının kurallarına göre yürütülür.

   v6.60 — AKIŞ DEĞİŞTİ (kullanıcı talimatı): filtre metadata'sı (Season/MAG/
   Buyer Group seçenekleri) artık RAPOR verisinden AYRI bir cache'te
   (oabMetadataStore) tutulur ve OAB authentication olmadan gösterilir. OAB
   session/Authorization yalnız kullanıcı "Get OAB"/"Refresh OAB" dediğinde
   doğrulanır; Overview > OAB açılışında login penceresi açılmaz.
   =================================================================== */
// OAB transport is owned by Buyer Log's internal Electron session.
// The browser window captures a short-lived Authorization into backend RAM;
// report traffic then goes directly through oabApiClient. No Edge/Chrome,
// external debugging port, external browser profile or browser connector is used.
function oabInternalAuthStatus() {
  const current = oabAuthState.status();
  return {
    authenticated: Boolean(current && current.authenticated),
    connected: Boolean(current && current.authenticated),
    loginRequired: !Boolean(current && current.authenticated),
    transport: 'electron-internal',
  };
}
function requireOabInternalAuth() {
  const status = oabInternalAuthStatus();
  if (status.authenticated) return status;
  const error = new Error('OAB oturumu gerekli.');
  error.code = 'OAB_AUTH_REQUIRED';
  error.statusCode = 401;
  error.details = { loginRequired:true, transport:'electron-internal' };
  throw error;
}
async function fetchOabReportFromInternalSession(params) {
  requireOabInternalAuth();
  return oabApiClient.fetchReportData(params || {});
}
app.get('/api/oab/auth/status', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), (req, res) => {
  try { res.set('Cache-Control','no-store').json({ ok:true, status:oabInternalAuthStatus() }); }
  catch (err) { automationError(res, err, 'PASS bağlantı durumu okunamadı.'); }
});
app.get('/api/oab/seasons', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), (req, res) => {
  try {
    // Bundled metadata: filtre seçenekleri uygulamayla birlikte gelen JSON'dan
    // okunur; normal filtre kullanımı PASS bağlantısı kurmaz.
    const seasons = oabStaticMetadata.getSeasons();
    const metadata = oabStaticMetadata.getInfo();
    res.set('Cache-Control','no-store').json({
      ok:true,
      seasons,
      fromCache:true,
      source:'bundled-json',
      fetchedAt:metadata.generatedAt,
      metadata,
    });
  } catch (err) { automationError(res, err, 'OAB filtre metadata yüklenemedi.'); }
});
app.post('/api/oab/mag', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '4kb' }), (req, res) => {
  try {
    const seasonRef = req.body && req.body.seasonRef;
    if (seasonRef == null || seasonRef === '') return res.status(400).json({ error:'seasonRef zorunlu.', code:'OAB_SEASON_REQUIRED' });
    const mag = oabStaticMetadata.getMag(seasonRef);
    const metadata = oabStaticMetadata.getInfo();
    res.set('Cache-Control','no-store').json({
      ok:true,
      mag,
      fromCache:true,
      source:'bundled-json',
      fetchedAt:metadata.generatedAt,
      metadata,
    });
  } catch (err) { automationError(res, err, 'OAB MAG metadata yüklenemedi.'); }
});
app.post('/api/oab/buyer-groups', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '4kb' }), (req, res) => {
  try {
    const merchSubGroupRef = req.body && req.body.merchSubGroupRef;
    if (merchSubGroupRef == null || merchSubGroupRef === '') return res.status(400).json({ error:'merchSubGroupRef zorunlu.', code:'OAB_MAG_REQUIRED' });
    const buyerGroups = oabStaticMetadata.getBuyerGroups(merchSubGroupRef);
    const metadata = oabStaticMetadata.getInfo();
    res.set('Cache-Control','no-store').json({
      ok:true,
      buyerGroups,
      fromCache:true,
      source:'bundled-json',
      fetchedAt:metadata.generatedAt,
      metadata,
    });
  } catch (err) { automationError(res, err, 'OAB Buyer Group metadata yüklenemedi.'); }
});
// OAB verisi: rapor cache'i (oabStore, metadata cache'inden AYRI) burada
// kontrol edilir. forceRefresh=true ("Refresh OAB") cache'i bypass eder ve
// PASS'ten taze veri alıp cache'i günceller. PASS bağlantısı (kurulu değilse)
// TAM OLARAK burada, seçilen üç filtreyle birlikte kurulur.
app.post('/api/oab/report', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const seasonRef = body.seasonRef, merchSubGroupRef = body.merchSubGroupRef, buyerGroupRef = body.buyerGroupRef;
    if (seasonRef == null || seasonRef === '' || merchSubGroupRef == null || merchSubGroupRef === '' || buyerGroupRef == null || buyerGroupRef === '') {
      return res.status(400).json({ error:'seasonRef, merchSubGroupRef ve buyerGroupRef zorunlu.', code:'OAB_PARAMS_REQUIRED' });
    }
    const metadataSelection = oabStaticMetadata.validateSelectedRefs({ seasonRef, merchSubGroupRef, buyerGroupRef });
    if (!metadataSelection.ok) {
      return res.status(400).json({
        error:'Seçilen OAB filtre kombinasyonu paketlenmiş metadata ile eşleşmiyor. Filtreleri yeniden seçin veya metadata dosyasını güncelleyin.',
        code:'OAB_METADATA_SELECTION_INVALID',
        details:{ field:metadataSelection.field },
      });
    }
    const key = oabStore.cacheKeyOf(seasonRef, merchSubGroupRef, buyerGroupRef);
    if (!body.forceRefresh) {
      const cached = oabStore.get(key);
      if (cached && cached.fresh) {
        oabSessionStore.save(req.currentUser.id, {
          selection:{ seasonRef, merchSubGroupRef, buyerGroupRef },
          rows:cached.rows,
          fields:cached.fields,
          fetchedAt:cached.fetchedAt,
          fromCache:true,
        });
        return res.json({ ok:true, rows:cached.rows, fields:cached.fields, fromCache:true, fetchedAt:cached.fetchedAt, ttlMinutes:cached.ttlMinutes });
      }
    }
    const rows = await fetchOabReportFromInternalSession({ seasonRef, merchSubGroupRef, buyerGroupRef });
    // Alan listesi HARD-CODE EDİLMEZ: response'taki satırların birleşik anahtar
    // kümesinden dinamik üretilir (81 civarındaki alanın hepsi, hangi satırda
    // olursa olsun kaybolmadan taşınır).
    const fields = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
    const saved = oabStore.set(key, { rows, fields, params: { seasonRef, merchSubGroupRef, buyerGroupRef } });
    oabSessionStore.save(req.currentUser.id, {
      selection:{ seasonRef, merchSubGroupRef, buyerGroupRef },
      rows:saved.rows,
      fields:saved.fields,
      fetchedAt:saved.fetchedAt,
      fromCache:false,
    });
    userAccess.appendAudit(req.currentUser, 'OAB_REPORT_FETCH', key, { rows: rows.length, fields: fields.length, forceRefresh: Boolean(body.forceRefresh) });
    res.json({ ok:true, rows:saved.rows, fields:saved.fields, fromCache:false, fetchedAt:saved.fetchedAt, ttlMinutes:oabStore.loadCacheSettings().ttlMinutes });
  } catch (err) { automationError(res, err, 'OAB raporu alınamadı.'); }
});

// ---- OAB çoklu seçim toplu çekme ve OAB durum route'ları → server/routes/oab-batch-routes.js ----
require('./routes/oab-batch-routes')(app, {
  afterSharedCollectionSave,
  automationError,
  canonicalCollectionOwner,
  collectionReplicaStatus,
  collectionSaveWorker,
  collectionWorkspaceEditAllowed,
  express,
  fetchOabReportFromInternalSession,
  liveEvents,
  logRuntimeFailure,
  oabBatch,
  oabSessionStore,
  oabStaticMetadata,
  oabStore,
  publishCollectionReplica,
  publishCollectionWorkspaceImages,
  redactSecrets,
  refreshCollectionPermissionScope,
  requestClientId,
  requireOabInternalAuth,
  sharedRevisionStore,
  userAccess,
});
/* ===================================================================
   INTAKE — WSSI Intake Raporu4 / Model.

   OAB ile aynı Overview yetki sınırını ve mevcut ModelQuery/MSOLAP yolunu
   kullanır. Raporun veri cache'i intake-store'da, kullanıcı görünümü ise
   mevcut user-preferences deposunda ayrı tutulur. Özellikle display label'lar
   sorgu kimliğine hiç girmez.
   =================================================================== */
const INTAKE_VIEW_PREF_KEY = 'lcw.intake.view.v1';
const INTAKE_RECOVERABLE_ERRORS = new Set([
  'MODEL_QUERY_FAILED', 'MODEL_QUERY_TIMEOUT', 'MODEL_QUERY_UNSUPPORTED',
  'MODEL_QUERY_NO_RESULT', 'MODEL_SCHEMA_UNAVAILABLE', 'MODEL_QUERY_OUT_OF_MEMORY',
]);
function intakeStoredView(userId) {
  const entry = userPreferences.load(userId).entries[INTAKE_VIEW_PREF_KEY];
  if (!entry || !entry.value) return null;
  try { const parsed = JSON.parse(entry.value); return parsed && typeof parsed === 'object' ? parsed : null; }
  catch (_) { return null; }
}
function intakeSaveView(userId, viewConfig) {
  const saved = userPreferences.merge(userId, {
    [INTAKE_VIEW_PREF_KEY]: { value: JSON.stringify(viewConfig), updatedAt: new Date().toISOString() },
  });
  return saved.entries[INTAKE_VIEW_PREF_KEY] || null;
}
function intakeSafeSourceMessage() {
  return 'INTAKE verisine şu anda ulaşılamıyor. Şirket ağı veya VPN bağlantısını kontrol edin.';
}
function intakeErrorResponse(err) {
  const code = String(err && err.code || 'INTAKE_SOURCE_UNAVAILABLE');
  if (code.startsWith('INTAKE_')) {
    return { status: Number(err && err.statusCode) || 400, code, message: String(err && err.message || 'INTAKE isteği geçersiz.') };
  }
  return { status: Number(err && err.statusCode) >= 500 ? Number(err.statusCode) : 502, code: 'INTAKE_SOURCE_UNAVAILABLE', message: intakeSafeSourceMessage() };
}
function intakeFieldToken(field) {
  return { id: field.id, sourceUniqueName: field.sourceUniqueName, fieldType: field.fieldType };
}
function intakeConnection() {
  // refreshEnabled controls scheduled/global refresh participation, not the
  // health of a configured source. Manual Overview refresh must work either way.
  const configured = intakeConnectionSelector.selectIntakeConnection(loadModelConnections().items);
  if (configured) {
    return {
      id: configured.id,
      name: configured.name || 'INTAKE',
      server: configured.server,
      catalog: configured.catalog,
      model: 'Model',
    };
  }
  const error = new Error('INTAKE veritabanı bağlantısı Bağlantı Ayarları ekranında tanımlanmalıdır.');
  error.code = 'INTAKE_CONNECTION_MISSING';
  error.statusCode = 409;
  throw error;
}
/* v7.81 — INTAKE'in Data Management'ta tanımlı ufku (ortak filtre).
   intake-budget profili 'filters' yeteneğini taşır: bu ekrandan filtre
   tanımlanabiliyordu ama rapor onu hiç okumuyordu. Tek gerçek kaynak
   kaynağın scope.horizon alanıdır; kişisel bir katman YOKTUR. */
function intakeHorizon() {
  const item = loadModelConnections().items.find(entry => entry && entry.role === 'intake');
  if (!item || !Array.isArray(item.scopes)) return null;
  const scope = item.scopes.find(entry => entry && Array.isArray(entry.targets) && entry.targets.includes('intake'));
  const horizon = scope && scope.horizon;
  return horizon && typeof horizon === 'object' && Object.keys(horizon).length ? horizon : null;
}
function intakeQueryKey(viewConfig, connection = intakeConnection(), horizon = intakeHorizon()) {
  const query = viewConfig && viewConfig.query || {};
  return intakeStore.queryKey({
    connection,
    /* Ufuk anahtarın PARÇASIDIR: değişince önbellek de değişmeli, yoksa
       filtre uygulanmamış eski satırlar geri döner. */
    horizon: horizon || null,
    rows: (query.rows || []).map(intakeFieldToken),
    columns: (query.columns || []).map(intakeFieldToken),
    measures: (query.measures || []).map(intakeFieldToken),
    filters: {
      fields: (query.filters || []).map(intakeFieldToken),
      values: query.filterValues || {},
    },
  });
}
function intakeStateResponse(req, snapshot = null, fields = null, offline = false, error = '', connection = intakeConnection()) {
  const saved = intakeStoredView(req.currentUser.id);
  const savedFields = saved && saved.query && typeof saved.query === 'object'
    ? [...(saved.query.rows || []), ...(saved.query.columns || []), ...(saved.query.measures || []), ...(saved.query.filters || [])]
    : [];
  const sourceFields = Array.isArray(fields) && fields.length
    ? fields
    : (snapshot && Array.isArray(snapshot.fields) && snapshot.fields.length
      ? snapshot.fields
      : (savedFields.length ? savedFields : intakeReport.defaultFields()));
  const viewConfig = intakeReport.reconcileViewConfig(saved || (snapshot && snapshot.viewConfig) || null, sourceFields);
  return {
    ok: true,
    connection,
    viewConfig,
    fields: sourceFields,
    snapshot: snapshot ? {
      rows: snapshot.rows,
      fields: snapshot.fields,
      fetchedAt: snapshot.fetchedAt,
      queryKey: snapshot.queryKey,
    } : null,
    offline: Boolean(offline),
    error: error || '',
  };
}
async function intakeLiveFields(connection = intakeConnection()) {
  const schema = await modelQuery.discoverSchema({
    server: connection.server,
    catalog: connection.catalog,
  });
  return { schema, fields: intakeReport.allowedSchema(schema), connection };
}
function intakeHorizonFields(fields) {
  return (Array.isArray(fields) ? fields : []).filter(field => field && field.fieldType === 'dimension').map(field => {
    /* Tip ve GÜVEN seviyesi birlikte taşınır: şemadan gelen tip predicate
       üretiminde otoritedir, addan tahmin edilen yalnız arayüz önerisidir. */
    const resolved = horizonFields.schemaFieldTypeInfo({ dataType: field.dataType, name: field.name });
    return {
      header: field.id, key: field.id, name: field.name, table: field.table, sourceUniqueName: field.sourceUniqueName,
      dynamic: true, tr: field.defaultLabel || field.name, en: field.defaultLabel || field.name,
      type: resolved.type, typeSource: resolved.confidence,
    };
  });
}
function intakeDistinctValue(value) { return value == null ? '' : String(value).trim(); }

app.get('/api/intake/state', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), (req, res) => {
  try {
    const connection = intakeConnection();
    const snapshot = intakeStore.loadSnapshot(req.currentUser.id);
    res.set('Cache-Control', 'no-store').json(intakeStateResponse(req, snapshot, null, false, '', connection));
  } catch (err) { automationError(res, err, 'INTAKE son snapshot durumu okunamadı.'); }
});
app.get('/api/intake/settings', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok: true, viewConfig: intakeReport.reconcileViewConfig(intakeStoredView(req.currentUser.id), []) }); }
  catch (err) { automationError(res, err, 'INTAKE görünüm ayarları okunamadı.'); }
});
app.put('/api/intake/settings', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '256kb' }), (req, res) => {
  try {
    const reset = Boolean(req.body && req.body.reset);
    const viewConfig = reset
      ? intakeReport.resetView()
      : intakeReport.reconcileViewConfig(req.body && (req.body.viewConfig || req.body.config), []);
    // Reset is intentionally scoped to the caller’s local Overview state. It
    // must not change model-connections or invalidate another user’s cache.
    const snapshot = reset ? intakeStore.clearSnapshot(req.currentUser.id) : { cleared: false };
    intakeSaveView(req.currentUser.id, viewConfig);
    userAccess.appendAudit(req.currentUser, 'INTAKE_VIEW_UPDATE', 'intake', { reset, snapshotCleared: snapshot.cleared });
    res.json({ ok: true, viewConfig, reset, snapshotCleared: snapshot.cleared });
  } catch (err) { automationError(res, err, 'INTAKE görünüm ayarı kaydedilemedi.'); }
});
app.get('/api/intake/metadata', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), async (req, res) => {
  try {
    const found = await intakeLiveFields();
    const saved = intakeStoredView(req.currentUser.id);
    res.set('Cache-Control', 'no-store').json({
      ok: true, connection: found.connection, fields: found.fields,
      viewConfig: intakeReport.reconcileViewConfig(saved, found.fields),
      provider: found.schema.provider || '', schemaErrors: found.schema.errors || [], offline: false,
    });
  } catch (err) {
    const snapshot = intakeStore.loadSnapshot(req.currentUser.id);
    if (snapshot && snapshot.fields.length) {
      return res.json({ ...intakeStateResponse(req, snapshot, snapshot.fields, true, intakeSafeSourceMessage()), source: 'snapshot' });
    }
    const failure = intakeErrorResponse(err);
    res.status(failure.status).json({ error: failure.message, code: failure.code, offline: true });
  }
});
app.post('/api/intake/distinct', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const found = await intakeLiveFields();
    const wanted = String(req.body && (req.body.fieldId || req.body.sourceUniqueName) || '').trim();
    const field = found.fields.find(item => item.id === wanted || item.sourceUniqueName === wanted);
    if (!field || field.fieldType !== 'dimension') {
      const error = new Error('INTAKE filtresi için geçerli bir dimension seçilmedi.'); error.code = 'INTAKE_FIELD_INVALID'; error.statusCode = 400; throw error;
    }
    const search = String(req.body && req.body.search || '').trim().slice(0, 120);
    const limit = Math.min(5000, Math.max(1, Number(req.body && req.body.limit) || 500));
    const column = intakeReport.daxRef(field);
    const text = search.replace(/"/g, '""');
    const valueType = intakeReport.intakeFieldValueType(field);
    /* CONTAINSSTRING metin işlevidir. Sayısal/tarih bir boyutta sorguyu tip
       hatasıyla düşürürdü; o alanlarda arama gelen listeye uygulanır. */
    const searchInDax = Boolean(search) && filterValueTypes.supportsTextOperators(valueType);
    const distinct = searchInDax ? `FILTER(DISTINCT(${column}), CONTAINSSTRING(${column}, "${text}"))` : `DISTINCT(${column})`;
    const result = await modelQuery.runModelRows({
      server: found.connection.server, catalog: found.connection.catalog,
      query: `EVALUATE TOPN(${limit}, ${distinct}, ${column}, ASC)`, generated: true,
      maxRows: limit, timeoutMs: 120000,
    });
    const searchKey = search.toLocaleLowerCase('tr-TR');
    const values = [...new Set((result.rows || []).map(row => intakeDistinctValue(Object.values(row || {})[0])).filter(Boolean))]
      .filter(value => searchInDax || !searchKey || value.toLocaleLowerCase('tr-TR').includes(searchKey))
      .sort((a, b) => a.localeCompare(b, 'tr'));
    res.json({ ok: true, fieldId: field.id, values, valueType, provider: result.provider || '', fromCache: false });
  } catch (err) {
    const failure = intakeErrorResponse(err);
    res.status(failure.status).json({ error: failure.message, code: failure.code, offline: failure.code === 'INTAKE_SOURCE_UNAVAILABLE' });
  }
});
app.post('/api/intake/report', userAccess.requireAnyArea('overview'), userAccess.requireCapability('OAB.VIEW'), express.json({ limit: '512kb' }), async (req, res) => {
  const userId = req.currentUser.id;
  const previous = intakeStore.loadSnapshot(userId);
  try {
    const found = await intakeLiveFields();
    const requested = req.body && (req.body.viewConfig || req.body.config);
    const saved = requested || intakeStoredView(userId);
    const viewConfig = intakeReport.reconcileViewConfig(saved, found.fields);
    const horizon = intakeHorizon();
    const built = intakeReport.buildIntakeQuery({ fields: found.fields, viewConfig, horizon });
    const queryKey = intakeQueryKey(built.viewConfig, found.connection, horizon);
    if (!(req.body && req.body.forceRefresh)) {
      const cached = intakeStore.get(queryKey);
      if (cached && cached.fresh) {
        intakeSaveView(userId, built.viewConfig);
        intakeStore.saveSnapshot(userId, { queryKey, rows: cached.rows, fields: cached.fields || found.fields, viewConfig: built.viewConfig, fetchedAt: cached.fetchedAt });
        return res.json({ ok: true, rows: cached.rows, fields: cached.fields || found.fields, viewConfig: built.viewConfig, queryKey, fromCache: true, offline: false, fetchedAt: cached.fetchedAt });
      }
    }
    const result = await modelQuery.runModelRows({
      server: found.connection.server, catalog: found.connection.catalog,
      query: built.query, headerMap: built.headerMap, generated: true,
      maxRows: built.maxRows, timeoutMs: 180000,
    });
    const rows = intakeReport.normalizeRows(result.rows, built.viewConfig);
    const record = intakeStore.set(queryKey, { rows, fields: found.fields, viewConfig: built.viewConfig, fetchedAt: new Date().toISOString() });
    intakeSaveView(userId, built.viewConfig);
    intakeStore.saveSnapshot(userId, { queryKey, rows, fields: found.fields, viewConfig: built.viewConfig, fetchedAt: record.fetchedAt });
    userAccess.appendAudit(req.currentUser, 'INTAKE_REPORT_FETCH', queryKey, { rows: rows.length, fields: found.fields.length, forceRefresh: Boolean(req.body && req.body.forceRefresh) });
    res.json({ ok: true, rows, fields: found.fields, viewConfig: built.viewConfig, queryKey, fromCache: false, offline: false, fetchedAt: record.fetchedAt, provider: result.provider || '', rowLimit: built.maxRows, truncated: rows.length >= built.maxRows });
  } catch (err) {
    const code = String(err && err.code || '');
    if (previous && Array.isArray(previous.rows) && INTAKE_RECOVERABLE_ERRORS.has(code)) {
      const fallback = intakeStateResponse(req, previous, previous.fields, true, intakeSafeSourceMessage());
      return res.json({ ...fallback, source: 'snapshot', fromCache: true });
    }
    const failure = intakeErrorResponse(err);
    res.status(failure.status).json({ error: failure.message, code: failure.code, offline: failure.code === 'INTAKE_SOURCE_UNAVAILABLE' });
  }
});


function currentUserIsModerator(req) { return Boolean(req.currentUser && userAccess.hasPermission(req.currentUser, 'manageAllOrders')); }
/* Not yazarı damgası (v7.29). Kimlik SUNUCUDAKİ oturumdan alınır; istemcinin
   gönderdiği hiçbir alan yazar olarak kabul edilmez (§32). */
function noteActorOf(profile) {
  if (!profile) return null;
  const id = profile.id == null ? '' : String(profile.id).trim();
  const name = String(profile.displayName || profile.username || '').trim();
  return id || name ? { id, name } : null;
}
function orderRowsForCode(profile, orderCode) {
  const code = Number(orderCode);
  if (!Number.isFinite(code)) return [];
  // Buyer folders are user-managed and therefore cannot be trusted as an
  // authorisation source. Order ownership is taken only from the last successful
  // Moderator ASAS snapshot persisted by user-access.js.
  return profile && !userAccess.hasPermission(profile, 'manageAllOrders') ? userAccess.authoritativeOrderRows(code) : [];
}

function overridesForViewer(profile, overrides) {
  if (!profile || userAccess.hasPermission(profile, 'manageAllOrders')) return overrides;
  return overrideScope.scopeOverridesForViewer(overrides, code => userAccess.authoritativeOrderRows(code).some(order => userAccess.canEditOrder(profile, order)));
}
function canUserEditOrderCode(profile, orderCode, precomputed = null) {
  // v7.16: manageAllOrders kontrolü KULLANICIYA bağlıdır, satıra değil. Satır
  // başına çağrıldığında her seferinde alt kullanıcı ağacı yürünüp izin kümesi
  // yeniden kuruluyordu. Çağıran bu kararı bir kez hesaplayıp geçirebilir.
  const manageAll = precomputed && typeof precomputed.manageAll === 'boolean'
    ? precomputed.manageAll
    : Boolean(profile && userAccess.hasPermission(profile, 'manageAllOrders'));
  if (manageAll) return true;
  const rows = orderRowsForCode(profile, orderCode);
  // Overrides are stored per order code, not per colour line. Therefore every ASAS
  // line sharing that code must belong to the selected user's scope before editing.
  return rows.length > 0 && rows.every(order => userAccess.canEditOrder(profile, order));
}
function canCurrentUserEditOrderCode(req, orderCode) {
  return canUserEditOrderCode(req.currentUser, orderCode);
}
function rejectUnauthorizedOrders(req, res, orderCodes) {
  const denied = [...new Set((orderCodes || []).map(Number).filter(Number.isFinite))].filter(code => !canCurrentUserEditOrderCode(req, code));
  if (!denied.length) return false;
  userAccess.appendAudit(req.currentUser, 'WRITE_DENIED', 'orders', { orderCodes: denied.slice(0,50), deniedCount: denied.length });
  res.status(403).json({ error: 'Kapsamınız dışındaki siparişlerde değişiklik yapamazsınız.', code: 'ORDER_VIEW_ONLY', deniedOrderCodes: denied.slice(0,50) });
  return true;
}
function recordOrderCode(record) {
  const raw = record && (record.orderCode ?? record['Order Code'] ?? record.ocode ?? record.siparisKod ?? record._sourceOrderCode);
  const code = Number(String(raw == null ? '' : raw).replace(/\./g, '').trim());
  return Number.isFinite(code) ? code : null;
}
function withOrderAccess(req, record) {
  const code = recordOrderCode(record);
  // Collection-originated Shipping Comparison rows are already scoped to the
  // current user's shipping store; they do not have an ASAS order code to
  // authorize against. Keep the existing order-scope check for order rows.
  return { ...record, _canEdit: code == null ? ((record && record._sourceModule === 'collection') || currentUserIsModerator(req)) : canCurrentUserEditOrderCode(req, code) };
}
function requestRevision(req) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const raw = req.headers['if-match'] != null ? req.headers['if-match'] : body.expectedRevision;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/^W\//, '').replace(/^"|"$/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function requestSuppFobRevision(req) {
  const body=req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)?req.body:{};
  const raw=req.headers['x-supp-fob-revision']!=null?req.headers['x-supp-fob-revision']:body.expectedSuppFobRevision;
  if(raw==null||raw==='')return null;
  const n=Number(String(raw).replace(/^W\//,'').replace(/^"|"$/g,''));
  return Number.isInteger(n)&&n>=0?n:null;
}
function apiError(res, err, fallbackMessage = 'İşlem tamamlanamadı.') {
  if (err && err.code === 'REVISION_CONFLICT') {
    return res.status(409).json({ error: err.message, code: err.code, currentRevision: err.currentRevision, expectedRevision: err.expectedRevision, revisionKey: err.revisionKey || null });
  }
  const status=err && err.statusCode || 500;
  if(status>=500)logRuntimeFailure('apiError', err);
  return res.status(status).json({ error: fallbackMessage, code: err && err.code || (status<500?'REQUEST_ERROR':'INTERNAL_ERROR') });
}
async function receiveRequestToTempFile(req, maxBytes) {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, 'buyerlog-upload-'));
  const file = path.join(root, 'upload.blgbackup');
  const output = fs.createWriteStream(file, { flags: 'wx' });
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('Yedek dosyası 550 MB güvenli yükleme sınırını aşıyor.');
        error.statusCode = 413; error.code = 'BACKUP_TOO_LARGE'; throw error;
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end(); await once(output, 'finish');
    if (!bytes) { const error = new Error('Yedek dosyası boş.'); error.statusCode = 400; error.code = 'EMPTY_BACKUP'; throw error; }
    return { root, file, bytes };
  } catch (err) {
    output.destroy(); fs.rmSync(root, { recursive: true, force: true }); throw err;
  }
}
app.post('/api/backup/restore', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), async (req, res) => {
  let upload = null;
  let ownsWriteLock = false;
  try {
    upload = await receiveRequestToTempFile(req, 550 * 1024 * 1024);
    if (systemRestoreState.writeLocked || [...fullRestoreJobs.values()].some(job => !job.done)) throw Object.assign(new Error('Başka bir geri yükleme işlemi devam ediyor.'), { code:'SYSTEM_RESTORE_IN_PROGRESS', statusCode:409 });
    // Set synchronously before starting the worker: all subsequent mutations
    // are rejected while the worker performs its commit/rollback transaction.
    systemRestoreState.legacyRestoreLocked = true; refreshSystemRestoreWriteLock(); ownsWriteLock = true;
    const result = await runBackupRestore(upload.file, { env:{
      BUYER_LOG_SERVER_DATA_ROOT:process.env.BUYER_LOG_SERVER_DATA_ROOT,
      BUYER_LOG_DATA_ROOT:process.env.BUYER_LOG_DATA_ROOT,
      BUYER_LOG_LOCAL_DATA_ROOT:process.env.BUYER_LOG_LOCAL_DATA_ROOT,
      BUYER_LOG_CONFIG_PATH:process.env.BUYER_LOG_CONFIG_PATH,
      BUYER_LOG_TEMP_ROOT:process.env.BUYER_LOG_TEMP_ROOT,
      BL_DATA_DIR:process.env.BL_DATA_DIR,
    } });
    const restored = loadRuntimeConfig(CONFIG_PATH, { defaults: DEFAULT_CONFIG });
    if (restored.warning) logRuntimeFailure('restoredConfigRead', restored.error || restored.warning);
    config = restored.config;
    sourceCaches.clear(); initialDataLoadPromises.clear();
    res.json({ ...result, restartRecommended: true });
  } catch (err) { apiError(res, err, 'Yedek geri yüklenemedi. Dosyanın geçerli ve bozulmamış olduğunu kontrol edin.'); }
  finally {
    if (ownsWriteLock) { systemRestoreState.legacyRestoreLocked = false; refreshSystemRestoreWriteLock(); }
    if (upload) await fs.promises.rm(upload.root, { recursive:true, force:true }).catch(error => logRuntimeFailure('backupRestoreTempCleanup', error));
  }
});
const FULL_RESTORE_MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
function fullRestoreApiError(res, error, fallback = 'Full System Restore tamamlanamadı.') {
  const status = Number(error && error.statusCode) || 500;
  return res.status(status).json({ error: error && error.message || fallback, code: error && error.code || 'FULL_RESTORE_FAILED', details: error && error.details || null });
}
function fullRestoreUploadFor(req, uploadId) {
  const upload = fullRestoreUploads.get(String(uploadId || ''));
  if (!upload || (upload.ownerId !== req.currentUser.id && req.currentUser.systemRole !== 'moderator')) return null;
  return upload;
}
function fullRestoreJobStatus(job) {
  return {
    id: job.id, phase: job.phase, current: job.current || 0, total: job.total || 0, item: job.item || '',
    bytesDone: Number(job.bytesDone) || 0, bytesTotal: Number(job.bytesTotal) || 0,
    ready: job.phase === 'Tamamlandı', done: ['Tamamlandı', 'Hata', 'İptal'].includes(job.phase), error: job.error || null, errorCode: job.errorCode || null,
    commitStarted: Boolean(job.commitStarted), writeLocked: Boolean(job.writeLocked), restartRecommended: Boolean(job.restartRecommended),
    result: job.result ? { ok: true, restoreId: job.result.restoreId, warnings: job.result.warnings || [], verification: job.result.verification || null } : null,
  };
}
const USER_RESTORE_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
function userRestoreUploadFor(req, uploadId) {
  const upload = userRestoreUploads.get(String(uploadId || ''));
  if (!upload || upload.ownerId !== req.currentUser.id) return null;
  return upload;
}
function userRestoreJobStatus(job) {
  return {
    id: job.id, phase: job.phase, current: job.current || 0, total: job.total || 0, item: job.item || '',
    bytesDone: Number(job.bytesDone) || 0, bytesTotal: Number(job.bytesTotal) || 0,
    done: Boolean(job.done), error: job.error || null, result: job.result || null,
  };
}
// Kişisel restore de stream upload kullanır; backup belleğe bütünüyle alınmaz.
app.post('/api/backups/user-restore/inspect', async (req, res) => {
  let upload = null;
  try {
    if (systemRestoreState.writeLocked) return res.status(409).json({ error: 'Full System Restore devam ederken kişisel restore başlatılamaz.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
    upload = await receiveRequestToTempFile(req, USER_RESTORE_MAX_ARCHIVE_BYTES);
    const inspected = await userRestoreService.inspect(upload.file, req.currentUser);
    const uploadId = crypto.randomUUID();
    userRestoreUploads.set(uploadId, { ...upload, id: uploadId, ownerId: req.currentUser.id, inspectedAt: Date.now(), inspected });
    upload = null;
    return res.status(200).json({ ok: true, uploadId, preflight: inspected.public });
  } catch (error) {
    const status = Number(error && error.statusCode) || 400;
    return res.status(status).json({ error: error && error.message || 'Kişisel backup incelenemedi.', code: error && error.code || 'USER_RESTORE_INSPECT_FAILED', details: error && error.details || null });
  } finally {
    if (upload) fs.rmSync(upload.root, { recursive: true, force: true });
  }
});

// Upload is deliberately a raw request stream. No Buffer/body parser is used,
// so a multi-GB Full System Backup never has to exist in process memory.
app.post('/api/backups/restore/inspect', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), async (req, res) => {
  let upload = null;
  try {
    if (systemRestoreState.writeLocked) return res.status(409).json({ error: 'Başka bir Full System Restore uygulanıyor.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
    upload = await receiveRequestToTempFile(req, FULL_RESTORE_MAX_ARCHIVE_BYTES);
    const createSafetyBackup = !['0', 'false', 'no'].includes(String(req.query && req.query.createSafetyBackup || '').toLowerCase());
    const info = await fullRestoreService.inspect(upload.file, { createSafetyBackup });
    const uploadId = crypto.randomUUID();
    fullRestoreUploads.set(uploadId, { ...upload, id: uploadId, ownerId: req.currentUser.id, inspectedAt: Date.now(), info, createSafetyBackup });
    upload = null;
    return res.status(200).json({ ok: true, uploadId, preflight: info });
  } catch (error) { return fullRestoreApiError(res, error, 'Full System Backup incelenemedi.'); }
  finally { if (upload) fs.rmSync(upload.root, { recursive: true, force: true }); }
});
app.use(express.json({ limit: '100mb' }));
app.use((err, req, res, next) => {
  if (!err) return next();
  /* Browser refresh/navigation can close a request while express/raw-body is
     still reading it. The client is already gone, so there is no useful
     response to send and this must not be logged as a server failure. */
  if (isClientRequestAborted(err)) {
    if (!res.headersSent) return res.status(499).end();
    return;
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Gönderilen veri izin verilen boyutu aşıyor.', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({ error: 'Gönderilen JSON verisi geçerli değil.', code: 'INVALID_JSON' });
  }
  return next(err);
});
// Buyer Log verileri kullanıcı düzenlemeleriyle sık değişir. Tarayıcı veya ara ağ
// katmanlarının eski API yanıtlarını tekrar kullanmasını engelle.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.post('/api/backups/user-restore/start', (req, res) => {
  try {
    if (systemRestoreState.writeLocked) return res.status(409).json({ error: 'Full System Restore devam ederken kişisel restore başlatılamaz.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
    if ([...userRestoreJobs.values()].some(job => job.ownerId === req.currentUser.id && !job.done)) return res.status(409).json({ error: 'Bu kullanıcı için bir restore zaten çalışıyor.', code: 'USER_RESTORE_IN_PROGRESS' });
    const upload = userRestoreUploadFor(req, req.body && req.body.uploadId);
    if (!upload) return res.status(404).json({ error: 'Restore için yüklenmiş kişisel backup bulunamadı.', code: 'USER_RESTORE_UPLOAD_NOT_FOUND' });
    const id = crypto.randomUUID();
    const job = { id, ownerId: req.currentUser.id, phase: 'Hazırlanıyor', current: 0, total: upload.inspected.info.fileCount || 0, item: '', bytesDone: 0, bytesTotal: upload.inspected.info.totalBytes || 0, error: null, result: null, done: false, createdAt: Date.now() };
    userRestoreJobs.set(id, job);
    setImmediate(async () => {
      try {
        const restored = await userRestoreService.restore(upload.file, {
          user: req.currentUser,
          preflight: upload.inspected,
          components: req.body && req.body.components,
          onProgress: progress => Object.assign(job, progress),
        });
        sourceCaches.clear(); initialDataLoadPromises.clear();
        job.result = restored;
        job.phase = 'Tamamlandı';
      } catch (error) {
        logRuntimeFailure('userRestore', error);
        job.phase = 'Hata';
        job.error = error && error.message || 'Kişisel restore başarısız.';
      } finally {
        job.done = true;
        try { fs.rmSync(upload.root, { recursive: true, force: true }); } catch (_) {}
        userRestoreUploads.delete(upload.id);
      }
    });
    return res.status(202).json(userRestoreJobStatus(job));
  } catch (error) {
    return res.status(Number(error && error.statusCode) || 500).json({ error: error && error.message || 'Kişisel restore başlatılamadı.', code: error && error.code || 'USER_RESTORE_FAILED' });
  }
});
app.get('/api/backups/user-restore/:id/status', (req, res) => {
  const job = userRestoreJobs.get(String(req.params.id || ''));
  if (!job || job.ownerId !== req.currentUser.id) return res.status(404).json({ error: 'Kişisel restore işi bulunamadı.', code: 'USER_RESTORE_JOB_NOT_FOUND' });
  return res.json(userRestoreJobStatus(job));
});

app.post('/api/backups/restore/start', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), (req, res) => {
  try {
    if (systemRestoreState.writeLocked || [...fullRestoreJobs.values()].some(job => !job.done)) return res.status(409).json({ error: 'Başka bir Full System Restore çalışıyor.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
    const upload = fullRestoreUploadFor(req, req.body && req.body.uploadId);
    if (!upload) return res.status(404).json({ error: 'Restore için yüklenmiş backup bulunamadı.', code: 'RESTORE_UPLOAD_NOT_FOUND' });
    const createSafetyBackup = !(req.body && req.body.createSafetyBackup === false);
    if (createSafetyBackup !== upload.createSafetyBackup) return res.status(409).json({ error: 'Güvenlik yedeği tercihi ön kontrolden sonra değişti. Ön kontrolü yeniden çalıştırın.', code: 'RESTORE_PREFLIGHT_STALE' });
    const id = crypto.randomUUID();
    const job = { id, ownerId: req.currentUser.id, phase: 'Hazırlanıyor', current: 0, total: upload.info.fileCount, item: '', error: null, commitStarted: false, writeLocked: false, cancelRequested: false, done: false, restartRecommended: false, createdAt: Date.now() };
    fullRestoreJobs.set(id, job);
    setImmediate(async () => {
      try {
        job.result = await fullRestoreService.restore(upload.file, {
          actor: req.currentUser,
          preflight: upload.info,
          createSafetyBackup,
          shouldCancel: () => job.cancelRequested && !job.commitStarted,
          onProgress: progress => Object.assign(job, progress),
        });
        job.phase = 'Tamamlandı'; job.restartRecommended = true;
      } catch (error) {
        logRuntimeFailure('fullSystemRestore', error);
        job.phase = error && error.code === 'RESTORE_CANCELLED' ? 'İptal' : 'Hata';
        job.error = error && error.message || 'Full System Restore başarısız.';
        job.errorCode = error && error.code || 'FULL_RESTORE_FAILED';
        job.rollback = error && error.rollback || null;
      } finally {
        job.done = true;
        try { fs.rmSync(upload.root, { recursive: true, force: true }); } catch (_) {}
        fullRestoreUploads.delete(upload.id);
      }
    });
    return res.status(202).json(fullRestoreJobStatus(job));
  } catch (error) { return fullRestoreApiError(res, error); }
});
app.get('/api/backups/restore/:id/status', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), (req, res) => {
  const job = fullRestoreJobs.get(String(req.params.id || ''));
  if (!job || (job.ownerId !== req.currentUser.id && req.currentUser.systemRole !== 'moderator')) return res.status(404).json({ error: 'Restore işi bulunamadı.', code: 'RESTORE_JOB_NOT_FOUND' });
  return res.json(fullRestoreJobStatus(job));
});
app.post('/api/backups/restore/:id/cancel', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), (req, res) => {
  const job = fullRestoreJobs.get(String(req.params.id || ''));
  if (!job || (job.ownerId !== req.currentUser.id && req.currentUser.systemRole !== 'moderator')) return res.status(404).json({ error: 'Restore işi bulunamadı.', code: 'RESTORE_JOB_NOT_FOUND' });
  if (job.done) return res.json({ ok: true, cancelAccepted: false, job: fullRestoreJobStatus(job) });
  if (job.commitStarted || systemRestoreState.commitStarted) return res.status(409).json({ ok: false, cancelAccepted: false, code: 'RESTORE_COMMIT_STARTED', job: fullRestoreJobStatus(job) });
  job.cancelRequested = true;
  return res.json({ ok: true, cancelAccepted: true, job: fullRestoreJobStatus(job) });
});
app.post('/api/backups/restore/:id/restart', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), (req, res) => {
  const job = fullRestoreJobs.get(String(req.params.id || ''));
  if (!job || (job.ownerId !== req.currentUser.id && req.currentUser.systemRole !== 'moderator')) return res.status(404).json({ error: 'Restore işi bulunamadı.', code: 'RESTORE_JOB_NOT_FOUND' });
  if (!job.done || job.phase !== 'Tamamlandı') return res.status(409).json({ error: 'Sunucu yeniden başlatma için restore tamamlanmış olmalı.', code: 'RESTORE_NOT_READY' });
  // The watchdog owns process restarts. This endpoint only confirms the
  // restart hand-off so an active browser session is not killed unexpectedly.
  return res.json({ ok: true, restartRecommended: true, restartRequired: true, job: fullRestoreJobStatus(job) });
});
// ---- Endeksmatik ------------------------------------------------------------
// Shared benchmark engine used by Collection and Orders. The browser sends only
// the selected model dimensions + manual/reference months/prices; the large
// workbook snapshot stays on the server.
function endeksmatikApiError(res, err, fallback) {
  const status = Number(err && err.statusCode) || 500;
  if (status >= 500) return apiError(res, err, fallback);
  return res.status(status).json({ error: err && err.message || fallback, code: err && err.code || 'REQUEST_ERROR', details: err && err.details || null });
}
app.get('/api/endeksmatik/status', (_req, res) => {
  try { res.json(endeksmatik.publicStatus()); }
  catch (err) { apiError(res, err, 'Endeksmatik veri durumu okunamadı.'); }
});
app.post('/api/endeksmatik/calculate', (req, res) => {
  try { res.json(endeksmatik.calculate(req.body || {})); }
  catch (err) { endeksmatikApiError(res, err, 'Endeksmatik hesabı yapılamadı.'); }
});
app.post('/api/endeksmatik/upload', userAccess.requirePermission('manageModelConnections'), async (req, res) => {
  try {
    const dataBase64 = String(req.body && req.body.dataBase64 || '');
    if (!dataBase64) return res.status(400).json({ error: 'dataBase64 alanı zorunlu.', code: 'VALIDATION_ERROR' });
    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length || buffer.length > 80 * 1024 * 1024) return res.status(400).json({ error: 'Endeksmatik Excel dosyası boş veya 80 MB sınırını aşıyor.', code: 'VALIDATION_ERROR' });
    const filename = path.basename(String(req.body && req.body.name || 'ENDEKSMATİK.xlsx')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'ENDEKSMATİK.xlsx';
    const status = await endeksmatik.importWorkbookBuffer(buffer, filename);
    publishSharedMasterChange('endeksmatik', req);
    userAccess.appendAudit(req.currentUser, 'ENDEKSMATIK_EXCEL_UPLOAD', filename, { recordCount: status.recordCount, sourceUpdatedAt: status.sourceUpdatedAt, season: status.season });
    res.json(status);
  } catch (err) { endeksmatikApiError(res, err, 'Endeksmatik Excel dosyası yüklenemedi.'); }
});

app.get('/api/user-data/inventory', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), (_req, res) => {
  try { res.json(getUserDataInventory()); }
  catch (err) { apiError(res, err, 'Kullanıcı veri envanteri okunamadı.'); }
});
app.post('/api/backup/export', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), async (req, res) => {
  let backup = null;
  try {
    const payload = req.body || {};
    backup = await exportBackupToFile({ appVersion: payload.appVersion || '', browserStorage: payload.browserStorage || {} });
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const filename = `BuyerLog_Backup_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.blgbackup`;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(backup.size));
    res.setHeader('X-Backup-File-Count', String(backup.fileCount));
    res.setHeader('X-Backup-Source-Bytes', String(backup.sourceBytes));
    let cleaned = false;
    const cleanup = () => { if (!cleaned) { cleaned = true; backup.cleanup(); } };
    const stream = fs.createReadStream(backup.path);
    stream.on('error', err => { cleanup(); if (!res.headersSent) apiError(res, err, 'Yedek paketi okunamadı.'); else res.destroy(err); });
    stream.on('close', cleanup); res.on('close', cleanup); stream.pipe(res);
  } catch (err) { if (backup) backup.cleanup(); apiError(res, err, 'Yedek paketi oluşturulamadı.'); }
});

// v7.57 — Kullanıcıya özel ve moderatör tam sistem yedekleri arka planda,
// tutarlı dosya snapshot'ları üzerinden hazırlanır; büyük ZIP yanıtları belleğe alınmaz.
const backupJobs = new Map();
function backupJobFor(req) {
  const job = backupJobs.get(String(req.params.id || ''));
  if (!job || (job.ownerId !== req.currentUser.id && req.currentUser.systemRole !== 'moderator')) return null;
  return job;
}
function backupJobStatus(job) {
  return {
    id: job.id, mode: job.mode, phase: job.phase, current: job.current, total: job.total,
    item: job.item || '', ready: Boolean(job.archive), error: job.error || null,
    filename: job.archive ? job.archive.filename : null,
  };
}
app.get('/api/backups/shared-personal/status', async (req, res) => {
  try {
    const result = await sharedPersonalBackupService.status(req.currentUser);
    res.set('Cache-Control', 'no-store').json({ ok: true, ...result });
  } catch (error) {
    res.status(Number(error && error.statusCode) || 503).json({ error: error && error.message || 'Ortak kişisel yedek durumu okunamadı.', code: error && error.code || 'SHARED_PERSONAL_BACKUP_STATUS_FAILED' });
  }
});
app.post('/api/backups/shared-personal', express.json({ limit: '12mb' }), async (req, res) => {
  try {
    if (systemRestoreState.writeLocked) return res.status(409).json({ error: 'Full System Restore devam ederken ortak kişisel yedek oluşturulamaz.', code: 'SYSTEM_RESTORE_IN_PROGRESS' });
    const result = await sharedPersonalBackupService.create(req.currentUser, req.body && req.body.browserStorage || {});
    res.status(result && result.configured === false ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    logRuntimeFailure('sharedPersonalBackup', error);
    res.status(Number(error && error.statusCode) || 503).json({ error: error && error.message || 'Ortak kişisel yedek oluşturulamadı.', code: error && error.code || 'SHARED_PERSONAL_BACKUP_FAILED' });
  }
});
app.get('/api/backups/shared-personal/latest', async (req, res) => {
  try {
    const latest = await sharedPersonalBackupService.latestFile(req.currentUser);
    if (!latest) return res.status(404).json({ error: 'Ortak klasörde bu kullanıcıya ait kişisel yedek bulunamadı.', code: 'SHARED_PERSONAL_BACKUP_NOT_FOUND' });
    const stat = await fs.promises.stat(latest.file);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(latest.file)}"`);
    res.setHeader('Content-Length', String(stat.size));
    const stream = fs.createReadStream(latest.file);
    stream.on('error', error => { if (!res.headersSent) apiError(res, error, 'Ortak kişisel yedek okunamadı.'); else res.destroy(error); });
    stream.pipe(res);
  } catch (error) {
    res.status(Number(error && error.statusCode) || 503).json({ error: error && error.message || 'Ortak kişisel yedek okunamadı.', code: error && error.code || 'SHARED_PERSONAL_BACKUP_READ_FAILED' });
  }
});

app.post('/api/backups', express.json({ limit: '12mb' }), (req, res) => {
  const mode = req.body && req.body.mode === 'full' ? 'full' : 'user';
  if (mode === 'full' && req.currentUser.systemRole !== 'moderator') return res.status(403).json({ error: 'Tam Sistem Yedeği yalnız moderatör tarafından oluşturulabilir.' });
  const running = [...backupJobs.values()].find(job => job.ownerId === req.currentUser.id && !job.archive && !job.error);
  if (running) return res.status(409).json({ error: 'Bu kullanıcı için bir yedekleme zaten çalışıyor.', job: backupJobStatus(running) });
  const id = crypto.randomUUID();
  const job = { id, mode, ownerId: req.currentUser.id, phase: 'Hazırlanıyor', current: 0, total: 0, item: '', error: null, archive: null, createdAt: Date.now() };
  backupJobs.set(id, job);
  setImmediate(async () => {
    try {
      job.archive = await backupService.create({
        mode,
        user: req.currentUser,
        browserStorage: req.body && req.body.browserStorage || {},
        components: mode === 'user' ? (req.body && req.body.components) : null,
        onProgress: progress => Object.assign(job, progress),
      });
    } catch (error) {
      job.phase = 'Hata'; job.error = error && error.message || 'Yedek oluşturulamadı.';
    }
  });
  res.status(202).json(backupJobStatus(job));
});
app.get('/api/backups/:id/status', (req, res) => {
  const job = backupJobFor(req);
  if (!job) return res.status(404).json({ error: 'Yedekleme işi bulunamadı.' });
  res.json(backupJobStatus(job));
});
app.get('/api/backups/:id/download', (req, res) => {
  const job = backupJobFor(req);
  if (!job || !job.archive) return res.status(404).json({ error: 'İndirilebilir yedek bulunamadı.' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.archive.filename}"`);
  res.setHeader('Content-Length', String(job.archive.size));
  const stream = fs.createReadStream(job.archive.path);
  stream.on('error', error => { if (!res.headersSent) apiError(res, error, 'Yedek dosyası okunamadı.'); else res.destroy(error); });
  stream.pipe(res);
});
const backupJobCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of backupJobs) if (job.createdAt < cutoff) {
    backupJobs.delete(id);
    if (job.archive && typeof job.archive.cleanup === 'function') void job.archive.cleanup();
  }
  const restoreCutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, upload] of fullRestoreUploads) if (upload.inspectedAt < restoreCutoff) {
    fullRestoreUploads.delete(id); try { fs.rmSync(upload.root, { recursive: true, force: true }); } catch (_) {}
  }
  for (const [id, upload] of userRestoreUploads) if (upload.inspectedAt < restoreCutoff) {
    userRestoreUploads.delete(id); try { fs.rmSync(upload.root, { recursive: true, force: true }); } catch (_) {}
  }
  for (const [id, job] of userRestoreJobs) if (job.createdAt < restoreCutoff && job.done) userRestoreJobs.delete(id);
  for (const [id, job] of fullRestoreJobs) if (job.createdAt < restoreCutoff && job.done) fullRestoreJobs.delete(id);
}, 5 * 60 * 1000);
if (typeof backupJobCleanupTimer.unref === 'function') backupJobCleanupTimer.unref();

app.get('/index.html', (_req, res) => res.set('Cache-Control', 'no-store').redirect(302, '/'));
const INDEX_TEMPLATE_FILE = path.join(__dirname, '..', 'public', 'index.html');
let INDEX_TEMPLATE_CACHE = null;
function renderIndexTemplate() {
  if (INDEX_TEMPLATE_CACHE == null) INDEX_TEMPLATE_CACHE = fs.readFileSync(INDEX_TEMPLATE_FILE, 'utf8');
  return INDEX_TEMPLATE_CACHE
    .replace(/__BL_CANONICAL_VERSION__/g, APP_VERSION)
    .replace(/__BL_ASSET_VERSION__/g, APP_VERSION)
    .replace(/__BL_DISPLAY_VERSION__/g, DISPLAY_VERSION);
}
// ---- Sikistirma: yeni bagimlilik YOK, Node'un kendi zlib'i kullanilir ----
// index.html ~1.3 MB, vendor betikleri ve /api/data yaniti cok MB olabiliyor. Bunlar
// sikistirilmadan gidiyordu; yerel makinede bile aktarim + ayristirma olculur zaman
// aliyor. Yalniz metin govdeleri ve belli bir esigin ustu sikistirilir; zaten sikistirilmis
// (zip/xlsx/png) indirmeler ve stream edilen yedekler ellenmez.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;
const COMPRESS_MIN_BYTES = 1024;
app.use((req, res, next) => {
  const accepts = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/i.test(accepts)) return next();
  const originalSend = res.send.bind(res);
  let compressionPending = false;
  res.send = body => {
    if (compressionPending || res.headersSent || res.getHeader('Content-Encoding')) return originalSend(body);
    const isText = typeof body === 'string';
    const isBuffer = Buffer.isBuffer(body);
    if (!isText && !isBuffer) return originalSend(body);
    const type = String(res.getHeader('Content-Type') || (isText ? 'text/html' : ''));
    if (!COMPRESSIBLE.test(type)) return originalSend(body);
    const raw = isBuffer ? body : Buffer.from(body, 'utf8');
    if (raw.length < COMPRESS_MIN_BYTES) return originalSend(body);

    // Asenkron zlib libuv iş havuzunu kullanır; büyük JSON yanıtları hazırlanırken
    // Node event loop'u senkron sıkıştırmayla bloke edilmez.
    compressionPending = true;
    zlib.gzip(raw, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (err, gz) => {
      compressionPending = false;
      if (res.headersSent || res.writableEnded) return;
      if (err) {
        try { res.removeHeader('Content-Encoding'); } catch (_) {}
        return originalSend(body);
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      return originalSend(gz);
    });
    return res;
  };
  next();
});

// Dynamic index is registered after the compression wrapper so the generated
// runtime version HTML is still gzip-compressed. It remains before static files.
app.get('/', (req, res) => {
  let profile = null;
  try { profile = userAccess.sessionProfile(req); } catch (_) {}
  if (!profile) {
    return res.set('Cache-Control','no-store').redirect(302, '/select-user');
  }
  // Shared Sync readiness is deliberately not part of the workspace gate.
  // Once credentials/session are valid, synchronization continues in background.
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderIndexTemplate());
});

// express.static gövdeyi akışla yazdığı için yukarıdaki res.send sarmalayıcısı ona
// erişemez; statik dosyaların sıkıştırması bu ayrı katmanda yapılır.
app.use(createStaticGzip(path.join(__dirname, '..', 'public')));
// Sabit adlı vendor dosyaları yalnız sürüm parametresiyle immutable olabilir.
// Aksi durumda yeni sürümde değişen kütüphane bazı istemcilerde bir yıl eski kalır.
app.use((req, res, next) => {
  if (/^\/vendor\//.test(req.path || '')) {
    const versioned = /^\d+\.\d+(?:\.\d+)?$/.test(String(req.query?.v || ''));
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (res.getHeader('Cache-Control')) return;
    res.setHeader('Cache-Control', path.extname(filePath).toLowerCase() === '.html' ? 'no-store' : 'no-cache');
  },
}));

// Her kullanıcının kaynak klasörü ve parse edilmiş ASAS / ANTREPO / Fabric / LFL
// önbelleği birbirinden ayrıdır. Bir Buyer klasör değiştirdiğinde başka bir kullanıcının
// açık oturumu ve verileri etkilenmez.
function emptySourceCache() {
  return {
    loadedAt: null, sources: null, asasOrders: null, asasOrdersByTarget: null,
    antrepoMap: {}, antrepoMapByTarget: null, antrepoHeaderInfo: null,
    lflRows: null, lflMeta: null, lflLoadedAt: null, fabricHeaderInfo: null,
    refreshWarnings: [], refreshWarningDetails: [],
    cpupdateOverrides: { submap: {}, suppfobmap: {}, suppfobmetamap: {} },
  };
}

const ANTREPO_WARNING_DETAIL_COLUMNS = [
  { key: 'sourceRow', label: 'Excel Satırı' },
  { key: 'orderCode', label: 'Sipariş Kod' },
  { key: 'model', label: 'Ürün Adı / Model Adı' },
  { key: 'colourCode', label: 'Renk Kod' },
  { key: 'colour', label: 'Renk' },
  { key: 'status', label: 'Supplier Portal Statü' },
  { key: 'importFile', label: 'İthalat Dosya No' },
  { key: 'containerNo', label: 'Konteyner No' },
  { key: 'vehicle', label: 'Vasıta Tipi' },
  { key: 'estimatedArrival', label: 'Tahmini Antrepo Giriş Tarihi' },
  { key: 'loadedQty', label: 'Yükleme Toplam Adet' },
  { key: 'iasOrderQty', label: 'Net Alım Sipariş Miktarı' },
];
function antrepoQuantityWarningInfo(file, meta) {
  const counts = meta && typeof meta === 'object' ? meta : {};
  const detailRows = counts.warningDetailRows && typeof counts.warningDetailRows === 'object'
    ? counts.warningDetailRows : {};
  const warnings = [], details = [];
  const add = (kind, count, message, title) => {
    if (!(Number(count) > 0)) return;
    warnings.push(message);
    const rows = Array.isArray(detailRows[kind]) ? detailRows[kind] : [];
    if (!rows.length) return;
    details.push({
      id: `antrepo-${kind}`,
      message,
      title,
      source: file || 'Antrepo',
      columns: ANTREPO_WARNING_DETAIL_COLUMNS,
      rows,
      totalRows: Number(count) || rows.length,
      truncated: Number(count) > rows.length,
    });
  };
  add(
    'blankLoadedQty',
    counts.blankLoadedQty,
    `${file}: ${Number(counts.blankLoadedQty).toLocaleString('tr-TR')} IAS satırında Yükleme Toplam Adet boş veya geçersiz.`,
    'Geçersiz Yükleme Toplam Adet Kayıtları',
  );
  if (counts.iasOrderQtyColumnPresent) {
    add(
      'blankIasOrderQty',
      counts.blankIasOrderQty,
      `${file}: ${Number(counts.blankIasOrderQty).toLocaleString('tr-TR')} IAS satırında Net Alım Sipariş Miktarı boş veya geçersiz.`,
      'Geçersiz Net Alım Sipariş Miktarı Kayıtları',
    );
  }
  return { warnings, details };
}
const sourceCaches = new Map();
const initialDataLoadPromises = new Map();
// sourceCaches hiçbir zaman kullanıcı bazında temizlenmiyordu; silinen/yeniden
// adlandırılan bir kullanıcının önbellek girdisi kalıcı olarak bellekte kalırdı.
// Bu küçük, tek amaçlı temizleyici uzun süre erişilmeyen girdileri düşürür.
const sourceCacheLastAccess = new Map();
const SOURCE_CACHE_IDLE_EVICT_MS = 24 * 60 * 60 * 1000;
function evictIdleSourceCaches() {
  const cutoff = Date.now() - SOURCE_CACHE_IDLE_EVICT_MS;
  for (const [id, last] of sourceCacheLastAccess) {
    if (last < cutoff) {
      sourceCaches.delete(id);
      sourceCacheLastAccess.delete(id);
      initialDataLoadPromises.delete(id);
    }
  }
}
setInterval(evictIdleSourceCaches, 60 * 60 * 1000).unref();
function sourceUserId(value) {
  if (typeof value === 'string') return value || 'moderator';
  if (value && value.currentUser) return String(value.currentUser.id || 'moderator');
  if (value && value.id) return String(value.id || 'moderator');
  return 'moderator';
}
function cacheForUser(value) {
  const id = sourceUserId(value);
  if (!sourceCaches.has(id)) sourceCaches.set(id, emptySourceCache());
  sourceCacheLastAccess.set(id, Date.now());
  return sourceCaches.get(id);
}
function replaceUserCache(value, next) {
  const id = sourceUserId(value); sourceCaches.set(id, next); return next;
}
/* Yalnız test/sonda içindir: sunucu içi kullanıcı önbelleğine ASAS satırı
   yerleştirir. Üretimde çağıran yoktur; BL_TEST_SEED açık değilse tanımlanmaz. */
if (process.env.BL_TEST_SEED === '1') {
  global.__blSeedAsas = (orders, userId = 'moderator') => {
    const cache = cacheForUser(userId);
    cache.asasOrders = Array.isArray(orders) ? orders : [];
    cache.loadedAt = new Date().toISOString();
    return cache.asasOrders.length;
  };
}
function resetUserCache(value) {
  const id = sourceUserId(value); initialDataLoadPromises.delete(id); return replaceUserCache(id, emptySourceCache());
}
function sourceFolderForUser(value) {
  const id = sourceUserId(value);
  return getUserSourceFolder(id, id === 'moderator' ? config.sourceFolder || null : null);
}
function sourceFilterReadiness(targets = null,value='moderator') {
  const overrides = loadOverrides();
  const items=userPreferences.applyHorizonOverrides(loadModelConnections().items,sourceUserId(value),targets,userAccess.roleWorkspaceEntries(value));
  return inspectSourceFilterReadiness(items, targets, {
    asasSourceMode: overrides.asasSourceMode === 'database' ? 'database' : 'excel',
  });
}
function sourceFilterRequiredError(targets = null,value='moderator') {
  const status = sourceFilterReadiness(targets,value);
  if (status.ready) return null;
  const error = new Error(sourceFilterReadinessMessage(status, 'tr'));
  error.code = 'SOURCE_FILTER_REQUIRED';
  error.statusCode = 400;
  error.filterStatus = status;
  return error;
}
function assertSourceFilters(targets = null,value='moderator') {
  const error = sourceFilterRequiredError(targets,value);
  if (error) throw error;
  return sourceFilterReadiness(targets,value);
}
function effectiveOverridesForUser(value, sharedOverrides = null, sourceModeOverride = '') {
  const runtime = cacheForUser(value), shared = sharedOverrides || loadOverrides();
  const source = runtime.cpupdateOverrides && typeof runtime.cpupdateOverrides === 'object'
    ? runtime.cpupdateOverrides : { submap: {}, suppfobmap: {}, suppfobmetamap: {} };
  const sourceMode = String(sourceModeOverride || shared.antrepoSourceMode || '').trim().toLowerCase();
  const antrepoMatchConfig = sourceMode === 'dashboard'
    ? dashboardAntrepoMatchRule()
    : shared.antrepoMatchConfig;
  // Source CP-update values belong to the selected user's workspace. Shared/manual
  // edits remain authoritative when both stores contain the same order code.
  return {
    ...shared,
    antrepoMatchConfig,
    submap: { ...(source.submap || {}), ...(shared.submap || {}) },
    suppfobmap: { ...(source.suppfobmap || {}), ...(shared.suppfobmap || {}) },
    suppfobmetamap: { ...(source.suppfobmetamap || {}), ...(shared.suppfobmetamap || {}) },
  };
}
function hydrateSnapshotPayload(value, snapshot, options = {}) {
  const id = sourceUserId(value);
  if (!snapshot) return null;
  const current = cacheForUser(id);
  const shared = options.shared === true;
  const hydratedLflRows = Array.isArray(snapshot.lflRows) ? snapshot.lflRows : [];
  const hydratedLflMeta = withFabricDimensions(snapshot.lflMeta || { rowCount: 0, warnings: [], dimensions: {} }, hydratedLflRows);
  const hydratedOrdersByTarget = snapshot.asasOrdersByTarget && typeof snapshot.asasOrdersByTarget === 'object'
    ? Object.fromEntries(Object.entries(snapshot.asasOrdersByTarget).map(([target, rows]) => [target, Array.isArray(rows) ? rows : []]))
    : null;
  const snapshotSources = { ...(snapshot.sources || {}) };
  delete snapshotSources.fabric;
  const next = replaceUserCache(id, {
    loadedAt: snapshot.loadedAt || snapshot.savedAt || new Date().toISOString(),
    sources: snapshotSources,
    asasOrders: Array.isArray(snapshot.asasOrders) ? snapshot.asasOrders : [],
    asasOrdersByTarget: hydratedOrdersByTarget,
    antrepoMap: snapshot.antrepoMap || {},
    antrepoMapByTarget: snapshot.antrepoMapByTarget || null,
    antrepoHeaderInfo: snapshot.antrepoHeaderInfo || null,
    fabricHeaderInfo: snapshot.fabricHeaderInfo || null,
    lflRows: hydratedLflRows,
    lflMeta: hydratedLflMeta,
    lflLoadedAt: snapshot.lflLoadedAt || snapshot.loadedAt || snapshot.savedAt || new Date().toISOString(),
    // Buyer açılışında Moderatör model snapshot'ı yalnız ham kaynak verisi için
    // kullanılabilir. Kullanıcıya özel CP-update override'ları başka profilden
    // kopyalanmaz.
    cpupdateInfo: shared ? null : (snapshot.cpupdateInfo || null),
    cpupdateOverrides: shared
      ? (current.cpupdateOverrides || { submap: {}, suppfobmap: {}, suppfobmetamap: {} })
      : (snapshot.cpupdateOverrides || { submap: {}, suppfobmap: {}, suppfobmetamap: {} }),
    refreshWarnings: Array.isArray(snapshot.refreshWarnings) ? snapshot.refreshWarnings : [],
    refreshWarningDetails: Array.isArray(snapshot.refreshWarningDetails) ? snapshot.refreshWarningDetails : [],
    excelRefresh: null,
    modelRefresh: snapshot.modelRefresh || null,
    lastRefreshResult: snapshot.lastRefreshResult || null,
  });
  userAccess.syncProfiles(next.asasOrders, { authoritative: id === 'moderator' });
  return next;
}

function hydrateModelSnapshot(value) {
  const id = sourceUserId(value);
  return hydrateSnapshotPayload(id, loadModelSnapshot(id));
}
async function hydrateModelSnapshotAsync(value) {
  const id = sourceUserId(value);
  return hydrateSnapshotPayload(id, await loadModelSnapshotAsync(id));
}

function hydrateSharedModelSnapshot(value) {
  const id = sourceUserId(value);
  if (id === 'moderator') return null;
  return hydrateSnapshotPayload(id, loadModelSnapshot('moderator'), { shared: true });
}

async function saveRuntimeModelSnapshot(id, runtime) {
  if (!runtime || !runtime.loadedAt) return null;
  return saveModelSnapshotAsync(id, {
    loadedAt: runtime.loadedAt,
    sources: runtime.sources || null,
    asasOrders: runtime.asasOrders || [],
    asasOrdersByTarget: runtime.asasOrdersByTarget || null,
    antrepoMap: runtime.antrepoMap || {},
    antrepoMapByTarget: runtime.antrepoMapByTarget || null,
    antrepoHeaderInfo: runtime.antrepoHeaderInfo || null,
    fabricHeaderInfo: runtime.fabricHeaderInfo || null,
    lflRows: runtime.lflRows || [],
    lflMeta: runtime.lflMeta || null,
    lflLoadedAt: runtime.lflLoadedAt || null,
    cpupdateInfo: runtime.cpupdateInfo || null,
    cpupdateOverrides: runtime.cpupdateOverrides || null,
    refreshWarnings: runtime.refreshWarnings || [],
    refreshWarningDetails: runtime.refreshWarningDetails || [],
    modelRefresh: runtime.modelRefresh || null,
    lastRefreshResult: runtime.lastRefreshResult || null,
  });
}

async function alignSnapshotWithExcelAntrepo(id, runtime) {
  const ov = loadOverrides();
  if (!runtime || ['database', 'dashboard'].includes(ov.antrepoSourceMode)) return runtime;

  const currentFile = currentAntrepoExcelFile(id);
  const expectedSource = currentFile ? `Excel: ${currentFile.name}` : null;
  const hasTargetMaps = runtime.antrepoMapByTarget
    && runtime.antrepoMapByTarget.cp
    && runtime.antrepoMapByTarget.backlog;
  if (currentFile && runtime.sources && runtime.sources.antrepo === expectedSource
      && runtime.antrepoHeaderInfo && hasTargetMaps) {
    return runtime;
  }

  try {
    const excel = await loadAntrepoFromExcel(id, ov.antrepoMatchConfig);
    runtime.antrepoMap = excel.map;
    runtime.antrepoMapByTarget = { ...(runtime.antrepoMapByTarget || {}), cp: excel.map, orders: excel.map, backlog: excel.map };
    runtime.antrepoHeaderInfo = excel.meta;
    runtime.sources = { ...(runtime.sources || {}), antrepo: `Excel: ${excel.file}` };
    const quantityInfo = antrepoQuantityWarningInfo(excel.file, excel.meta || {});
    runtime.refreshWarnings = [
      ...(runtime.refreshWarnings || []).filter(message => !/IAS satırında (?:Yükleme Toplam Adet|Net Alım Sipariş Miktarı) boş veya geçersiz/i.test(String(message || ''))),
      ...(excel.integrityWarnings || []),
      ...quantityInfo.warnings,
    ];
    runtime.refreshWarningDetails = [
      ...(runtime.refreshWarningDetails || []).filter(detail => !String(detail && detail.id || '').startsWith('antrepo-')),
      ...quantityInfo.details,
    ];
    await saveRuntimeModelSnapshot(id, runtime);
  } catch (err) {
    // Excel modu seçiliyken eski Database snapshot'ını kullanmak yanlış ve yanıltıcıdır.
    // Dosya yoksa/okunamıyorsa IAS verisini bilinçli olarak boşaltıp kullanıcıya açık
    // uyarı veririz; böylece eski, farklı bir kaynaktan gelen kayıtlar siparişlere bağlanmaz.
    runtime.antrepoMap = {};
    runtime.antrepoMapByTarget = { ...(runtime.antrepoMapByTarget || {}), cp: {}, orders: {}, backlog: {} };
    runtime.antrepoHeaderInfo = null;
    runtime.sources = { ...(runtime.sources || {}), antrepo: expectedSource };
    const message = `Antrepo Excel: ${err.publicMessage || err.message || 'dosya okunamadı.'}`;
    runtime.refreshWarnings = [
      ...(runtime.refreshWarnings || []).filter(item => !/^Antrepo Excel:/i.test(String(item || ''))),
      message,
    ];
    runtime.refreshWarningDetails = (runtime.refreshWarningDetails || []).filter(detail => !String(detail && detail.id || '').startsWith('antrepo-'));
  }
  return runtime;
}

async function loadInitialDataAndLfl(value){
  const id = sourceUserId(value);
  // Model snapshot'ı kişiselleştirilmiş sorgu sonucudur: Horizon ve veri kapsamı
  // içerebilir. Bu nedenle başka kullanıcının (eski fallback'te Moderatörün)
  // snapshot'ı başlangıç verisi olarak kullanılamaz. Ortak ham metadata cache'i
  // ayrı kalır; sonuç dataset'i daima gerçek user ID ile izole edilir.
  const snapshot = await hydrateModelSnapshotAsync(id);
  if(snapshot)return snapshot;
  // Uygulama açılışı hiçbir zaman ASAS veri modelini otomatik sorgulamaz. Snapshot
  // yoksa boş ama kullanılabilir ekran hemen açılır; Antrepo Excel ise ilk ASAS
  // yenilemesinde aynı üçlü anahtarla bağlanır.
  return replaceUserCache(id, {
    ...emptySourceCache(),
    loadedAt: null,
    sources: { asas: null, antrepo: null, lfl: null },
    asasOrders: [],
    lflRows: [],
    lflMeta: { rowCount: 0, warnings: [], dimensions: {} },
    refreshWarnings: [],
    refreshWarningDetails: [],
  });
}
async function ensureDataLoaded(value){
  const id = sourceUserId(value), runtime = cacheForUser(id);
  if(runtime.loadedAt && Array.isArray(runtime.asasOrders) && runtime.lflLoadedAt) return runtime;
  if(!initialDataLoadPromises.has(id)) {
    initialDataLoadPromises.set(id, loadInitialDataAndLfl(id).finally(()=>{ initialDataLoadPromises.delete(id); }));
  }
  return initialDataLoadPromises.get(id);
}

// KUR.xlsx seçili kaynak klasöründen içe alınır; normalleştirilmiş sonuç ortak
// FX store'a yazılır. Diğer cihazların fiziksel Excel dosyasına erişmesi gerekmez.
async function syncFxFromKurWorkbook(value, force = false) {
  const id = sourceUserId(value), appRoot = path.join(__dirname, '..');
  const sourceFolder = sourceFolderForUser(id);
  const current = loadFx();
  try {
    const parsed = await runExcelTask('loadFxWorkbookFromDirectories', {
      directories: [sourceFolder, ...(id === 'moderator' ? [appRoot] : [])].filter(Boolean),
      current, force,
    }, { timeoutMs: 5000 });
    if (!parsed.found || !parsed.updated) return parsed;
    const saved = saveFx({
      ...parsed.data,
      sourceFile: parsed.file,
      sourceType: 'KUR',
      sourceModifiedAt: parsed.modifiedAt,
      updatedAt: new Date().toISOString(),
    }, null);
    publishSharedMasterChange('fx', typeof value === 'object' ? value : null);
    console.log(`[${id}] KUR Excel arka planda okundu: ${parsed.file} (${parsed.stats.monthCount} ay, ${parsed.stats.currencyCount} döviz)`);
    return { found: true, updated: true, file: parsed.file, stats: parsed.stats, data: saved };
  } catch (err) {
    logRuntimeFailure('fxWorkbookRead', err);
    return { found: false, updated: false, error: 'KUR Excel dosyası arka planda okunamadı.' };
  }
}

async function loadLflFromDisk(value, withExcelRefresh = false) {
  const id = sourceUserId(value), runtime = cacheForUser(id), sourceFolder = sourceFolderForUser(id);
  if (!sourceFolder) throw new Error('Henüz bir kaynak klasör seçilmedi.');
  const found = findLatestSourceFiles(sourceFolder);
  if (!found.lfl) {
    runtime.lflRows = [];
    runtime.lflMeta = { rowCount: 0, warnings: ['Kaynak klasörde adı LFL ile başlayan bir .xlsx dosyası bulunamadı.'], dimensions: {} };
    runtime.lflLoadedAt = new Date().toISOString();
    runtime.sources = { ...(runtime.sources || {}), lfl: null };
    return { rows: runtime.lflRows, meta: runtime.lflMeta, source: null, loadedAt: runtime.lflLoadedAt };
  }
  let refreshWarning = '';
  if (withExcelRefresh && config.refreshWithExcel && platform.canRefreshExcel()) {
    try { await refreshExcelFile(found.lfl.full, config.excelRefreshTimeoutMs); }
    catch (err) { refreshWarning = `LFL Excel yenilemesi tamamlanamadı; dosyanın mevcut hali okundu: ${err.message}`; }
  }
  const parsed = await runExcelTask('parseLflFile', { fullPath: found.lfl.full }, { timeoutMs: Math.max(240000, Number(config.excelRefreshTimeoutMs) || 0) });
  if (refreshWarning) parsed.meta.warnings = [refreshWarning, ...(parsed.meta.warnings || [])];
  runtime.lflRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  runtime.lflMeta = withFabricDimensions(parsed.meta, runtime.lflRows);
  runtime.lflLoadedAt = new Date().toISOString();
  runtime.sources = { ...(runtime.sources || {}), lfl: found.lfl.name };
  return { rows: runtime.lflRows, meta: runtime.lflMeta, source: found.lfl.name, loadedAt: runtime.lflLoadedAt };
}

// Date nesneleri JSON.stringify sırasında UTC'ye çevrildiğinde Türkiye gibi UTC+ saat
// dilimlerinde 19.10.2026 yerel gece yarısı 18.10.2026T21:00:00Z olarak gider. Arayüz
// bu değerin başındaki günü okuyunca tarih bir gün geri görünür. API'de tarih-saat değil,
// yalnızca takvim tarihi taşıdığımız alanları YYYY-MM-DD olarak seri hale getiriyoruz.
function dateOnlyISO(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  const localMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const y = utcMidnight && !localMidnight ? d.getUTCFullYear() : d.getFullYear();
  const m = (utcMidnight && !localMidnight ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utcMidnight && !localMidnight ? d.getUTCDate() : d.getDate();
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(day)}`;
}
// Yanit govdesi eskiden IKI kez dolasiliyordu: once jsonDateSafe tum agaci klonluyor
// (10.000 satir x ~45 alan icin satir basina yeni nesne), sonra res.json ayni agaci
// JSON.stringify ile bir kez daha geziyordu. Asagidaki yol tek gecistir: stringify'in
// replacer'i Date alanlarini yerinde donusturur, ara klon hic olusmaz.
// Not: replacer'a gelen deger Date.prototype.toJSON'dan gecmis olur; ham Date'e
// tasiyici nesne uzerinden (this[key]) erisilir.
function dateSafeReplacer(key, value) {
  const raw = this[key];
  return raw instanceof Date ? dateOnlyISO(raw) : value;
}
function sendDateSafeJson(res, value) {
  const body = JSON.stringify(value, dateSafeReplacer);
  res.type('application/json');
  return res.send(body === undefined ? 'null' : body);
}

function assertAntrepoMatchDidNotCollapse(orders, antrepoMap, matchRule, label='Antrepo') {
  const rows = Array.isArray(orders) ? orders : [];
  const meta = parseLib.antrepoParseMeta(antrepoMap) || {};
  if (!rows.length || !(Number(meta.matchableRows) > 0)) return null;
  const audit = parseLib.auditAntrepoMatching(rows, antrepoMap, matchRule);
  if (Number(audit?.totals?.matched) > 0) return audit;
  const first = audit && audit.conditions && audit.conditions[0];
  const firstStats = first && audit.fields ? audit.fields[first.id] : null;
  // Aynı Sipariş Kodları iki tarafta mevcut olmasına rağmen tam üçlü eşleşme sıfıra
  // düştüyse yeni veriyi sessizce CP/Orders'a uygulamak tüm siparişleri yanlışlıkla
  // üretimde/boş gösterebilir. Fail-closed: mevcut başarılı snapshot korunur.
  if (firstStats && Number(firstStats.shared) > 0) {
    const mismatch = (audit.samples || []).slice(0, 3).map(sample => `${sample.anchor}: ${sample.mismatch.join(', ')}`).join(' | ');
    const error = new Error(`${label} yenilemesinde ASAS–ANTREPO tam eşleşmesi 0'a düştü. Aynı Sipariş Kodları mevcut ancak Model Adı/Ürün Adı + Renk Kod koşulları eşleşmiyor.${mismatch ? ` Örnek: ${mismatch}` : ''}`);
    error.statusCode = 422;
    error.code = 'ANTREPO_MATCH_COLLAPSED';
    error.details = audit;
    throw error;
  }
  return audit;
}
function jsonDateSafe(value) {
  if (value instanceof Date) return dateOnlyISO(value);
  if (Array.isArray(value)) return value.map(jsonDateSafe);
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => { out[k] = jsonDateSafe(v); });
    return out;
  }
  return value;
}

// Ana yükleme mantığı: klasörden en güncel ASAS/Antrepo/Sub-Mfr dosyalarını bulur,
// istenirse önce GERÇEK Excel ile açıp pivot tabloları/veri bağlantılarını yeniler
// (withExcelRefresh=true -> "Yenile" butonu bunu tetikler), sonra hepsini parse eder.
// Sub-Mfr dosyasındaki submap/suppfobmap bilgisi kalıcı overrides'a yazılır.
async function loadFromDisk(value, withExcelRefresh) {
  const id = sourceUserId(value), runtime = cacheForUser(id), sourceFolder = sourceFolderForUser(id);
  if (!sourceFolder) {
    const error = new Error('Henüz bir kaynak klasör seçilmedi. Üstteki "📁 Kaynak Klasörü Seç" butonuna bas.');
    error.statusCode = 400; error.code = 'SOURCE_FOLDER_MISSING'; throw error;
  }
  const found = findLatestSourceFiles(sourceFolder);
  if (!found.asas) {
    const error = new Error(`Klasörde "asas*.xlsx" adlandırmasına uyan bir dosya bulunamadı: ${sourceFolder}`);
    error.statusCode = 404; error.code = 'ASAS_SOURCE_NOT_FOUND'; throw error;
  }

  // Excel COM / Power Query yenilemesi kaynak dosyayı güncelleyen yardımcı aşamadır.
  // Bir kullanıcının işlemi yalnız kendi seçili klasöründeki dosyalara uygulanır.
  const excelRefresh = await refreshSourceWorkbooks(found, {
    enabled: Boolean(withExcelRefresh && config.refreshWithExcel && platform.canRefreshExcel()),
    configuredTimeoutMs: config.excelRefreshTimeoutMs,
  });
  if (withExcelRefresh && found.antrepo) {
    const antrepoRefresh = (excelRefresh.files || []).find(item => item && item.source === 'ANTREPO');
    if (!excelRefresh.enabled || !antrepoRefresh || antrepoRefresh.ok !== true) {
      const reason = antrepoRefresh && antrepoRefresh.error ? ` ${antrepoRefresh.error}` : '';
      const error = new Error(`Antrepo Excel pivot tabloları yenilenemedi. Güncel pivot verisi doğrulanmadan dosya okunmadı.${reason}`);
      error.statusCode = 500; error.code = 'ANTREPO_EXCEL_REFRESH_REQUIRED'; throw error;
    }
  }

  let parsedSources;
  try {
    parsedSources = await runExcelTask('loadSources', {
      asasPath: found.asas.full,
      antrepoPath: found.antrepo ? found.antrepo.full : null,
      cpupdatePath: found.cpupdate ? found.cpupdate.full : null,
      matchRule: effectiveOverridesForUser(id).antrepoMatchConfig,
    }, { timeoutMs: computeParseTimeoutMs(found, config.excelRefreshTimeoutMs) });
  } catch (err) {
    err.code = err.code || 'SOURCE_PARSE_FAILED';
    err.publicMessage = 'ASAS veya Antrepo Excel dosyası okunamadı. Dosyanın bozuk olmadığını, başka bir program tarafından kilitlenmediğini ve beklenen sütunları içerdiğini kontrol edin.';
    throw err;
  }
  const parsedAsas = parsedSources.parsedAsas;
  if (!parsedAsas) throw new Error('ASAS dosyasında "Sipariş Kod" sütunu bulunamadı.');
  const antrepoMap = parsedSources.antrepoMap || {};
  const antrepoHeaderInfo = parseLib.antrepoParseMeta(antrepoMap);
  if (found.antrepo) assertAntrepoMatchDidNotCollapse(parsedAsas.orders, antrepoMap, effectiveOverridesForUser(id).antrepoMatchConfig, 'Antrepo Excel');

  // Excel fallback akışında da LFL, ayrı kumaş/LFL kaynağından değil aynı ana
  // ASAS çalışma kitabından üretilir. ASAS LFL alanlarını içermiyorsa son başarılı
  // LFL snapshot'ı korunur ve kullanıcıya açık uyarı verilir.
  const parsedLfl = parsedSources.parsedLfl && Array.isArray(parsedSources.parsedLfl.rows)
    ? parsedSources.parsedLfl
    : null;
  const preservedLfl = {
    rows: parsedLfl ? parsedLfl.rows : runtime.lflRows,
    meta: parsedLfl ? withFabricDimensions(parsedLfl.meta, parsedLfl.rows) : runtime.lflMeta,
    loadedAt: parsedLfl ? new Date().toISOString() : runtime.lflLoadedAt,
    source: parsedLfl ? found.asas.name : (runtime.sources && runtime.sources.lfl || null),
  };

  let cpupdateInfo = null;
  let cpupdateOverrides = { submap: {}, suppfobmap: {}, suppfobmetamap: {} };
  if (found.cpupdate && parsedSources.cpupdate) {
    const result = parsedSources.cpupdate;
    cpupdateOverrides = {
      submap: { ...(result.submap || {}) },
      suppfobmap: { ...(result.suppfobmap || {}) },
      suppfobmetamap: Object.fromEntries(Object.keys(result.suppfobmap || {}).map(key => [key, { source: 'manual', origin: 'cpupdate' }])),
    };
    cpupdateInfo = { file: found.cpupdate.name, subCount: result.sub, fobCount: result.fob };
  }

  const excelQuantityInfo = found.antrepo
    ? antrepoQuantityWarningInfo(found.antrepo.name, antrepoHeaderInfo || {})
    : { warnings: [], details: [] };
  const next = replaceUserCache(id, {
    loadedAt: new Date().toISOString(),
    sources: {
      asas: found.asas.name,
      antrepo: found.antrepo ? found.antrepo.name : null,
      cpupdate: found.cpupdate ? found.cpupdate.name : null,
      lfl: preservedLfl.source,
    },
    asasOrders: parsedAsas.orders,
    asasOrdersByTarget: { cp: parsedAsas.orders, orders: parsedAsas.orders, backlog: parsedAsas.orders, priceanalysis: parsedAsas.orders },
    antrepoMap,
    antrepoMapByTarget: { cp: antrepoMap, orders: antrepoMap, backlog: antrepoMap },
    antrepoHeaderInfo,
    lflRows: preservedLfl.rows,
    lflMeta: preservedLfl.meta,
    lflLoadedAt: preservedLfl.loadedAt,
    cpupdateInfo,
    cpupdateOverrides,
    fabricHeaderInfo: parsedAsas.fabricHeaderInfo || null,
    refreshWarnings: [
      ...(excelRefresh.warnings || []),
      ...excelQuantityInfo.warnings,
      ...(!parsedLfl && parsedSources.lflError
        ? [`LFL aynı ASAS kaynağından üretilemedi; son başarılı LFL verisi korundu: ${parsedSources.lflError}`]
        : []),
    ],
    refreshWarningDetails: [
      ...excelQuantityInfo.details,
      ...(parsedAsas.fabricHeaderInfo && Array.isArray(parsedAsas.fabricHeaderInfo.warningDetails)
        ? parsedAsas.fabricHeaderInfo.warningDetails : []),
    ],
    excelRefresh,
  });
  // Yalnız Moderatörün ASAS kaynağı kullanıcı profilleri, otomatik kapsamlar ve
  // sipariş sahipliği için yetkili kaynaktır. Buyer klasörleri bu güvenlik verisini değiştiremez.
  userAccess.syncProfiles(next.asasOrders, { authoritative: id === 'moderator' });
  return next;
}

// Antrepo Excel yalnız gerçek Excel içinde pivot/veri bağlantıları yenilendikten
// sonra okunabilir. Stale pivot verisini sessizce kullanmak backlog/CP sonuçlarını
// yanlışlaştırdığı için refresh hatasında fail-closed davranırız.
async function refreshAntrepoExcelBeforeRead(file) {
  if (!file || !file.full) {
    const error = new Error('Antrepo Excel dosyası bulunamadı.');
    error.statusCode = 404; error.code = 'ANTREPO_SOURCE_NOT_FOUND'; throw error;
  }
  if (!platform.canRefreshExcel()) {
    const error = new Error('Antrepo Excel pivot tabloları yenilenmeden veri okunamaz. Bu işlem Windows ve Microsoft Excel gerektirir.');
    error.statusCode = 501; error.code = 'ANTREPO_EXCEL_REFRESH_UNSUPPORTED'; throw error;
  }
  const timeoutMs = computeRefreshTimeoutMs(file.full, config.excelRefreshTimeoutMs);
  try {
    const output = await refreshExcelFile(file.full, timeoutMs);
    return { ok: true, source: 'ANTREPO', name: file.name, timeoutMs, output: String(output || '') };
  } catch (err) {
    const error = new Error(`Antrepo Excel pivot tabloları yenilenemedi (${file.name}). Güncel pivot verisi doğrulanmadan dosya okunmadı. ${err && err.message ? err.message : ''}`.trim());
    error.statusCode = Number(err && err.statusCode) || 500;
    error.code = (err && err.code) || 'ANTREPO_EXCEL_REFRESH_FAILED';
    error.cause = err;
    throw error;
  }
}

// Excel worker parse görevleri için zaman aşımı: küçük dosyalarda en az 5 dk,
// büyük dosyalarda dosya boyutuna göre uzar, en çok 20 dk'da sınırlanır.
const EXCEL_PARSE_TIMEOUT_MIN_MS = 300000;
const EXCEL_PARSE_TIMEOUT_MAX_MS = 20 * 60 * 1000;
const EXCEL_PARSE_TIMEOUT_MS_PER_MB = 3500;
function excelParseTimeoutMs(fileSizeBytes) {
  const perSize = EXCEL_PARSE_TIMEOUT_MIN_MS + Math.ceil(fileSizeBytes / (1024 * 1024)) * EXCEL_PARSE_TIMEOUT_MS_PER_MB;
  return Math.max(EXCEL_PARSE_TIMEOUT_MIN_MS, Math.min(EXCEL_PARSE_TIMEOUT_MAX_MS, perSize));
}

// Antrepo ana kaynağı varsayılan olarak kullanıcının kaynak klasöründeki en
// güncel Antrepo Excel dosyasıdır. Database seçeneği yalnız kullanıcı özellikle
// etkinleştirdiğinde Data Model Connection içindeki IAS bağlantısını çalıştırır.
async function loadAntrepoFromExcel(value, matchRule = null, options = {}) {
  const id = sourceUserId(value), sourceFolder = sourceFolderForUser(id);
  if (!sourceFolder) {
    const error = new Error('Antrepo kaynağı Excel olarak seçili ancak henüz bir kaynak klasör seçilmedi. Kaynak Veri alanından klasör seçin veya Antrepo Excel yükleyin.');
    error.statusCode = 400; error.code = 'ANTREPO_SOURCE_FOLDER_MISSING'; throw error;
  }
  const found = findLatestSourceFiles(sourceFolder);
  if (!found.antrepo) {
    const error = new Error(`Antrepo kaynağı Excel olarak seçili ancak klasörde "antrepo*.xlsx" dosyası bulunamadı: ${sourceFolder}`);
    error.statusCode = 404; error.code = 'ANTREPO_SOURCE_NOT_FOUND'; throw error;
  }
  // Pivot yenileme (gerçek Excel/COM) başarısız olursa Refresh'i tamamen
  // engellemek yerine dosyanın son kaydedilmiş haliyle devam ederiz; kullanıcı
  // "sunucudan güncellenmedi" uyarısıyla açıkça bilgilendirilir.
  let refreshResult = null;
  let refreshFailureWarning = null;
  if (options && options.refreshBeforeRead === true) {
    if (typeof options.onRefreshStart === 'function') options.onRefreshStart();
    try {
      refreshResult = await runRefreshTelemetry(options.telemetry, 'ANTREPO Excel', 'pivot-refresh', 'wait', () => refreshAntrepoExcelBeforeRead(found.antrepo));
    } catch (err) {
      refreshResult = { ok: false, source: 'ANTREPO', name: found.antrepo.name, error: (err && (err.publicMessage || err.message)) || String(err) };
      refreshFailureWarning = `Antrepo Excel pivot tabloları yenilenemedi; veri sunucudan güncellenmedi, "${found.antrepo.name}" dosyasının son kaydedilmiş hali kullanıldı. ${refreshResult.error}`;
    }
  }
  const stat = fs.statSync(found.antrepo.full);
  let parsed;
  if (typeof options.onParseStart === 'function') options.onParseStart();
  try {
    parsed = await runRefreshTelemetry(options.telemetry, 'ANTREPO Excel', 'file-parse', 'wait', () => runExcelTask('parseAntrepoFile', {
      fullPath: found.antrepo.full,
      matchRule: matchRule || loadOverrides().antrepoMatchConfig,
    }, { timeoutMs: excelParseTimeoutMs(stat.size) }));
  } catch (err) {
    err.code = err.code || 'ANTREPO_EXCEL_PARSE_FAILED';
    err.publicMessage = `Antrepo Excel dosyası okunamadı: ${found.antrepo.name}. Dosyanın açık/kilitli olmadığını ve Sipariş Kod, Ürün Ad, Renk Kod sütunlarını içerdiğini kontrol edin.`;
    throw err;
  }
  const map = parsed && parsed.map && typeof parsed.map === 'object' ? parsed.map : {};
  const meta = parsed && parsed.meta ? parsed.meta : parseLib.antrepoParseMeta(map);
  // Worker structured-clone işlemi non-enumerable parser meta alanını taşımaz.
  // Doğrulama aynı satır sayılarını kullanabilsin diye meta bilgisini haritaya
  // yeniden iliştiririz; bu alan API/Excel verisine enumerable olarak sızmaz.
  if (meta && map && typeof map === 'object') {
    Object.defineProperty(map, '__antrepoMeta', { value: meta, enumerable: false, configurable: true });
  }
  if (meta && meta.ok === false) {
    const error = new Error(meta.reason || 'Antrepo Excel eşleştirme alanları çözülemedi.');
    error.statusCode = 422; error.code = 'ANTREPO_EXCEL_MAPPING_INVALID'; error.details = meta; throw error;
  }
  const integrityWarnings = [
    ...validateAntrepoIntegrity('EXCEL', map, [], matchRule || loadOverrides().antrepoMatchConfig),
    ...(refreshFailureWarning ? [refreshFailureWarning] : []),
  ];
  return { map, meta: meta || null, file: found.antrepo.name, fullPath: found.antrepo.full, integrityWarnings, excelRefresh: refreshResult };
}

/* Eşleşme ölçümünü sunucu günlüğüne yazar. Sayıların yanına HER İKİ TARAFTAN
   birer örnek anahtar da konur: sıfır eşleşmede sorunun "ASAS anahtarı hiç
   üretilemiyor" mu yoksa "iki tarafın anahtar biçimi farklı" mı olduğunu
   ayırt etmenin tek hızlı yolu bu. Anahtarlar sipariş kodu/model/renk
   içerdiği için yalnız iki tanesi ve kırpılmış olarak yazılır. */
function powerBiMatchDiagnostic(stats, samples = {}) {
  const trim = list => (Array.isArray(list) ? list : []).slice(0, 2).map(item => String(item).slice(0, 160));
  try {
    console.info('[POWERBI] POWERBI_MATCH_RATE', {
      ...stats,
      ...(samples.upstream ? { upstream: samples.upstream } : {}),
      iasSampleKeys: trim(samples.ias),
      asasSampleKeys: trim(samples.asas),
    });
  } catch (_) { /* günlük yazımı ana akışı düşürmemeli */ }
}

async function loadAntrepoFromDashboard(value, asasOrders, matchRule = null, options = {}) {
  const id = sourceUserId(value);
  if (typeof options.markPhase === 'function') options.markPhase('dashboard-import');
  const orderCodes = uniqueOrderCodes((Array.isArray(asasOrders) ? asasOrders : []).map(order => order && order.ocode));
  if (!orderCodes.length) return { map: {}, meta: { ok: true, dataRows: 0, columns: [], resolved: {}, missing: [] }, manifest: null, rows: [] };
  const checkpointStore = createDashboardCheckpointStore({ root: path.join(LOCAL_DATA_ROOT, 'dashboard-refresh'), userId: id });
  const savedCheckpoint = checkpointStore.load();
  const savedCodes = savedCheckpoint && Array.isArray(savedCheckpoint.allOrderCodes) ? uniqueOrderCodes(savedCheckpoint.allOrderCodes) : [];
  const dashboardOrderIdentity = code => String(code == null ? '' : code).trim().toLocaleUpperCase('tr-TR').replace(/[.,\s]/g, '');
  const canResume = savedCheckpoint && savedCheckpoint.source === 'dashboard'
    && savedCodes.length === orderCodes.length
    && savedCodes.every(code => orderCodes.some(current => dashboardOrderIdentity(current) === dashboardOrderIdentity(code)));
  const session = await browserIntegrationManager.ensureDashboardSession(id, { session:options.dashboardSession });
  try {
    const connector = new PowerBiImportDashboardConnector({
      batchSize: Number(config.powerBiDashboardBatchSize) || 250,
      maxRetries: Number(config.powerBiDashboardMaxRetries) || 2,
      backoffMs: Number(config.powerBiDashboardBackoffMs) || 500,
      transport: {
        getSchema: () => session.getSchema(),
        queryBatch: (codes, queryOptions) => session.queryBatch(codes, queryOptions),
      },
    });
    const progress = event => {
      if (typeof options.onProgress === 'function') options.onProgress(event);
      if (typeof options.telemetry === 'function' && event && event.lastBatch) {
        options.telemetry({ type: 'measure', category: 'query', connection: 'Power BI İthalat Dashboard', operation: 'dashboard-batch', timestampMs: Date.now(), durationMs: 0 });
      }
    };
    const result = await connector.refresh({
      orderCodes,
      manifest: canResume ? savedCheckpoint : null,
      refreshId: options.refreshId,
      signal: options.signal,
      onProgress: progress,
      checkpoint: valueToSave => checkpointStore.save(valueToSave),
    });
    if (result.stopped) return { map: {}, meta: { ok: false, stopped: true }, manifest: result.manifest, rows: [] };
    const dashboardRule = dashboardAntrepoMatchRule();
    const normalizedRows = normalizeDashboardRows(result.rows || []);
    const parsed = parseLib.parseAntrepoRows(normalizedRows.map(row => { const { _sourceFields, ...cleanRow } = row; return cleanRow; }), dashboardRule);
    // Dashboard'da bulunamayan veya batch'i kalıcı olarak başarısız olan
    // siparişlerin mevcut IAS bilgisi silinmez; yalnızca SUCCESS gelen
    // siparişler yeni Dashboard satırlarıyla değiştirilir.
    const previousMap = options.previousMap && typeof options.previousMap === 'object' ? options.previousMap : null;
    if (previousMap && result.manifest) {
      let preservedIndex = 0;
      for (const order of Array.isArray(asasOrders) ? asasOrders : []) {
        const rawCode = order && order.ocode != null ? order.ocode : '';
        const identity = String(rawCode).trim().toLocaleUpperCase('tr-TR').replace(/[.,\s]/g, '');
        if (!identity || result.manifest.orderStates[identity] === 'SUCCESS') continue;
        for (const hit of parseLib.findAntrepoHits(previousMap, order, { rule: dashboardRule })) {
          parsed[`__dashboard_preserved_${preservedIndex++}`] = hit;
        }
      }
    }
    const failedCount = Number(result.manifest && result.manifest.failedOrders) || 0;
    const notFoundCount = Number(result.manifest && result.manifest.notFoundOrders) || 0;
    if (failedCount || notFoundCount) {
      result.integrityWarnings = [
        ...(result.integrityWarnings || []),
        `Power BI İthalat Dashboard: ${notFoundCount} sipariş bulunamadı, ${failedCount} sipariş kalıcı olarak başarısız oldu; mevcut IAS verileri korundu.`,
      ];
    }
    const integrityWarnings = [...(result.integrityWarnings || []), ...validateAntrepoIntegrity('DASHBOARD', parsed, asasOrders, dashboardRule)];

    /* EŞLEŞME ORANI ÖLÇÜMÜ.
       Bütünlük kontrolü yalnız IAS tarafının YAPISINI doğrular (sütunlar var mı,
       satır tanesi korundu mu). "Sütunlar yerinde ama hiçbir ASAS siparişi
       eşleşmedi" durumu oradan SESSİZCE geçiyordu: tarama başarılı görünüyor,
       Backlog üretiliyor, ama CP'nin Lojistik alanları (STATUS / Ant. Arrival /
       Del. Type) boş kalıyordu. findAntrepoHits'in zaten var olan diag sayacı
       burada kullanılarak bu sessiz başarısızlık görünür hâle getirilir. */
    const matchDiag = {};
    const orderList = Array.isArray(asasOrders) ? asasOrders : [];
    let matchedOrders = 0;
    for (const order of orderList) {
      if (parseLib.findAntrepoHits(parsed, order, { rule: dashboardRule, diag: matchDiag }).length) matchedOrders += 1;
    }
    if (orderList.length) {
      const percent = Math.round((matchedOrders / orderList.length) * 100);
      powerBiMatchDiagnostic({
        orders: orderList.length, matched: matchedOrders, percent,
        keyMissing: matchDiag.targetIncomplete || 0, noCounterpart: matchDiag.unmatched || 0,
        ambiguous: matchDiag.ambiguous || 0, iasKeys: Object.keys(parsed).length,
      }, {
        ias: Object.values(parsed).map(hit => parseLib.dynamicAntrepoMatchKey(hit, 'ias', dashboardRule)).filter(Boolean),
        asas: orderList.map(order => parseLib.dynamicAntrepoMatchKey(order, 'asas', dashboardRule)).filter(Boolean),
        /* iasKeys=0 iken sorunun NEREDE olduğunu ayırt etmek için akışın
           yukarısındaki sayılar: dashboard hiç satır mı döndürmedi, yoksa
           satırlar geldi de başlık mı çözülemedi? İkisi de bugün sessizce
           geçebiliyor (validateAntrepoIntegrity, satır gelmediyse bilinçli
           olarak uyarı üretmiyor). */
        upstream: {
          manifestSuccess: Number(result.manifest && result.manifest.successfulOrders) || 0,
          manifestNotFound: Number(result.manifest && result.manifest.notFoundOrders) || 0,
          manifestFailed: Number(result.manifest && result.manifest.failedOrders) || 0,
          rawRows: (result.rows || []).length,
          normalizedRows: normalizedRows.length,
          parseOk: parsed.__antrepoMeta ? parsed.__antrepoMeta.ok : null,
          parseDataRows: parsed.__antrepoMeta ? parsed.__antrepoMeta.dataRows : null,
          parseMissing: parsed.__antrepoMeta ? parsed.__antrepoMeta.missing : null,
          firstRowKeys: Object.keys(normalizedRows[0] || {}).filter(name => name !== '_sourceFields').slice(0, 12),
        },
      });
      if (!matchedOrders) integrityWarnings.push(
        `Antrepo (DASHBOARD): ${orderList.length} ASAS siparişinin hiçbiri IAS satırlarıyla eşleşmedi `
        + `(anahtar üretilemeyen: ${matchDiag.targetIncomplete || 0}, karşılığı bulunamayan: ${matchDiag.unmatched || 0}). `
        + 'Lojistik alanları (STATUS, Ant. Arrival, Del. Type) boş kalacak.');
      /* DÜŞÜK EŞLEŞME ORANI UYARI DEĞİLDİR (iş kuralı):
         Dashboard'da görünmeyen siparişler doğaldır — onlar ÜRETİMDEDİR.
         Ayrıca bir siparişin birden çok parsiyeli olabilir; ör. 5000 adedin
         2000'i depoda, 2000'i yolda, kalan 1000 üretimde veya eksik yükleme.
         Bu yüzden "eşleşmeyen" (unmatched) ve "birden fazla eşleşen"
         (ambiguous) sayaçları beklenen durumlardır ve kullanıcıya uyarı
         olarak gösterilmez; yalnız tanılama günlüğünde tutulur.
         SIFIR eşleşme ise hâlâ gerçek bir arıza işaretidir (yukarıda). */
    }
    checkpointStore.clear();
    return { map: parsed, meta: parsed.__antrepoMeta || null, manifest: result.manifest, rows: normalizedRows, integrityWarnings, source: POWER_BI_IMPORT_DASHBOARD_URL };
  } finally {
    await (typeof session.release === 'function' ? session.release() : session.close());
  }
}

// ASAS Excel yalnız gerçek Excel içinde pivot/veri bağlantıları yenilendikten
// sonra okunabilir. Antrepo Excel akışıyla aynı fail-closed mantığı geçerlidir.
async function refreshAsasExcelBeforeRead(file) {
  if (!file || !file.full) {
    const error = new Error('ASAS Excel dosyası bulunamadı.');
    error.statusCode = 404; error.code = 'ASAS_SOURCE_NOT_FOUND'; throw error;
  }
  if (!platform.canRefreshExcel()) {
    const error = new Error('ASAS Excel pivot tabloları yenilenmeden veri okunamaz. Bu işlem Windows ve Microsoft Excel gerektirir.');
    error.statusCode = 501; error.code = 'ASAS_EXCEL_REFRESH_UNSUPPORTED'; throw error;
  }
  const timeoutMs = computeRefreshTimeoutMs(file.full, config.excelRefreshTimeoutMs);
  try {
    const output = await refreshExcelFile(file.full, timeoutMs);
    return { ok: true, source: 'ASAS', name: file.name, timeoutMs, output: String(output || '') };
  } catch (err) {
    const error = new Error(`ASAS Excel pivot tabloları yenilenemedi (${file.name}). Güncel pivot verisi doğrulanmadan dosya okunmadı. ${err && err.message ? err.message : ''}`.trim());
    error.statusCode = Number(err && err.statusCode) || 500;
    error.code = (err && err.code) || 'ASAS_EXCEL_REFRESH_FAILED';
    error.cause = err;
    throw error;
  }
}

// ASAS ana kaynağı varsayılan olarak kullanıcının kaynak klasöründeki en güncel
// ASAS Excel dosyasıdır (Antrepo Excel akışıyla birebir aynı mantık). Aynı
// çalışma kitabındaki LFL sayfası da bu tek okumadan üretilir. Database seçeneği
// yalnız kullanıcı özellikle etkinleştirdiğinde Data Model Connection çalışır.
async function loadAsasFromExcel(value, matchRule = null, options = {}) {
  const id = sourceUserId(value), sourceFolder = sourceFolderForUser(id);
  if (!sourceFolder) {
    const error = new Error('ASAS kaynağı Excel olarak seçili ancak henüz bir kaynak klasör seçilmedi. Kaynak Veri alanından klasör seçin veya ASAS Excel yükleyin.');
    error.statusCode = 400; error.code = 'ASAS_SOURCE_FOLDER_MISSING'; throw error;
  }
  const found = findLatestSourceFiles(sourceFolder);
  if (!found.asas) {
    const error = new Error(`ASAS kaynağı Excel olarak seçili ancak klasörde "asas*.xlsx" dosyası bulunamadı: ${sourceFolder}`);
    error.statusCode = 404; error.code = 'ASAS_SOURCE_NOT_FOUND'; throw error;
  }
  // Pivot yenileme (gerçek Excel/COM) başarısız olursa Refresh'i tamamen
  // engellemek yerine dosyanın son kaydedilmiş haliyle devam ederiz; kullanıcı
  // "sunucudan güncellenmedi" uyarısıyla açıkça bilgilendirilir.
  let refreshResult = null;
  let refreshFailureWarning = null;
  if (options && options.refreshBeforeRead === true) {
    if (typeof options.onRefreshStart === 'function') options.onRefreshStart();
    try {
      refreshResult = await runRefreshTelemetry(options.telemetry, 'ASAS Excel', 'pivot-refresh', 'wait', () => refreshAsasExcelBeforeRead(found.asas));
    } catch (err) {
      refreshResult = { ok: false, source: 'ASAS', name: found.asas.name, error: (err && (err.publicMessage || err.message)) || String(err) };
      refreshFailureWarning = `ASAS Excel pivot tabloları yenilenemedi; veri sunucudan güncellenmedi, "${found.asas.name}" dosyasının son kaydedilmiş hali kullanıldı. ${refreshResult.error}`;
    }
  }
  const stat = fs.statSync(found.asas.full);
  let parsed;
  if (typeof options.onParseStart === 'function') options.onParseStart();
  try {
    parsed = await runRefreshTelemetry(options.telemetry, 'ASAS Excel', 'file-parse', 'wait', () => runExcelTask('parseAsasFile', {
      fullPath: found.asas.full,
      matchRule: matchRule || loadOverrides().antrepoMatchConfig,
    }, { timeoutMs: excelParseTimeoutMs(stat.size) }));
  } catch (err) {
    err.code = err.code || 'ASAS_EXCEL_PARSE_FAILED';
    err.publicMessage = `ASAS Excel dosyası okunamadı: ${found.asas.name}. Dosyanın açık/kilitli olmadığını ve Sipariş Kod sütununu içerdiğini kontrol edin.`;
    throw err;
  }
  const parsedAsas = parsed && parsed.parsedAsas;
  if (!parsedAsas || !Array.isArray(parsedAsas.orders)) {
    const error = new Error(`ASAS Excel dosyasında "Sipariş Kod" sütunu bulunamadı: ${found.asas.name}.`);
    error.statusCode = 422; error.code = 'ASAS_EXCEL_MAPPING_INVALID'; throw error;
  }
  const parsedLfl = parsed && parsed.parsedLfl && Array.isArray(parsed.parsedLfl.rows) ? parsed.parsedLfl : null;
  return {
    orders: parsedAsas.orders,
    fabricHeaderInfo: parsedAsas.fabricHeaderInfo || null,
    lflRows: parsedLfl ? parsedLfl.rows : null,
    lflMeta: parsedLfl ? withFabricDimensions(parsedLfl.meta, parsedLfl.rows) : null,
    lflError: (parsed && parsed.lflError) || '',
    file: found.asas.name,
    fullPath: found.asas.full,
    excelRefresh: refreshResult,
    refreshFailureWarning,
  };
}

// Ana Refresh veri kaynağı: ASAS ve LFL Data Model Connection üzerinden gelir.
// Antrepo ise varsayılan Excel / isteğe bağlı Database kaynağından alınır.
function throwIfRefreshSignalAborted(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Yenileme kullanıcı tarafından durduruldu.');
  error.code = 'REFRESH_CANCELLED'; error.statusCode = 409;
  throw error;
}

async function publishRefreshedRuntime(id, next) {
  const snapshotMetrics = await saveRuntimeModelSnapshot(id, next);
  replaceUserCache(id, next);
  userAccess.syncProfiles(next.asasOrders, { authoritative: id === 'moderator' });
  Object.defineProperty(next, '_refreshPersistenceMetrics', { value:snapshotMetrics || null, enumerable:false, configurable:true });
  return next;
}

async function loadFromModels(value, targets = null, options = {}) {
  const id = sourceUserId(value), runtime = cacheForUser(id);
  const markSourcePhase = typeof options.markPhase === 'function' ? options.markPhase : () => {};
  markSourcePhase('source-setup');
  throwIfRefreshSignalAborted(options.signal);
  const requestedTargets = Array.isArray(targets) && targets.length ? targets : ['cp','orders','backlog','lfl','priceanalysis'];
  assertSourceFilters(requestedTargets,value);
  const store = loadModelConnections();
  const connectionItems=userPreferences.applyHorizonOverrides(store.items,id,requestedTargets,userAccess.roleWorkspaceEntries(value));
  const sourcePolicy=options&&options.sourcePolicy&&typeof options.sourcePolicy==='object'?options.sourcePolicy:{};
  const overrides = loadOverrides();
  const antrepoMode = sourcePolicy.antrepoMode || (['database', 'dashboard'].includes(overrides.antrepoSourceMode) ? overrides.antrepoSourceMode : 'excel');
  const matchRule = antrepoMode === 'dashboard' ? dashboardAntrepoMatchRule() : overrides.antrepoMatchConfig;
  const asasMode = sourcePolicy.asasMode|| (overrides.asasSourceMode === 'database' ? 'database' : 'excel');
  const lflMode = sourcePolicy.lflMode|| (overrides.lflSourceMode === 'database' ? 'database' : 'excel');
  const needsAntrepo = requestedTargets.some(target => target === 'cp' || target === 'orders' || target === 'backlog');
  const needsLfl = requestedTargets.includes('lfl');

  // ASAS Kaynağı Excel seçiliyse Data Model bağlantısı hiç sorgulanmaz; sipariş ve
  // LFL satırları aynı ASAS çalışma kitabından okunup Data Model sonucu gibi
  // hedeflere dağıtılır (Antrepo Excel akışıyla birebir aynı desen). Antrepo
  // eşleştirme denetimi doğru ASAS satırlarını görsün diye bu adım Data Model
  // sorgusundan ÖNCE çalışır.
  // ASAS çalışma kitabı, siparişler VEYA LFL Excel'den besleniyorsa okunur; aynı
  // kitaptan hem sipariş hem LFL satırları çıkar (tek okuma, iki çıktı).
  const needsAsasExcel = asasMode === 'excel' || (lflMode === 'excel' && needsLfl);
  const asasExcel = needsAsasExcel ? await loadAsasFromExcel(id, matchRule, {
    refreshBeforeRead: true,
    telemetry: options.telemetry,
    onRefreshStart: () => markSourcePhase('asas-excel-refresh'),
    onParseStart: () => markSourcePhase('asas-excel-parse'),
  }) : null;
  const presetAsasOrdersByTarget = {};
  if (asasExcel && asasMode === 'excel') {
    for (const target of requestedTargets) {
      if (target === 'cp' || target === 'orders' || target === 'backlog' || target === 'priceanalysis') presetAsasOrdersByTarget[target] = asasExcel.orders;
    }
  }
  markSourcePhase('database');
  const result = await loadFromModelConnections(connectionItems, {
    targets,
    matchRule,
    includeAntrepo: antrepoMode === 'database' && needsAntrepo,
    includeAsas: asasMode === 'database',
    includeLfl: lflMode === 'database',
    presetAsasOrdersByTarget,
    presetLfl: asasExcel && needsLfl && lflMode === 'excel' ? { rows: asasExcel.lflRows, meta: asasExcel.lflMeta } : null,
    signal: options.signal,
    telemetry: options.telemetry,
  });
  throwIfRefreshSignalAborted(options.signal);
  // Database scopes already report the exact Horizon used by their query.
  // Excel-backed targets do not create model runs, so preserve the resolved
  // scope Horizon in the same runtime metadata for restart and page badges.
  const appliedHorizons = result.appliedHorizons && typeof result.appliedHorizons === 'object'
    ? { ...result.appliedHorizons } : {};
  for (const target of requestedTargets) {
    if (Object.prototype.hasOwnProperty.call(appliedHorizons, target)) continue;
    let resolved = null;
    for (const connection of connectionItems) {
      const scopes = Array.isArray(connection.scopes) && connection.scopes.length
        ? connection.scopes : [{ targets: ['cp', 'orders', 'backlog', 'lfl', 'priceanalysis'], horizon: connection.horizon || {} }];
      const scope = scopes.find(item => item && item.enabled !== false
        && Array.isArray(item.targets) && item.targets.includes(target));
      if (scope) { resolved = scope.horizon || {}; break; }
    }
    /* v7.81 — Kişisel ufka geri düşüş KALDIRILDI. Ufuk yalnız Veri
       Yönetimi'ndeki kaynak filtresinden gelir; kaynakta yoksa yoktur. */
    if (resolved != null) appliedHorizons[target] = resolved;
  }
  result.appliedHorizons = appliedHorizons;
  let antrepoHeaderInfo = runtime.antrepoHeaderInfo || null;

  if (asasExcel) {
    result.sources = { ...(result.sources || {}) };
    // Kaynak etiketleri artık her iki mod ayrı ayrı yazılır: ASAS Database + LFL
    // Excel (veya tersi) seçilebildiği için tek bir etiket yanıltıcı olurdu.
    if (asasMode === 'excel') result.sources.asas = `Excel: ${asasExcel.file}`;
    if (needsLfl && lflMode === 'excel') result.sources.lfl = `Excel: ${asasExcel.file}`;
    if (asasMode === 'excel' && asasExcel.fabricHeaderInfo) result.fabricHeaderInfo = asasExcel.fabricHeaderInfo;
    result._asasExcelRefresh = asasExcel.excelRefresh || null;
    if (asasExcel.refreshFailureWarning) {
      result.warnings = [...(result.warnings || []), asasExcel.refreshFailureWarning];
    }
    if (needsLfl && lflMode === 'excel' && asasExcel.lflError) {
      result.warnings = [
        ...(result.warnings || []),
        `LFL aynı ASAS Excel kaynağından üretilemedi; son başarılı LFL verisi korundu: ${asasExcel.lflError}`,
      ];
    }
  }

  // Dashboard kaynağı ASAS siparişlerini DOM'dan değil, aynı yenilemede elde
  // edilen tam veri kümesinden alır. Dashboard sonucu daha sonra Excel ve
  // Database ile aynı parse/eşleştirme hattına girer; böylece çoklu IAS
  // parsiyelleri korunur. Dashboard adapter'ı renk için Renk Tanım ↔ ASAS Renk
  // koşulunu kullanır; Excel/Database'in Renk Kod kuralı değişmez.
  if (antrepoMode === 'dashboard' && needsAntrepo) {
    const dashboardOrders = result.asasOrdersByTarget && typeof result.asasOrdersByTarget === 'object'
      ? Object.values(result.asasOrdersByTarget).flat().filter(Boolean)
      : (result.asasOrders || []);
    const dashboard = await loadAntrepoFromDashboard(id, dashboardOrders, matchRule, {
      signal: options.signal,
      dashboardSession: options.dashboardSession,
      previousMap: runtime.antrepoMap,
      refreshId: options.refreshId,
      markPhase: markSourcePhase,
      onProgress: options.onDashboardProgress,
      telemetry: options.telemetry,
    });
    antrepoHeaderInfo = dashboard.meta || antrepoHeaderInfo;
    result.antrepoMapByTarget = { ...(result.antrepoMapByTarget || {}) };
    for (const target of requestedTargets) {
      if (target === 'cp' || target === 'orders' || target === 'backlog') result.antrepoMapByTarget[target] = dashboard.map;
    }
    result.antrepoMap = result.antrepoMapByTarget.cp || result.antrepoMapByTarget.orders || result.antrepoMapByTarget.backlog || dashboard.map;
    result.sources = { ...(result.sources || {}), antrepo: 'Dashboard: Power BI İthalat Dashboard' };
    result._antrepoDashboardRefresh = dashboard.manifest || null;
    result.warnings = [...(result.warnings || []), ...(dashboard.integrityWarnings || [])];
  }

  // Excel kaynağında tek Antrepo dosyası CP, Orders ve Backlog'a aynı
  // parsiyel satırlarıyla verilir. Data Model bağlantısı bu modda hiç sorgulanmaz.
  if (antrepoMode === 'excel' && needsAntrepo) {
    const excel = await loadAntrepoFromExcel(id, matchRule, {
      refreshBeforeRead: true,
      telemetry: options.telemetry,
      onRefreshStart: () => markSourcePhase('antrepo-excel-refresh'),
      onParseStart: () => markSourcePhase('antrepo-excel-parse'),
    });
    antrepoHeaderInfo = excel.meta;
    result.antrepoMapByTarget = { ...(result.antrepoMapByTarget || {}) };
    for (const target of requestedTargets) {
      if (target === 'cp' || target === 'orders' || target === 'backlog') result.antrepoMapByTarget[target] = excel.map;
    }
    result.antrepoMap = result.antrepoMapByTarget.cp || result.antrepoMapByTarget.orders || result.antrepoMapByTarget.backlog || excel.map;
    const auditOrders = (result.asasOrdersByTarget && (result.asasOrdersByTarget.cp || result.asasOrdersByTarget.orders || result.asasOrdersByTarget.backlog))
      || result.asasOrders || [];
    const excelMatchAudit = assertAntrepoMatchDidNotCollapse(auditOrders, excel.map, matchRule, `Antrepo Excel (${excel.file})`);
    if (excelMatchAudit && Number(excelMatchAudit.totals && excelMatchAudit.totals.matched) > 0) {
      result.warnings = [
        ...(result.warnings || []),
        `Antrepo Excel (${excel.file}): ${Number(excelMatchAudit.totals.matched).toLocaleString('tr-TR')} ASAS satırı Sipariş Kod + Model Adı/Ürün Ad + Renk Kod ile birebir eşleşti.`,
      ];
    }
    result.sources = { ...(result.sources || {}), antrepo: `Excel: ${excel.file}` };
    result._antrepoExcelRefresh = excel.excelRefresh || null;
    const quantityInfo = antrepoQuantityWarningInfo(excel.file, excel.meta || {});
    result.warnings = [...(result.warnings || []), ...(excel.integrityWarnings || []), ...quantityInfo.warnings];
    result.warningDetails = [...(result.warningDetails || []), ...quantityInfo.details];
  }

  markSourcePhase('source-processing');

  // Refresh sırasında eski/bozuk eşlemeler model şemasından otomatik onarıldıysa
  // aynı düzeltmeyi kalıcı bağlantı ayarına da yaz.
  if (result.mappingRepairs > 0) {
    try { replaceModelConnections(store.items, store.revision); }
    catch (err) { result.warnings = [...(result.warnings || []), `Otomatik eşleme onarımı çalıştı ancak ayarlara kaydedilemedi: ${err.message}`]; }
  }
  for (const run of result.runs || []) {
    try { recordModelConnectionRun(run.item.id, run.summary); } catch (_) { /* refresh sonucunu gölgeleme */ }
  }
  const previousCpupdate = runtime.cpupdateOverrides && typeof runtime.cpupdateOverrides === 'object'
    ? runtime.cpupdateOverrides : { submap: {}, suppfobmap: {}, suppfobmetamap: {} };

  // Hedef bazlı birleştirme: kısmi yenilemede dokunulmayan hedeflerin önceki
  // verisi korunur, yalnız yenilenenler değişir.
  const mergedOrders = (() => {
    if (!result.partialTargets) {
      return {
        asasOrders: result.asasOrders,
        antrepoMap: result.antrepoMap,
        asasOrdersByTarget: result.asasOrdersByTarget || null,
        antrepoMapByTarget: result.antrepoMapByTarget || null,
      };
    }
    const orders = { ...(runtime.asasOrdersByTarget || {}) };
    const antrepo = { ...(runtime.antrepoMapByTarget || {}) };
    for (const target of result.partialTargets) {
      if (result.asasOrdersByTarget && result.asasOrdersByTarget[target]) orders[target] = result.asasOrdersByTarget[target];
      if (result.antrepoMapByTarget && result.antrepoMapByTarget[target]) antrepo[target] = result.antrepoMapByTarget[target];
    }
    return {
      asasOrders: orders.cp || orders.orders || orders.backlog || runtime.asasOrders || [],
      antrepoMap: antrepo.cp || antrepo.orders || antrepo.backlog || runtime.antrepoMap || {},
      asasOrdersByTarget: orders,
      antrepoMapByTarget: antrepo,
    };
  })();
  const next = {
    loadedAt: result.loadedAt,
    sources: {
      ...result.sources,
      cpupdate: null,
    },
    asasOrders: mergedOrders.asasOrders,
    antrepoMap: mergedOrders.antrepoMap,
    asasOrdersByTarget: mergedOrders.asasOrdersByTarget,
    antrepoMapByTarget: mergedOrders.antrepoMapByTarget,
    antrepoHeaderInfo,
    lflRows: result.lflRows == null ? runtime.lflRows : result.lflRows,
    lflMeta: result.lflMeta == null ? runtime.lflMeta : result.lflMeta,
    lflLoadedAt: result.lflRows == null ? runtime.lflLoadedAt : result.lflLoadedAt,
    cpupdateInfo: null,
    cpupdateOverrides: previousCpupdate,
    fabricHeaderInfo: result.fabricHeaderInfo || runtime.fabricHeaderInfo || null,
    refreshWarnings: result.warnings || [],
    refreshWarningDetails: result.warningDetails || [],
    excelRefresh: (() => {
      const entries = [
        antrepoMode === 'excel' && needsAntrepo ? (result._antrepoExcelRefresh || null) : null,
        asasExcel ? (result._asasExcelRefresh || null) : null,
      ].filter(Boolean);
      if (!entries.length) return null;
      return entries.length === 1 ? entries[0] : entries;
    })(),
    modelRefresh: {
      at: result.loadedAt,
      antrepoSourceMode: antrepoMode,
      dashboard: result._antrepoDashboardRefresh || null,
      asasSourceMode: asasMode,
      lflSourceMode: lflMode,
      scopes: Array.isArray(result.scopes) ? result.scopes : [],
      appliedHorizons: result.appliedHorizons && typeof result.appliedHorizons === 'object' ? result.appliedHorizons : {},
      connections: (result.runs || []).map(run => ({
        id: run.item.id, role: run.item.role, name: run.item.name || run.item.catalog,
        server: run.item.server, catalog: run.item.catalog,
        rowCount: run.summary.rowCount, elapsedMs: run.summary.elapsedMs, provider: run.summary.provider,
        timings: run.timings || null,
        queryFingerprint: run.queryFingerprint || '',
      })),
      queryMetrics: result.queryMetrics || null,
      sourceGenerationId: result.loadedAt,
      moduleProjectionTargets: Array.isArray(requestedTargets) ? requestedTargets.slice() : [],
    },
  };
  throwIfRefreshSignalAborted(options.signal);
  if (options.deferPublish) return next;
  return publishRefreshedRuntime(id, next);
}

// Büyük senkron döngüleri (onbinlerce sipariş) tek karede işlemek olay
// döngüsünü tıkayıp Refresh sırasında diğer kullanıcıların isteklerini
// bekletir. Her N kayıtta bir kısa bir mikro-bekleme ile döngü kontrolü
// geri verilir; toplam hesaplama süresi değişmez, yalnız bölünür.
async function yieldToEventLoopEvery(index, everyN = 500) {
  if (index > 0 && index % everyN === 0) await new Promise(resolve => setImmediate(resolve));
}

// "Yenile" sonrası kullanıcıya "neler değişti" özetini verebilmek için eski/yeni
// siparişleri (ocode|colour bazında) karşılaştırır.
async function computeRefreshSummary(oldOrders, oldAntrepoMap, newOrders, newAntrepoMap, overrides) {
  const matchRule = (overrides && overrides.antrepoMatchConfig) || undefined;
  const statusOf = (o, map) => {
    const hit = findAntrepoHit(map, o, { rule: matchRule });
    return deriveOperationalStatus(hit ? (hit.statu || '') : (o.kalan > 0 ? 'Üretimde' : 'Depoda'), o);
  };
  const oldMap = new Map((oldOrders || []).map(o => [`${o.ocode}|${o.colour}`.toUpperCase(), o]));
  const newMap = new Map((newOrders || []).map(o => [`${o.ocode}|${o.colour}`.toUpperCase(), o]));
  const metaOf = o => ({
    subMfr: (overrides && overrides.submap && overrides.submap[o.ocode]) || '',
    specialCode: o.ozel || '', modelName: o.model || '',
    mag: o.merch || '', mmyg: o.ageGroup || '', buyer: o.buyer || '', buyingGroup: o.buyerGrup || '',
    season: o.season || '', manufacturer: o.manufacturer || ''
  });
  const dateValue = v => {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return String(v || '');
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  };
  const clean = v => v == null ? '' : String(v).trim();
  /* v6.45 — SESSİZ EŞLEŞME KAYBI DÜZELTİLDİ.
     ASAS tarafında sipariş kodu SAYI olarak tutuluyor (temiz: "1314997").
     Antrepo/IAS tarafındaki _matchOcode ise yalnız trim+normalize ediliyor
     (exactOrderCodeKey — CP/Backlog üretim eşleştirmesi için BİLİNÇLİ olarak
     katı, v4.32 kararı); kaynak veri noktalı geldiyse ("1.314.997") bu iki
     temsil STRING olarak asla eşleşmiyordu. Sonuç: yenileme özetindeki
     Antrepo satırları kendi ASAS siparişini bulamıyor, metaOf({}) çağrılıp
     MAG/MMYG/Buyer/Buying Group/Season/Manufacturer/Sub-Mfr/Special Code
     hep boş geliyordu — CP'deki gerçek eşleştirme etkilenmiyordu, yalnız bu
     rapordaki GÖRÜNTÜLEME zenginleştirmesi bozuktu.
     Burada amaç veri BAĞLAMAK değil, rapor satırını meta bilgiyle
     ZENGİNLEŞTİRMEK olduğu için katı eşleşmeye gerek yok; orderCodeKey'in
     biçim-toleranslı normalleştirmesi kullanılır. */
  const orderLineKey = o => [parseLib.orderCodeKey(o && (o._matchOcode || o.ocode)), clean(o && o.model), clean(o && o.ccode)].join('|').toLocaleUpperCase('tr-TR');
  const orderLineIndex = new Map();
  for (const o of [...(oldOrders || []), ...(newOrders || [])]) { const key = orderLineKey(o); if (key && !orderLineIndex.has(key)) orderLineIndex.set(key, o); }
  const antrepoDetailBase = hit => {
    const row = hit || {}, lineOrder = orderLineIndex.get(orderLineKey(row));
    const orderColourKey = `${parseLib.orderCodeKey(row.ocode)}|${clean(row.colour)}`.toUpperCase();
    const o = lineOrder || newMap.get(orderColourKey) || oldMap.get(orderColourKey) || {};
    return {
      ocode: row.ocode != null && row.ocode !== '' ? row.ocode : o.ocode,
      colourCode: row.ccode || o.ccode || '', colour: row.colour || o.colour || '',
      importFile: row.importFile || '', containerNo: row.containerNo || '',
      loadedQty: row.loadedQty == null ? '' : row.loadedQty, iasOrderQty: row.iasOrderQty == null ? '' : row.iasOrderQty,
      sourceRow: Number.isFinite(Number(row._sourceRow)) ? Number(row._sourceRow) + 1 : '',
      ...metaOf(o), modelName: row.model || o.model || '',
    };
  };

  let newlyAppeared = 0, disappeared = 0, statusChanged = 0, qtyChangedOrders = 0, kalanDelta = 0;
  const details = [];
  const asasChangedKeys = new Set();
  let newMapIndex = 0;
  for (const [key, o] of newMap) {
    await yieldToEventLoopEvery(newMapIndex++);
    if (!oldMap.has(key)) {
      newlyAppeared++; asasChangedKeys.add(key);
      details.push({ source: 'ASAS', ocode: o.ocode, colourCode:o.ccode||'', colour: o.colour, ...metaOf(o), changeType: 'Yeni görünen', field:'Sipariş kaydı', before:'', after:'Yeni kayıt', detail: `Kalan: ${o.kalan}` });
      continue;
    }
    const old = oldMap.get(key);
    const oldStatus = statusOf(old, oldAntrepoMap), newStatus = statusOf(o, newAntrepoMap);
    if (oldStatus !== newStatus) {
      statusChanged++;
      const hasAntrepo = !!(findAntrepoHit(oldAntrepoMap, old, { rule: matchRule }) || findAntrepoHit(newAntrepoMap, o, { rule: matchRule }));
      details.push({ source: hasAntrepo ? 'Antrepo' : 'ASAS', ocode: o.ocode, colourCode:o.ccode||'', colour: o.colour, ...metaOf(o), changeType: 'Durum değişti', field:'Operasyonel durum', before:oldStatus||'', after:newStatus||'', detail: `${oldStatus || '(boş)'} → ${newStatus || '(boş)'}` });
    }
    if (old.kalan !== o.kalan) {
      qtyChangedOrders++; kalanDelta += (o.kalan - old.kalan); asasChangedKeys.add(key);
      details.push({ source: 'ASAS', ocode: o.ocode, colourCode:o.ccode||'', colour: o.colour, ...metaOf(o), changeType: 'Kalan adet değişti', field:'Kalan adet', before:String(old.kalan??''), after:String(o.kalan??''), detail: `${old.kalan} → ${o.kalan} (${o.kalan - old.kalan > 0 ? '+' : ''}${o.kalan - old.kalan})` });
    }
    const numberText = v => Number.isFinite(Number(v)) ? Number(v).toLocaleString('tr-TR') : '';
    const moneyText = v => Number.isFinite(Number(v)) ? Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    const asasFields = [
      ['Net sipariş miktarı', 'qty', numberText],
      ['Merkez sevke hazır kalan', 'merkezSevkeHazirKalan', numberText],
      ['FOB fiyatı', 'fob', moneyText],
      ['Üretici', 'manufacturer', clean], ['Sezon', 'season', clean], ['Ürün klasmanı', 'category', clean],
      ['MAG', 'merch', clean], ['MMYG', 'ageGroup', clean], ['Buyer', 'buyer', clean], ['Buying Group', 'buyerGrup', clean],
      ['Üretim ülkesi', 'countryRaw', clean], ['Lisans', 'license', clean], ['Model adı', 'model', clean], ['Line', 'line', clean],
      ['OPD', 'opd', dateValue], ['Ex-Factory', 'ex', dateValue], ['Retail', 'retail', dateValue], ['Model bütçe tarihi', 'mb', dateValue], ['Buying son onay tarihi', 'shipConf', dateValue],
    ];
    asasFields.forEach(([label, field, fmt]) => {
      const a = fmt(old[field]), b = fmt(o[field]);
      if (a === b) return;
      asasChangedKeys.add(key);
      details.push({ source: 'ASAS', ocode: o.ocode, colourCode:o.ccode||'', colour: o.colour, ...metaOf(o), changeType: `${label} değişti`, field:label, before:a||'', after:b||'', detail: `${a || '(boş)'} → ${b || '(boş)'}` });
    });
  }
  for (const [key, o] of oldMap) {
    if (!newMap.has(key)) {
      disappeared++; asasChangedKeys.add(key);
      details.push({ source: 'ASAS', ocode: o.ocode, colourCode:o.ccode||'', colour: o.colour, ...metaOf(o), changeType: 'Artık görünmüyor', field:'Sipariş kaydı', before:'Mevcut kayıt', after:'', detail: `Önceki kalan: ${o.kalan}` });
    }
  }

  // Antrepo haritasının __ias_row_N anahtarı sorgu sırasıdır; yenilemeler arası
  // kimlik değildir. İş alanlarıyla multiset eşleştir, sonra kaynaktaki TÜM
  // gerçek sütunları karşılaştır. Böylece sıra değişikliği binlerce sahte fark
  // üretmez ve yalnız önceden seçilmiş dört alanla sınırlı kalınmaz.
  const antrepoChangedKeys = new Set();
  const antrepoPairs = refreshHistoryDiff.pairAntrepoRows(oldAntrepoMap, newAntrepoMap);
  let antPairIndex = 0;
  for (const pair of antrepoPairs) {
    await yieldToEventLoopEvery(antPairIndex++);
    const oldHit = pair.oldRow, newHit = pair.newRow, preferred = newHit || oldHit || {};
    // v7.15: değişmemiş çiftler bir satır sonra atlanıyor; identity/base ise
    // onlar için de hesaplanıyordu. Gerçek veride çiftlerin neredeyse tamamı
    // "same" olduğu için bu, her yenilemede binlerce gereksiz nesne kurulumuydu.
    if (pair.kind === 'same') continue;
    const identity = refreshHistoryDiff.identity(preferred), base = antrepoDetailBase(preferred);
    if (!oldHit && newHit) {
      antrepoChangedKeys.add(identity);
      details.push({ source:'Antrepo', ...base, changeType:'Antrepo kaydı eklendi', field:'Antrepo kaydı', before:'', after:'Yeni kayıt', detail:clean(newHit.statu)||'Yeni kayıt' });
      continue;
    }
    if (oldHit && !newHit) {
      antrepoChangedKeys.add(identity);
      details.push({ source:'Antrepo', ...base, changeType:'Antrepo kaydı kaldırıldı', field:'Antrepo kaydı', before:'Mevcut kayıt', after:'', detail:clean(oldHit.statu)||'Önceki kayıt kaldırıldı' });
      continue;
    }
    for (const change of refreshHistoryDiff.fieldChanges(oldHit, newHit)) {
      antrepoChangedKeys.add(identity);
      details.push({ source:'Antrepo', ...base, changeType:`${change.field} değişti`, field:change.field, before:change.before, after:change.after, detail:`${change.before||'(boş)'} → ${change.after||'(boş)'}` });
    }
  }

  const asasChangeCount = details.filter(d => d.source === 'ASAS').length;
  const antrepoChangeCount = details.filter(d => d.source === 'Antrepo').length;
  return {
    oldOrderCount: oldMap.size,
    newOrderCount: newMap.size,
    newlyAppeared, disappeared, statusChanged, qtyChangedOrders, kalanDelta,
    asasChangedOrders: asasChangedKeys.size, antrepoChangedOrders: antrepoChangedKeys.size,
    asasChangeCount, antrepoChangeCount,
    hasChanges: details.length > 0,
    details,
  };
}

const COLLECTION_CATALOG_FIELDS = Object.freeze({
  category: 'Category',
  mag: 'Merch Alt Grup Kod',
  mmyg: 'Merch Marka Yaş Grup Kod',
  buyingGroup: 'Buyer Grup (TR)',
  buyer: 'Buyer',
  manufacturer: 'Manufacturer',
  season: 'Season',
  license: 'License',
  licensor: 'Licensor',
  country: 'Country',
  line: 'Line',
  productMainDefinition: 'Ürün Ana Tanım',
});

// Katalog anahtarları Collection UI alanlarıdır; kaynak değerler ASAS'ın
// canonical registry binding'inden okunur. Product Main Definition'ın ASAS
// karşılığı canonical productDescription'dır ve Collection/PLM alanından ayrı
// tutulur.
const COLLECTION_CATALOG_CANONICAL_FIELDS = Object.freeze({
  category: 'category',
  mag: 'mag',
  mmyg: 'mmyg',
  buyingGroup: 'buyingGroup',
  buyer: 'buyer',
  manufacturer: 'manufacturer',
  season: 'season',
  license: 'license',
  licensor: 'licensor',
  country: 'country',
  line: 'line',
  productMainDefinition: 'productDescription',
});

// Increment when the persisted collection-catalog payload contract changes.
// Version 3 adds the ASAS manufacturer directory used by Collection price
// entry, while keeping Product Main Definition sourced from canonical ASAS
// productDescription. Old cached catalogs are rebuilt on demand.
const COLLECTION_CATALOG_SCHEMA_VERSION = 3;

function collectionCatalogsComplete(catalogs) {
  if (!catalogs || typeof catalogs !== 'object') return false;
  return Object.keys(COLLECTION_CATALOG_FIELDS).every(key => Array.isArray(catalogs[key]));
}

function collectionCatalogProjectionComplete(data) {
  return Boolean(
    data
    && Number(data.catalogSchemaVersion) === COLLECTION_CATALOG_SCHEMA_VERSION
    && collectionCatalogsComplete(data.catalogs)
  );
}


function stableHashValue(value) {
  const seen = new WeakSet();
  const normalize = input => {
    if (input == null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    Object.keys(input).sort().forEach(key => { out[key] = normalize(input[key]); });
    return out;
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
function pageProjectionContext(currentUser = null) {
  const id = sourceUserId(currentUser), shared = loadOverrides(), connections = loadModelConnections();
  const roleEntries = userAccess.roleWorkspaceEntries(currentUser || id);
  const effectiveConnections = userPreferences.applyHorizonOverrides(connections.items, id, null, roleEntries);
  const profile = currentUser ? userAccess.publicProfile(currentUser) : null;
  const filterStatus = sourceFilterReadiness(['cp','orders','backlog'], currentUser || id);
  const contextHash = stableHashValue({
    schema: pageProjectionCache.CACHE_SCHEMA_VERSION,
    userId: id,
    profile: profile ? {
      id: profile.id, role: profile.role, systemRole: profile.systemRole, status: profile.status,
      scopes: profile.scopes, permissions: profile.permissions, accessAreas: profile.accessAreas,
      capabilities: profile.capabilities, mags: profile.mags, mmygs: profile.mmygs, buyingGroups: profile.buyingGroups,
    } : null,
    modelConnectionRevision: Number(connections.revision) || 0,
    effectiveConnections,
    // Görsel/link metadata değişikliği büyük CP/Orders projection'ını geçersiz
    // kılmamalı. Yalnız projection satırlarını gerçekten etkileyen alt
    // revizyonlar context'e girer; güvenlik ve horizon hash'leri ayrı korunur.
    projectionOverrideRevisions: {
      orders:Number(shared._revisions && shared._revisions.orders) || 0,
      suppFob:Number(shared._revisions && shared._revisions.suppFob) || 0,
      pricingRules:Number(shared._revisions && shared._revisions.pricingRules) || 0,
      transitRules:Number(shared._revisions && shared._revisions.transitRules) || 0,
      nonDtrManufacturers:Number(shared._revisions && shared._revisions.nonDtrManufacturers) || 0,
      landedMultipliers:Number(shared._revisions && shared._revisions.landedMultipliers) || 0,
      freightRates:Number(shared._revisions && shared._revisions.freightRates) || 0,
      antrepoMatchRule:Number(shared._revisions && shared._revisions.antrepoMatchRule) || 0,
    },
    sourceModes: { asas: shared.asasSourceMode || 'excel', antrepo: shared.antrepoSourceMode || 'excel', lfl: shared.lflSourceMode || 'excel' },
    sourceFolder: sourceFolderForUser(id) || '',
    filterStatus,
  });
  return { id, contextHash, filterStatus };
}
function projectionSourceRevision(runtime){
  const source=runtime&&typeof runtime==='object'?runtime:{};
  // LFL sayfa önbelleği modülü değildir ve kendi dosyasını sayfa açılınca
  // yükler; kaynak adını anahtara katmak LFL'ye girildiği an CP/Siparişler/
  // Genel Bakış önbelleklerini boşuna geçersiz kılıyordu.
  const sources=source.sources&&typeof source.sources==='object'?{...source.sources}:null;
  if(sources)delete sources.lfl;
  return stableHashValue({loadedAt:source.loadedAt||null,sources:sources&&Object.keys(sources).length?sources:null,excelRefresh:source.excelRefresh||null});
}
function pageProjectionMatchesRuntime(manifest,runtime){
  const expected=String(runtime&&runtime.loadedAt||'');
  // Cold startup'ta runtime henüz disk snapshot'ından açılmamış olabilir; bu
  // durumda doğrulanmış manifest hızlı başlangıç kaynağıdır. Runtime yüklüyse
  // sourceLoadedAt birebir eşleşmeden eski projection kabul edilmez.
  if(!expected)return true;
  if(manifest&&manifest.sourceRevisionKey)return String(manifest.sourceRevisionKey)===projectionSourceRevision(runtime);
  return String(manifest&&manifest.sourceLoadedAt||'')===expected;
}
function filterRowsByEffectiveHorizon(currentUser,target,rows){
  const source=Array.isArray(rows)?rows:[];if(!currentUser)return source;
  const id=sourceUserId(currentUser),runtime=cacheForUser(id);
  const appliedMap=runtime.modelRefresh&&runtime.modelRefresh.appliedHorizons&&typeof runtime.modelRefresh.appliedHorizons==='object'
    ? runtime.modelRefresh.appliedHorizons : null;
  let horizon=null,hasApplied=false;
  if(appliedMap&&Object.prototype.hasOwnProperty.call(appliedMap,target)){
    horizon=appliedMap[target]||{};hasApplied=true;
  }else{
    const persisted=userPreferences.getAppliedHorizon(id,target);
    if(persisted&&typeof persisted==='object'){
      horizon=persisted.byConnection&&typeof persisted.byConnection==='object'
        ? Object.values(persisted.byConnection).find(item=>item&&typeof item==='object')||{} : persisted;
      hasApplied=true;
    }
  }
  if(hasApplied)return horizonFields.filterRows(source,horizon);
  const connections=loadModelConnections(),roleEntries=userAccess.roleWorkspaceEntries(currentUser||id),effective=userPreferences.applyHorizonOverrides(connections.items,id,[target],roleEntries);
  for(const connection of effective){
    const scopes=Array.isArray(connection.scopes)&&connection.scopes.length?connection.scopes:[{targets:['cp','orders','backlog','lfl','priceanalysis'],horizon:connection.horizon||{}}];
    const scope=scopes.find(item=>item&&item.enabled!==false&&Array.isArray(item.targets)&&item.targets.includes(target));if(scope){horizon=scope.horizon||{};break;}
  }
  /* v7.26 — MODEL BAĞLANTISI OLMAYAN KURULUM.

     Ufuk yalnız bağlantı kapsamlarından okunuyordu. ASAS Excel modunda hiç
     model bağlantısı tanımlı olmayabilir; o durumda kullanıcının kendi
     kaydettiği ufuk hiç uygulanmıyor, ekran her şeyi gösteriyordu. Kişisel
     (ve ön ayardan gelen) ufuk artık bağlantıdan bağımsız da çözülür. */
  /* v7.81 — Kişisel/ön ayar ufkuna geri düşüş KALDIRILDI (kullanıcı
     kararı). Kaynakta filtre yoksa satırlar süzülmez. */
  if(!horizon)return source;
  /* v7.26 — KOŞUL GRUPLARI DA UYGULANIR.

     Bu süzgeç yalnız SEZON ve TARİH biliyordu. "MAG = CK1E" gibi bir ufuk
     Excel modunda hiçbir şeyi süzmüyordu: kullanıcı ufkunu kurup kaydediyor,
     ekranda hiçbir şey değişmiyordu. Artık DAX tarafıyla AYNI modeli
     (gruplar arası VEYA, grup içi VE) satır satır işleten ortak modül
     kullanılıyor; iki yolun sonucu ayrışamaz. */
  // Ufuk bir kez derlenir; satır başına yalnız karşılaştırma kalır
  // (gerçek ASAS'ta 29.923 satır için 191 ms → 96 ms).
  return horizonFields.filterRows(source,horizon);
}
function pageCacheRuntimeMeta(runtime) {
  const src = runtime || {};
  return {
    loadedAt: src.loadedAt || null,
    sources: src.sources || null,
    cpupdateInfo: src.cpupdateInfo || null,
    cpupdateOverrides: src.cpupdateOverrides || null,
    fabricHeaderInfo: src.fabricHeaderInfo || null,
    antrepoHeaderInfo: src.antrepoHeaderInfo || null,
    lflMeta: src.lflMeta || null,
    refreshWarnings: Array.isArray(src.refreshWarnings) ? src.refreshWarnings : [],
    refreshWarningDetails: Array.isArray(src.refreshWarningDetails) ? src.refreshWarningDetails : [],
    modelRefresh: src.modelRefresh || null,
    lastRefreshResult: src.lastRefreshResult || null,
  };
}
function cachedRuntimeFromManifest(manifest) {
  return { ...emptySourceCache(), ...((manifest && manifest.runtimeMeta) || {}) };
}
function pageProjectionCanEdit(currentUser, row) { return canUserEditOrderCode(currentUser, row && row['Order Code']); }
function sameProjectionSourceRows(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function buildCpAndOrdersProjectionRows(cpSource, ordersSource, cpAntrepo, ordersAntrepo, overrides, allowed) {
  if (!allowed) return { cpRows:[], ordersRows:[], shared:false };
  if (cpAntrepo === ordersAntrepo && sameProjectionSourceRows(cpSource, ordersSource)) {
    const shared = buildSharedOrderProjectionRowsFromASAS(ordersSource, ordersAntrepo, overrides);
    return { cpRows:shared.cp, ordersRows:shared.orders, shared:true };
  }
  return {
    cpRows:buildCPRowsFromASAS(cpSource, cpAntrepo, overrides),
    ordersRows:buildOrdersRowsFromASAS(ordersSource, ordersAntrepo, overrides),
    shared:false,
  };
}
async function buildAndWritePageProjectionCache(currentUser, runtime = null) {
  const ctx = pageProjectionContext(currentUser), id = ctx.id;
  if (!ctx.filterStatus.ready) return null;
  const active = runtime || cacheForUser(id);
  if (!Array.isArray(active.asasOrders)) return null;
  const overrides = effectiveOverridesForUser(id);
  const cpDataAllowed = !currentUser || ['overview','cp','orders','koleksiyon','shipping','source'].some(area => userAccess.hasArea(currentUser, area));
  const orderSummaryDataAllowed = !currentUser || ['overview','backlog','source'].some(area => userAccess.hasArea(currentUser, area));
  const scoped = (target,rows) => currentUser ? userAccess.filterRowsByScope(currentUser, filterRowsByEffectiveHorizon(currentUser,target,rows)) : rows;
  const scopedCpSource = scoped('cp',ordersForTarget(active, 'cp', overrides));
  const scopedOrdersSource = scoped('orders',ordersForTarget(active, 'orders', overrides));
  const cpAntrepo = antrepoForTarget(active, 'cp'), ordersAntrepo = antrepoForTarget(active, 'orders');
  const cpModelColumns = cpDataAllowed ? loadModelConnections().items.flatMap(item => (item.cpColumns || []).map(col => ({...col, role:item.role, connectionId:item.id, connectionName:item.name || item.catalog || item.server}))) : [];
  const workerMinRows=Math.max(1000,Number(process.env.BL_PROJECTION_WORKER_MIN_ROWS)||5000);
  if(cpDataAllowed&&process.env.BL_DISABLE_PROJECTION_WORKER!=='1'&&Math.max(scopedCpSource.length,scopedOrdersSource.length)>=workerMinRows){
    try{
      // v7.16: aynı sipariş kodu binlerce satırda tekrar ediyor; karar kod başına
      // bir kez alınır ve kullanıcı düzeyindeki manageAll kontrolü dışarı çıkarılır.
      const workerEditContext = { manageAll: currentUser ? Boolean(userAccess.hasPermission(currentUser, 'manageAllOrders')) : true };
      const workerEditByCode = new Map();
      const editableOrderCodes = currentUser ? scopedCpSource.filter(row => {
        const code = row && row.ocode, key = String(code == null ? '' : code);
        if (!workerEditByCode.has(key)) workerEditByCode.set(key, Boolean(canUserEditOrderCode(currentUser, code, workerEditContext)));
        return workerEditByCode.get(key);
      }).map(row => row.ocode) : scopedCpSource.map(row => row && row.ocode);
      const worker=await runProjectionWorker({
        cpSource:scopedCpSource,ordersSource:scopedOrdersSource,cpAntrepo,ordersAntrepo,overrides,cpModelColumns,
        shared:cpAntrepo===ordersAntrepo&&sameProjectionSourceRows(scopedCpSource,scopedOrdersSource),
        orderSummaryAllowed:orderSummaryDataAllowed,editableOrderCodes,
      });
      const compressed=Object.fromEntries(Object.entries(worker.compressed||{}).map(([module,entry])=>[module,{buffer:Buffer.from(entry.buffer),uncompressedBytes:entry.uncompressedBytes}]));
      return pageProjectionCache.writeCompressedGeneration(id,{
        contextHash:ctx.contextHash,sourceLoadedAt:active.loadedAt||null,projections:compressed,
        extra:{runtimeMeta:pageCacheRuntimeMeta(active),sourceRevisionKey:projectionSourceRevision(active),performance:{projectionWorker:true,...(worker.metrics||{})}},
      });
    }catch(workerError){logRuntimeFailure('projectionWorkerFallback',workerError);}
  }
  const projected = buildCpAndOrdersProjectionRows(scopedCpSource, scopedOrdersSource, cpAntrepo, ordersAntrepo, overrides, cpDataAllowed);
  const cpRows = projected.cpRows, ordersRows = projected.ordersRows;
  const orderSummaryRows = orderSummaryDataAllowed ? buildOrderSummaryRowsFromASAS(scopedCpSource, antrepoForTarget(active, 'cp'), overrides) : [];
  const overviewRows = orderSummaryDataAllowed ? buildOverviewSummaryRowsFromASAS(scopedCpSource, overrides) : [];
  // v7.16: _canEdit her satır için ayrı hesaplanıyordu ve her hesap alt kullanıcı
  // ağacını yürüyüp izin kümesini yeniden kuruyordu. Gerçek ölçüm: çağrı başına
  // 35 ms; 1.155 satırlık bir yenilemede page-cache aşaması 28 saniye sürüyordu.
  // Karar artık (a) kullanıcı için bir kez, (b) sipariş kodu başına bir kez alınır.
  const editContext = { manageAll: currentUser ? Boolean(userAccess.hasPermission(currentUser, 'manageAllOrders')) : true };
  const editByOrderCode = new Map();
  const rowCanEdit = row => {
    if (!currentUser || editContext.manageAll) return true;
    const key = String(row && row['Order Code'] == null ? '' : row['Order Code']);
    if (!editByOrderCode.has(key)) editByOrderCode.set(key, Boolean(canUserEditOrderCode(currentUser, row && row['Order Code'], editContext)));
    return editByOrderCode.get(key);
  };
  cpRows.forEach(row => { row._canEdit = rowCanEdit(row); });
  ordersRows.forEach(row => { row._canEdit = false; });
  orderSummaryRows.forEach(row => { row._canEdit = rowCanEdit(row); });
  const projections = {
    cp: { rows: cpRows, cpModelColumns },
    overview: { rows: overviewRows },
    orders: { rows: ordersRows },
    'order-summary': { rows: orderSummaryRows },
    'collection-catalog': {
      catalogs: cpDataAllowed ? buildCollectionCatalogs(ordersRows.length ? ordersRows : overviewRows) : {},
      catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION,
    },
  };
  return pageProjectionCache.writeGeneration(id, {
    contextHash: ctx.contextHash,
    sourceLoadedAt: active.loadedAt || null,
    projections,
    extra: { runtimeMeta: pageCacheRuntimeMeta(active),sourceRevisionKey:projectionSourceRevision(active) },
  });
}
async function warmPageProjectionCachesFromSnapshots() {
  const profiles = userAccess.allPublicProfiles().filter(profile => profile && profile.enabled !== false);
  const bySnapshotId = new Map();
  for (const profile of profiles) {
    const key = pageProjectionCache.safeUserId(profile.id);
    if (!bySnapshotId.has(key)) bySnapshotId.set(key, profile);
  }
  const snapshotIds = pageProjectionCache.listSnapshotUserIds(SNAPSHOT_ROOT);
  for (const snapshotId of snapshotIds) {
    const profile = bySnapshotId.get(pageProjectionCache.safeUserId(snapshotId));
    if (!profile) continue;
    try {
      const ctx = pageProjectionContext(profile);
      if (!ctx.filterStatus.ready) continue;
      const manifest = pageProjectionCache.loadManifest(profile.id);
      const complete = Boolean(
        manifest
        && String(manifest.contextHash || '') === String(ctx.contextHash || '')
        && ['cp','overview','orders','collection-catalog'].every(module => manifest.modules && manifest.modules[module])
      );
      if (complete) continue;
      await ensureDataLoaded(profile.id);
      await buildAndWritePageProjectionCache(profile, cacheForUser(profile.id));
    } catch (error) {
      logRuntimeFailure('pageCacheWarmup', error, { userId: profile.id });
    } finally {
      // Moderator verisi planlı otomasyonlar tarafından kullanılabildiği için
      // mevcut davranış korunur; diğer kullanıcıların ham snapshot'ları RAM'de
      // tutulmaz. Hazır projection dosyaları ilk girişte doğrudan okunur.
      if (profile.id !== 'moderator') resetUserCache(profile.id);
    }
  }
}

// Sipariş özeti ayrı 'order-summary' modülündedir; eski generation'larda orders
// içine gömülüdür. İkisi de yoksa null: önbellek isabet sayılmaz.
function orderSummaryFromCache(byModule) {
  const split = byModule['order-summary'];
  if (split && split.data && Array.isArray(split.data.rows)) return split.data.rows;
  const legacy = byModule.orders && byModule.orders.data && byModule.orders.data.orderSummary;
  return Array.isArray(legacy) ? legacy : null;
}
async function loadCachedPageProjectionSet(currentUser, startup) {
  const ctx = pageProjectionContext(currentUser);
  if (!ctx.filterStatus.ready) return { ctx, hit: false };
  const runtime=cacheForUser(ctx.id),manifest=pageProjectionCache.loadManifest(ctx.id);
  if(manifest&&!pageProjectionMatchesRuntime(manifest,runtime))return {ctx,hit:false,stale:true,manifest};
  // Startup yalnız manifest/runtime metadatasını okur. Büyük Overview gzip
  // projeksiyonunu burada açmak ve JSON.parse etmek, ilk UI çizimini gereksiz
  // şekilde geciktirir; aktif ekran hazır olduktan sonra sıkıştırılmış endpoint
  // üzerinden lazy olarak alınır.
  if (startup) return { ctx, hit: false, manifest };
  // İlk ekran Overview'dur. CP ve Collection kataloglarını burada açmak,
  // görünmeyen iki büyük payload'u gunzip/parse edip tekrar JSON'a dönüştürüyordu.
  // Bunlar ilgili sekme ilk kez açıldığında hazır gzip projection olarak alınır.
  const wanted = ['cp','overview','orders','collection-catalog'];
  const [loaded, summary] = await Promise.all([
    Promise.all(wanted.map(module => pageProjectionCache.readProjection(ctx.id, module, ctx.contextHash))),
    pageProjectionCache.readProjection(ctx.id, 'order-summary', ctx.contextHash),
  ]);
  if (loaded.some(item => !item)) return { ctx, hit: false, manifest };
  const byModule = Object.fromEntries(loaded.map(item => [item.module, item]));
  if (summary) byModule['order-summary'] = summary;
  if (orderSummaryFromCache(byModule) === null) return { ctx, hit: false, manifest };
  const loadedManifest = loaded[0].manifest;
  if(!pageProjectionMatchesRuntime(loadedManifest,runtime))return {ctx,hit:false,stale:true};
  return { ctx, hit: true, byModule, manifest:loadedManifest, readMs: loaded.reduce((sum,item)=>sum+(Number(item.ms)||0),0) };
}
function backlogCacheKey(params) { return stableHashValue(params).slice(0, 48); }

function buildCollectionCatalogs(orderRows) {
  const buckets = Object.fromEntries(Object.keys(COLLECTION_CATALOG_FIELDS).map(key => [key, new Map()]));
  for (const row of Array.isArray(orderRows) ? orderRows : []) {
    for (const [key, field] of Object.entries(COLLECTION_CATALOG_FIELDS)) {
      const canonicalId = COLLECTION_CATALOG_CANONICAL_FIELDS[key];
      const canonicalValue = canonicalId ? canonicalFields.value(row, 'overview', canonicalId) : undefined;
      const rawValue = canonicalId ? canonicalValue : (row && row[field]);
      const value = String(rawValue == null ? '' : rawValue).trim();
      if (!value) continue;
      const identity = canonicalFields.token(value).replace(/\s+/g, '');
      if (identity && !buckets[key].has(identity)) buckets[key].set(identity, value);
    }
  }
  const result = {};
  for (const [key, values] of Object.entries(buckets)) {
    result[key] = [...values.values()].sort((a, b) => a.localeCompare(b, 'tr-TR', { numeric: true, sensitivity: 'base' }));
  }
  return result;
}

async function buildResponse(currentUser = null, options = {}) {
  const id = sourceUserId(currentUser), startup = options.startup === true;
  const cached = await loadCachedPageProjectionSet(currentUser, startup);
  const filterStatus = cached.ctx ? cached.ctx.filterStatus : sourceFilterReadiness(startup ? ['cp'] : ['cp','orders'], currentUser || id);
  const sourceFilterRequired = !filterStatus.ready;
  let active = cacheForUser(id), cp = startup ? null : [], orders = startup ? null : [], orderSummary = startup ? null : [], overviewSummary = null, collectionCatalogs = startup ? null : {}, cpModelColumns = startup ? null : [];
  let pageCacheHit = false, pageCacheReadMs = 0, pageCacheGeneration = null;

  if (cached.hit) {
    pageCacheHit = true;
    pageCacheReadMs = Number(cached.readMs) || 0;
    pageCacheGeneration = cached.manifest && cached.manifest.activeGeneration || null;
    active = cachedRuntimeFromManifest(cached.manifest);
    if (!startup) {
      cp = cached.byModule.cp.data.rows || [];
      cpModelColumns = cached.byModule.cp.data.cpModelColumns || [];
    }
    overviewSummary = startup ? (cached.byModule.overview.data.rows || []) : null;
    if (!startup) {
      orders = cached.byModule.orders.data.rows || [];
      orderSummary = orderSummaryFromCache(cached.byModule);
      const cachedCatalogData = cached.byModule['collection-catalog'].data || {};
      if (collectionCatalogProjectionComplete(cachedCatalogData)) {
        collectionCatalogs = cachedCatalogData.catalogs;
      } else {
        // Do not invalidate/rebuild every page projection for an old catalog
        // schema. Orders is already available in this cache hit, so rebuild
        // only the lightweight collection-catalog projection.
        collectionCatalogs = buildCollectionCatalogs(orders.length ? orders : (cached.byModule.overview.data.rows || []));
        try {
          await storeOnDemandProjection(currentUser, cached.ctx, 'collection-catalog', {
            catalogs: collectionCatalogs,
            catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION,
          }, active);
        } catch (cacheError) { logRuntimeFailure('collectionCatalogSchemaRepair', cacheError); }
      }
    }
  } else if (startup) {
    // Cold cache miss must not deserialize the complete raw snapshot on the UI
    // critical path.  Safe runtime metadata can still be read from the manifest;
    // the active Overview projection is rebuilt on demand after UI_READY.
    if (cached.manifest) active = cachedRuntimeFromManifest(cached.manifest);
  } else if (!sourceFilterRequired) {
    if (!active.asasOrders) await ensureDataLoaded(id);
    active = cacheForUser(id);
    const overridesForBuild = effectiveOverridesForUser(id);
    const cpDataAllowed = !currentUser || ['overview','cp','orders','koleksiyon','shipping','source'].some(area => userAccess.hasArea(currentUser, area));
    const orderSummaryDataAllowed = !currentUser || ['overview','backlog','source'].some(area => userAccess.hasArea(currentUser, area));
    const scoped = (target,rows) => currentUser ? userAccess.filterRowsByScope(currentUser, filterRowsByEffectiveHorizon(currentUser,target,rows)) : rows;
    const scopedCpSource = scoped('cp',ordersForTarget(active, 'cp', overridesForBuild));
    const scopedOrdersSource = scoped('orders',ordersForTarget(active, 'orders', overridesForBuild));
    const cpAntrepo=antrepoForTarget(active,'cp'),ordersAntrepo=antrepoForTarget(active,'orders');
    const projected=startup?null:buildCpAndOrdersProjectionRows(scopedCpSource,scopedOrdersSource,cpAntrepo,ordersAntrepo,overridesForBuild,cpDataAllowed);
    cp = startup ? null : projected.cpRows;
    orders = startup ? null : projected.ordersRows;
    orderSummary = startup ? null : (orderSummaryDataAllowed ? buildOrderSummaryRowsFromASAS(scopedCpSource, antrepoForTarget(active, 'cp'), overridesForBuild) : []);
    overviewSummary = startup && orderSummaryDataAllowed ? buildOverviewSummaryRowsFromASAS(scopedCpSource, overridesForBuild) : null;
    const accessForBuiltRow = row => canUserEditOrderCode(currentUser, row['Order Code']);
    (cp || []).forEach(row => { row._canEdit = Boolean(accessForBuiltRow(row)); });
    (orders || []).forEach(row => { row._canEdit = false; });
    (orderSummary || []).forEach(row => { row._canEdit = Boolean(accessForBuiltRow(row)); });
    collectionCatalogs = startup ? null : (cpDataAllowed ? buildCollectionCatalogs(orders) : {});
    cpModelColumns = startup ? null : (cpDataAllowed ? loadModelConnections().items.flatMap(item => (item.cpColumns || []).map(col => ({...col, role:item.role, connectionId:item.id, connectionName:item.name || item.catalog || item.server}))) : []);
    // Eski sürümden gelen kullanıcı snapshot'ı ilk kez açıldıysa hazır başlangıç
    // projeksiyonunu aynı istek içinde üret. Bir sonraki giriş raw snapshot'ı açmaz.
    const ctx = pageProjectionContext(currentUser);
    const projections = {};
    if (startup) projections.overview = { rows: overviewSummary || [] };
    else {
      projections.cp = { rows: cp, cpModelColumns };
      projections['collection-catalog'] = { catalogs: collectionCatalogs, catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION };
      projections.overview = { rows: buildOverviewSummaryRowsFromASAS(scopedCpSource, overridesForBuild) };
      projections.orders = { rows: orders || [] };
      projections['order-summary'] = { rows: orderSummary || [] };
    }
    try {
      await pageProjectionCache.writeGeneration(id, { contextHash: ctx.contextHash, sourceLoadedAt: active.loadedAt || null, projections, extra: { runtimeMeta: pageCacheRuntimeMeta(active),sourceRevisionKey:projectionSourceRevision(active) } });
    } catch (cacheError) { logRuntimeFailure('pageProjectionCacheWrite', cacheError); }
  }

  const sharedOverrides = loadOverrides();
  const sourceOverrides = active.cpupdateOverrides && typeof active.cpupdateOverrides === 'object'
    ? active.cpupdateOverrides : { submap: {}, suppfobmap: {}, suppfobmetamap: {} };
  const overrides = {
    ...sharedOverrides,
    submap: { ...(sourceOverrides.submap || {}), ...(sharedOverrides.submap || {}) },
    suppfobmap: { ...(sourceOverrides.suppfobmap || {}), ...(sharedOverrides.suppfobmap || {}) },
    suppfobmetamap: { ...(sourceOverrides.suppfobmetamap || {}), ...(sharedOverrides.suppfobmetamap || {}) },
  };
  const cpDataAllowed = !currentUser || ['overview','cp','orders','koleksiyon','shipping','source'].some(area => userAccess.hasArea(currentUser, area));
  const orderSummaryDataAllowed = !currentUser || ['overview','backlog','source'].some(area => userAccess.hasArea(currentUser, area));
  return {
    loadedAt: sourceFilterRequired ? null : active.loadedAt,
    hasCachedData: !sourceFilterRequired && Boolean(active.loadedAt),
    sourceFilterRequired,
    sourceFilterStatus: filterStatus,
    sourceFilterMessage: sourceFilterRequired ? sourceFilterReadinessMessage(filterStatus, 'tr') : '',
    sources: (() => { const value = { ...(active.sources || { asas: null, antrepo: null, lfl: null }) }; delete value.fabric; return value; })(),
    sourceFolder: sourceFolderForUser(id),
    cpupdateInfo: active.cpupdateInfo,
    fabricHeaderInfo: active.fabricHeaderInfo || null,
    antrepoHeaderInfo: active.antrepoHeaderInfo || null,
    antrepoSourceMode: ['database', 'dashboard'].includes(overrides.antrepoSourceMode) ? overrides.antrepoSourceMode : 'excel',
    asasSourceMode: overrides.asasSourceMode === 'database' ? 'database' : 'excel',
    lflSourceMode: overrides.lflSourceMode === 'database' ? 'database' : 'excel',
    warnings: Array.isArray(active.refreshWarnings) ? active.refreshWarnings : [],
    warningDetails: [...new Map([
      ...(Array.isArray(active.refreshWarningDetails) ? active.refreshWarningDetails : []),
      ...(active.fabricHeaderInfo && Array.isArray(active.fabricHeaderInfo.warningDetails) ? active.fabricHeaderInfo.warningDetails : []),
    ].map(detail => [`${String(detail && detail.id || '')}\u0000${String(detail && detail.message || '')}`, detail])).values()],
    excelRefresh: active.excelRefresh || null,
    modelRefresh: sourceFilterRequired ? null : (active.modelRefresh || null),
    lastRefreshResult: active.lastRefreshResult || null,
    pricingRules: Array.isArray(overrides.pricingRules) ? overrides.pricingRules : [],
    transitRules: Array.isArray(overrides.transitRules) ? overrides.transitRules : [],
    nonDtrManufacturers: BLBusinessRules.normalizeManufacturerList(overrides.nonDtrManufacturers),
    landedMultipliers: overrides.landedMultipliers || { tr: 1.05, overseas: 1.11 },
    freightRates: BLFreight.normalizeSettings(overrides.freightRates),
    noteColumns: Array.isArray(overrides.noteColumnDefs) ? overrides.noteColumnDefs : [],
    antrepoMatchRule: parseLib.normalizeAntrepoMatchRule(overrides.antrepoMatchRule),
    antrepoMatchConfig: parseLib.normalizeAntrepoMatchConfig(overrides.antrepoMatchConfig),
    storeRevisions: { overrides: Number(overrides._revision)||0, orders: Number(overrides._revisions&&overrides._revisions.orders)||0, suppFob: Number(overrides._revisions&&overrides._revisions.suppFob)||0, pricingRules: Number(overrides._revisions&&overrides._revisions.pricingRules)||0, transitRules: Number(overrides._revisions&&overrides._revisions.transitRules)||0, nonDtrManufacturers: Number(overrides._revisions&&overrides._revisions.nonDtrManufacturers)||0, landedMultipliers: Number(overrides._revisions&&overrides._revisions.landedMultipliers)||0, freightRates: Number(overrides._revisions&&overrides._revisions.freightRates)||0, antrepoMatchRule: Number(overrides._revisions&&overrides._revisions.antrepoMatchRule)||0, antrepoSourceMode: Number(overrides._revisions&&overrides._revisions.antrepoSourceMode)||0, asasSourceMode: Number(overrides._revisions&&overrides._revisions.asasSourceMode)||0, lflSourceMode: Number(overrides._revisions&&overrides._revisions.lflSourceMode)||0, noteColumnDefs: Number(overrides._revisions&&overrides._revisions.noteColumnDefs)||0, refreshHistory: Number(loadRefreshHistory(id)._revision)||0 },
    lflMeta: active.lflMeta || null,
    currentUser: currentUser ? userAccess.publicProfile(currentUser) : null,
    cp: startup ? null : (cpDataAllowed ? cp : []),
    orders: startup ? null : (cpDataAllowed ? (orders || []) : []),
    orderSummary: startup ? null : (orderSummaryDataAllowed ? (orderSummary || []) : []),
    overviewSummary: startup ? (orderSummaryDataAllowed ? (overviewSummary || []) : []) : null,
    ordersDeferred: startup && cpDataAllowed,
    orderSummaryDeferred: startup && orderSummaryDataAllowed,
    cpDeferred: startup && cpDataAllowed,
    collectionCatalogs: startup ? null : (cpDataAllowed ? collectionCatalogs : {}),
    collectionCatalogsDeferred: startup && cpDataAllowed,
    cpModelColumns: startup ? null : (cpDataAllowed ? cpModelColumns : []),
    overviewDeferred: startup && !cached.hit && !sourceFilterRequired,
    pageCache: { hit: pageCacheHit, readMs: pageCacheReadMs, generation: pageCacheGeneration },
  };
}

// Mevcut (bellekteki) veriyi döner; hiç yüklenmemişse diskten okur (Excel'i YENİLEMEDEN,
// sadece dosyadaki mevcut değerleri okur — hızlıdır, sayfa açılışında kullanılır).
app.get('/api/data', async (req, res) => {
  const started = process.hrtime.bigint();
  try {
    await localDbReadyPromise;
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const response = await buildResponse(req.currentUser, { startup: String(req.query.mode || '') === 'initial' });
    if (process.env.NODE_ENV !== 'production') {
      const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
      res.set('Server-Timing', `total;dur=${totalMs.toFixed(1)}, page-cache;dur=${Number(response.pageCache && response.pageCache.readMs || 0).toFixed(1)}`);
    }
    sendDateSafeJson(res, response);
  } catch (err) { apiError(res, err, 'Ana veri yüklenemedi. Kaynak dosyaları ve klasör erişimini kontrol edin.'); }
});

// Hazır projection'ı disk/RAM'deki gzip buffer olarak doğrudan yollar. Bu yol
// cache hit'te sunucuda gunzip -> JSON.parse -> stringify -> gzip zincirini
// tamamen kaldırır; tarayıcı standart Content-Encoding desteğiyle yalnız bir kez
// ayrıştırır. Context hash kontrolü kullanıcı/yetki/horizon izolasyonunu korur.
const PAGE_PROJECTION_AREAS = Object.freeze({ cp:'cp', overview:'overview', orders:'orders', 'collection-catalog':'koleksiyon' });
const PAGE_PROJECTION_TARGETS = Object.freeze({ cp:['cp'], overview:['cp'], orders:['orders'], 'collection-catalog':['cp'] });
function sendCompressedPageProjection(res, cached) {
  res.status(200);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Encoding', 'gzip');
  res.set('Vary', 'Accept-Encoding');
  res.set('Content-Length', String(cached.buffer.length));
  res.set('X-Page-Cache', cached.fallback ? 'fallback' : 'hit');
  res.set('X-Page-Cache-Generation', String(cached.manifest && cached.manifest.activeGeneration || ''));
  if (process.env.NODE_ENV !== 'production') {
    res.set('Server-Timing', `page-cache-read;dur=${Number(cached.ms || 0).toFixed(1)}, disk;dur=${Number(cached.diskReadMs || 0).toFixed(1)}`);
  }
  return res.end(cached.buffer);
}
app.get('/api/page-projection/:module', async (req, res) => {
  try {
    const module = String(req.params.module || ''), area = PAGE_PROJECTION_AREAS[module];
    if (!area) return res.status(404).json({ error:'Bilinmeyen page projection.', code:'PAGE_PROJECTION_UNKNOWN' });
    if (!userAccess.hasArea(req.currentUser, area)) return res.status(403).json({ error:'Bu alana erişim yetkiniz yok.', code:'AREA_FORBIDDEN' });
    const filterStatus = sourceFilterReadiness(PAGE_PROJECTION_TARGETS[module], req);
    if (!filterStatus.ready) return res.status(409).json({ error:sourceFilterReadinessMessage(filterStatus, 'tr'), code:'SOURCE_FILTER_REQUIRED', sourceFilterStatus:filterStatus });
    const ctx = pageProjectionContext(req.currentUser);
    const cached = await pageProjectionCache.readProjectionCompressed(ctx.id, module, ctx.contextHash);
    if (!cached||!pageProjectionMatchesRuntime(cached.manifest,cacheForUser(ctx.id))) return res.status(404).json({ error:'Hazır ekran önbelleği bulunamadı.', code:'PAGE_CACHE_MISS' });
    return sendCompressedPageProjection(res, cached);
  } catch (err) { apiError(res, err, 'Hazır ekran önbelleği okunamadı.'); }
});

const pageProjectionBuildInFlight = new Map();
async function singleFlightPageProjection(currentUser, module, builder) {
  const ctx = pageProjectionContext(currentUser), key = `${ctx.id}\u0000${ctx.contextHash}\u0000${module}`;
  if (pageProjectionBuildInFlight.has(key)) return pageProjectionBuildInFlight.get(key);
  const promise = Promise.resolve().then(() => builder(ctx)).finally(() => {
    if (pageProjectionBuildInFlight.get(key) === promise) pageProjectionBuildInFlight.delete(key);
  });
  pageProjectionBuildInFlight.set(key, promise);
  return promise;
}
async function storeOnDemandProjection(currentUser, ctx, module, value, runtime) {
  const manifest=pageProjectionCache.loadManifest(ctx.id);
  let saved=manifest&&pageProjectionMatchesRuntime(manifest,runtime)
    ?await pageProjectionCache.writeProjection(ctx.id,module,ctx.contextHash,value):null;
  if (!saved) {
    await pageProjectionCache.writeGeneration(ctx.id, {
      contextHash:ctx.contextHash, sourceLoadedAt:runtime.loadedAt || null,
      projections:{ [module]:value }, extra:{ runtimeMeta:pageCacheRuntimeMeta(runtime),sourceRevisionKey:projectionSourceRevision(runtime) },
    });
  }
  return value;
}
app.get('/api/data/overview', userAccess.requireArea('overview'), async (req, res) => {
  try {
    const value = await singleFlightPageProjection(req.currentUser, 'overview', async ctx => {
      const runtime = cacheForUser(ctx.id); if (!runtime.asasOrders) await ensureDataLoaded(ctx.id);
      const active = cacheForUser(ctx.id), overrides = effectiveOverridesForUser(ctx.id);
      const cached = await pageProjectionCache.readProjection(ctx.id, 'overview', ctx.contextHash);
      if (cached&&pageProjectionMatchesRuntime(cached.manifest,active)) return cached.data;
      const scoped = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'cp',ordersForTarget(active, 'cp', overrides)));
      const rows = buildOverviewSummaryRowsFromASAS(scoped, overrides);
      return storeOnDemandProjection(req.currentUser, ctx, 'overview', { rows }, active);
    });
    sendDateSafeJson(res, value);
  } catch (err) { apiError(res, err, 'Genel Bakış verisi yüklenemedi.'); }
});
app.get('/api/data/cp', userAccess.requireArea('cp'), async (req, res) => {
  try {
    const value = await singleFlightPageProjection(req.currentUser, 'cp', async ctx => {
      const runtime = cacheForUser(ctx.id); if (!runtime.asasOrders) await ensureDataLoaded(ctx.id);
      const active = cacheForUser(ctx.id), overrides = effectiveOverridesForUser(ctx.id);
      const cached = await pageProjectionCache.readProjection(ctx.id, 'cp', ctx.contextHash);
      if (cached&&pageProjectionMatchesRuntime(cached.manifest,active)) return cached.data;
      const scoped = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'cp',ordersForTarget(active, 'cp', overrides)));
      const rows = buildCPRowsFromASAS(scoped, antrepoForTarget(active, 'cp'), overrides);
      rows.forEach(row => { row._canEdit = Boolean(canUserEditOrderCode(req.currentUser, row['Order Code'])); });
      const cpModelColumns = loadModelConnections().items.flatMap(item => (item.cpColumns || []).map(col => ({...col, role:item.role, connectionId:item.id, connectionName:item.name || item.catalog || item.server})));
      return storeOnDemandProjection(req.currentUser, ctx, 'cp', { rows, cpModelColumns }, active);
    });
    sendDateSafeJson(res, value);
  } catch (err) { apiError(res, err, 'CP verisi yüklenemedi.'); }
});

app.get('/api/data/collection-catalog', userAccess.requireArea('koleksiyon'), async (req, res) => {
  try {
    const value = await singleFlightPageProjection(req.currentUser, 'collection-catalog', async ctx => {
      const runtime = cacheForUser(ctx.id); if (!runtime.asasOrders) await ensureDataLoaded(ctx.id);
      const active = cacheForUser(ctx.id), overrides = effectiveOverridesForUser(ctx.id);
      const cached = await pageProjectionCache.readProjection(ctx.id, 'collection-catalog', ctx.contextHash);
      if (cached
        && pageProjectionMatchesRuntime(cached.manifest,active)
        && collectionCatalogProjectionComplete(cached.data)) return cached.data;
      const scoped = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'cp',ordersForTarget(active, 'cp', overrides)));
      const catalogs = buildCollectionCatalogs(buildOverviewSummaryRowsFromASAS(scoped, overrides));
      return storeOnDemandProjection(req.currentUser, ctx, 'collection-catalog', {
        catalogs,
        catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION,
      }, active);
    });
    sendDateSafeJson(res, value);
  } catch (err) { apiError(res, err, 'Koleksiyon filtre kataloğu yüklenemedi.'); }
});

// Historical Orders is the largest projection. It is not needed on Overview or CP,
// so build and transfer it only when the user opens the Orders page.
app.get('/api/data/orders', userAccess.requireArea('orders'), async (req, res) => {
  try {
    const id = sourceUserId(req), filterStatus = sourceFilterReadiness(['orders'], req);
    if (!filterStatus.ready) {
      return sendDateSafeJson(res, {
        orders: [], collectionCatalogs: {}, sourceFilterRequired: true,
        sourceFilterStatus: filterStatus,
        sourceFilterMessage: sourceFilterReadinessMessage(filterStatus, 'tr'),
      });
    }
    const ctx = pageProjectionContext(req.currentUser);
    const [cachedOrders, cachedCatalog] = await Promise.all([
      pageProjectionCache.readProjection(id, 'orders', ctx.contextHash),
      pageProjectionCache.readProjection(id, 'collection-catalog', ctx.contextHash),
    ]);
    const loadedRuntime=cacheForUser(id);
    if (cachedOrders&&pageProjectionMatchesRuntime(cachedOrders.manifest,loadedRuntime)) {
      const runtimeMeta = cachedRuntimeFromManifest(cachedOrders.manifest);
      const cachedOrderRows = cachedOrders.data.rows || [];
      let collectionCatalogs;
      let catalogReadMs = Number(cachedCatalog&&cachedCatalog.ms)||0;
      if (cachedCatalog
        && pageProjectionMatchesRuntime(cachedCatalog.manifest,loadedRuntime)
        && collectionCatalogProjectionComplete(cachedCatalog.data)) {
        collectionCatalogs = cachedCatalog.data.catalogs;
      } else {
        collectionCatalogs = buildCollectionCatalogs(cachedOrderRows);
        try {
          await storeOnDemandProjection(req.currentUser,ctx,'collection-catalog',{
            catalogs: collectionCatalogs,
            catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION,
          },loadedRuntime);
        } catch (cacheError) { logRuntimeFailure('ordersCollectionCatalogSchemaRepair', cacheError); }
        catalogReadMs = 0;
      }
      return sendDateSafeJson(res, {
        loadedAt: runtimeMeta.loadedAt,
        sources: runtimeMeta.sources || {},
        orders: cachedOrderRows,
        collectionCatalogs,
        pageCache: { hit: true, readMs: (Number(cachedOrders.ms)||0) + catalogReadMs, generation: cachedOrders.manifest.activeGeneration },
      });
    }
    const runtime = cacheForUser(id);
    if (!runtime.asasOrders) await ensureDataLoaded(id);
    const active = cacheForUser(id), overrides = effectiveOverridesForUser(id);
    const scopedOrders = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'orders',ordersForTarget(active, 'orders', overrides)));
    const orders = buildOrdersRowsFromASAS(scopedOrders, antrepoForTarget(active, 'orders'), overrides);
    orders.forEach(row => { row._canEdit = false; });
    const scopedCp = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'cp',ordersForTarget(active, 'cp', overrides)));
    const orderSummary = buildOrderSummaryRowsFromASAS(scopedCp, antrepoForTarget(active, 'cp'), overrides);
    orderSummary.forEach(row => { row._canEdit = Boolean(canUserEditOrderCode(req.currentUser, row['Order Code'])); });
    const catalogs = buildCollectionCatalogs(orders);
    try {
      await storeOnDemandProjection(req.currentUser,ctx,'orders',{rows:orders},active);
      await storeOnDemandProjection(req.currentUser,ctx,'order-summary',{rows:orderSummary},active);
      await storeOnDemandProjection(req.currentUser,ctx,'collection-catalog',{
        catalogs,
        catalogSchemaVersion: COLLECTION_CATALOG_SCHEMA_VERSION,
      },active);
    } catch (cacheError) { logRuntimeFailure('ordersPageCacheWrite', cacheError); }
    sendDateSafeJson(res, { loadedAt: active.loadedAt, sources: active.sources || {}, orders, collectionCatalogs: catalogs, pageCache: { hit: false } });
  } catch (err) { apiError(res, err, 'Siparişler verisi yüklenemedi.'); }
});

// Backlog raporunu farklı retail tarih aralığı / buyer grup / gruplama boyutlarıyla
// yeniden hesaplar (dosyaları tekrar okumaz, bellekteki son veriyi kullanır — hızlıdır).
const backlogSourceFieldsInFlight = new Map();
function rowsHaveSourceFields(rows) {
  return Array.isArray(rows) && rows.some(row => row && row._sourceFields && Object.keys(row._sourceFields).length);
}
function antrepoHasSourceFields(map) {
  if (!map || typeof map !== 'object') return false;
  return Object.keys(map).some(key => {
    const value = map[key], rows = Array.isArray(value) ? value : [value];
    return rowsHaveSourceFields(rows);
  });
}
async function ensureBacklogSourceFields(value) {
  const id = sourceUserId(value);
  if (backlogSourceFieldsInFlight.has(id)) return backlogSourceFieldsInFlight.get(id);
  const job = (async () => {
    const runtime = cacheForUser(id), overrides = effectiveOverridesForUser(id);
    const asasRows = ordersForTarget(runtime, 'backlog', overrides);
    const antrepoMap = antrepoForTarget(runtime, 'backlog');
    const asasMode = overrides.asasSourceMode === 'database' ? 'database' : 'excel';
    const antrepoMode = ['database', 'dashboard'].includes(overrides.antrepoSourceMode) ? overrides.antrepoSourceMode : 'excel';
    let changed = false;
    if (asasMode === 'excel' && !rowsHaveSourceFields(asasRows)) {
      try {
        const parsed = await loadAsasFromExcel(id, overrides.antrepoMatchConfig, { refreshBeforeRead: false });
        runtime.asasOrdersByTarget = { ...(runtime.asasOrdersByTarget || {}), backlog: parsed.orders };
        changed = true;
      } catch (err) { console.warn(`[backlog] ASAS ham başlıkları hazırlanamadı (${id}):`, err.message); }
    }
    if (antrepoMode === 'excel' && !antrepoHasSourceFields(antrepoMap)) {
      try {
        const parsed = await loadAntrepoFromExcel(id, overrides.antrepoMatchConfig, { refreshBeforeRead: false });
        runtime.antrepoMapByTarget = { ...(runtime.antrepoMapByTarget || {}), backlog: parsed.map };
        runtime.antrepoHeaderInfo = parsed.meta || runtime.antrepoHeaderInfo;
        changed = true;
      } catch (err) { console.warn(`[backlog] Antrepo ham başlıkları hazırlanamadı (${id}):`, err.message); }
    }
    if (changed) await saveRuntimeModelSnapshot(id, runtime);
  })().finally(() => backlogSourceFieldsInFlight.delete(id));
  backlogSourceFieldsInFlight.set(id, job);
  return job;
}

app.get('/api/backlog', userAccess.requireArea('backlog'), async (req, res) => {
  try {
    const id = sourceUserId(req), filterStatus = sourceFilterReadiness(['backlog'], req);
    const { retailFrom, retailTo, inStoreFrom, inStoreTo, buyerGrup, groupBy, dimFilters, antrepoFrom, antrepoTo, antrepoDateLevels } = req.query;
    const dims = groupBy ? String(groupBy).split(',').filter(Boolean) : [];
    const dateLevels = antrepoDateLevels ? String(antrepoDateLevels).split(',').filter(Boolean) : undefined;
    let parsedDimFilters = {};
    if (dimFilters) { try { parsedDimFilters = JSON.parse(dimFilters); } catch { parsedDimFilters = {}; } }
    const params = { retailFrom:retailFrom||'', retailTo:retailTo||'', inStoreFrom:inStoreFrom||'', inStoreTo:inStoreTo||'', buyerGrup:buyerGrup||'', groupBy:dims, dimFilters:parsedDimFilters, antrepoFrom:antrepoFrom||'', antrepoTo:antrepoTo||'', antrepoDateLevels:dateLevels||[] };
    if (!filterStatus.ready) {
      const overrides = loadOverrides();
      const emptyReport = buildBacklogGrouped([], {}, overrides, params);
      return sendDateSafeJson(res, { ...emptyReport, sourceFilterRequired: true, sourceFilterStatus: filterStatus, sourceFilterMessage: sourceFilterReadinessMessage(filterStatus, 'tr') });
    }
    const ctx = pageProjectionContext(req.currentUser), key = backlogCacheKey(params);
    const cached = await pageProjectionCache.readBacklog(id, ctx.contextHash, key);
    if (cached) return sendDateSafeJson(res, { ...cached.data, pageCache: { hit:true, readMs:Number(cached.ms)||0, generation:cached.manifest.activeGeneration } });
    const runtime = cacheForUser(id);
    if (!runtime.asasOrders) await ensureDataLoaded(id);
    await ensureBacklogSourceFields(id);
    const active = cacheForUser(id), overrides = effectiveOverridesForUser(id);
    const scopedBacklog = userAccess.filterRowsByScope(req.currentUser, filterRowsByEffectiveHorizon(req.currentUser,'backlog',ordersForTarget(active, 'backlog', overrides)));
    const report = buildBacklogGrouped(scopedBacklog, antrepoForTarget(active, 'backlog'), overrides, params);
    try { await pageProjectionCache.writeBacklog(id, ctx.contextHash, key, report); }
    catch (cacheError) { logRuntimeFailure('backlogPageCacheWrite', cacheError); }
    sendDateSafeJson(res, { ...report, pageCache: { hit:false } });
  } catch (err) { apiError(res, err, 'Backlog raporu hesaplanamadı.'); }
});


const BACKLOG_TEMPLATE_HEADERS = [
  'Sezon','Sipariş Yerleştirme MerchTarih','Siparişin Üretildiği Ülke','Buyer','Buyer Grup (TR)','Lisans','Üretici','Alt Üretici','Line','Ürün Klasman','Sipariş Kod','Özel Kod 1','Model Adı','Renk Kod','Renk','Orijinal Exfactory Merch Ay','Orijinal Exfactory Merch Tarih','Retail Depo Merch Yil Ay','Retail Depo Tarih Yıl Ay Gün','Model Bütçe Merch Yil Ay','Model Bütçe Tarih Yıl Ay Gün','Model Bütçe Yil Hafta','Retail Depo Merch Yil Hafta','Net Alım Sipariş Miktarı','Adet','Gelen Alım Sipariş Miktarı Merkez Sevke Hazır Depo','Kalan Alım Sipariş Miktarı','FOB Fiyatı','Net Gelen Alım Sipariş Miktarı','Kalan Alım Sipariş Miktarı_Merkez Sevke Hazır Depo','GÜNCEL DURUM\n(STATUS)','REVİZE YÜKLEME TARİHİ\n(EX-FACTORY)','ANTREPO GİRİŞ TARİHİ','YÜKLEME TİPİ','ANTREPO-RETAIL','Üretici Tükleme Tipi Teyidi','RİSK\n(PRIORITY)','buying note'
];

// Backlog Excel Ayarları'ndaki "Sütun Ekle" kataloğu. Kaynak of truth AKTİF ASAS /
// Antrepo kaynağının GERÇEK sütun başlıklarıdır: katalog burada her istekte ham
// _sourceFields başlıklarından yeniden üretilir, bu yüzden veritabanı şemasına yeni
// bir sütun geldiğinde uygulama koduna hiçbir isim eklemek gerekmez.
// /api/backlog yanıtındaki customDimensions'a güvenilmez; o yanıt sayfa cache'inden
// (ham başlıklar hazırlanmadan önce yazılmış olabilir) veya kaynak filtresi hazır
// değilken boş raporla dönebilir.
app.get('/api/backlog-source-columns', userAccess.requireArea('backlog'), async (req,res)=>{
  try{
    assertSourceFilters(['backlog'], req);
    const id=sourceUserId(req),runtime=cacheForUser(id);
    if(!runtime.asasOrders) await loadFromDisk(id,false);
    await ensureBacklogSourceFields(id);
    const active=cacheForUser(id),overrides=effectiveOverridesForUser(id);
    const backlogOrders=userAccess.filterRowsByScope(req.currentUser,ordersForTarget(active,'backlog',overrides));
    const columns=parseLib.backlogCustomDimensionContext(backlogOrders,antrepoForTarget(active,'backlog')).customDimensions;
    sendDateSafeJson(res,{columns,defaultHeaders:BACKLOG_TEMPLATE_HEADERS});
  }catch(err){apiError(res,err,'Backlog kaynak sütunları listelenemedi.');}
});

app.get('/api/backlog-export', userAccess.requireArea('backlog'), async (req,res)=>{
  try{
    assertSourceFilters(['backlog'], req);
    const id=sourceUserId(req),runtime=cacheForUser(id);
    if(!runtime.asasOrders) await loadFromDisk(id,false);
    await ensureBacklogSourceFields(id);
    const active=cacheForUser(id),overrides=effectiveOverridesForUser(id);
    const {retailFrom,retailTo,inStoreFrom,inStoreTo,buyerGrup,groupBy,dimFilters,antrepoFrom,antrepoTo,antrepoDateLevels}=req.query;
    const dims=groupBy?String(groupBy).split(',').filter(Boolean):[];
    const dateLevels=antrepoDateLevels?String(antrepoDateLevels).split(',').filter(Boolean):undefined;
    let parsedDimFilters={}; if(dimFilters){try{parsedDimFilters=JSON.parse(dimFilters);}catch{}}
    const filterOpts={retailFrom,retailTo,inStoreFrom,inStoreTo,buyerGrup,groupBy:dims,dimFilters:parsedDimFilters,antrepoFrom,antrepoTo,antrepoDateLevels:dateLevels};
    const backlogOrders=userAccess.filterRowsByScope(req.currentUser,ordersForTarget(active,'backlog',overrides));
    const backlogAntrepo=antrepoForTarget(active,'backlog');
    // Excel detayı Backlog ekranıyla AYNI hedef kapsamını ve AYNI aktif filtreleri
    // kullanır. CP'nin birincil cache'i bu akışa kesinlikle karışmaz.
    const sourceCatalog=parseLib.backlogCustomDimensionContext(backlogOrders,backlogAntrepo).customDimensions;
    const requestedIds=String(req.query.sourceColumns||'').split(',').map(value=>value.trim()).filter(Boolean);
    const sourceById=new Map(sourceCatalog.map(column=>[column.id,column]));
    const sourceColumns=requestedIds.map(id=>sourceById.get(id)).filter(Boolean);
    const previewLimit=Math.min(500,Math.max(0,Number(req.query.previewLimit)||0));
    const detailRows=buildBacklogTemplateRows(backlogOrders,backlogAntrepo,overrides,filterOpts,sourceColumns,previewLimit?{limit:previewLimit}:{});
    const exportHeaders=[...BACKLOG_TEMPLATE_HEADERS,...sourceColumns.map(column=>column.label)];
    // format=json: satırlar istemciye gider, Excel istemcide CP ile AYNI stil motoruyla üretilir.
    if(req.query.format==='json'){
      return sendDateSafeJson(res, { headers: exportHeaders, rows: detailRows, totalRows:detailRows.totalRows||detailRows.length, sourceColumns, sourceCatalog });
    }
    const workerResult=await runExcelTask('writeBacklogWorkbook',{headers:exportHeaders,detailRows,templatePath:path.join(__dirname,'templates','BACKLOG.xlsx')},{timeoutMs:300000});
    const buffer=Buffer.from(workerResult.data);
    const d=new Date(),p=x=>String(x).padStart(2,'0');
    const name=`Backlog_Report_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
    res.send(buffer);
  }catch(err){apiError(res,err,'Backlog Excel raporu oluşturulamadı.');}
});

// Backlog pivot'unda bir düğüme tıklanınca veya CP/Siparişler sayfasında seçili
// siparişler için rapor istendiğinde aynı operasyon satırı detayını döner.
app.post('/api/backlog-detail', userAccess.requireAnyArea('backlog','cp','orders'), async (req, res) => {
  try {
    const body = req.body || {};
    const selectionRequest = Array.isArray(body.identities) && body.identities.length > 0;
    const sourceTarget = selectionRequest && body.sourceTarget === 'orders' ? 'orders' : (selectionRequest ? 'cp' : 'backlog');
    if (!req.currentUser || !userAccess.hasArea(req.currentUser, sourceTarget)) {
      return res.status(403).json({ error: 'Bu Backlog detay kaynağına erişim yetkiniz bulunmuyor.', code: 'ACCESS_AREA_REQUIRED' });
    }
    assertSourceFilters([sourceTarget], req);
    const id=sourceUserId(req),runtime=cacheForUser(id);
    if (!runtime.asasOrders) await ensureDataLoaded(id);
    if (sourceTarget === 'backlog') await ensureBacklogSourceFields(id);
    const active=cacheForUser(id),overrides = effectiveOverridesForUser(id);
    // v4.32: düğüm YOLU + pivotun filtre seçenekleri gönderilir; sunucu aynı ağacı
    // kurup o düğümün satırlarını döner. CP/Siparişler seçimi tam
    // Sipariş Kod + Model Adı + Renk Kod kimlikleriyle çözülür.
    let selector;
    if (selectionRequest) {
      const identities=body.identities.slice(0,5000).map(item=>({
        orderCode:item && item.orderCode,
        modelName:item && item.modelName,
        colourCode:item && item.colourCode,
      }));
      selector={identities};
    } else if (body.path != null) {
      let dimFilters = body.dimFilters;
      if (typeof dimFilters === 'string') { try { dimFilters = JSON.parse(dimFilters); } catch (e) { dimFilters = {}; } }
      const list = value => (Array.isArray(value) ? value : (value ? String(value).split(',') : [])).filter(Boolean);
      selector = {
        path: String(body.path),
        retailFrom: body.retailFrom || '', retailTo: body.retailTo || '',
        inStoreFrom: body.inStoreFrom || '', inStoreTo: body.inStoreTo || '',
        antrepoFrom: body.antrepoFrom || '', antrepoTo: body.antrepoTo || '',
        buyerGrup: list(body.buyerGrup),
        groupBy: list(body.groupBy),
        antrepoDateLevels: list(body.antrepoDateLevels),
        dimFilters: dimFilters && typeof dimFilters === 'object' ? dimFilters : {},
      };
    } else if (Array.isArray(body.ocodes) && body.ocodes.length) {
      selector = body.ocodes;
    } else {
      return res.status(400).json({ error: 'path, identities veya ocodes zorunlu.' });
    }
    sendDateSafeJson(res, {
      headers: BACKLOG_TEMPLATE_HEADERS,
      rows: buildBacklogDetailRows(
        ordersForTarget(active, sourceTarget, overrides),
        antrepoForTarget(active, sourceTarget),
        overrides,
        selector,
        {includeInternalMeta:true}
      )
    });
  } catch (err) { apiError(res, err, 'Backlog detayları alınamadı.'); }
});

app.get('/api/refresh-history', userAccess.requireArea('source'), (req, res) => {
  try { sendDateSafeJson(res, loadRefreshHistory(sourceUserId(req))); }
  catch (err) { apiError(res, err, 'ASAS & ANTREPO geçmişi okunamadı.'); }
});
app.delete('/api/refresh-history', userAccess.requireArea('source'), (req, res) => {
  try { sendDateSafeJson(res, clearRefreshHistory(requestRevision(req), sourceUserId(req))); }
  catch (err) { apiError(res, err, 'ASAS & ANTREPO geçmişi tamamen silinemedi.'); }
});
app.delete('/api/refresh-history/:id', userAccess.requireArea('source'), (req, res) => {
  try { sendDateSafeJson(res, deleteRefreshHistory(req.params.id, requestRevision(req), sourceUserId(req))); }
  catch (err) { apiError(res, err, 'ASAS & ANTREPO geçmişi kaydı silinemedi.'); }
});


// Hedefe göre veri kümesi. Bir bağlantı CP, Siparişler ve Backlog için ayrı kapsamlar
// tanımladıysa her sayfa kendi sorgusunun sonucunu görür; aynı kapsam paylaşılıyorsa
// ilgili sayfalar aynı veri kümesini kullanır.
// Elle revize edilen tarihler (overrides.datemap) burada uygulanır: böylece CP,
// Sipariş Özeti ve Backlog aynı tarihleri görür ve model yenilemesi revizyonu ezmez.
function ordersForTarget(active, target, overrides) {
  const byTarget = active && active.asasOrdersByTarget;
  const rows = byTarget && Array.isArray(byTarget[target]) ? byTarget[target] : null;
  return applyDateOverrides(rows || active.asasOrders || [], overrides);
}
function antrepoForTarget(active, target) {
  const byTarget = active && active.antrepoMapByTarget;
  const map = byTarget && byTarget[target] && typeof byTarget[target] === 'object' ? byTarget[target] : null;
  return map || active.antrepoMap || {};
}

/* Planlanan & Gerçekleşen Analizi snapshot'ı.
   Backlog'un KENDİ hedef veri kümesi ve effective override'ları kullanılır;
   analiz için ikinci bir veri modeli kurulmaz. Snapshot sipariş/model/renk
   düzeyinde kompaktlaştırılır ve store yalnız delta yazar. */
async function captureBacklogPlanActualSnapshot(id, runtime, overrides) {
  const active = runtime || cacheForUser(id);
  if (!active || !active.loadedAt || !Array.isArray(active.asasOrders)) return null;
  const effective = overrides || effectiveOverridesForUser(id);
  const orders = ordersForTarget(active, 'backlog', effective);
  const antrepo = antrepoForTarget(active, 'backlog');
  const templateRows = buildBacklogTemplateRows(orders, antrepo, effective, {}, [], {});
  const snapshot = backlogPlanActual.projectSnapshot(orders, templateRows, {
    capturedAt: new Date().toISOString(),
    sourceGenerationId: active.modelRefresh && active.modelRefresh.sourceGenerationId || active.loadedAt || '',
  });
  return backlogPlanActual.appendSnapshot(id, snapshot);
}

async function ensureBacklogPlanActualArchive(id) {
  let archive = await backlogPlanActual.readArchive(id);
  if (archive && archive.base) return archive;
  const runtime = cacheForUser(id);
  if (!runtime.loadedAt) await ensureDataLoaded(id);
  const hydrated = cacheForUser(id);
  if (hydrated.loadedAt) await captureBacklogPlanActualSnapshot(id, hydrated, effectiveOverridesForUser(id));
  archive = await backlogPlanActual.readArchive(id);
  return archive;
}

app.get('/api/backlog-plan-actual', userAccess.requireArea('backlog'), async (req, res) => {
  try {
    assertSourceFilters(['backlog'], req);
    const id = sourceUserId(req);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const fromMs = Date.parse(from), toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return res.status(400).json({ error:'Geçerli bir başlangıç ve bitiş zamanı seçin.' });
    }

    const archive = await ensureBacklogPlanActualArchive(id);
    const resolved = backlogPlanActual.resolveRange(archive, from, to);
    if (!resolved.start || !resolved.end) {
      return sendDateSafeJson(res, {
        requested:{ from, to }, coverage:resolved.coverage || null, resolved:{ start:null, end:null },
        summary:null, changes:[], activity:[], catalogs:{}, message:'Henüz karşılaştırılabilir Backlog snapshotı yok.'
      });
    }

    // Yetki filtresi snapshot farkından ÖNCE uygulanır. Böylece kullanıcı
    // geçmişte bugün erişemediği Buyer/MAG/MMYG/Buying Group satırlarını da göremez.
    const startRows = userAccess.filterRowsByScope(req.currentUser, resolved.start.rows);
    const endRows = userAccess.filterRowsByScope(req.currentUser, resolved.end.rows);

    // Refresh History Kaynak Veri alanına ait ayrı bir UI olabilir; bu API onu
    // doğrudan açmaz. Yalnız analiz aralığındaki detaylar alınır ve aynı Backlog
    // veri yetkisiyle süzülür.
    const historyStore = loadRefreshHistory(id);
    const scopedHistory = {
      items:(Array.isArray(historyStore && historyStore.items) ? historyStore.items : []).map(item => ({
        ...item,
        details:userAccess.filterRowsByScope(req.currentUser, Array.isArray(item && item.details) ? item.details : []),
      })),
    };
    const activityResult = backlogPlanActual.collapseHistory(
      scopedHistory.items,
      resolved.start.capturedAt,
      resolved.end.capturedAt
    );
    const comparison = backlogPlanActual.compareSnapshots(startRows, endRows, {
      from, to, activity:activityResult.activity,
    });
    const catalogRows = [
      ...comparison.changes,
      ...activityResult.activity,
    ];
    return sendDateSafeJson(res, {
      requested:{ from, to },
      coverage:resolved.coverage,
      resolved:{
        start:{ capturedAt:resolved.start.capturedAt, sourceGenerationId:resolved.start.sourceGenerationId || '' },
        end:{ capturedAt:resolved.end.capturedAt, sourceGenerationId:resolved.end.sourceGenerationId || '' },
      },
      summary:comparison.summary,
      changes:comparison.changes,
      activity:activityResult.activity,
      catalogs:backlogPlanActual.catalogsFromRows(catalogRows),
    });
  } catch (err) {
    apiError(res, err, 'Planlanan & Gerçekleşen Analizi oluşturulamadı.');
  }
});

const refreshInFlight = new Set();
// "Yenile" Data Model Connection ekranındaki aktif ASAS / Antrepo bağlantılarını
// doğrudan sorgular. Kaynak klasördeki Excel dosyaları bu akışta kullanılmaz.
/* --- Arka planda yenileme ---------------------------------------------------
 * Model sorgusu uzun sürebiliyor ve kullanıcı bu süre boyunca uygulamayı hiç
 * kullanamıyordu. Artık Yenile işi arka planda başlar ve istek hemen döner:
 * ekrandaki veriler (son anlık görüntü) kullanılmaya devam eder, iş bittiğinde
 * yeni veri sessizce yerine geçer.
 *
 * Bu, sorguyu hızlandırmaz — BEKLEMEYİ ortadan kaldırır. Sorgunun kendisi
 * yavaşsa süre dökümü (sunucu / yazma / ayrıştırma) hâlâ onu gösterir.
 */
const refreshJobs = new Map();

function recordRefreshTelemetry(id, event = {}) {
  const type = event.type === 'end' ? 'end' : 'start';
  const timestampMs = Number(event.timestampMs) || Date.now();
  const timestamp = new Date(timestampMs).toISOString();
  const connection = String(event.connection || 'Refresh');
  const operation = String(event.operation || 'operation');
  const category = String(event.category || 'wait');
  const durationMs = Math.max(0, Number(event.durationMs) || 0);
  const error = event.error ? String(event.error).replace(/\s+/g, ' ').slice(0, 500) : '';
  if (type === 'start') console.log(`[${timestamp}] [${connection}] [${operation}] START category=${category}`);
  else console.log(`[${timestamp}] [${connection}] [${operation}] END duration=${durationMs}ms category=${category}${error ? ` error=${error}` : ''}`);

  const job = refreshJobs.get(id);
  if (!job) return;
  if (!Array.isArray(job.operations)) job.operations = [];
  job.operations.push({ type, timestamp, timestampMs, connection, operation, category, durationMs:type === 'end' ? durationMs : null, error:error || null });
  if (job.operations.length > 400) job.operations.splice(0, job.operations.length - 400);
}

function createRefreshTelemetry(id) {
  return event => {
    if (!event || event.type !== 'measure') return recordRefreshTelemetry(id, event);
    const startedMs = Number(event.timestampMs) || Date.now();
    const durationMs = Math.max(0, Number(event.durationMs) || 0);
    recordRefreshTelemetry(id, { ...event, type:'start', timestampMs:startedMs });
    recordRefreshTelemetry(id, { ...event, type:'end', timestampMs:startedMs + durationMs, durationMs });
  };
}

async function runRefreshTelemetry(telemetry, connection, operation, category, task) {
  const startedMs = Date.now();
  if (typeof telemetry === 'function') telemetry({ type:'start', connection, operation, category, timestampMs:startedMs });
  try {
    const result = await task();
    if (typeof telemetry === 'function') telemetry({ type:'end', connection, operation, category, timestampMs:Date.now(), durationMs:Date.now() - startedMs });
    return result;
  } catch (error) {
    if (typeof telemetry === 'function') telemetry({ type:'end', connection, operation, category, timestampMs:Date.now(), durationMs:Date.now() - startedMs, error:String(error && error.message || error) });
    throw error;
  }
}

function refreshJobState(id) {
  const job = refreshJobs.get(id);
  if (!job) return { running: false, phase: 'idle', jobId: null };
  return {
    jobId: job.jobId || null,
    running: Boolean(job.running),
    phase: job.phase || 'idle',
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.running ? Date.now() - job.startedMs : (job.elapsedMs || 0),
    error: job.error || null,
    errorCode: job.errorCode || null,
    repairAction: job.repairAction || null,
    summary: job.summary || null,
    sourceRequest:job.sourceRequest||null,
    connections: job.connections || null,
    operations: Array.isArray(job.operations) ? job.operations.slice(-400) : [],
    // Aşama dökümü: sayaç panelinde adım adım gösterilir.
    phases: Array.isArray(job.phases) ? job.phases.map(item => ({
      phase: item.phase,
      startedAt: item.startedAt,
      ms: item.ms != null ? item.ms : (job.running ? Date.now() - item.startedMs : 0),
      running: item.endedMs == null && Boolean(job.running),
    })) : [],
    loadedAt: job.loadedAt || null,
    requestedTargets: Array.isArray(job.requestedTargets) ? job.requestedTargets : null,
    cancelable: Boolean(job.running && !job.commitStarted),
    cancelRequested: Boolean(job.cancelRequested),
    dashboard: job.dashboard || null,
    metrics: job.metrics || null,
  };
}

function markRefreshJobPhase(id,phase){
  const job=refreshJobs.get(id);if(!job||!job.running)return;
  const now=Date.now();if(!Array.isArray(job.phases))job.phases=[];
  const previous=job.phases[job.phases.length-1];
  if(previous&&previous.phase===phase&&!previous.endedMs)return;
  if(previous&&!previous.endedMs){previous.endedMs=now;previous.ms=now-previous.startedMs;}
  job.phase=phase;job.phases.push({phase,startedMs:now,startedAt:new Date(now).toISOString(),endedMs:null,ms:null});
}

async function performRefresh(id, currentUser, targets = null, options = {}) {
  // Aşama işaretleri (v5.89): sayaca tıklandığında yenilemenin hangi adımda
  // olduğu ve her adımın kaç saniye sürdüğü gösterilebilsin diye her geçiş
  // zaman damgasıyla kaydedilir. Bağlantı bazlı süre dökümü (sunucu / yazma /
  // ayrıştırma) yalnız sorgular bittikten sonra oluşur; bu işaretler aradaki
  // süreyi de görünür kılar.
  const markPhase=phase=>markRefreshJobPhase(id,phase);
  const job = refreshJobs.get(id);
  const telemetry = createRefreshTelemetry(id);
  const signal = options.signal || (job && job.controller && job.controller.signal) || null;
  const throwIfRefreshCancelled=()=>{const current=refreshJobs.get(id);if((current&&current.cancelRequested)||(signal&&signal.aborted)){const error=new Error('Yenileme kullanıcı tarafından durduruldu.');error.code='REFRESH_CANCELLED';throw error;}};
  const totalStarted = Date.now();
  let active = cacheForUser(id);
  const oldOrders = Array.isArray(active.asasOrders) ? active.asasOrders : [];
  const oldAntrepoMap = active.antrepoMap || {};
  const oldSources = active.sources ? { ...active.sources } : {};
  throwIfRefreshCancelled();
  const requestedTargets = Array.isArray(targets) && targets.length ? targets : ['cp','orders','backlog','lfl','priceanalysis'];
  const sourcePolicy = options && options.sourcePolicy && typeof options.sourcePolicy === 'object' ? options.sourcePolicy : {};
  const refreshOverrides = loadOverrides();
  const antrepoMode = sourcePolicy.antrepoMode || (['database', 'dashboard'].includes(refreshOverrides.antrepoSourceMode) ? refreshOverrides.antrepoSourceMode : 'excel');
  const needsDashboard = antrepoMode === 'dashboard' && requestedTargets.some(target => target === 'cp' || target === 'orders' || target === 'backlog');
  let dashboardSession = null;
  if (needsDashboard) {
    markPhase('dashboard-preflight');
    dashboardSession = await browserIntegrationManager.ensureDashboardSession(id, {
      onState: state => { if (state === 'WAITING_FOR_USER') markPhase('dashboard-browser-waiting'); },
    });
    throwIfRefreshCancelled();
  }
  const staged = await loadFromModels(id, targets, {
    ...options, signal, deferPublish:true, markPhase, telemetry, dashboardSession,
    onDashboardProgress: progress => {
      const current = refreshJobs.get(id);
      if (current) current.dashboard = progress;
    },
  });
  // Model görselleri normal veri yenilemesinden tamamen ayrıdır. ASAS/PLM
  // görsel aktarımı yalnız Tools > Model Görsellerini Güncelle komutlarıyla çalışır.
  markPhase('comparing');
  throwIfRefreshCancelled();
  const ov = effectiveOverridesForUser(id, loadOverrides(), antrepoMode);
  const summary = await runRefreshTelemetry(telemetry, 'Refresh', 'comparison', 'wait', () => computeRefreshSummary(oldOrders, oldAntrepoMap, staged.asasOrders, staged.antrepoMap, ov));
  let historyItem = null;
  const refreshedAt = new Date().toISOString();
  staged.lastRefreshResult = {
    at: refreshedAt,
    hasChanges: Boolean(summary.hasChanges),
    totalChanges: Number(summary.details && summary.details.length) || 0,
    asasChangeCount: Number(summary.asasChangeCount) || 0,
    antrepoChangeCount: Number(summary.antrepoChangeCount) || 0,
    newlyAppeared: Number(summary.newlyAppeared) || 0,
    disappeared: Number(summary.disappeared) || 0,
    statusChanged: Number(summary.statusChanged) || 0,
    qtyChangedOrders: Number(summary.qtyChangedOrders) || 0,
    historyItemId: null,
    notes: (summary.details || []).slice(0, 8).map(detail => ({
      source: String(detail.source || ''), ocode: detail.ocode == null ? '' : String(detail.ocode),
      modelName: String(detail.modelName || ''), colour: String(detail.colour || ''),
      changeType: String(detail.changeType || ''), detail: String(detail.detail || ''),
    })),
  };
  throwIfRefreshCancelled();
  markPhase('saving');
  if (job) job.commitStarted = true;
  await runRefreshTelemetry(telemetry, 'Local storage', 'snapshot-save', 'save', () => publishRefreshedRuntime(id, staged));
  // Applied Horizon only advances after the new runtime snapshot is safely
  // published. A failed/cancelled refresh therefore cannot move this state.
  try {
    for (const [target, horizon] of Object.entries(staged.modelRefresh && staged.modelRefresh.appliedHorizons || {})) {
      userPreferences.saveAppliedHorizon(id, target, horizon);
    }
  } catch (error) {
    // The data snapshot remains authoritative; a preference write failure must
    // not turn a successful refresh into a data refresh failure.
    logRuntimeFailure('appliedHorizonPersistence', error);
  }
  active = staged;
  // Projection cache türetilebilir veridir. Kaynak snapshot atomik olarak
  // yayınlandıktan sonra hazırlanır; cache hatası başarılı yerel veriyi geri
  // almaz ve sonraki ekran açılışında güvenle yeniden üretilebilir.
  markPhase('page-cache');
  try { await runRefreshTelemetry(telemetry, 'Local storage', 'page-cache-write', 'cache', () => buildAndWritePageProjectionCache(currentUser, active)); }
  catch (cacheError) { logRuntimeFailure('refreshPageCacheWrite', cacheError); }
  markPhase('finalizing');
  clearDeliveryOverridesForOrders((active.asasOrders || []).map(order => order.ocode));
  // Her başarılı yenileme bir zaman işareti üretir. İçerik değişmemişse store
  // yalnız boş delta marker'ı yazar; Pzt 10:00 → Pzt 10:00 gibi sınırlar yine
  // doğru snapshot'a çözülebilir.
  try {
    await runRefreshTelemetry(telemetry, 'Local storage', 'backlog-plan-actual-snapshot', 'save', () =>
      captureBacklogPlanActualSnapshot(id, active, effectiveOverridesForUser(id))
    );
  } catch (snapshotError) {
    // Analiz geçmişi türetilebilir bir katmandır; kaydedilememesi başarılı veri
    // yenilemesini geri almamalı, fakat teşhis kaydı bırakmalıdır.
    logRuntimeFailure('backlogPlanActualSnapshot', snapshotError);
  }
  if (summary.hasChanges) {
    historyItem = addRefreshHistory({
      createdAt: new Date().toISOString(),
      sources: { previous: oldSources, current: active.sources || {} },
      scope: {
        requestedTargets: Array.isArray(targets) && targets.length ? targets.slice() : ['cp','orders','backlog','lfl','priceanalysis'],
        sourceScopes: Array.isArray(active.modelRefresh && active.modelRefresh.scopes) ? active.modelRefresh.scopes : [],
      },
      summary: {
        oldOrderCount: summary.oldOrderCount, newOrderCount: summary.newOrderCount,
        newlyAppeared: summary.newlyAppeared, disappeared: summary.disappeared,
        statusChanged: summary.statusChanged, qtyChangedOrders: summary.qtyChangedOrders,
        kalanDelta: summary.kalanDelta, asasChangedOrders: summary.asasChangedOrders, antrepoChangedOrders: summary.antrepoChangedOrders,
        asasChangeCount: summary.asasChangeCount, antrepoChangeCount: summary.antrepoChangeCount,
        totalChanges: summary.details.length,
      },
      details: summary.details,
    }, id);
  }
  if (historyItem) active.lastRefreshResult.historyItemId = historyItem.id;
  const connections = active.modelRefresh && Array.isArray(active.modelRefresh.connections) ? active.modelRefresh.connections : [];
  const metrics = {
    dbQueryMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.executeMs) || 0)),
    connectionWaitMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.connectionOpenMs) || 0)),
    retryMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.retryMs) || 0)),
    dbResultWriteMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.writeMs) || 0)),
    parseMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.parseMs) || 0)),
    uiBlockingMs: Math.max(0, ...connections.map(item => Number(item.timings && item.timings.uiBlockingMs) || 0)),
    // Kaynak refresh BuyerLogLocal.db delta günlüğüne yazmaz; iş verisi atomik
    // model snapshot'ında tutulur. İki süreyi birbirine karıştırmadan raporla.
    localDbWriteMs: 0,
    localSnapshotWriteMs: Number(active._refreshPersistenceMetrics && active._refreshPersistenceMetrics.totalMs) || 0,
    dashboard: active.modelRefresh && active.modelRefresh.dashboard || null,
    totalMs: Date.now() - totalStarted,
  };
  userAccess.appendAudit(currentUser, 'MODEL_REFRESH', 'Data Model Connection', { hasChanges: summary.hasChanges, totalChanges: summary.details.length });
  return { summary, historyItem, modelRefresh: active.modelRefresh || null, lastRefreshResult: active.lastRefreshResult, metrics };
}

app.get('/api/refresh-status', userAccess.requireArea('source'), (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(refreshJobState(sourceUserId(req)));
});

app.get('/api/shared-revisions',async(_req,res)=>{
  try{res.set('Cache-Control','no-store').json(await sharedRevisionStore.read());}catch(err){apiError(res,err,'Paylaşılan veri revizyonları okunamadı.');}
});

// Price & Supplier Analysis için Horizon kaynağı: ASAS satırlarının yalnızca
// bu modüle ait kapsamı transfer edilir. Büyük ham küme başlangıçta /api/data
// içine eklenmez; analiz ekranı açıldığında mevcut runtime snapshot'tan okunur.
app.get('/api/data/price-analysis', userAccess.requireArea('priceanalysis'), async (req, res) => {
  try {
    const id = sourceUserId(req), filterStatus = sourceFilterReadiness(['priceanalysis'], req);
    if (!filterStatus.ready) {
      return sendDateSafeJson(res, { rows: [], loadedAt: null, sources: {}, sourceFilterRequired: true,
        sourceFilterStatus: filterStatus, sourceFilterMessage: sourceFilterReadinessMessage(filterStatus, 'tr') });
    }
    const runtime = cacheForUser(id);
    if (!runtime.asasOrders) await ensureDataLoaded(id);
    const active = cacheForUser(id), overrides = effectiveOverridesForUser(id);
    const sourceRows = active.asasOrdersByTarget && Array.isArray(active.asasOrdersByTarget.priceanalysis)
      ? active.asasOrdersByTarget.priceanalysis : (Array.isArray(active.asasOrders) ? active.asasOrders : []);
    const rows = userAccess.filterRowsByScope(req.currentUser,
      filterRowsByEffectiveHorizon(req.currentUser, 'priceanalysis', applyDateOverrides(sourceRows, overrides)));
    sendDateSafeJson(res, { rows, rawCount: rows.length, loadedAt: active.loadedAt, sources: active.sources || {}, modelRefresh: active.modelRefresh || null });
  } catch (err) { apiError(res, err, 'Price & Supplier Analysis Horizon verisi yüklenemedi.'); }
});
async function currentSyncStatus() {
  const status = await syncSettings.read();
  try { status.localSnapshotDate = (await fs.promises.stat(localDb.getFile())).mtime.toISOString(); }
  catch (_) { status.localSnapshotDate = null; }
  return { ...status, localDbPath: localDb.getFile(), sharedSyncRoot: status.sharedSyncRoot || '' };
}
/* Data Maintenance is deliberately lazy/read-only until invoked. No storage
   scan or legacy hashing is allowed on the startup critical path. */
app.get('/api/data-maintenance/analyze', userAccess.requireArea('source'), async (_req, res) => {
  try { res.json({ ok:true, ...(await dataMaintenance.analyze()) }); } catch (error) { res.status(error.statusCode||500).json({ error:error.message||String(error), code:error.code||'DATA_MAINTENANCE_ANALYZE_FAILED' }); }
});
app.get('/api/data-maintenance/verify', userAccess.requireArea('source'), async (_req, res) => {
  try { res.json({ ok:true, result:await dataMaintenance.verify() }); } catch (error) { res.status(error.statusCode||500).json({ error:error.message||String(error), code:error.code||'DATA_MAINTENANCE_VERIFY_FAILED' }); }
});
app.get('/api/data-maintenance/plm-health', userAccess.requireArea('source'), async (_req, res) => {
  try { res.json({ ok:true, result:await dataMaintenance.plmHealth() }); } catch (error) { res.status(error.statusCode||500).json({ error:error.message||String(error), code:error.code||'PLM_HEALTH_FAILED' }); }
});
app.get('/api/data-maintenance/sync-health', userAccess.requireArea('source'), async (_req, res) => {
  try { res.json({ ok:true, result:await dataMaintenance.syncHealth() }); } catch (error) { res.status(error.statusCode||500).json({ error:error.message||String(error), code:error.code||'SYNC_HEALTH_FAILED' }); }
});
app.post('/api/data-maintenance/clean', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), express.json({ limit:'16kb' }), async (req, res) => {
  try { const rawScope=String(req.body&&req.body.scope||'all'); const scope=['browser','legacy'].includes(rawScope)?rawScope:'all'; const result=await dataMaintenance.safeClean({ apply:Boolean(req.body&&req.body.apply), scope }); userAccess.appendAudit(req.currentUser,'DATA_MAINTENANCE_SAFE_CLEAN','source',{apply:Boolean(req.body&&req.body.apply),scope,removed:result.removed||0,freed:result.freed||0}); res.json({ok:true,result}); } catch(error){res.status(error.statusCode||500).json({error:error.message||String(error),code:error.code||'DATA_MAINTENANCE_CLEAN_FAILED'});}
});
app.post('/api/data-maintenance/compact-local-db', userAccess.requireArea('source'), userAccess.requirePermission('manageBackup'), express.json({ limit:'16kb' }), async (req, res) => {
  try { const result=await dataMaintenance.compactLocalData({ keepUploadedTail:Number(req.body&&req.body.keepUploadedTail)||1000 }); userAccess.appendAudit(req.currentUser,'LOCAL_DB_COMPACT','source',{compacted:result.compacted,bytesFreed:result.bytesFreed}); res.json({ok:true,result}); } catch(error){res.status(error.statusCode||500).json({error:error.message||String(error),code:error.code||'LOCAL_DB_COMPACTION_FAILED'});}
});

app.get('/api/sync-settings', userAccess.requireArea('source'), async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok: true, settings: await currentSyncStatus(), localDbPath: localDb.getFile() }); }
  catch (err) { apiError(res, err, 'Yerel senkron ayarları okunamadı.'); }
});
app.get('/api/sync-status', userAccess.requireArea('source'), async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok: true, status: { ...(await currentSyncStatus()), startupPerformanceLog: startupPerformanceLog.slice() } }); }
  catch (err) { apiError(res, err, 'Sync durumu okunamadı.'); }
});
const STARTUP_CLIENT_MARKS = new Set([
  'APP_BOOT_START','FRONTEND_BOOT_START','FRONTEND_BOOTSTRAP_START','FRONTEND_BOOTSTRAP_READY','DOM_CREATION_READY',
  'CACHE_LOAD_START','CACHE_LOAD_READY','AUTH_USER_LOAD_START','AUTH_USER_LOAD_READY','AUTH_READY',
  'DATASOURCE_PREPARATION_START','DATASOURCE_PREPARATION_READY','FILTER_PIVOT_INIT_START','FILTER_PIVOT_INIT_READY',
  'IMAGE_THUMBNAIL_INIT_START','IMAGE_THUMBNAIL_INIT_READY','ACTIVE_MODULE_INIT_START','ACTIVE_MODULE_INIT_READY',
  'TABLE_RENDER_START','TABLE_RENDER_READY','UI_FIRST_RENDER','UI_READY',
  'PRE_FRONTEND_STEP_LOCAL_CONTEXT_START','PRE_FRONTEND_STEP_LOCAL_CONTEXT_READY','PRE_FRONTEND_STEP_XLSX_DEFERRED',
  'PRE_FRONTEND_STEP_CORE_RESOURCES_READY','PRE_FRONTEND_STEP_APP_SCRIPTS_START','PRE_FRONTEND_STEP_APP_SCRIPTS_READY',
  'PRE_FRONTEND_STEP_APP_MAIN_START','PRE_FRONTEND_STEP_APP_MAIN_READY','PRE_FRONTEND_STEP_UI_SHELL_READY',
]);
app.post('/api/startup/ready', express.json({ limit: '32kb' }), (req, res) => {
  const marks = Array.isArray(req.body && req.body.marks) ? req.body.marks : [];
  const emitted = new Set();
  for (const clientMark of marks) {
    const name=String(clientMark&&clientMark.name||'');
    if(!STARTUP_CLIENT_MARKS.has(name)||emitted.has(name))continue;
    emitted.add(name);
    const sourceDetail=clientMark&&clientMark.detail&&typeof clientMark.detail==='object'?clientMark.detail:{};
    markStartup(name, { ...sourceDetail, source: 'client', clientElapsedMs: Number(clientMark.atMs) || 0, durationMs: Number(sourceDetail.durationMs) || 0 });
  }
  markStartup('STARTUP_CLIENT_REPORT_RECEIVED', { source: 'server', clientMarkCount: emitted.size });
  uiReadySignaled = true;
  scheduleBackgroundServices();
  res.status(202).json({ ok: true, backgroundSyncDelayMs: BACKGROUND_SYNC_DELAY_MS });
});
// Koleksiyon birleşim çakışmaları (collection:*) aynı listede, yalnız erişilebilir sahipler için.
async function allSyncConflicts(profile) { return [...await localDb.listConflicts(), ...await collectionMergeConflictsFor(profile)]; }
app.get('/api/sync-conflicts', userAccess.requireArea('source'), async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ ok: true, conflicts: await allSyncConflicts(req.currentUser) }); }
  catch (err) { apiError(res, err, 'Sync çakışmaları okunamadı.'); }
});
app.post('/api/sync-conflicts/:id/resolve', userAccess.requireArea('source'), express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const choice = String(req.body && req.body.choice || 'current');
    let conflict;
    if (String(req.params.id).startsWith('collection:')) {
      const visible = (await collectionMergeConflictsFor(req.currentUser)).some(item => item.conflictId === req.params.id);
      if (!visible) return res.status(404).json({ error:'Koleksiyon çakışması bulunamadı.', code:'COLLECTION_CONFLICT_NOT_FOUND' });
      conflict = await collectionReplication.resolveMergeConflict(req.params.id, choice, item => applyCollectionConflictChoice(req.currentUser, item));
    } else conflict = await localDb.resolveConflict(req.params.id, choice, req.body && req.body.value);
    res.json({ ok: true, conflict, conflicts: await allSyncConflicts(req.currentUser) });
  } catch (err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    apiError(res, err, 'Sync çakışması çözülemedi.');
  }
});
app.put('/api/sync-settings', userAccess.requireArea('source'), express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const folder = String(req.body && (req.body.sharedSyncRoot ?? req.body.sharedSyncFolder) || '').trim();
    const requestedDbPath = String(req.body && (req.body.localDbPath ?? req.body.localDbFolder) || '').trim();
    if (!folder && !requestedDbPath) return res.status(400).json({ ok: false, error: 'Shared Sync Folder veya Local DB gerekli.' });
    const currentSync = await syncSettings.read(), syncFolder = folder || currentSync.sharedSyncRoot;
    let checkedHub = null;
    if (syncFolder) {
      checkedHub = await sharedHub.validate(syncFolder, { requireWrite:true });
      const localState = sharedHub.readLocalState();
      if (localState && localState.completed && localState.hubId && localState.hubId !== checkedHub.manifest.hubId) {
        if ((await localDb.pendingCount()) > 0) return res.status(409).json({ ok:false, error:'Bekleyen local değişiklikler varken farklı Shared Hub seçilemez.', code:'SHARED_HUB_PENDING_CHANGES' });
        return res.status(409).json({ ok:false, error:'Seçilen klasör farklı bir Buyer Log Shared Hub’a ait. Aynı Hub’ın yeni ağ yolunu seçin.', code:'SHARED_HUB_IDENTITY_MISMATCH' });
      }
    }
    if (requestedDbPath) {
      const dbFolder = path.extname(requestedDbPath).toLowerCase() === '.db' ? path.dirname(requestedDbPath) : requestedDbPath;
      if (path.resolve(dbFolder) !== path.resolve(path.dirname(localDb.getFile()))) await localDb.moveTo(dbFolder);
    }
    const settings = await syncSettings.save(checkedHub ? checkedHub.root : syncFolder, localDb.getFile());
    if (req.body && req.body.syncPeriodMinutes != null) await syncSettings.savePeriod(req.body.syncPeriodMinutes);
    if (req.body && req.body.packageRetentionDays != null) await syncSettings.saveRetentionDays(req.body.packageRetentionDays);
    const hubStatus = checkedHub ? await bootstrapSharedHub({ force:true }) : null;
    res.json({ ok: true, settings:await currentSyncStatus(), localDbPath: localDb.getFile(), hub:hubStatus });
  } catch (err) { apiError(res, err, 'Sync klasörü kaydedilemedi.'); }
});
app.put('/api/sync-period', userAccess.requireArea('source'), express.json({ limit: '4kb' }), async (req, res) => {
  try { res.json({ ok: true, status: await syncSettings.savePeriod(req.body && req.body.syncPeriodMinutes) }); }
  catch (err) { apiError(res, err, 'Sync periyodu kaydedilemedi.'); }
});
app.put('/api/sync-package-retention', userAccess.requireArea('source'), express.json({ limit: '4kb' }), async (req, res) => {
  try { res.json({ ok: true, status: await syncSettings.saveRetentionDays(req.body && req.body.packageRetentionDays) }); }
  catch (err) { apiError(res, err, 'Paket saklama süresi kaydedilemedi.'); }
});
app.post('/api/sync-settings/browse', userAccess.requireArea('source'), express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const settings = await syncSettings.read();
    const requested = String(req.body && req.body.initialFolder || '').trim();
    const isLocalDbBrowse = String(req.body && req.body.purpose || '') === 'local-db';
    const initialPath = requested || (isLocalDbBrowse ? path.dirname(localDb.getFile()) : settings.sharedSyncRoot) || '';
    const folder = await chooseFolderDialog({ mode:isLocalDbBrowse ? 'source' : 'network', initialPath });
    res.json(folder ? { ok: true, folder } : { ok: true, cancelled: true });
  }
  catch (err) { apiError(res, err, 'Sync klasörü seçilemedi.'); }
});
app.post('/api/sync-settings/test', userAccess.requireArea('source'), express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const settings=await syncSettings.read();
    const root=String(req.body && (req.body.sharedSyncRoot ?? req.body.sharedSyncFolder) || settings.sharedSyncRoot);
    const checked=await sharedHub.validate(root,{requireWrite:true});
    res.json({ok:true,folder:checked.root,hubId:checked.manifest.hubId,schemaVersion:checked.manifest.schemaVersion});
  } catch (err) { res.status(err.statusCode||400).json({ ok:false, error:err.message||String(err), code:err.code||'SHARED_HUB_TEST_FAILED' }); }
});
app.post('/api/sync-settings/sync-now', userAccess.requireArea('source'), async (req, res) => {
  try {
    const settings = await syncSettings.syncOnce();
    touchCollectionLiveUser(req.currentUser && req.currentUser.id);
    await pollCollectionReplicas().catch(error => logRuntimeFailure('collectionLivePoll', error));
    res.json({ ok: true, settings, localDbPath: localDb.getFile() });
  }
  catch (err) { apiError(res, err, 'Senkron başlatılamadı.'); }
});
app.post('/api/refresh', userAccess.requireArea('source'), async (req, res) => {
  const id = sourceUserId(req);
  if (refreshInFlight.has(id)) {
    return res.status(409).json({ error: 'Bu kullanıcı için bir veri yenileme işlemi zaten devam ediyor.', code: 'OPERATION_IN_PROGRESS', job: refreshJobState(id) });
  }

  // Eski davranış (isteği yanıt dönene kadar bekletmek) korunuyor; testler ve
  // otomasyon bunu { sync: true } ile isteyebilir.
  const wantSync = Boolean(req.body && req.body.sync);
  // Yalnız belirli sayfaları yenile: ['cp'], ['orders'], ['backlog'], ['lfl'] veya birkaçı.
  const rawTargets = req.body && Array.isArray(req.body.targets) ? req.body.targets : null;
  const targets = rawTargets ? rawTargets.filter(t => ['cp', 'orders', 'backlog', 'lfl', 'priceanalysis'].includes(String(t))) : null;
  const requestedTargets = targets && targets.length ? targets : ['cp','orders','backlog','lfl','priceanalysis'];
  const filterError = sourceFilterRequiredError(requestedTargets,req);
  if (filterError) {
    return res.status(filterError.statusCode).json({ error: filterError.message, code: filterError.code, sourceFilterRequired: true, sourceFilterStatus: filterError.filterStatus });
  }

  if (!wantSync) {
    const startedAt = new Date().toISOString();
    const job = {
      jobId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,
      running: true, phase: 'source-setup', startedAt, startedMs: Date.now(), error: null,
      requestedTargets: requestedTargets.slice(), loadedAt: null,
      controller: new AbortController(), cancelRequested:false, commitStarted:false,
      operations: [],
    };
    refreshJobs.set(id, job);
    refreshInFlight.add(id);
    const currentUser = req.currentUser;
    // Bilerek await edilmiyor: istek hemen döner, iş arka planda sürer.
    // Kullanıcının Source Data seçimleri refresh akışına aynen aktarılmalı.
    // Önceki kod ASAS/LFL'i burada zorla Database seçiyordu; ekranda ASAS
    // Excel seçili olsa bile loadFromModels aktif ASAS bağlantısı arıyor ve
    // dashboard'a hiç ulaşmadan "aktif ASAS veri modeli bağlantısı yok"
    // hatasıyla bitiyordu.
    const refreshOverrides = loadOverrides();
    const selectedAsasMode = refreshOverrides.asasSourceMode === 'database' ? 'database' : 'excel';
    const selectedLflMode = refreshOverrides.lflSourceMode === 'database' ? 'database' : 'excel';
    const selectedAntrepoMode = ['database', 'dashboard'].includes(refreshOverrides.antrepoSourceMode) ? refreshOverrides.antrepoSourceMode : 'excel';
    performRefresh(id, currentUser, targets && targets.length ? targets : null, {signal:job.controller.signal,sourcePolicy:{asasMode:selectedAsasMode,antrepoMode:selectedAntrepoMode,lflMode:selectedLflMode},refreshId:job.jobId}).then(result => {
      job.summary = { ...result.summary, historyItemId: result.historyItem ? result.historyItem.id : null };
      job.connections = result.modelRefresh && result.modelRefresh.connections || null;
      job.loadedAt = cacheForUser(id).loadedAt || null;
      job.metrics = result.metrics || null;
      const last = Array.isArray(job.phases) ? job.phases[job.phases.length - 1] : null;
      if (last && !last.endedMs) { last.endedMs = Date.now(); last.ms = last.endedMs - last.startedMs; }
      job.phase = 'done';
    }).catch(err => {
      logRuntimeFailure('modelRefresh', err);
      job.phase = 'error';
      job.error = String(err && (err.publicMessage || err.message) || 'Yenileme başarısız oldu.');
      job.errorCode = (err && err.code) || 'MODEL_REFRESH_FAILED';
      job.repairAction = err && err.repairAction || null;
    }).finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.now() - job.startedMs;
      refreshInFlight.delete(id);
    });
    return res.status(202).json({ started: true, job: refreshJobState(id) });
  }

  refreshInFlight.add(id);
  try {
    const result = await performRefresh(id, req.currentUser, targets && targets.length ? targets : null);
    const response = await buildResponse(req.currentUser);
    response.refreshSummary = { ...result.summary, historyItemId: result.historyItem ? result.historyItem.id : null };
    const refreshHistoryStore = loadRefreshHistory(id);
    response.refreshHistory = refreshHistoryStore.items;
    response.refreshHistoryRevision = refreshHistoryStore._revision;
    sendDateSafeJson(res, response);
  } catch (err) {
    logRuntimeFailure('modelRefresh', err);
    const message = err && (err.publicMessage || err.message) ? (err.publicMessage || err.message) : 'Yenileme başarısız oldu.';
    res.status(Number(err && err.statusCode) || 500).json({
      error: message,
      code: (err && err.code) || 'MODEL_REFRESH_FAILED',
      repairAction: err && err.repairAction || null,
    });
  } finally { refreshInFlight.delete(id); }
});
app.post('/api/refresh-cancel', userAccess.requireArea('source'), (req,res) => {
  const job=refreshJobs.get(sourceUserId(req));
  if(!job||!job.running)return res.json({ok:true,running:false});
  if(job.commitStarted)return res.status(409).json({ok:false,running:true,cancelAccepted:false,error:'Yenileme güvenli yayın aşamasına geçti; veri bütünlüğü için bu kısa aşama tamamlanıyor.',job:refreshJobState(sourceUserId(req))});
  job.cancelRequested=true;
  if(job.controller&&!job.controller.signal.aborted)job.controller.abort();
  res.json({ok:true,running:true,cancelAccepted:true,job:refreshJobState(sourceUserId(req))});
});

/* v6.44 — CANLI SENKRONİZASYON AKIŞI.
   Sekme açılışında bağlanır, sunucu kapanana veya sekme kapanana kadar açık
   kalır. Ayrı bir keep-alive gerekmez; heartbeat/goodbye pencere ömrünü zaten
   yönetiyor, bu bağlantı yalnız değişiklik sinyali taşır. */
app.get('/api/live-events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  // v7.19: abonenin isteği saklanır ki yayın anında oturum profili TAZE olarak
  // çözülebilsin. Profil nesnesini kopyalayıp saklasaydık, oturum sürerken
  // yetkisi daraltılan bir kullanıcı eski kapsamıyla veri almaya devam ederdi.
  const entry = liveEvents.addClient(res, String(req.query.clientId || ''), { req });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); liveEvents.removeClient(entry); });
});

/* v7.19 — CANLI YAMANIN ABONE BAZINDA YETKİ SÜZGECİ.

   SSE tek bir yayın akışıdır; aboneler farklı veri kapsamlarına sahiptir. Bir
   satırın alan değerleri (Supp. FOB fiyatı, notlar, revize tarihler) o siparişi
   göremeyen bir aboneye ASLA gönderilmemelidir (§32).

   Görünürlük kararı, yazma yetkisiyle AYNI otoriteden alınır: son başarılı
   Moderatör ASAS anlık görüntüsündeki sipariş satırları (authoritativeOrderRows
   — kod bazında indeksli, O(1)) ve kullanıcının veri kapsamı. Kullanıcının
   klasörleri veya istemciden gelen hiçbir değer otorite değildir.

   Fark: yazma "siparişin BÜTÜN satırları kapsamımda mı" diye sorar; görünürlük
   "EN AZ BİR satırı kapsamımda mı" diye sorar — projeksiyonun satır süzgeciyle
   aynı semantik.

   Horizon (sezon/tarih penceresi) bilerek süzgece girmez: o bir görünüm
   penceresidir, yetki sınırı değil. Kapsam içinde ama horizon dışında bir satır
   zaten istemcinin elinde yoktur, gelen yama sessizce eşleşmez.

   Küme kurulmaz, sipariş başına tekil kontrol yapılır: bir olayda yalnız birkaç
   sipariş değişir. Onbinlerce satırı taramak, her yazmada her aboneye bir
   tarama maliyeti bindirirdi. */
function liveEventCanSeeOrder(profile, orderCode, precomputed = null) {
  const manageAll = precomputed && typeof precomputed.manageAll === 'boolean'
    ? precomputed.manageAll
    : Boolean(profile && userAccess.hasPermission(profile, 'manageAllOrders'));
  if (manageAll) return true;
  const rows = userAccess.authoritativeOrderRows(Number(orderCode));
  if (!rows.length) return false; // otorite bilmiyorsa gönderme
  return userAccess.filterRowsByScope(profile, rows).length > 0;
}
liveEvents.setPatchAuthorizer((entry, rowPatches, event) => {
  if (!Array.isArray(rowPatches) || !rowPatches.length) return [];
  let profile = null;
  try { profile = entry && entry.req ? userAccess.sessionProfile(entry.req) : null; }
  catch (_) { return []; }
  if (!profile) return []; // oturumu düşmüş abone veri almaz
  try {
    /* v7.21 — Koleksiyon farklı bir yetki kuralına tabidir.

       Sipariş kapsamı satır satır sorulur; Koleksiyon ise SAYFA bazında
       yetkilendirilir: kullanıcının o workspace'e erişimi ya vardır ya yoktur.
       Erişimi yoksa hiçbir satır gönderilmez — kısmi süzme diye bir şey yok. */
    if (event && event.area === 'collection') {
      const ownerId = String(event.ownerId || '');
      if (!ownerId) return [];
      return userAccess.collectionAccessLevel(profile, ownerId) ? rowPatches : [];
    }
    const precomputed = { manageAll: Boolean(userAccess.hasPermission(profile, 'manageAllOrders')) };
    if (precomputed.manageAll) return rowPatches;
    const seen = new Map();
    return rowPatches.filter(item => {
      const code = Number(item && item.orderCode);
      if (!Number.isFinite(code)) return false;
      if (!seen.has(code)) seen.set(code, liveEventCanSeeOrder(profile, code, precomputed));
      return seen.get(code);
    });
  } catch (error) { logRuntimeFailure('liveEventPatchScope', error); return []; }
});

const ROW_PATCH_IDENTITY_KEYS = new Set(['model','modelName','ccode','colourCode','colorCode','plmId','imagePlmId','imageColourCode']);
const ROW_PATCH_INCREMENTAL_KEYS = new Set([...ROW_PATCH_IDENTITY_KEYS,'notes','suppFob','suppFobMeta','delType','dates','imageRef','noteColumns']);
function rowPatchIncrementalSafe(patch) {
  if (!patch || typeof patch !== 'object') return false;
  if (Object.keys(patch).some(key => !ROW_PATCH_INCREMENTAL_KEYS.has(key))) return false;
  if (patch.dates && Object.values(patch.dates).some(value => value == null || value === '')) return false;
  return true;
}
/* v7.19 — Canlı olayın yama olarak gidip gidemeyeceğine karar verir.

   Kural kasıtlı olarak katı: TEK bir öğe bile artımlı uygulanamıyorsa tur
   yeniden yüklemeye düşer. Yarım yama uygulamak, karşı ekranda sessiz veri
   sapması demektir — açık ara en pahalı hata türü (§142). */
function liveRowPatchesFor(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const clean = list
    .filter(item => item && Number.isFinite(Number(item.orderCode)) && rowPatchIncrementalSafe(item.patch))
    .map(item => ({ orderCode: Number(item.orderCode), patch: item.patch }));
  return clean.length === list.length ? clean : null;
}
function projectionPatchMatches(row, item) {
  const patch=item&&item.patch||{}, orderCode=parseLib.orderCodeKey(item&&item.orderCode);
  if (!row || parseLib.orderCodeKey(row['Order Code']) !== orderCode) return false;
  const model=String(patch.modelName??patch.model??'').trim(),ccode=String(patch.ccode??patch.colourCode??patch.colorCode??'').trim();
  if (model && String(row['Model Name']||'').trim() !== model) return false;
  if (ccode && String(row['C.Code']||'').trim() !== ccode) return false;
  return true;
}
function applyIncrementalProjectionPatch(row, patch, overrides) {
  if (patch.notes && typeof patch.notes === 'object') {
    if (Object.prototype.hasOwnProperty.call(patch.notes,'Notes')) row.Notes=patch.notes.Notes==null?'':String(patch.notes.Notes);
    if (Object.prototype.hasOwnProperty.call(patch.notes,'EkNot')) row['Ek Not']=patch.notes.EkNot==null?'':String(patch.notes.EkNot);
    /* v7.29 — yazar ve tarih damgaları KAYDEDİLMİŞ notesmap'ten okunur, patch'ten
       değil: patch istemciden gelir ve yazar taşımaz (taşısa da kabul edilmezdi).
       Bu satır atlanırsa önbellekten dönen satırlar yazarsız kalır ve kullanıcının
       az önce yazdığı not kendi Genel Bakış listesinde görünmezdi. */
    const notesRec = (overrides && overrides.notesmap
      && (overrides.notesmap[parseLib.rowLineKey(row)] || overrides.notesmap[parseLib.orderCodeKey(row['Order Code'])])) || {};
    row._notesAt=notesRec.NotesAt||''; row._ekNotAt=notesRec.EkNotAt||'';
    row._notesBy=notesRec.NotesBy||''; row._notesByName=notesRec.NotesByName||'';
    row._ekNotBy=notesRec.EkNotBy||''; row._ekNotByName=notesRec.EkNotByName||'';
  }
  if (Object.prototype.hasOwnProperty.call(patch,'suppFob')) {
    row['Supp. FOB']=patch.suppFob==null?null:Number(patch.suppFob);
    row._suppFobManual=true;row._suppFobOverride=true;row._suppFobRule=null;
    row._suppFobMeta=patch.suppFobMeta&&typeof patch.suppFobMeta==='object'?patch.suppFobMeta:{source:'manual'};
  }
  if (patch.delType != null) row['Del. Type']=String(patch.delType);
  if (patch.dates && typeof patch.dates === 'object') {
    const dateFields={exFactory:'Ex-factory',retailDate:'Retail Date',inStoreDate:'In-Store (Model Budget)'};
    for (const [incoming,field] of Object.entries(dateFields)) if (Object.prototype.hasOwnProperty.call(patch.dates,incoming)) row[field]=String(patch.dates[incoming]);
  }
  if (Object.prototype.hasOwnProperty.call(patch,'imageRef')) {
    const ref=patch.imageRef==null?'':String(patch.imageRef).trim();
    row._imageRef=ref;row._imageUrl=ref?`/api/cp-images/${encodeURIComponent(ref)}`:'';
  }
  if (patch.noteColumns && typeof patch.noteColumns === 'object') {
    const validIds = new Set((overrides.noteColumnDefs || []).map(def => def.id));
    for (const [id, value] of Object.entries(patch.noteColumns)) {
      if (!validIds.has(id)) continue;
      row[id] = value == null ? '' : String(value);
    }
  }
  if (patch.delType != null || patch.dates) parseLib.applyFormulas(row, overrides.transitRules);
  return row;
}
async function rewriteProjectionCacheForRowPatches(currentUser, beforeContext, items) {
  const clean=(Array.isArray(items)?items:[]).filter(item=>item&&Number.isFinite(Number(item.orderCode))&&rowPatchIncrementalSafe(item.patch));
  if (!clean.length || clean.length !== (Array.isArray(items)?items.length:0)) return false;
  const afterContext=pageProjectionContext(currentUser);
  if (!beforeContext || String(beforeContext.contextHash)===String(afterContext.contextHash)) return false;
  const overrides=effectiveOverridesForUser(afterContext.id);
  const manifest=await pageProjectionCache.rewriteGeneration(afterContext.id,{
    fromContextHash:beforeContext.contextHash,toContextHash:afterContext.contextHash,
    transform:(_module,payload)=>{
      if (!payload || typeof payload!=='object') return payload;
      const lists=[];
      if (Array.isArray(payload.rows)) lists.push(payload.rows);
      if (Array.isArray(payload.orderSummary)) lists.push(payload.orderSummary);
      for (const rows of lists) for (const row of rows) for (const item of clean) {
        if (projectionPatchMatches(row,item)) applyIncrementalProjectionPatch(row,item.patch,overrides);
      }
      return payload;
    },
  });
  return Boolean(manifest);
}

app.post('/api/overrides/batch', async (req, res) => {
  try {
    const items = modelImageRegistry.normalizeItems((req.body || {}).items);
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    if (rejectUnauthorizedOrders(req, res, items.map(item => item && item.orderCode))) return;
    const beforeContext=pageProjectionContext(req.currentUser);
    const saved = patchOrderOverrides(items, requestRevision(req), requestSuppFobRevision(req), { actor: noteActorOf(req.currentUser) });
    void sharedRevisionStore.update('cpOverrides',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    let pageCachePatched=false;
    try { pageCachePatched=await rewriteProjectionCacheForRowPatches(req.currentUser,beforeContext,items); }
    catch (cacheError) { logRuntimeFailure('rowProjectionCachePatch',cacheError); }
    userAccess.appendAudit(req.currentUser, 'ORDER_BATCH_UPDATE', 'orders', { orderCodes: items.map(item=>Number(item&&item.orderCode)).filter(Number.isFinite), count: items.length });
    liveEvents.notifyChange('orders', requestClientId(req), { rowPatches: liveRowPatchesFor(items) });
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, updated: saved.updated, overrides: saved.overrides, revision: saved.revision, revisions: saved.revisions, skipped: saved.skipped || [], pageCachePatched });
  } catch (err) { apiError(res, err, 'Toplu sipariş düzenlemeleri kaydedilemedi.'); }
});

// Kullanıcı düzenlemesi (sub-manufacturer, not, teslimat tipi) kalıcı kaydedilir.
// body: { orderCode, notes?: {Notes?,EkNot?}, subManufacturer?, licensor?, suppFob?, delType? }
app.patch('/api/overrides/:orderCode', async (req, res) => {
  try {
    const orderCode = Number(req.params.orderCode);
    if (!Number.isFinite(orderCode)) return res.status(400).json({ error: 'Geçerli sipariş kodu zorunlu.', code: 'VALIDATION_ERROR' });
    if (rejectUnauthorizedOrders(req, res, [orderCode])) return;
    const beforeContext=pageProjectionContext(req.currentUser);
    /* origin YALNIZ audit içindir; override store'una VERİ olarak girmez.
       Yama gövdesinden ayıklanır — yoksa sipariş kaydına anlamsız bir alan
       sızar, projeksiyon önbelleğine yazılır ve canlı yayınla bütün
       cihazlara sipariş alanı gibi dağılırdı. */
    const write = copilotProvenance.describeWrite(req.body);
    const patchBody = write.patch;
    const saved = patchOrderOverride(orderCode, patchBody, requestRevision(req), requestSuppFobRevision(req), { actor: noteActorOf(req.currentUser) });
    void sharedRevisionStore.update('cpOverrides',{actorId:req.currentUser.id}).catch(error=>logRuntimeFailure('sharedRevision',error));
    let pageCachePatched=false;
    try { pageCachePatched=await rewriteProjectionCacheForRowPatches(req.currentUser,beforeContext,[{orderCode,patch:patchBody}]); }
    catch (cacheError) { logRuntimeFailure('rowProjectionCachePatch',cacheError); }
    /* Değişikliğin KAYNAĞI kayda geçer: aynı uç hem elle düzenlemeyi hem
       Copilot önerisini taşıyor ve altı ay sonra ikisini ayırt edebilmek
       gerekiyor. Kaynak istemciden gelir ama AKTÖR oturumdan belirlenir —
       istemcinin bildirdiği bir kimliğe güvenilmez. */
    userAccess.appendAudit(req.currentUser, 'ORDER_UPDATE', String(orderCode), {
      fields: write.fields,
      ...(write.origin || {}),
    });
    liveEvents.notifyChange('orders', requestClientId(req), { rowPatches: liveRowPatchesFor([{ orderCode, patch: patchBody }]) });
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, overrides: saved.overrides, revision: saved.revision, revisions: saved.revisions, pageCachePatched });
  } catch (err) { apiError(res, err, 'Sipariş düzenlemesi kaydedilemedi.'); }
});

async function rewriteProjectionCacheForImageItems(currentUser,beforeContext,items){
  const exact=new Map(),byPlm=new Map();
  for(const item of Array.isArray(items)?items:[]){
    const plm=parseLib.normalizePlmImageId(item&&item.plmId),colour=parseLib.normalizeCpImageColourCode(item&&item.colourCode),ref=item&&item.imageRef!=null?String(item.imageRef).trim():'';
    if(!plm)continue;if(colour)exact.set(`${plm}\u0000${colour}`,ref);else byPlm.set(plm,ref);
  }
  if(!exact.size&&!byPlm.size)return false;
  const afterContext=pageProjectionContext(currentUser);
  if(!beforeContext||String(beforeContext.contextHash)===String(afterContext.contextHash))return false;
  const manifest=await pageProjectionCache.rewriteGeneration(afterContext.id,{
    fromContextHash:beforeContext.contextHash,toContextHash:afterContext.contextHash,
    transform:(_module,payload)=>{
      if(!Array.isArray(payload&&payload.rows))return payload;
      for(const row of payload.rows){
        const plm=parseLib.normalizePlmImageId(row&&row['PLM ID']),colour=parseLib.normalizeCpImageColourCode(row&&row['C.Code']);
        if(!plm)continue;const key=`${plm}\u0000${colour}`,hasExact=exact.has(key),ref=hasExact?exact.get(key):byPlm.get(plm);
        if(!hasExact&&!byPlm.has(plm))continue;
        row._imageRef=ref||'';row._imageUrl=ref?`/api/cp-images/${encodeURIComponent(ref)}`:'';
      }
      return payload;
    },
  });
  return Boolean(manifest);
}

app.post('/api/plm-image-links', userAccess.requireArea('koleksiyon'), async (req, res) => {
  try {
    assertModelImageMutable();
    const items = (req.body || {}).items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    const beforeContext=pageProjectionContext(req.currentUser);
    const saved = patchPlmImageLinks(items, requestRevision(req));
    /* MANUEL SAHİPLİK. Bu uç kullanıcının ELLE yaptığı görsel bağlama/
       kaldırma işidir. Otomatik sahiplik kaydı burada DÜŞER; aksi hâlde
       kullanıcının koyduğu görsel eski PLM kaydı yüzünden "otomatik"
       sayılır ve bir sonraki senkron onu sessizce ezerdi. */
    try {
      const forgotten = items.map(item => plmImageIngestLib.canonicalKeyFor(item)).filter(Boolean);
      if (forgotten.length) plmImageOwnership.forget(forgotten);
      /* MANUEL KARAR ARTIK TAŞINIR. Yerel çıkarım ("kayıt yoksa manuel") tek
         makinede güvenliydi ama ağdan geçmiyordu: başka bir kullanıcının
         otomatik senkronu bu görseli ezebilirdi. Karar açık bir kayda yazılır
         ve MANUAL sahiplikle paylaşılan depoya yayımlanır. Boş referans bir
         MEZAR TAŞIDIR: eski bir istemcinin yerel kopyası onu diriltemesin. */
      recordManualImageOwnership(items, req.currentUser.id);
    } catch (ownershipError) { logRuntimeFailure('plmImageOwnershipForget', ownershipError); }
    let pageCachePatched=false;
    try{pageCachePatched=await rewriteProjectionCacheForImageItems(req.currentUser,beforeContext,items);}
    catch(cacheError){logRuntimeFailure('imageProjectionCachePatch',cacheError);}
    userAccess.appendAudit(req.currentUser, 'PLM_IMAGE_LINKS', 'collection', { count: saved.updated });
    res.json({ ok: true, updated: saved.updated, overrides: saved.overrides, revision: saved.revision, skipped: saved.skipped || [], pageCachePatched });
  } catch (err) { apiError(res, err, 'PLM görsel bağlantıları kaydedilemedi.'); }
});

app.post('/api/overrides/batch-suppfob', async (req, res) => {
  try {
    const items = (req.body || {}).items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.' });
    if (rejectUnauthorizedOrders(req, res, items.map(item => item && item.orderCode))) return;
    const beforeContext=pageProjectionContext(req.currentUser);
    const clean = items.map(item => ({
      orderCode: Number(item && item.orderCode),
      // Satır kimliği: sipariş + model + renk kodu. Gelmezse eski sipariş bazlı anahtar.
      model: item && item.model == null ? '' : String(item.model),
      ccode: item && item.ccode == null ? '' : String(item.ccode),
      suppFob: Number(item && item.suppFob),
      suppFobMeta: item && item.suppFobMeta && typeof item.suppFobMeta === 'object' ? {
        source: item.suppFobMeta.source === 'rule' ? 'rule' : 'manual',
        ruleId: item.suppFobMeta.ruleId == null ? '' : String(item.suppFobMeta.ruleId),
        opdStart: item.suppFobMeta.opdStart == null ? '' : String(item.suppFobMeta.opdStart),
        opdEnd: item.suppFobMeta.opdEnd == null ? '' : String(item.suppFobMeta.opdEnd),
        seasons: normalizePricingRuleSeasons(item.suppFobMeta.seasons != null ? item.suppFobMeta.seasons : item.suppFobMeta.season),
        licensor: item.suppFobMeta.licensor == null
          ? (item.suppFobMeta.manufacturer == null ? '' : String(item.suppFobMeta.manufacturer))
          : String(item.suppFobMeta.licensor),
        license: item.suppFobMeta.license == null ? '' : String(item.suppFobMeta.license),
        royalty: Number(item.suppFobMeta.royalty),
        trCommission: item.suppFobMeta.trCommission == null || item.suppFobMeta.trCommission === '' ? null : Number(item.suppFobMeta.trCommission),
        ydCommission: item.suppFobMeta.ydCommission == null || item.suppFobMeta.ydCommission === '' ? null : Number(item.suppFobMeta.ydCommission),
        commissionGroup: item.suppFobMeta.commissionGroup == null ? '' : String(item.suppFobMeta.commissionGroup),
        commission: item.suppFobMeta.commission == null || item.suppFobMeta.commission === '' ? null : Number(item.suppFobMeta.commission),
        effectiveRoyalty: item.suppFobMeta.effectiveRoyalty == null || item.suppFobMeta.effectiveRoyalty === '' ? null : Number(item.suppFobMeta.effectiveRoyalty),
        hologramCost: Number(item.suppFobMeta.hologramCost),
        applied: item.suppFobMeta.applied === true,
      } : { source: 'manual' },
    }));
    const preFilterSkipped = clean
      .filter(item => !(Number.isFinite(item.orderCode) && Number.isFinite(item.suppFob)))
      .map(item => ({ orderCode: item.orderCode, reason: 'invalid-order-code-or-value' }));
    const validItems = clean.filter(item => Number.isFinite(item.orderCode) && Number.isFinite(item.suppFob));
    const saved = patchSuppFobOverrides(validItems, requestRevision(req), { actor: noteActorOf(req.currentUser) });
    let pageCachePatched=false;
    const rowPatches=validItems.map(item=>({orderCode:item.orderCode,patch:{model:item.model,ccode:item.ccode,suppFob:item.suppFob,suppFobMeta:item.suppFobMeta}}));
    try{pageCachePatched=await rewriteProjectionCacheForRowPatches(req.currentUser,beforeContext,rowPatches);}
    catch(cacheError){logRuntimeFailure('suppFobProjectionCachePatch',cacheError);}
    userAccess.appendAudit(req.currentUser, 'SUPP_FOB_BATCH_UPDATE', 'orders', { orderCodes: validItems.map(item=>item.orderCode), count: validItems.length });
    liveEvents.notifyChange('orders', requestClientId(req), { rowPatches: liveRowPatchesFor(rowPatches) });
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, updated: saved.updated, overrides: saved.overrides, revision: saved.revision, skipped: [...preFilterSkipped, ...(saved.skipped || [])], pageCachePatched });
  } catch (err) { apiError(res, err, 'Supp. FOB düzenlemeleri kaydedilemedi.'); }
});

// ---- ASAS / LFL veri kaynağı modu ve yükleme route'ları → server/routes/asas-source-routes.js ----
require('./routes/asas-source-routes')(app, {
  apiError,
  cacheForUser,
  excelParseTimeoutMs,
  findLatestSourceFiles,
  fs,
  loadOverrides,
  path,
  publishSharedMasterChange,
  refreshAsasExcelBeforeRead,
  replaceAsasSourceMode,
  replaceLflSourceMode,
  requestRevision,
  runExcelTask,
  saveRuntimeModelSnapshot,
  sourceFolderForUser,
  sourceUserId,
  userAccess,
  withFabricDimensions,

});
// ---- Antrepo veri kaynağı: Excel (varsayılan) / Database (isteğe bağlı) ----
function currentAntrepoExcelFile(value) {
  const folder = sourceFolderForUser(value);
  if (!folder) return null;
  try { return findLatestSourceFiles(folder).antrepo || null; } catch (_) { return null; }
}
function safeAntrepoUploadName(value) {
  const original = path.basename(String(value || 'Antrepo.xlsx')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  const stem = original.replace(/\.xlsx$/i, '') || 'Antrepo';
  const prefixed = /^antrepo/i.test(stem) ? stem : `Antrepo - ${stem}`;
  return `${prefixed.slice(0, 160)}.xlsx`;
}
app.get('/api/antrepo-source', userAccess.requireArea('source'), (req, res) => {
  const ov = loadOverrides();
  const file = currentAntrepoExcelFile(req);
  const revision = Number(ov._revisions && ov._revisions.antrepoSourceMode) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({
    mode: ['database', 'dashboard'].includes(ov.antrepoSourceMode) ? ov.antrepoSourceMode : 'excel',
    revision,
    sourceFolder: sourceFolderForUser(req),
    sourceFile: file ? file.name : null,
  });
});
app.put('/api/antrepo-source', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), (req, res) => {
  try {
    const mode = String(req.body && req.body.mode || '').toLowerCase();
    if (!['excel', 'database', 'dashboard'].includes(mode)) return res.status(400).json({ error: 'mode yalnız excel, database veya dashboard olabilir.', code: 'VALIDATION_ERROR' });
    const saved = replaceAntrepoSourceMode(mode, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'ANTREPO_SOURCE_CHANGE', 'settings', { mode: saved.mode });
    publishSharedMasterChange('antrepoSourceMode', req);
    const file = currentAntrepoExcelFile(req);
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ...saved, sourceFolder: sourceFolderForUser(req), sourceFile: file ? file.name : null });
  } catch (err) { apiError(res, err, 'Antrepo veri kaynağı değiştirilemedi.'); }
});
app.post('/api/antrepo-source/upload', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), async (req, res) => {
  let temp = '';
  try {
    const id = sourceUserId(req);
    const folder = sourceFolderForUser(id);
    if (!folder) {
      const error = new Error('Antrepo Excel yüklemek için önce Kaynak Klasör seçin.');
      error.statusCode = 400; error.code = 'SOURCE_FOLDER_MISSING'; throw error;
    }
    const dataBase64 = String(req.body && req.body.dataBase64 || '');
    if (!dataBase64) return res.status(400).json({ error: 'dataBase64 alanı zorunlu.', code: 'VALIDATION_ERROR' });
    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length || buffer.length > 100 * 1024 * 1024) return res.status(400).json({ error: 'Antrepo Excel dosyası boş veya çok büyük.', code: 'VALIDATION_ERROR' });
    fs.mkdirSync(folder, { recursive: true });
    const filename = safeAntrepoUploadName(req.body && req.body.name);
    const target = path.join(folder, filename);
    temp = target.replace(/\.xlsx$/i, `.upload-${process.pid}-${Date.now()}.xlsx`);
    await fs.promises.writeFile(temp, buffer);

    // Yüklenen çalışma kitabı önce gerçek Excel'de açılıp pivot/veri bağlantıları
    // yenilenmeye çalışılır. Bu adım başarısız olursa (ör. Excel/COM erişilemiyor)
    // yüklemeyi tamamen reddetmek yerine dosyanın kendi son kaydedilmiş (yenilenmemiş)
    // hâliyle devam edilir; kullanıcı açık bir uyarıyla bilgilendirilir.
    let excelRefresh = null;
    let refreshFailureWarning = null;
    try {
      excelRefresh = await refreshAntrepoExcelBeforeRead({ name: filename, full: temp });
    } catch (err) {
      excelRefresh = { ok: false, source: 'ANTREPO', name: filename, error: (err && (err.publicMessage || err.message)) || String(err) };
      refreshFailureWarning = `Antrepo Excel pivot tabloları yenilenemedi; veri sunucudan güncellenmedi, "${filename}" dosyasının yüklenen son kaydedilmiş hali kullanıldı. ${excelRefresh.error}`;
    }
    const stat = fs.statSync(temp);
    const parsedResult = await runExcelTask('parseAntrepoFile', {
      fullPath: temp,
      matchRule: loadOverrides().antrepoMatchConfig,
    }, { timeoutMs: excelParseTimeoutMs(stat.size) });
    const parsedMap = parsedResult && parsedResult.map && typeof parsedResult.map === 'object' ? parsedResult.map : {};
    const parsedMeta = parsedResult && parsedResult.meta ? parsedResult.meta : parseLib.antrepoParseMeta(parsedMap);
    if (parsedMeta && parsedMap && typeof parsedMap === 'object') {
      Object.defineProperty(parsedMap, '__antrepoMeta', { value: parsedMeta, enumerable: false, configurable: true });
    }
    if (parsedMeta && parsedMeta.ok === false) {
      const error = new Error(parsedMeta.reason || 'Antrepo Excel eşleştirme alanları çözülemedi.');
      error.statusCode = 422; error.code = 'ANTREPO_EXCEL_MAPPING_INVALID'; error.details = parsedMeta; throw error;
    }
    validateAntrepoIntegrity('EXCEL', parsedMap, [], loadOverrides().antrepoMatchConfig);

    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) { /* rename gerçek hatayı versin */ }
    fs.renameSync(temp, target);
    temp = '';

    const modeSaved = replaceAntrepoSourceMode('excel');
    const parsed = { map: parsedMap, meta: parsedMeta, file: filename };
    const runtime = cacheForUser(id);
    runtime.antrepoMap = parsed.map;
    runtime.antrepoMapByTarget = { ...(runtime.antrepoMapByTarget || {}), cp: parsed.map, orders: parsed.map, backlog: parsed.map };
    runtime.antrepoHeaderInfo = parsed.meta;
    runtime.sources = { ...(runtime.sources || {}), antrepo: `Excel: ${parsed.file}` };
    const quantityInfo = antrepoQuantityWarningInfo(parsed.file, parsed.meta || {});
    runtime.refreshWarnings = [
      ...(refreshFailureWarning ? [refreshFailureWarning] : []),
      ...quantityInfo.warnings,
    ];
    runtime.refreshWarningDetails = [...quantityInfo.details];
    await saveRuntimeModelSnapshot(id, runtime);
    userAccess.appendAudit(req.currentUser, 'ANTREPO_EXCEL_UPLOAD', filename, { rows: Number(parsed.meta && parsed.meta.dataRows) || Object.keys(parsed.map).length });
    publishSharedMasterChange('antrepoSourceMode', req);
    res.json({
      ok: true, mode: 'excel', revision: modeSaved.revision,
      sourceFolder: folder, sourceFile: parsed.file,
      rowCount: Number(parsed.meta && parsed.meta.dataRows) || Object.keys(parsed.map).length,
      matchableRows: Number(parsed.meta && parsed.meta.matchableRows) || 0,
      meta: parsed.meta || null,
      pivotRefreshed: !refreshFailureWarning,
      excelRefresh,
      warning: refreshFailureWarning || null,
    });
  } catch (err) {
    if (temp) { try { fs.unlinkSync(temp); } catch (_) {} }
    apiError(res, err, 'Antrepo Excel dosyası yüklenemedi.');
  }
});

// ---- OPD + sezon + Licensor + License bazlı Royalty ve TR/YD komisyon hesapları ----
function normalizePricingRuleDate(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? text : '';
}
function normalizePricingCountryGroup(value) {
  const key = String(value == null ? '' : value).trim().toUpperCase().replace(/[\s_]+/g, '-');
  if (key === 'TR') return 'TR';
  if (key === 'NON-TR') return 'Non-TR';
  return '';
}
function normalizePricingRuleSeasons(value) {
  const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const seen = new Set(), out = [];
  for (const item of raw) {
    const text = String(item == null ? '' : item).trim();
    const key = text.toLocaleUpperCase('tr-TR');
    if (text && !seen.has(key)) { seen.add(key); out.push(text); }
  }
  return out.sort((a, b) => a.localeCompare(b, 'tr'));
}
function pricingRuleSeasonSetsOverlap(a, b) {
  const aa = normalizePricingRuleSeasons(a && a.seasons != null ? a.seasons : a && a.season);
  const bb = normalizePricingRuleSeasons(b && b.seasons != null ? b.seasons : b && b.season);
  if (!aa.length || !bb.length) return true;
  const bset = new Set(bb.map(v => v.toLocaleUpperCase('tr-TR')));
  return aa.some(v => bset.has(v.toLocaleUpperCase('tr-TR')));
}
function pricingRuleDateRangesOverlap(a, b) {
  const a1 = a.opdStart ? Date.parse(a.opdStart + 'T00:00:00Z') : -Infinity;
  const a2 = a.opdEnd ? Date.parse(a.opdEnd + 'T00:00:00Z') : Infinity;
  const b1 = b.opdStart ? Date.parse(b.opdStart + 'T00:00:00Z') : -Infinity;
  const b2 = b.opdEnd ? Date.parse(b.opdEnd + 'T00:00:00Z') : Infinity;
  return a1 <= b2 && b1 <= a2;
}
app.get('/api/landed-multipliers', (req, res) => {
  const ov = loadOverrides();
  const revision = Number(ov._revisions && ov._revisions.landedMultipliers) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({ multipliers: ov.landedMultipliers || { tr: 1.05, overseas: 1.11 }, revision });
});
app.put('/api/landed-multipliers', userAccess.requireArea('source'), userAccess.requirePermission('manageBusinessRules'), express.json({limit:'32kb'}), (req, res) => {
  try {
    const raw = req.body && req.body.multipliers;
    const tr = Number(raw && raw.tr), overseas = Number(raw && raw.overseas);
    if (!Number.isFinite(tr) || tr <= 0 || tr > 10 || !Number.isFinite(overseas) || overseas <= 0 || overseas > 10) {
      return res.status(400).json({ error:'TR ve Overseas Landed çarpanları 0 ile 10 arasında pozitif sayı olmalıdır.' });
    }
    const saved = replaceLandedMultipliers({ tr, overseas }, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'LANDED_MULTIPLIERS_UPDATE', 'collection', { tr:saved.multipliers.tr, overseas:saved.multipliers.overseas, revision:saved.revision });
    publishSharedMasterChange('landedMultipliers', req);
    res.json(saved);
  } catch (err) { apiError(res, err, 'Landed çarpanları kaydedilemedi.'); }
});

// ---- Kullanıcı tanımlı not sütunları ve Excel içe aktarma denetimi route'ları → server/routes/note-column-routes.js ----
require('./routes/note-column-routes')(app, {
  apiError,
  express,
  loadOverrides,
  publishSharedMasterChange,
  replaceNoteColumnDefs,
  requestRevision,
  userAccess,

});
// ---- Navlun Ücretleri (Nakliye Kıyaslama > Navlun Hesaplama) ----
// Ücretler kaynak Excel'de tablonun başında duruyordu ve elle güncelleniyordu.
// Burada tek merkezde tutulur: bir kez güncellenince tüm kullanıcıların
// hesabı yeni ücretle çalışır.
app.get('/api/freight-rates', userAccess.requireAnyArea('shipping', 'source'), (req, res) => {
  const ov = loadOverrides();
  const revision = Number(ov._revisions && ov._revisions.freightRates) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({ freight: BLFreight.normalizeSettings(ov.freightRates), revision });
});
app.put('/api/freight-rates', userAccess.requireArea('shipping'), userAccess.requirePermission('manageBusinessRules'), express.json({ limit: '32kb' }), (req, res) => {
  try {
    const raw = req.body && req.body.freight;
    const rates = Array.isArray(raw && raw.rates) ? raw.rates : null;
    if (!rates || !rates.length) return res.status(400).json({ error: 'En az bir navlun ücreti tanımlanmalıdır.' });
    if (rates.length > 20) return res.status(400).json({ error: 'En fazla 20 navlun ücreti tanımlanabilir.' });
    for (const item of rates) {
      const rate = Number(item && item.rate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return res.status(400).json({ error: 'Her navlun birim ücreti 0 ile 1000 arasında pozitif bir sayı olmalıdır.' });
      if (!String(item && item.label || '').trim()) return res.status(400).json({ error: 'Her navlun satırının bir adı olmalıdır.' });
      if (!BLFreight.MODES.includes(item && item.mode)) return res.status(400).json({ error: 'Navlun tipi yalnız Uçak veya Gemi+Uçak olabilir.' });
    }
    const factor = Number(raw && raw.volumetricFactor);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 1000) return res.status(400).json({ error: 'Hacimsel ağırlık katsayısı 0 ile 1000 arasında pozitif bir sayı olmalıdır.' });
    const landedMultiplier = Number(raw && raw.landedMultiplier);
    if (!Number.isFinite(landedMultiplier) || landedMultiplier <= 0 || landedMultiplier > 10) return res.status(400).json({ error: 'Landed çarpanı 0 ile 10 arasında pozitif bir sayı olmalıdır.' });
    const carton = raw && raw.carton;
    for (const key of ['cartonL', 'cartonH', 'cartonW']) {
      const side = Number(carton && carton[key]);
      if (!Number.isFinite(side) || side <= 0 || side > 1000) return res.status(400).json({ error: 'Varsayılan koli ölçüleri 0 ile 1000 cm arasında olmalıdır.' });
    }
    const saved = replaceFreightRates({ rates, volumetricFactor: factor, landedMultiplier, carton }, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'FREIGHT_RATES_UPDATE', 'shipping', { count: saved.freight.rates.length, revision: saved.revision });
    publishSharedMasterChange('freightRates', req);
    res.json(saved);
  } catch (err) { apiError(res, err, 'Navlun ücretleri kaydedilemedi.'); }
});

app.get('/api/pricing-rules', (req, res) => {
  const ov = loadOverrides();
  const revision = Number(ov._revisions && ov._revisions.pricingRules) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({ rules: Array.isArray(ov.pricingRules) ? ov.pricingRules : [], revision });
});
app.put('/api/pricing-rules', userAccess.requireArea('source'), userAccess.requirePermission('manageBusinessRules'), (req, res) => {
  try {
    const incoming = (req.body || {}).rules;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'rules (dizi) zorunlu.' });
    const migrated = BLBusinessRules.migrateLicenseRoyaltyRules(incoming);
    const nullablePercent = value => {
      if (value == null || String(value).trim() === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    };
    const nullableMoney = value => {
      if (value == null || String(value).trim() === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    };
    const rules = migrated.map((r, i) => ({
      id: String(r.id || ('rule-' + Date.now() + '-' + i)),
      opdStart: normalizePricingRuleDate(r.opdStart),
      opdEnd: normalizePricingRuleDate(r.opdEnd),
      seasons: normalizePricingRuleSeasons(r.seasons != null ? r.seasons : r.season),
      licensor: String(r.licensor != null ? r.licensor : (r.manufacturer || '')).trim(),
      license: String(r.license || '').trim(),
      royalty: Number(r.royalty),
      trCommission: nullablePercent(r.trCommission),
      ydCommission: nullablePercent(r.ydCommission),
      hologramCost: Number(r.hologramCost),
      legacyTrHologramCost: nullableMoney(r.legacyTrHologramCost),
      legacyYdHologramCost: nullableMoney(r.legacyYdHologramCost),
      legacyRuleIds: Array.isArray(r.legacyRuleIds) ? r.legacyRuleIds.map(String).filter(Boolean) : [],
      migratedFromCountrySplit: r.migratedFromCountrySplit === true,
    })).filter(r => {
      const commissions = [r.trCommission, r.ydCommission].filter(value => value != null);
      const commissionValid = commissions.length > 0 && commissions.every(value => Number.isFinite(value) && value >= 0 && value <= 100);
      const totalValid = (r.trCommission == null || r.royalty + r.trCommission <= 100)
        && (r.ydCommission == null || r.royalty + r.ydCommission <= 100);
      const legacyHologramValid = (r.legacyTrHologramCost == null || (Number.isFinite(r.legacyTrHologramCost) && r.legacyTrHologramCost >= 0))
        && (r.legacyYdHologramCost == null || (Number.isFinite(r.legacyYdHologramCost) && r.legacyYdHologramCost >= 0));
      return (!r.opdStart || !r.opdEnd || r.opdStart <= r.opdEnd)
        && r.licensor && r.license
        && Number.isFinite(r.royalty) && r.royalty >= 0 && r.royalty <= 100
        && commissionValid && totalValid
        && Number.isFinite(r.hologramCost) && r.hologramCost >= 0
        && legacyHologramValid;
    });
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const a = rules[i], b = rules[j];
        const sameKey = a.licensor.toLocaleUpperCase('tr-TR') === b.licensor.toLocaleUpperCase('tr-TR')
          && a.license.toLocaleUpperCase('tr-TR') === b.license.toLocaleUpperCase('tr-TR');
        const sameCountrySide = (a.trCommission != null && b.trCommission != null)
          || (a.ydCommission != null && b.ydCommission != null);
        if (sameKey && sameCountrySide && pricingRuleSeasonSetsOverlap(a, b) && pricingRuleDateRangesOverlap(a, b)) {
          return res.status(400).json({ error: 'Aynı Licensor, License, ülke kapsamı ve ortak sezon için OPD tarih aralıkları çakışamaz.' });
        }
      }
    }
    const before = loadOverrides();
    const previousRules = Array.isArray(before.pricingRules) ? before.pricingRules : [];
    const previousById = new Map(previousRules.map(rule => [String(rule && rule.id || ''), rule]));
    const nextById = new Map(rules.map(rule => [String(rule && rule.id || ''), rule]));
    const createdRuleIds = rules.filter(rule => !previousById.has(String(rule.id))).map(rule => String(rule.id));
    const deletedRuleIds = previousRules.filter(rule => !nextById.has(String(rule && rule.id || ''))).map(rule => String(rule.id));
    const updatedRuleIds = rules.filter(rule => previousById.has(String(rule.id)) && JSON.stringify(previousById.get(String(rule.id))) !== JSON.stringify(rule)).map(rule => String(rule.id));
    const changedLicenseMap = new Map();
    const markChangedLicense = rule => {
      const value = String(rule && rule.license || '').trim(), key = value.toLocaleUpperCase('tr-TR');
      if (key && value) changedLicenseMap.set(key, value);
    };
    new Set([...previousById.keys(), ...nextById.keys()]).forEach(id => {
      const previousRule = previousById.get(id), nextRule = nextById.get(id);
      if (JSON.stringify(previousRule) !== JSON.stringify(nextRule)) { markChangedLicense(previousRule); markChangedLicense(nextRule); }
    });
    const changedLicenses = [...changedLicenseMap.values()];
    const saved = replacePricingRules(rules, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'PRICING_RULES_UPDATE', 'settings', {
      revision: saved.revision, count: saved.rules.length, changedLicenses,
      createdRuleIds, updatedRuleIds, deletedRuleIds,
    });
    publishSharedMasterChange('pricingRules', req, { revision: saved.revision, changedLicenses });
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, rules: saved.rules, revision: saved.revision });
  } catch (err) { apiError(res, err, 'License Royalty Calculations kaydedilemedi.'); }
});


const normalizeTransitDelType = BLBusinessRules.normalizeTransitDelType;
function normalizeTransitList(value) {
  const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const seen = new Set(), out = [];
  raw.forEach(item => {
    const text = String(item == null ? '' : item).trim();
    const key = text.toLocaleUpperCase('tr-TR');
    if (text && !seen.has(key)) { seen.add(key); out.push(text); }
  });
  return out.sort((a, b) => a.localeCompare(b, 'tr'));
}
/* VERİ EŞLEŞTİRME KURALLARI (v7.82).

   Kural artık "ASAS tarafı / IAS tarafı" diye iki sabit kutuya yazılmaz.
   Kullanıcı koşul başına 2+ OPERAND tanımlar; her operand BİR KAYNAĞA bağlıdır.
   Kaynak listesi burada sabit değil, kayıtlı model bağlantıları + kaynak
   PROFİLLERİ (source-profiles.js) üzerinden üretilir. Üçüncü bir veritabanı
   bağlandığında bu uçta kod değişikliği gerekmez: bağlantı listeye girer ve
   koşullarda seçilebilir hâle gelir.

   ÇÖZÜLEMEYEN ALAN SESSİZ GEÇİLMEZ. Yapılandırılmış sütun kaybolduysa operand
   `unresolved` işaretiyle döner, kayıt reddedilir ve kullanıcı düzeltir. "Benzer
   bir alan bul" davranışı yok: yanlış bir alan üzerinden kurulan eşleşme sessiz
   ve pahalıdır. */
function modelRole(item) {
  if (item && item.role === 'fabric') return 'legacy-fabric';
  return item && item.role === 'antrepo' ? 'antrepo' : 'asas';
}
function primaryMatchConnection(items, role) {
  return (Array.isArray(items) ? items : []).find(item =>
    item && modelRole(item) === role && item.refreshEnabled !== false && item.server && item.catalog)
    || (Array.isArray(items) ? items : []).find(item => item && modelRole(item) === role && item.server && item.catalog)
    || null;
}
function matchSideFromCanonical(item, canonicalHeader) {
  const mapping = item && item.mapping && typeof item.mapping === 'object' ? item.mapping : {};
  const candidates = canonicalHeader === 'Ürün Ad'
    ? ['Ürün Ad', 'Ürün Adı', 'Model Adı']
    : [canonicalHeader];
  let entry = null;
  for (const candidate of candidates) {
    entry = modelFields.normalizeMappingEntry(mapping[candidate], item && item.horizon && item.horizon.table);
    if (entry && entry.name) break;
  }
  return entry && entry.name ? {
    header: canonicalHeader,
    canonicalHeader,
    table: entry.table || '',
    name: entry.name,
    kind: 'column',
  } : null;
}
function canonicalHeaderForMatchSide(item, side) {
  if (!item || !side) return '';
  const mapping = item.mapping && typeof item.mapping === 'object' ? item.mapping : {};
  for (const [header, value] of Object.entries(mapping)) {
    const entry = modelFields.normalizeMappingEntry(value, item && item.horizon && item.horizon.table);
    if (!entry || entry.kind === 'measure') continue;
    if (String(entry.table || '') === String(side.table || '') && String(entry.name || '') === String(side.name || '')) return header;
  }
  return '';
}
function mappedMatchColumns(item) {
  if (!item) return [];
  const out = [];
  const seen = new Set();
  for (const [header, value] of Object.entries(item.mapping || {})) {
    const entry = modelFields.normalizeMappingEntry(value, item.horizon && item.horizon.table);
    if (!entry || !entry.name || entry.kind === 'measure') continue;
    const key = `${entry.table || ''}\u0000${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table: entry.table || '', name: entry.name, kind: 'column', canonicalHeader: header, header });
  }
  return out;
}
async function matchSchemaForConnection(item, options = {}) {
  if (!item) return { columns: [], error: 'Bağlantı bulunamadı.', authoritative: false, loaded: false };
  const fallback = mappedMatchColumns(item);
  // Pencereyi açarken bütün modeli taramak dakikalar sürebiliyordu. Normal açılış
  // yalnız kayıtlı Field Mapping alanlarını kullanır. Kullanıcı özellikle tam
  // şemayı istediğinde ?full=1 ile metadata taraması yapılır ve sunucu cache'lenir.
  if (!options.full) return { columns: fallback, error: '', authoritative: false, loaded: false };
  try {
    const schema = await modelQuery.discoverSchema({ server: item.server, catalog: item.catalog });
    const all = (schema.columns || []).filter(entry => entry && entry.kind === 'column');
    const canonicalByKey = new Map(fallback.map(entry => [`${entry.table || ''}\u0000${entry.name}`, entry.canonicalHeader || '']));
    const errors = (schema.errors || []).map(entry => entry.error).filter(Boolean).join(' · ');
    return {
      columns: all.map(entry => ({ ...entry, canonicalHeader: canonicalByKey.get(`${entry.table || ''}\u0000${entry.name}`) || '' })),
      error: errors,
      // Tam şema OKUNDUYSA liste otoriterdir: içinde olmayan sütun gerçekten yok.
      authoritative: !errors && all.length > 0,
      loaded: true,
    };
  } catch (err) {
    return { columns: fallback, error: String(err && err.message || err), authoritative: false, loaded: true };
  }
}
function excelAntrepoMatchSchema(runtime) {
  const meta = runtime && runtime.antrepoHeaderInfo;
  const columns = Array.isArray(meta && meta.columns) ? meta.columns : [];
  const defaults = ['Sipariş Kod', 'Ürün Ad', 'Ürün Adı', 'Renk Kod', 'Renk Tanım', 'Renk'];
  const list = [...new Set([...columns, ...defaults].map(value => String(value || '').trim()).filter(Boolean))];
  return {
    columns: list.map(name => ({ table: 'Antrepo Excel', name, kind: 'column', canonicalHeader: name, header: name })),
    error: columns.length ? '' : 'Antrepo Excel henüz okunmadı; standart alanlar gösteriliyor.',
    // Gerçek başlıklar okunduysa liste otoriterdir; okunmadıysa yalnız öneridir.
    authoritative: columns.length > 0,
  };
}
function catalogueMatchSchema(role) {
  let fields = [];
  try { fields = modelFields.fieldsForRole(role) || []; } catch (_) { fields = []; }
  return {
    columns: fields.map(field => ({ table: '', name: field.header, kind: 'column', canonicalHeader: field.header, header: field.header })),
    error: '',
    /* Excel kaynağının sütunları katalogla SINIRLI DEĞİLDİR (ek sütunlar var);
       bu liste yalnız öneridir, "bu sütun yok" demeye yetkisi yoktur. */
    authoritative: false,
  };
}

/* KAYNAK KATALOĞU. Eşleştirmede yer alabilecek bütün veri kaynakları — bugün
   iki tane, yarın daha fazla. Her giriş kendi şemasını taşır; koşul düzenleyici
   bu listeden okur, kaynak adı/rol bilgisi kod içinde geçmez. */
async function matchRuleSourceCatalog(runtime, { full = false, fullSourceId = '' } = {}) {
  const ov = loadOverrides();
  const antrepoMode = ['database', 'dashboard'].includes(ov.antrepoSourceMode) ? ov.antrepoSourceMode : 'excel';
  const asasMode = ov.asasSourceMode === 'database' ? 'database' : 'excel';
  const items = (loadModelConnections().items || []).filter(item => item && modelRole(item) !== 'legacy-fabric');
  const out = [];
  const pending = [];

  const push = (entry, schemaPromise) => {
    out.push(entry);
    pending.push(schemaPromise.then(schema => {
      entry.columns = schema.columns || [];
      entry.error = schema.error || '';
      entry.authoritative = Boolean(schema.authoritative);
      entry.schemaLoaded = Boolean(schema.loaded);
    }));
  };

  for (const item of items) {
    const role = modelRole(item);
    const profile = dataManagementSourceProfiles.fromLegacyRole(role);
    if (!profile) continue;
    // Rolün veri kaynağı veritabanı değilse bağlantı sorgulanmıyor demektir;
    // eşleştirmede de yer alamaz. Bunun yerine aşağıda gerçek kaynak eklenir.
    if (role === 'antrepo' && antrepoMode !== 'database') continue;
    if (role === 'asas' && asasMode !== 'database') continue;
    const primary = primaryMatchConnection(items, role);
    push({
      id: String(item.id),
      role,
      profileId: profile.id,
      label: item.name || item.catalog || item.server || profile.label.tr,
      kind: 'database',
      connection: { server: item.server || '', catalog: item.catalog || '' },
      // Eski kayıtlar kaynak kimliği taşımaz; mantıksal kimlik takma ad olarak tanınır.
      aliases: primary && primary.id === item.id ? [parseLib.defaultMatchSourceId(role)] : [],
      item,
      columns: [], error: '', authoritative: false,
    }, matchSchemaForConnection(item, { full: full || String(item.id) === String(fullSourceId || '') }));
  }

  if (asasMode !== 'database') {
    const profile = dataManagementSourceProfiles.fromLegacyRole('asas');
    push({
      id: 'asas-excel',
      role: 'asas',
      profileId: profile ? profile.id : '',
      label: 'ASAS Excel',
      kind: 'excel',
      connection: { server: '', catalog: '' },
      aliases: [parseLib.defaultMatchSourceId('asas')],
      item: null,
      columns: [], error: '', authoritative: false,
    }, Promise.resolve(catalogueMatchSchema('asas')));
  }
  if (antrepoMode !== 'database') {
    const profile = dataManagementSourceProfiles.fromLegacyRole('antrepo');
    push({
      id: antrepoMode === 'dashboard' ? 'antrepo-dashboard' : 'antrepo-excel',
      role: 'antrepo',
      profileId: profile ? profile.id : '',
      label: antrepoMode === 'dashboard' ? 'Power BI Dashboard' : 'Antrepo Excel',
      kind: antrepoMode,
      connection: { server: '', catalog: '' },
      aliases: [parseLib.defaultMatchSourceId('antrepo')],
      item: null,
      columns: [], error: '', authoritative: false,
    }, Promise.resolve(excelAntrepoMatchSchema(runtime)));
  }

  await Promise.all(pending);
  return out;
}
/* Operandın kaynağı: önce kimlik, sonra takma ad, en son AYNI ROLDEKİ birincil
   kaynak. Son adım eski kayıtları ve Excel↔Veritabanı geçişlerini ayakta tutar;
   sütun tahmini DEĞİLDİR — yalnız hangi kaynağın o rolü taşıdığını söyler. */
function resolveMatchSource(sources, operand) {
  const wantedId = String(operand && operand.sourceId || '').trim();
  if (wantedId) {
    const exact = sources.find(source => source.id === wantedId);
    if (exact) return exact;
    const alias = sources.find(source => (source.aliases || []).includes(wantedId));
    if (alias) return alias;
  }
  const role = parseLib.matchRoleKey(operand && operand.role);
  return sources.find(source => source.role === role) || null;
}
function enrichMatchOperand(operand, sources) {
  const source = resolveMatchSource(sources, operand);
  if (!source) {
    // Rolü taşıyan hiçbir kaynak bağlı değil. Kural düzenlenebilir kalır ama
    // kaydedilemez; hangi tarafın eksik olduğu ekranda söylenir.
    return { ...operand, unresolved: 'source' };
  }
  const item = source.item;
  const canonical = operand.canonicalHeader || operand.header
    || (item ? canonicalHeaderForMatchSide(item, operand) : '');
  const mapped = canonical && item ? matchSideFromCanonical(item, canonical) : null;
  const table = operand.table || (mapped && mapped.table) || (source.kind === 'database' ? '' : (source.columns[0] || {}).table || '');
  const name = operand.name || (mapped && mapped.name) || (source.kind === 'database' ? '' : canonical);

  let unresolved = '';
  if (!name && !canonical) {
    unresolved = 'column';
  } else if (source.kind === 'database' && !name) {
    // Kanonik başlık bu bağlantının alan eşlemesinde artık yok: hangi sütunun
    // kastedildiği bilinmiyor. Benzerine kaymak yerine kullanıcıya sorulur.
    unresolved = 'column';
  } else if (source.authoritative && name) {
    const key = `${table || ''}\u0000${name}`;
    const known = source.columns.some(column => `${column.table || ''}\u0000${column.name}` === key)
      || source.columns.some(column => column.name === name);
    if (!known) unresolved = 'column';
  }

  return {
    sourceId: source.id,
    role: source.role,
    header: canonical || operand.header || name,
    canonicalHeader: canonical,
    table,
    name,
    kind: 'column',
    unresolved,
  };
}
function enrichMatchConfigForSources(value, sources) {
  const config = parseLib.normalizeAntrepoMatchConfig(value);
  const conditions = config.conditions.map((condition, index) => ({
    id: String(condition.id || `condition-${index + 1}`),
    normalization: condition.normalization || '',
    operands: condition.operands.map(operand => enrichMatchOperand(operand, sources)),
  }));
  return parseLib.normalizeAntrepoMatchConfig({
    version: 2,
    sources: sources.map(source => ({
      id: source.id, role: source.role, profileId: source.profileId, label: source.label, kind: source.kind,
      connectionId: source.item ? source.item.id : '',
    })),
    conditions,
  });
}
function validateMatchConfig(config) {
  if (!config.conditions.length) {
    const error = new Error('En az bir eşleştirme koşulu gerekli.');
    error.statusCode = 400; error.code = 'MATCH_CONDITION_REQUIRED'; throw error;
  }
  const seenConditions = new Set();
  config.conditions.forEach((condition, index) => {
    if (condition.operands.length < 2) {
      const error = new Error(`Koşul ${index + 1} en az iki kaynağı karşılaştırmalı.`);
      error.statusCode = 400; error.code = 'MATCH_OPERAND_REQUIRED'; throw error;
    }
    const seenSources = new Set();
    for (const operand of condition.operands) {
      if (!operand.name && !operand.canonicalHeader && !operand.header) {
        const error = new Error(`Koşul ${index + 1} için ${operand.sourceId || operand.role || 'kaynak'} sütunu seçilmedi.`);
        error.statusCode = 400; error.code = 'MATCH_COLUMN_REQUIRED'; throw error;
      }
      if (operand.unresolved) {
        const label = operand.canonicalHeader || operand.header || operand.name;
        const error = new Error(operand.unresolved === 'source'
          ? `Koşul ${index + 1}: "${label}" alanının kaynağı bağlı değil. Kaynağı seçin.`
          : `Koşul ${index + 1}: "${label}" sütunu kaynakta bulunamadı. Doğru sütunu seçin.`);
        error.statusCode = 400; error.code = 'MATCH_COLUMN_UNRESOLVED'; throw error;
      }
      if (seenSources.has(operand.sourceId)) {
        const error = new Error(`Koşul ${index + 1}: aynı kaynak bir koşulda iki kez kullanılamaz.`);
        error.statusCode = 400; error.code = 'MATCH_SOURCE_DUPLICATE'; throw error;
      }
      seenSources.add(operand.sourceId);
    }
    /* Birebir AYNI koşulu iki kez kaydetmek kuralı değiştirmez, yalnız her
       yenilemede ikinci kez hesaplanır ve ekranı karıştırır. */
    const key = JSON.stringify(condition.operands
      .map(operand => [operand.sourceId, operand.table || '', operand.name || operand.canonicalHeader || operand.header])
      .sort());
    if (seenConditions.has(key)) {
      const error = new Error(`Koşul ${index + 1} daha önce eklenmiş bir koşulun aynısı.`);
      error.statusCode = 400; error.code = 'MATCH_CONDITION_DUPLICATE'; throw error;
    }
    seenConditions.add(key);
  });
  return config;
}
function canonicalMatchSide(header, mapped = null) {
  return mapped || { header, canonicalHeader: header, table: '', name: '', kind: 'column' };
}
/* Alan eşlemesinden türetilen öneri. Rol başına birincil kaynak üzerinden kurulur;
   kaynak adı değil ROL sabittir, çünkü öneri "sipariş satırı ile antrepo satırını
   nasıl bağlarız" sorusunun bilinen cevabıdır. */
function suggestedMatchConfig(sources) {
  const pairs = [
    ['Sipariş Kod', 'Sipariş Kod'],
    ['Model Adı', 'Ürün Ad'],
    ['Renk Kod', 'Renk Kod'],
  ];
  const left = sources.find(source => source.role === 'asas') || null;
  const right = sources.find(source => source.role === 'antrepo') || null;
  if (!left || !right) return null;
  const sideFor = (source, header) => {
    const mapped = source.item ? matchSideFromCanonical(source.item, header) : null;
    return { sourceId: source.id, role: source.role, ...canonicalMatchSide(header, mapped) };
  };
  return {
    version: 2,
    conditions: pairs.map(([asasHeader, iasHeader], index) => ({
      id: ['ocode', 'model', 'ccode'][index],
      operands: [sideFor(left, asasHeader), sideFor(right, iasHeader)],
    })),
  };
}

app.get('/api/match-rule', userAccess.requireArea('source'), async (req, res) => {
  try {
    const id = sourceUserId(req), runtime = cacheForUser(id);
    const ov = loadOverrides();
    const sourceMode = ['database', 'dashboard'].includes(ov.antrepoSourceMode) ? ov.antrepoSourceMode : 'excel';
    const full = String(req.query.full || '') === '1';
    const fullSourceId = String(req.query.fullSource || '').trim();
    const catalog = await matchRuleSourceCatalog(runtime, { full, fullSourceId });
    const config = enrichMatchConfigForSources(ov.antrepoMatchConfig, catalog);
    res.json({
      config,
      revision: Number(ov._revisions && ov._revisions.antrepoMatchRule) || 0,
      suggested: suggestedMatchConfig(catalog),
      sources: catalog.map(source => ({
        id: source.id, role: source.role, profileId: source.profileId, label: source.label,
        kind: source.kind, connection: source.connection, columns: source.columns,
        error: source.error, authoritative: source.authoritative, schemaLoaded: source.schemaLoaded,
      })),
      unresolved: parseLib.unresolvedMatchOperands(config),
      sourceMode,
      fullSchema: full,
      fullSourceId,
      exactOnly: true,
    });
  } catch (err) { apiError(res, err, 'Eşleştirme kuralı okunamadı.'); }
});
app.put('/api/match-rule', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), async (req, res) => {
  try {
    const id = sourceUserId(req), runtime = cacheForUser(id);
    const ov = loadOverrides();
    const sourceMode = ['database', 'dashboard'].includes(ov.antrepoSourceMode) ? ov.antrepoSourceMode : 'excel';
    const catalog = await matchRuleSourceCatalog(runtime, { full: false });
    const incoming = (req.body || {}).config || (req.body || {}).rule;
    const config = validateMatchConfig(enrichMatchConfigForSources(incoming, catalog));
    const saved = replaceAntrepoMatchRule(config, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'DATA_MATCH_RULE_UPDATE', 'settings', {
      conditions: config.conditions.length,
      sources: config.sources.map(source => source.id),
      sourceMode,
    });
    publishSharedMasterChange('antrepoMatchRule', req);
    res.json(saved);
  } catch (err) { apiError(res, err, 'Eşleştirme kuralı kaydedilemedi.'); }
});
app.get('/api/match-audit', userAccess.requireArea('source'), async (req, res) => {
  try {
    const target = String(req.query.target || 'backlog') === 'cp' ? 'cp' : 'backlog';
    assertSourceFilters([target], req);
    const id = sourceUserId(req), runtime = cacheForUser(id);
    if (!runtime.asasOrders) await ensureDataLoaded(id);
    const active = cacheForUser(id), overrides = effectiveOverridesForUser(id);
    const audit = parseLib.auditAntrepoMatching(
      ordersForTarget(active, target, overrides),
      antrepoForTarget(active, target),
      overrides.antrepoMatchConfig);
    sendDateSafeJson(res, { target, ...audit });
  } catch (err) { apiError(res, err, 'Eşleştirme denetimi çalıştırılamadı.'); }
});
app.get('/api/transit-rules', (req, res) => {
  const ov = loadOverrides();
  const revision = Number(ov._revisions && ov._revisions.transitRules) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({ rules: Array.isArray(ov.transitRules) ? ov.transitRules : [], revision });
});
app.put('/api/transit-rules', userAccess.requireArea('source'), userAccess.requirePermission('manageBusinessRules'), (req, res) => {
  try {
    const incoming = (req.body || {}).rules;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'rules (dizi) zorunlu.' });
    const seen = new Set();
    const rules = incoming.map((r, i) => ({
      id: String(r.id || ('transit-rule-' + Date.now() + '-' + i)),
      exfStart: normalizePricingRuleDate(r.exfStart),
      exfEnd: normalizePricingRuleDate(r.exfEnd),
      seasons: normalizeTransitList(r.seasons),
      countries: normalizeTransitList(r.countries),
      delType: normalizeTransitDelType(r.delType),
      days: Number(r.days),
    })).filter(r => {
      if ((r.exfStart && r.exfEnd && r.exfStart > r.exfEnd) || !r.delType || !Number.isFinite(r.days) || !Number.isInteger(r.days) || r.days < 0 || r.days > 3650) return false;
      const key = [r.exfStart, r.exfEnd, r.seasons.map(v => v.toLocaleUpperCase('tr-TR')).join('~'), r.countries.map(v => v.toLocaleUpperCase('tr-TR')).join('~'), r.delType].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const baseRules = Array.isArray(req.body && req.body.baseRules) ? req.body.baseRules : null;
    const saved = replaceTransitRules(rules, requestRevision(req), baseRules);
    publishSharedMasterChange('transitRules', req);
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, rules: saved.rules, revision: saved.revision });
  } catch (err) { apiError(res, err, 'Transit kuralları kaydedilemedi.'); }
});

app.get('/api/non-dtr-manufacturers', (_req, res) => {
  const ov = loadOverrides();
  const revision = Number(ov._revisions && ov._revisions.nonDtrManufacturers) || 0;
  res.set('ETag', `"${revision}"`);
  res.json({ manufacturers: BLBusinessRules.normalizeManufacturerList(ov.nonDtrManufacturers), revision });
});
app.put('/api/non-dtr-manufacturers', userAccess.requireArea('source'), userAccess.requirePermission('manageBusinessRules'), (req, res) => {
  try {
    const incoming = (req.body || {}).manufacturers;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'manufacturers (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    const manufacturers = BLBusinessRules.normalizeManufacturerList(incoming)
      .filter(value => value.length <= 160)
      .slice(0, 1000);
    const saved = replaceNonDtrManufacturers(manufacturers, requestRevision(req));
    publishSharedMasterChange('nonDtrManufacturers', req);
    res.set('ETag', `"${saved.revision}"`);
    res.json({ ok: true, manufacturers: saved.manufacturers, revision: saved.revision });
  } catch (err) { apiError(res, err, 'Non-DTR üreticiler kaydedilemedi.'); }
});

/* --- Veri modeli bağlantıları ---------------------------------------------
 * Kaynak Excel dosyalarındaki pivotlar SSAS Tabular modellerine bağlıdır. Buradaki
 * uçlar aynı modelleri Excel'i hiç açmadan sorgulayıp sonucu diske yazar.
 *
 * ÖNEMLİ: "Kaynak Veriden Güncelle" akışı DEĞİŞMEDİ. Uygulama verisini hâlâ Excel
 * dosyalarından okur; bu uçlar yalnız ölçüm ve dışa aktarma içindir.
 */
const MODEL_EXPORT_ROOT = path.join(LOCAL_DATA_ROOT, 'model-exports');
const modelRunInFlight = new Set();

function modelExportPath(name, format) {
  const base = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'model-export';
  const withExt = /\.(csv|json)$/i.test(base) ? base : `${base}.${format === 'json' ? 'json' : 'csv'}`;
  return path.join(MODEL_EXPORT_ROOT, withExt);
}
function modelSupportInfo() {
  return { supported: platform.IS_WINDOWS, platformLabel: platform.platformLabel(), exportFolder: MODEL_EXPORT_ROOT };
}
function modelApiError(res, err, fallback) {
  const status = Number(err && err.statusCode) || 500;
  res.status(status).json({
    error: String(err && err.message ? err.message : fallback),
    code: (err && err.code) || 'MODEL_QUERY_FAILED',
  });
}

// Ufuk/filter seçim listeleri aynı alan için tekrar tekrar pahalı DISTINCT DAX
// çalıştırmasın. Beş dakikalık sonuç cache'i ve aynı anda gelen istek birleştirmesi
// Source ile Data Model Connection ekranlarını belirgin biçimde hızlandırır.
const MODEL_DISTINCT_CACHE_TTL_MS = 5 * 60 * 1000;
const modelDistinctCache = new Map();
const modelDistinctPending = new Map();
function modelDistinctCacheKey(body, limit) {
  return [
    String(body.server || '').trim().toLowerCase(),
    String(body.catalog || '').trim().toLowerCase(),
    String(body.table || '').trim().toLowerCase(),
    String(body.field || '').trim().toLowerCase(),
    String(body.search || '').trim().toLocaleLowerCase('tr-TR'),
    String(limit),
  ].join('|');
}
async function cachedModelDistinct(body, limit, loader) {
  const key = modelDistinctCacheKey(body, limit);
  const hit = modelDistinctCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_DISTINCT_CACHE_TTL_MS) {
    return { ...hit.value, values: [...hit.value.values], cached: true };
  }
  if (modelDistinctPending.has(key)) {
    const value = await modelDistinctPending.get(key);
    return { ...value, values: [...value.values], cached: true };
  }
  const pending = Promise.resolve().then(loader).then(value => {
    const stored = { ...value, values: [...value.values] };
    modelDistinctCache.set(key, { at: Date.now(), value: stored });
    return stored;
  }).finally(() => modelDistinctPending.delete(key));
  modelDistinctPending.set(key, pending);
  const value = await pending;
  return { ...value, values: [...value.values], cached: false };
}

/* v7.83 — DISTINCT DEĞER KENDİ TİPİYLE BİRLİKTE DÖNER.

   Listeden seçilen bir değer, AYNI ŞEMAYA karşı doğrudan filtre olarak
   kullanılabilmeli. Eskiden buradan yalnız `String(value)` dönüyordu: tip
   bilgisi kayboluyor, arayüz metin saklıyor ve predicate üreticisi sayısal bir
   sütuna metin literali yazıyordu.

   GÖSTERİM METİN KALIR — bilinçli. "00123" sayıya çevrilseydi baştaki sıfırlar
   yok olur ve değer artık hiçbir satırı tutmazdı. Taşınan şey değerin biçimi
   değil, ALANIN TİPİDİR (`valueType`); kanonik dönüşümü predicate üreticisi
   yapar (filter-value-types.js). */
async function resolveDistinctValueType(body) {
  try {
    const schema = await modelQuery.discoverSchema({ server: body.server, catalog: body.catalog });
    return filterValueTypes.columnTypeIndex(schema)(body.table, body.field) || '';
  } catch (_) {
    // Şema okunamadı: tip bildirilmez ve çağıran taraf bugünkü davranışına düşer.
    return '';
  }
}
async function queryModelDistinctValues(body, limit = 5000) {
  const valueType = await resolveDistinctValueType(body);
  return cachedModelDistinct({ ...body, valueType }, limit, async () => {
    const table = String(body.table || '').trim();
    const field = String(body.field || '').trim();
    const column = `'${table.replace(/'/g, "''")}'[${field.replace(/]/g, ']]')}]`;
    const search = String(body.search || '').trim().slice(0, 120);
    const offset = Math.min(100000, Math.max(0, Number(body.offset) || 0));
    const escapedSearch = search.replace(/"/g, '""');
    /* CONTAINSSTRING metin işlevidir; sayısal veya tarih bir sütunda sorguyu tip
       hatasıyla düşürür. Bu sütunlarda arama sorguya değil, gelen listeye
       uygulanır — kullanıcı yine arayabilir, sorgu yine çalışır. */
    const searchInDax = Boolean(search) && filterValueTypes.supportsTextOperators(valueType);
    const source = searchInDax
      ? `FILTER(DISTINCT(${column}), CONTAINSSTRING(${column}, "${escapedSearch}"))`
      : `DISTINCT(${column})`;
    const take = Math.min(100000, offset + limit);
    const result = await modelQuery.runModelRows({
      server: body.server, catalog: body.catalog,
      query: `EVALUATE TOPN(${take}, ${source}, ${column}, ASC)`,
      generated: true, maxRows: take, timeoutMs: 120000,
    });
    const searchKey = search.toLocaleLowerCase('tr-TR');
    const allValues = [...new Set((result.rows || []).map(row => {
      const first = Object.values(row)[0];
      return first == null ? '' : String(first).trim();
    }))]
      .filter(value => searchInDax || !searchKey || value.toLocaleLowerCase('tr-TR').includes(searchKey))
      .sort((a, b) => a.localeCompare(b, 'tr'));
    const values = allValues.slice(offset, offset + limit);
    return {
      ok: true, table, field, values, valueType,
      offset, limit, hasMore: allValues.length > offset + values.length,
      truncated: allValues.length >= take,
      elapsedMs: result.elapsedMs, provider: result.provider,
    };
  });
}

/* VERİ YÖNETİMİ ÖZETİ (P2).

   Yeni ekran ham modelConnections'ı OKUMAZ. Okusaydı rol adları, kapsam
   dizileri ve ufuk nesneleri istemciye yeniden sızar ve eski karmaşa yeni
   ekranda tekrar kurulurdu. Bu uç yalnız görüntülenecek olanı döndürür:
   kaynaklar, modüller, filtre özetleri ve matris hücre durumları.

   Salt-okunur ve sorgusuz: bir kaynak erişilemez olsa bile 200 döner. */
app.get('/api/data-management/overview', userAccess.requireArea('source'), (req, res) => {
  try {
    const store = loadModelConnections();
    const language = String(req.query && req.query.language || 'tr') === 'en' ? 'en' : 'tr';

    /* Ekran, GERÇEKTE çalışacak filtreyi göstermeli. Bu yüzden katman
       çözümlemesi yenileme akışının kullandığı AYNI girdilerle yapılır:
       aynı rol şablonları, aynı ön ayar çözümleyicisi. Farklı girdi vermek,
       ekranın yenilemenin çalıştırmayacağı bir filtre göstermesi demekti. */
    const userId = sourceUserId(req);
    const roleEntries = userAccess.roleWorkspaceEntries(req.currentUser || userId);
    const resolveLayer = ({ moduleId, sourceId, role, definition }) => {
      try {
        return userPreferences.resolveHorizonProvenance(
          userId, moduleId, definition, { connectionId: sourceId, role }, roleEntries);
      } catch (error) {
        // Tercih okunamıyorsa ekran kapanmaz; yalnız ortak katman gösterilir.
        logRuntimeFailure('dataManagementLayer', error);
        return null;
      }
    };

    const model = dataManagementReadModel.build(store.items, { language, resolveLayer });
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      revision: store.revision,
      ...model,
      support: modelSupportInfo(),
      /* v7.81 — Araçlar bölümü için ortam bilgisi. "Kaynak Klasör" eskiden
         düğmenin ETİKETİNDE seçili yolu gösteriyordu; araç satırına taşınınca
         o bilgi kaybolmasın diye burada döner. Ayrı bir /api/status isteği
         atmak, ekran zaten bu özeti alırken ikinci bir gidiş-dönüş olurdu. */
      environment: { sourceFolder: sourceFolderForUser(req) },
      // Yazma yetkisi olmayan kullanıcı ekranı görebilir ama düzenleyemez;
      // arayüz düğmeleri buna göre kapatır (tahmin etmez).
      canManage: Boolean(req.currentUser && userAccess.hasPermission(req.currentUser, 'manageModelConnections')),
    });
  } catch (err) { apiError(res, err, 'Veri Yönetimi özeti okunamadı.'); }
});

/* CORPORATE INTEGRATION LAB.

   This projection deliberately reuses Data Management, the per-user runtime
   cache and Automation recipes. It is diagnostic only: it owns no connection,
   mapping, refresh or automation configuration and cannot execute a destructive browser
   action. A live source probe is performed only by the explicit inspect POST.

   v10.91 — Live probe evidence is retained in-memory for a short diagnostic
   window. Previously the POST returned the probe to the browser but the later
   AI export rebuilt the snapshot with an empty probe list, so a genuinely
   corporate test was exported as LOCAL_SIMULATION. */
const INTEGRATION_LAB_PROBE_TTL_MS = 30 * 60 * 1000;
const integrationLabProbeCache = new Map();

function integrationLabProbeOwner(req) {
  return String(req && req.currentUser && req.currentUser.id || sourceUserId(req) || 'anonymous');
}
function integrationLabProbeKey(req, sourceId) {
  return `${integrationLabProbeOwner(req)}|${String(sourceId || '')}`;
}
function integrationLabPruneProbes() {
  const now = Date.now();
  for (const [key, probe] of integrationLabProbeCache) {
    const at = Date.parse(probe && probe.at || 0);
    if (!at || now - at > INTEGRATION_LAB_PROBE_TTL_MS) integrationLabProbeCache.delete(key);
  }
}
function integrationLabRememberProbe(req, probe) {
  if (!probe || !probe.sourceId) return;
  integrationLabPruneProbes();
  integrationLabProbeCache.set(integrationLabProbeKey(req, probe.sourceId), corporateIntegrationLab.redact(probe));
}
function integrationLabRememberedProbes(req) {
  integrationLabPruneProbes();
  const prefix = `${integrationLabProbeOwner(req)}|`;
  return [...integrationLabProbeCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, probe]) => probe);
}
function integrationLabEffectiveProbes(req, probes = []) {
  const merged = new Map();
  for (const probe of integrationLabRememberedProbes(req)) {
    if (probe && probe.sourceId) merged.set(String(probe.sourceId), probe);
  }
  for (const probe of Array.isArray(probes) ? probes : []) {
    if (probe && probe.sourceId) merged.set(String(probe.sourceId), corporateIntegrationLab.redact(probe));
  }
  return [...merged.values()];
}

function integrationLabRowsForSource(source, runtime, userId) {
  if (!source) return [];
  if (source.profileId === 'intake-budget') {
    const snapshot = intakeStore.loadSnapshot(userId);
    return snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
  }
  if (!runtime) return [];
  if (source.profileId === 'asas-orders') return Array.isArray(runtime.asasOrders) ? runtime.asasOrders : [];
  if (source.profileId === 'ias-warehouse') {
    const values = Object.values(runtime.antrepoMap && typeof runtime.antrepoMap === 'object' ? runtime.antrepoMap : {});
    const rows = [];
    for (const value of values) {
      if (Array.isArray(value)) rows.push(...value.filter(item => item && typeof item === 'object'));
      else if (value && typeof value === 'object') rows.push(value);
    }
    return rows;
  }
  return [];
}

function integrationLabSourceAudits(overview, runtime, userId) {
  const ias = Array.isArray(overview && overview.sources)
    ? overview.sources.find(source => source.profileId === 'ias-warehouse')
    : null;
  if (!ias || !runtime) return {};
  try {
    const overrides = effectiveOverridesForUser(userId);
    return {
      [ias.id]: parseLib.auditAntrepoMatching(
        Array.isArray(runtime.asasOrders) ? runtime.asasOrders : [],
        runtime.antrepoMap && typeof runtime.antrepoMap === 'object' ? runtime.antrepoMap : {},
        overrides.antrepoMatchConfig),
    };
  } catch (error) {
    logRuntimeFailure('integrationLabMatchAudit', error);
    return {};
  }
}

function integrationLabSnapshot(req, probes = []) {
  const store = loadModelConnections();
  const language = String(req.query && req.query.language || req.body && req.body.language || 'tr') === 'en' ? 'en' : 'tr';
  const overview = dataManagementReadModel.build(store.items, { language });
  const userId = sourceUserId(req);
  const runtime = cacheForUser(userId);
  const sourceRows = {};
  for (const source of overview.sources) sourceRows[source.id] = integrationLabRowsForSource(source, runtime, userId);
  const sourceAudits = integrationLabSourceAudits(overview, runtime, userId);
  return corporateIntegrationLab.buildSnapshot({
    overview,
    support: modelSupportInfo(),
    probes: integrationLabEffectiveProbes(req, probes),
    sourceRows,
    sourceAudits,
    automations: automationState(req.currentUser.id, req.currentUser),
  });
}

function integrationLabProbeError(error) {
  return {
    error: String(error && error.message || error || 'Unknown error'),
    code: String(error && error.code || ''),
    statusCode: Number(error && error.statusCode) || 0,
  };
}

function integrationLabScopeDescriptor(scope) {
  return {
    id: String(scope && scope.id || ''),
    name: String(scope && scope.name || ''),
    targets: Array.isArray(scope && scope.targets) ? scope.targets.slice(0, 20) : [],
  };
}

/* Execute the same generated/manual DAX shape as the real source, but keep the
   returned row sample bounded. The query itself is preserved in the diagnostic
   package so an AI can identify stale mappings/columns instead of seeing only
   "connection successful". */
async function integrationLabProbeTabularSource(req, source, storedItem, probe) {
  const schema = await modelQuery.discoverSchema({
    server: source.connection.server,
    catalog: source.connection.catalog,
  });
  probe.schema = {
    columnCount: Array.isArray(schema.columns) ? schema.columns.length : 0,
    measureCount: Array.isArray(schema.measures) ? schema.measures.length : 0,
    errors: Array.isArray(schema.errors) ? schema.errors.slice(0, 20) : [],
    provider: String(schema.provider || probe.provider || ''),
  };
  const columnType = filterValueTypes.columnTypeIndex(schema);
  const scopes = effectiveScopes(storedItem).filter(scope => scope && scope.enabled !== false);
  if (!scopes.length) {
    const error = new Error('Bu kaynak için çalıştırılabilir kapsam bulunamadı.');
    error.code = 'MODEL_REFRESH_NO_SCOPE';
    error.statusCode = 400;
    throw error;
  }
  const uniqueScopes = [...new Map(scopes.map(scope => [String(scope.id || ''), scope])).values()];
  const limitedScopes = uniqueScopes.slice(0, 12);
  const overrides = effectiveOverridesForUser(sourceUserId(req));
  const matchRule = overrides && overrides.antrepoMatchConfig;
  const queryRuns = [];
  let sample = [];
  let sampledRows = 0;

  for (const scope of limitedScopes) {
    const descriptor = integrationLabScopeDescriptor(scope);
    try {
      const scoped = { ...storedItem, horizon: scope.horizon || {}, _scopeTargets: scope.targets || [] };
      const built = buildConnectionQuery(scoped, { columnType, matchRule });
      const result = await modelQuery.runModelRows({
        server: storedItem.server,
        catalog: storedItem.catalog,
        query: built.query,
        headerMap: built.headerMap,
        generated: Boolean(built.generated),
        maxRows: 250,
        timeoutMs: 120000,
      });
      const rows = Array.isArray(result.rows) ? result.rows : [];
      if (!sample.length && rows.length) sample = rows.slice(0, 5);
      sampledRows += rows.length;
      queryRuns.push({
        ...descriptor,
        ok: true,
        mode: built.mode,
        generated: Boolean(built.generated),
        query: built.query,
        rowCount: Number(result.rowCount) || rows.length,
        sampledRows: rows.length,
        truncated: Boolean(result.truncated),
        elapsedMs: Number(result.elapsedMs) || 0,
        provider: String(result.provider || ''),
        warnings: (built.warnings || []).slice(0, 20),
      });
    } catch (error) {
      queryRuns.push({ ...descriptor, ok: false, ...integrationLabProbeError(error) });
    }
  }
  probe.queryRuns = queryRuns;
  probe.queryOk = queryRuns.length > 0 && queryRuns.every(run => run.ok === true);
  probe.queryRowCount = sampledRows;
  probe.queryError = probe.queryOk ? '' : String((queryRuns.find(run => !run.ok) || {}).error || 'Live query failed.');
  probe.queryCode = probe.queryOk ? '' : String((queryRuns.find(run => !run.ok) || {}).code || '');
  probe.scopeCount = uniqueScopes.length;
  probe.scopeProbeTruncated = Math.max(0, uniqueScopes.length - limitedScopes.length);
  probe.sample = sample;
  return sample;
}

async function integrationLabProbeIntake(req, source, storedItem, probe) {
  const connection = {
    id: storedItem && storedItem.id || source.id,
    name: storedItem && storedItem.name || source.name || 'INTAKE',
    server: storedItem && storedItem.server || source.connection.server,
    catalog: storedItem && storedItem.catalog || source.connection.catalog,
    model: 'Model',
  };
  const found = await intakeLiveFields(connection);
  probe.schema = {
    columnCount: Array.isArray(found.schema && found.schema.columns) ? found.schema.columns.length : 0,
    measureCount: Array.isArray(found.schema && found.schema.measures) ? found.schema.measures.length : 0,
    errors: Array.isArray(found.schema && found.schema.errors) ? found.schema.errors.slice(0, 20) : [],
    provider: String(found.schema && found.schema.provider || probe.provider || ''),
  };
  const snapshot = intakeStore.loadSnapshot(req.currentUser.id);
  const saved = intakeStoredView(req.currentUser.id);
  const viewConfig = intakeReport.reconcileViewConfig(saved || (snapshot && snapshot.viewConfig) || null, found.fields);
  const scopes = storedItem ? effectiveScopes(storedItem).filter(scope => scope && scope.enabled !== false) : [];
  const intakeScope = scopes.find(scope => Array.isArray(scope.targets) && scope.targets.includes('intake')) || scopes[0] || null;
  const horizon = intakeScope && intakeScope.horizon || intakeHorizon();
  const built = intakeReport.buildIntakeQuery({ fields: found.fields, viewConfig, horizon, maxRows: 250 });
  const started = Date.now();
  const result = await modelQuery.runModelRows({
    server: connection.server,
    catalog: connection.catalog,
    query: built.query,
    headerMap: built.headerMap,
    generated: true,
    maxRows: built.maxRows,
    timeoutMs: 180000,
  });
  const rows = intakeReport.normalizeRows(result.rows, built.viewConfig);
  probe.queryOk = true;
  probe.queryRowCount = rows.length;
  probe.queryError = '';
  probe.queryCode = '';
  probe.queryRuns = [{
    id: intakeScope && intakeScope.id || 'intake',
    name: intakeScope && intakeScope.name || 'INTAKE',
    targets: intakeScope && Array.isArray(intakeScope.targets) ? intakeScope.targets : ['intake'],
    ok: true,
    mode: 'generated',
    generated: true,
    query: built.query,
    rowCount: Number(result.rowCount) || rows.length,
    sampledRows: rows.length,
    truncated: Boolean(result.truncated) || rows.length >= built.maxRows,
    elapsedMs: Number(result.elapsedMs) || (Date.now() - started),
    provider: String(result.provider || ''),
    queryFields: built.queryFields,
  }];
  probe.sample = rows.slice(0, 5);
  return rows;
}

async function integrationLabRunLiveProbe(req, source, storedItem) {
  let probe = {
    kind: 'live-connectivity',
    sourceId: source.id,
    sourceName: source.name,
    profileId: source.profileId,
    ok: false,
    queryOk: null,
    simulated: false,
    at: new Date().toISOString(),
    error: '',
    code: '',
  };
  let liveRows = [];
  try {
    const discovered = await modelQuery.discoverTables({
      server: source.connection.server,
      catalog: source.connection.catalog,
    });
    probe = {
      ...probe,
      ok: true,
      provider: discovered.provider || '',
      method: discovered.method || '',
      tableCount: Array.isArray(discovered.tables) ? discovered.tables.length : 0,
      elapsedMs: Number(discovered.elapsedMs) || 0,
      attempts: Array.isArray(discovered.attempts) ? discovered.attempts.slice(0, 10) : [],
    };
  } catch (error) {
    Object.assign(probe, integrationLabProbeError(error));
    logRuntimeFailure('integrationLabConnectivityProbe', error);
    return { probe, liveRows };
  }

  try {
    liveRows = source.profileId === 'intake-budget'
      ? await integrationLabProbeIntake(req, source, storedItem, probe)
      : await integrationLabProbeTabularSource(req, source, storedItem, probe);
  } catch (error) {
    const failure = integrationLabProbeError(error);
    probe.queryOk = false;
    probe.queryError = failure.error;
    probe.queryCode = failure.code;
    probe.queryRuns = Array.isArray(probe.queryRuns) && probe.queryRuns.length
      ? probe.queryRuns
      : [{ id: 'query', name: source.name, targets: [], ok: false, ...failure }];
    logRuntimeFailure('integrationLabQueryProbe', error);
  }
  return { probe, liveRows };
}

app.get('/api/data-management/integration-lab', userAccess.requireArea('source'), (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({ ok: true, ...integrationLabSnapshot(req) });
  } catch (err) { apiError(res, err, 'Corporate Integration Lab okunamadı.'); }
});

app.post('/api/data-management/integration-lab/inspect', userAccess.requireArea('source'), express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const store = loadModelConnections();
    const base = integrationLabSnapshot(req);
    const overviewSource = base.inventory.find(item => item.id === String(body.sourceId || '') && item.kind === 'database');
    const stored = dataManagementReadModel.build(store.items, { language: body.language === 'en' ? 'en' : 'tr' });
    const source = stored.sources.find(item => item.id === String(body.sourceId || ''));
    if (!source || !overviewSource) return res.status(404).json({ error: 'Kaynak bulunamadı.', code: 'INTEGRATION_SOURCE_NOT_FOUND' });

    const rawSource = store.items.find(item => item && item.id === source.id) || {
      id: source.id,
      name: source.name,
      role: source.profileId === 'intake-budget' ? 'intake' : (source.profileId === 'ias-warehouse' ? 'antrepo' : 'asas'),
      server: source.connection.server,
      catalog: source.connection.catalog,
      mode: source.queryMode === 'manual' ? 'manual' : 'auto',
      query: '',
      mapping: {},
      scopes: [],
    };

    let probe;
    let liveRows = [];
    if (body.liveProbe !== false) {
      const result = await integrationLabRunLiveProbe(req, source, rawSource);
      probe = result.probe;
      liveRows = result.liveRows;
    } else {
      probe = {
        kind: 'live-connectivity', sourceId: source.id, sourceName: source.name,
        profileId: source.profileId, ok: false, queryOk: null, simulated: true,
        at: new Date().toISOString(), error: 'Live probe was not requested.', code: '',
      };
    }
    integrationLabRememberProbe(req, probe);

    const snapshot = integrationLabSnapshot(req, [probe]);
    const userId = sourceUserId(req);
    const runtime = cacheForUser(userId);
    const cachedRows = integrationLabRowsForSource(source, runtime, userId);
    const rows = source.profileId === 'intake-budget' && liveRows.length ? liveRows : cachedRows;
    const sourceAudits = integrationLabSourceAudits(stored, runtime, userId);
    const inspector = corporateIntegrationLab.inspectSource({
      source,
      rawRows: rows,
      normalizedRows: rows,
      modelRows: rows,
      traceValue: body.traceValue,
      joinAudit: sourceAudits[source.id],
      liveProbe: probe,
    });
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      environment: snapshot.environment,
      probe: corporateIntegrationLab.redact(probe),
      inspector,
    });
  } catch (err) { apiError(res, err, 'Entegrasyon tanısı tamamlanamadı.'); }
});

app.get('/api/data-management/integration-lab/diagnostic', userAccess.requireArea('source'), (req, res) => {
  try {
    const report = corporateIntegrationLab.buildDiagnosticPackage(integrationLabSnapshot(req));
    if (String(req.query && req.query.format || '').toLowerCase() === 'text') {
      res.type('text/plain').set('Content-Disposition', 'attachment; filename="buyer-log-integration-diagnostic.txt"').send(report.text);
      return;
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, diagnostic: report.json });
  } catch (err) { apiError(res, err, 'AI tanı paketi oluşturulamadı.'); }
});

/* YENİLEME GRUPLARI (P6).

   Tanım ORTAK, çalıştırma kişisel. Grubun kendisi yenileme yapmaz: istemci
   grubun modül listesini mevcut /api/refresh akışına verir. İkinci bir
   yenileme motoru YAZILMADI — aşama paneli, iptal ve iş kuyruğu zaten var
   ve çalışıyor (CLAUDE.md §9). */
app.get('/api/data-management/refresh-groups', userAccess.requireArea('source'), (_req, res) => {
  try {
    const store = loadRefreshGroups();
    res.set('ETag', `"${store.revision}"`).set('Cache-Control', 'no-store')
      .json({ ok: true, items: store.items, revision: store.revision, refreshableModules: refreshGroupRules.refreshableModules() });
  } catch (err) { apiError(res, err, 'Yenileme grupları okunamadı.'); }
});

app.put('/api/data-management/refresh-groups', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit: '64kb' }), (req, res) => {
  try {
    const items = (req.body || {}).items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items (dizi) zorunlu.', code: 'VALIDATION_ERROR' });
    /* Sessizce düşürmek yerine NEDENİNİ söyle: normalizeGroups geçersiz grubu
       eler, kullanıcı da kaydettiğini sanıp grubu bulamaz. */
    const check = refreshGroupRules.validateGroups(items);
    if (!check.ok) return res.status(400).json({ error: check.problems.join(' '), code: 'REFRESH_GROUP_INVALID', problems: check.problems });

    const saved = replaceRefreshGroups(items, requestRevision(req));
    userAccess.appendAudit(req.currentUser, 'REFRESH_GROUPS_UPDATE', 'settings', { count: saved.items.length });
    res.set('ETag', `"${saved.revision}"`).json({ ok: true, items: saved.items, revision: saved.revision });
  } catch (err) { apiError(res, err, 'Yenileme grupları kaydedilemedi.'); }
});

/* KAYNAK EKLE / DÜZENLE / AÇ-KAPAT (§7, §8).

   Sihirbazın seçenekleri PROFİL kaydından üretilir; burada sabit bir tür
   listesi yoktur. Yeni bir kaynak türü eklemek source-profiles.js'e bir kayıt
   eklemektir — bu uçta kod değişikliği gerekmez.

   Bağlantı SINAMASI ayrı uçtadır (/api/model-connections/inspect) ve zaten
   çalışıyor; sihirbaz kaydetmeden önce onu çağırır. Burada ikinci bir sınama
   yazılmadı. */
app.get('/api/data-management/source-options', userAccess.requireArea('source'), (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({ ok: true, profiles: dataManagementSourceWriter.createOptions() });
  } catch (err) { apiError(res, err, 'Kaynak türleri okunamadı.'); }
});

/* EXCEL WORKBOOK CONNECTION DISCOVERY --------------------------------------
   Excel yalnız connection metadata keşfi içindir. Worksheet/Pivot sonucu
   okunmaz; workbook path canonical source'a yazılmaz. Seçilen dosya yolu
   Electron picker'ın HMAC proof'u olmadan backend tarafından okunmaz. */
const DATABASE_DISCOVERY_TTL_MS = 15 * 60 * 1000;
const databaseDiscoverySessions = new Map();
function pruneDatabaseDiscoverySessions() {
  const now = Date.now();
  for (const [id, entry] of databaseDiscoverySessions) if (!entry || now - entry.createdAt > DATABASE_DISCOVERY_TTL_MS) databaseDiscoverySessions.delete(id);
}
function workbookPathProof(filePath) {
  if (!DESKTOP_BRIDGE_SECRET) return '';
  const value = path.resolve(String(filePath || '')).toLowerCase();
  return crypto.createHmac('sha256', DESKTOP_BRIDGE_SECRET).update(value, 'utf8').digest('hex');
}
function validWorkbookPathProof(filePath, supplied) {
  const expected = workbookPathProof(filePath), got = String(supplied || '');
  if (!expected || !got || expected.length !== got.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex')); } catch (_) { return false; }
}
function discoverySession(id) {
  pruneDatabaseDiscoverySessions();
  const entry = databaseDiscoverySessions.get(String(id || ''));
  if (!entry) throw Object.assign(new Error('Excel bağlantı keşfi süresi doldu. Dosyayı yeniden seçin.'), { code:'DISCOVERY_EXPIRED', statusCode:410 });
  return entry;
}
function discoveryCandidate(entry, candidateId) {
  const item = (entry.result.connections || []).find(candidate => candidate && candidate.id === String(candidateId || ''));
  if (!item) throw Object.assign(new Error('Seçilen database bağlantısı bulunamadı.'), { code:'DISCOVERY_CONNECTION_NOT_FOUND', statusCode:404 });
  return item;
}
function incomingDbCredential(candidate, body = {}) {
  const auth = candidate && candidate.connector && candidate.connector.auth || {};
  return {
    username: String(body.username != null ? body.username : auth.username || '').trim().slice(0, 300),
    password: String(body.password == null ? '' : body.password),
  };
}
async function testDiscoveredDatabase(candidate, credential = {}) {
  if (!candidate || !candidate.supported) throw Object.assign(new Error('Bu Excel bağlantısı Buyer Log database connector tarafından desteklenmiyor.'), { code:'UNSUPPORTED_PROVIDER', statusCode:400 });
  const connector = candidate.connector || {};
  const auth = connector.auth || {};
  if ((auth.type === 'username-password' || auth.type === 'office-managed') && !credential.password) {
    throw Object.assign(new Error('Bu bağlantı için Buyer Log kimlik bilgisi gerekiyor.'), { code:'AUTH_REQUIRED', statusCode:401 });
  }
  if (connector.kind === 'analysis-services') {
    if (auth.type !== 'windows' && auth.type !== 'unknown') throw Object.assign(new Error('Bu Analysis Services bağlantısının Excel/Office kimlik bilgisi Buyer Log tarafından çıkarılamaz. Windows Authentication kullanın veya bağlantıyı manuel tanımlayın.'), { code:'AUTH_REQUIRED', statusCode:401 });
    const found = await modelQuery.discoverTables({ server:connector.server, catalog:connector.database });
    return { ok:true, provider:found.provider || 'MSOLAP', elapsedMs:Number(found.elapsedMs)||0, tableCount:(found.tables || []).length };
  }
  const tested = await databaseConnector.testConnection(connector, { credentials:credential, timeoutSeconds:30 });
  return { ok:true, provider:tested.provider || connector.provider || connector.driver || connector.kind, elapsedMs:tested.elapsedMs || 0, tableCount:0 };
}

app.post('/api/data-management/database-discovery/excel', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit:'32kb' }), (req, res) => {
  try {
    const filePath = String(req.body && req.body.path || '');
    const proof = String(req.body && req.body.proof || '');
    if (!validWorkbookPathProof(filePath, proof)) return res.status(403).json({ ok:false, code:'WORKBOOK_SELECTION_NOT_VERIFIED', error:'Excel dosyası yalnız Buyer Log dosya seçicisinden seçilebilir.' });
    const result = excelConnectionDiscovery.discoverFile(filePath);
    const id = `xdd_${crypto.randomBytes(16).toString('hex')}`;
    databaseDiscoverySessions.set(id, { createdAt:Date.now(), result });
    const candidates = (result.connections || []).map(excelConnectionDiscovery.publicCandidate);
    return res.set('Cache-Control','no-store').json({
      ok:true, discoveryId:id, workbookName:result.workbookName,
      count:candidates.length, supportedCount:candidates.filter(item => item.supported).length,
      connections:candidates, warnings:result.warnings || [], expiresInMs:DATABASE_DISCOVERY_TTL_MS,
    });
  } catch (err) { apiError(res, err, 'Excel database bağlantı metadata’sı okunamadı.'); }
});

app.post('/api/data-management/database-discovery/:id/test', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit:'32kb' }), async (req, res) => {
  try {
    const entry = discoverySession(req.params.id), candidate = discoveryCandidate(entry, req.body && req.body.candidateId);
    const probe = await testDiscoveredDatabase(candidate, incomingDbCredential(candidate, req.body || {}));
    return res.set('Cache-Control','no-store').json({ ok:true, probe });
  } catch (err) {
    const status = Number(err && err.statusCode) || 502;
    return res.status(status).set('Cache-Control','no-store').json({ ok:false, code:err && err.code || 'DATABASE_TEST_FAILED', error:String(err && err.message || 'Database bağlantısı sınanamadı.') });
  }
});

app.post('/api/data-management/database-discovery/:id/add', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit:'64kb' }), async (req, res) => {
  try {
    const entry = discoverySession(req.params.id), candidate = discoveryCandidate(entry, req.body && req.body.candidateId);
    const credential = incomingDbCredential(candidate, req.body || {});
    const probe = await testDiscoveredDatabase(candidate, credential); // direct DB test; Excel is not used here
    const store = loadModelConnections();
    const plan = dataManagementSourceWriter.planDiscoveredSourceCreate(store.items, {
      name:req.body && req.body.name || candidate.name,
      connector:candidate.connector,
      query:candidate.query && candidate.query.safe ? candidate.query.text : '',
      discovery:{ origin:'excel-workbook', workbookName:entry.result.workbookName, connectionName:candidate.name, importedAt:new Date().toISOString() },
    });
    if (!plan.ok) return res.status(plan.code === 'SOURCE_LIMIT' ? 409 : 400).json({ ok:false, code:plan.code, error:plan.message });
    const saved = replaceModelConnections(plan.items, null);
    try {
      if (credential.password) databaseCredentialStore.set(plan.sourceId, credential);
      else databaseCredentialStore.remove(plan.sourceId);
    } catch (credentialError) {
      // A password-based source without its local secret is not a valid completed
      // import. Roll back the just-created shared config rather than leave a
      // connection that can never run on this PC.
      if (credential.password) {
        try { replaceModelConnections(store.items, null); } catch (_) {}
        throw Object.assign(new Error('Database kimlik bilgisi bu bilgisayarda güvenli biçimde saklanamadı.'), { code:'CREDENTIAL_SAVE_FAILED', statusCode:500 });
      }
    }
    databaseDiscoverySessions.delete(req.params.id);
    userAccess.appendAudit(req.currentUser, 'DATABASE_SOURCE_IMPORT_EXCEL', plan.sourceId, {
      sourceName:req.body && req.body.name || candidate.name, workbookName:entry.result.workbookName,
      connectionName:candidate.name, connectorKind:candidate.connector && candidate.connector.kind || '',
    });
    publishSharedMasterChange('modelConnections', req);
    return res.status(201).set('Cache-Control','no-store').json({ ok:true, sourceId:plan.sourceId, revision:saved.revision, probe, warnings:plan.warnings || [] });
  } catch (err) {
    const status = Number(err && err.statusCode) || 500;
    return res.status(status).set('Cache-Control','no-store').json({ ok:false, code:err && err.code || 'DATABASE_SOURCE_IMPORT_FAILED', error:String(err && err.message || 'Database kaynağı eklenemedi.') });
  }
});

function savedDatabaseSource(sourceId) {
  const item = loadModelConnections().items.find(value => value && value.id === String(sourceId || ''));
  if (!item || item.role !== 'custom' || !item.connector) throw Object.assign(new Error('Database kaynağı bulunamadı.'), { code:'DATABASE_SOURCE_NOT_FOUND', statusCode:404 });
  return item;
}
function localDatabaseCredential(item, body = {}) {
  const stored = databaseCredentialStore.get(item.id);
  return {
    username:String(body.username != null ? body.username : stored.username || item.connector && item.connector.auth && item.connector.auth.username || '').trim().slice(0,300),
    password:String(body.password != null ? body.password : stored.password || ''),
  };
}
app.post('/api/database-sources/:id/test', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit:'32kb' }), async (req, res) => {
  try {
    const item = savedDatabaseSource(req.params.id), credential = localDatabaseCredential(item, req.body || {});
    let probe;
    if (item.connector.kind === 'analysis-services') {
      const found = await modelQuery.discoverTables({ server:item.connector.server, catalog:item.connector.database });
      probe = { provider:found.provider || 'MSOLAP', elapsedMs:Number(found.elapsedMs)||0, tableCount:(found.tables || []).length };
    } else probe = await databaseConnector.testConnection(item.connector, { credentials:credential, timeoutSeconds:30 });
    return res.set('Cache-Control','no-store').json({ ok:true, probe, credential:databaseCredentialStore.publicStatus(item.id) });
  } catch (err) { return res.status(Number(err && err.statusCode)||502).set('Cache-Control','no-store').json({ ok:false, code:err && err.code || 'DATABASE_TEST_FAILED', error:String(err && err.message || 'Database bağlantısı sınanamadı.') }); }
});
app.post('/api/database-sources/:id/query', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit:'256kb' }), async (req, res) => {
  try {
    const item = savedDatabaseSource(req.params.id), credential = localDatabaseCredential(item, req.body || {});
    const query = String(req.body && req.body.query != null ? req.body.query : item.query || '');
    let result;
    if (item.connector.kind === 'analysis-services') {
      result = await modelQuery.runModelRows({ server:item.connector.server, catalog:item.connector.database, query, generated:false, maxRows:Math.min(1000, Math.max(1, Number(req.body && req.body.maxRows)||20)), timeoutMs:120000 });
    } else result = await databaseConnector.runRows(item.connector, query, { credentials:credential, maxRows:Math.min(1000, Math.max(1, Number(req.body && req.body.maxRows)||20)), timeoutSeconds:120 });
    return res.set('Cache-Control','no-store').json({ ok:true, rows:result.rows || [], rowCount:Number(result.rowCount)||0, elapsedMs:Number(result.elapsedMs)||0, provider:result.provider || '', truncated:Boolean(result.truncated) });
  } catch (err) { return res.status(Number(err && err.statusCode)||502).set('Cache-Control','no-store').json({ ok:false, code:err && err.code || 'DATABASE_QUERY_FAILED', error:String(err && err.message || 'Database sorgusu çalıştırılamadı.') }); }
});

app.post('/api/data-management/source', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit: '256kb' }), (req, res) => {
  try {
    const body = req.body || {};
    const store = loadModelConnections();
    const plan = dataManagementSourceWriter.planSourceCreate(store.items, {
      name: body.name, profileId: body.profileId,
      server: body.server, catalog: body.catalog,
      moduleIds: body.moduleIds,
    });
    if (!plan.ok) {
      const status = plan.code === 'SOURCE_LIMIT' ? 409 : 400;
      return res.status(status).json({ error: plan.message, code: plan.code });
    }
    const saved = replaceModelConnections(plan.items, null);
    userAccess.appendAudit(req.currentUser, 'DATA_MANAGEMENT_SOURCE_CREATE', plan.sourceId, { profileId: body.profileId, name: body.name });
    publishSharedMasterChange('modelConnections', req);
    res.status(201).json({ ok: true, sourceId: plan.sourceId, revision: saved.revision, warnings: plan.warnings });
  } catch (err) { apiError(res, err, 'Kaynak eklenemedi.'); }
});

app.patch('/api/data-management/source/:id', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit: '512kb' }), (req, res) => {
  try {
    const body = req.body || {};
    const sourceId = String(req.params.id || '').trim();
    const store = loadModelConnections();

    // Eşzamanlılık kontrolü kaynak başınadır (P9 sözleşmesi).
    const expected = String(body.expectedSourceRevision || '').trim();
    if (expected) {
      const current = store.items.find(item => item && String(item.id) === sourceId);
      const actual = current ? dataManagementAdapter.configRevision(current) : '';
      if (actual && actual !== expected) {
        return res.status(409).json({ error: 'Bu kaynak siz bakarken başka bir pencerede değiştirildi.', code: 'SOURCE_CHANGED' });
      }
    }

    /* Tek uç, üç işlem — ama her biri AYRI plan fonksiyonu. Tek bir devasa
       "kaynağı güncelle" yazıcısı, hangi alanın neyi etkilediğini belirsizleştirir. */
    let plan = null;
    if (typeof body.enabled === 'boolean') {
      plan = dataManagementSourceWriter.planSourceEnabled(store.items, { sourceId, enabled: body.enabled });
    } else if (body.mappingEntry && typeof body.mappingEntry === 'object') {
      /* TEK alan. Bütün eşlemeyi geri göndermek, bayat bir görünümde başka
         bir alanın sessizce düşmesi demekti. */
      plan = dataManagementSourceWriter.planMappingEntry(store.items, {
        sourceId, header: body.mappingEntry.header, entry: body.mappingEntry.entry,
      });
    } else if (body.mapping && typeof body.mapping === 'object') {
      plan = dataManagementSourceWriter.planMappingWrite(store.items, { sourceId, mapping: body.mapping });
    } else if (typeof body.queryMode === 'string') {
      /* Sorgu modu AYRI bir plan fonksiyonuyla yazılır: "elle yazılan DAX'a
         geç" kararı, ad değiştirmekle aynı yolda gitmemeli — filtrelerin
         devre dışı kalması gibi bir sonucu var ve kendi uyarılarını taşır. */
      plan = dataManagementSourceWriter.planSourceQuery(store.items, {
        sourceId, mode: body.queryMode, query: body.query,
      });
    } else if (body.cpColumn && typeof body.cpColumn === 'object') {
      /* CP sütunları da TEK TEK yazılır. Tam listeyi göndermek, bayat bir
         görünümde başka bir pencerede eklenmiş sütunun sessizce düşmesi
         demekti — eşleme yazmasıyla aynı gerekçe. */
      plan = dataManagementSourceWriter.planCpColumn(store.items, {
        sourceId,
        op: body.cpColumn.op,
        id: body.cpColumn.id,
        label: body.cpColumn.label,
        group: body.cpColumn.group,
        entry: body.cpColumn.entry,
      });
    } else {
      plan = dataManagementSourceWriter.planSourceUpdate(store.items, {
        sourceId, name: body.name, server: body.server, catalog: body.catalog,
      });
    }
    if (!plan.ok) {
      const conflict = plan.code === 'ROLE_ALREADY_ACTIVE' || plan.code === 'CP_COLUMN_LABEL_TAKEN';
      const status = plan.code === 'SOURCE_NOT_FOUND' || plan.code === 'CP_COLUMN_NOT_FOUND' ? 404 : (conflict ? 409 : 400);
      return res.status(status).json({ error: plan.message, code: plan.code });
    }
    if (plan.code === 'NO_CHANGE') return res.json({ ok: true, changed: false, revision: store.revision, warnings: plan.warnings });

    const saved = replaceModelConnections(plan.items, null);
    userAccess.appendAudit(req.currentUser, 'DATA_MANAGEMENT_SOURCE_UPDATE', sourceId, {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      mapping: body.mapping ? Object.keys(body.mapping).length : undefined,
    });
    publishSharedMasterChange('modelConnections', req);
    res.json({ ok: true, changed: true, revision: saved.revision, warnings: plan.warnings });
  } catch (err) { apiError(res, err, 'Kaynak güncellenemedi.'); }
});

/* KAYNAĞI SİL (§7).

   AYRI BİR UÇ. PATCH'e bir `deleted:true` alanı eklemek, "adı güncelle" ile
   "her şeyi yok et" isteklerini aynı yola sokardı; yanlış gövdeyle atılan bir
   PATCH geri alınamaz bir silme yapabilirdi. Fiil ayrı, yetki ayrı, denetim
   kaydı ayrı.

   Ne silindiği YANITLA DÖNER: arayüz "3 modül, 38 alan eşlemesi, 2 CP sütunu
   gitti" diyebilmeli. Sessiz bir 200, kullanıcının kaybını ancak bir sonraki
   yenilemede fark etmesi demekti. */
app.delete('/api/data-management/source/:id', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), express.json({ limit: '16kb' }), (req, res) => {
  try {
    const body = req.body || {};
    const sourceId = String(req.params.id || '').trim();
    const store = loadModelConnections();

    const expected = String(body.expectedSourceRevision || '').trim();
    if (expected) {
      const current = store.items.find(item => item && String(item.id) === sourceId);
      const actual = current ? dataManagementAdapter.configRevision(current) : '';
      if (actual && actual !== expected) {
        return res.status(409).json({
          error: 'Bu kaynak siz bakarken başka bir pencerede değiştirildi. Ekranı tazeleyip tekrar deneyin.',
          code: 'SOURCE_CHANGED',
        });
      }
    }

    const plan = dataManagementSourceWriter.planSourceDelete(store.items, {
      sourceId,
      // Ad teyidi istemciden gelir; gönderilmezse zorlanmaz (bkz. planSourceDelete).
      expectedName: Object.prototype.hasOwnProperty.call(body, 'expectedName') ? body.expectedName : null,
    });
    if (!plan.ok) {
      const status = plan.code === 'SOURCE_NOT_FOUND' ? 404 : (plan.code === 'SOURCE_REQUIRED' ? 409 : 400);
      return res.status(status).json({ error: plan.message, code: plan.code });
    }

    const saved = replaceModelConnections(plan.items, null);
    try { databaseCredentialStore.remove(sourceId); } catch (_) {}
    userAccess.appendAudit(req.currentUser, 'DATA_MANAGEMENT_SOURCE_DELETE', sourceId, plan.removed);
    publishSharedMasterChange('modelConnections', req);
    res.json({ ok: true, revision: saved.revision, removed: plan.removed, warnings: plan.warnings });
  } catch (err) { apiError(res, err, 'Kaynak silinemedi.'); }
});

/* ORTAK MODÜL FİLTRESİNİ KAYDET (P3 — yazma).

   YALNIZ ortak katmanı yazar. Kişisel Horizon user-preferences'ta yaşamaya ve
   sayfa rozetindeki düzenleyiciyle yönetilmeye devam eder; ikisini tek yazma
   yoluna sıkıştırmak "hangi katmanı düzenliyorum?" belirsizliğini yeni ekranda
   yeniden üretirdi.

   Paylaşım kararı (güncelle / ayır) İSTEMCİDEN AÇIKÇA gelir; sunucu varsayılan
   uydurmaz. Uyarılar yanıtla birlikte döner — sessizce kaydetmek, kullanıcının
   başka bir sayfanın verisi değişince durumu keşfetmesi demekti. */
// ---- Horizon şablonları ve Veri Yönetimi katman route'ları → server/routes/horizon-template-routes.js ----
require('./routes/horizon-template-routes')(app, {
  addHorizonTemplate,
  apiError,
  dataManagementAdapter,
  dataManagementBindingWriter,
  dataManagementFilterWriter,
  deleteHorizonTemplate,
  express,
  loadHorizonTemplates,
  loadModelConnections,
  modelHorizon,
  modelSupportInfo,
  publishSharedMasterChange,
  replaceModelConnections,
  requestRevision,
  sourceUserId,
  userAccess,
  userPreferences,

});
// ---- Veri modeli bağlantıları route'ları (şema, sorgu, çalıştırma) → server/routes/model-connection-routes.js ----
require('./routes/model-connection-routes')(app, {
  MODEL_EXPORT_ROOT,
  alignHorizonWithMapping,
  apiError,
  ensureConnectionMapping,
  express,
  fs,
  intakeLiveFields,
  intakeSafeSourceMessage,
  intakeStore,
  loadModelConnections,
  logRuntimeFailure,
  modelApiError,
  modelExportPath,
  modelFields,
  modelHorizon,
  modelQuery,
  modelRunInFlight,
  queryModelDistinctValues,
  recordModelConnectionRun,
  replaceModelConnections,
  resolveColumnTypes,
  userAccess,

});
// ---- LFL verisi route'ları → server/routes/lfl-routes.js ----
require('./routes/lfl-routes')(app, {
  apiError,
  attachModelImageIdentities,
  cacheForUser,
  ensureDataLoaded,
  initialDataLoadPromises,
  loadFromModels,
  modelImageIdentityOrders,
  runExcelTask,
  sendDateSafeJson,
  sourceFilterReadiness,
  sourceFilterReadinessMessage,
  sourceUserId,
  userAccess,
  withFabricDimensions,

});
// ---- Global Flow · Earth 3D sağlayıcı ayarları → server/routes/global-flow-earth-routes.js ----
require('./routes/global-flow-earth-routes')(app, { express, userAccess });
// ---- Octopus (Copilot) route'ları → server/routes/copilot-routes.js ----
require('./routes/copilot-routes')(app, {
  APP_VERSION,
  DISPLAY_VERSION,
  agentAi,
  agentPlatformError,
  agentPolicyEngine,
  agentToolRegistry,
  apiError,
  auth,
  cacheForUser,
  copilotActions,
  copilotAgent,
  express,
  getExcelWorkerStats,
  octopusExports,
  sourceFolderForUser,
  sourceUserId,
  userAccess,
  getConfig: () => config,
});
// ---- Görünüm ve filtre profilleri + kaynak klasör seçimi route'ları → server/routes/view-profile-routes.js ----
require('./routes/view-profile-routes')(app, {
  addFilterProfile,
  addView,
  apiError,
  chooseFolderDialog,
  deleteFilterProfile,
  deleteView,
  loadFilterProfiles,
  loadViews,
  markUsedFilterProfile,
  markUsedView,
  requestRevision,
  resetUserCache,
  setFavoriteFilterProfile,
  setFavoriteView,
  setUserSourceFolder,
  sourceFolderForUser,
  sourceUserId,
  syncFxFromKurWorkbook,
  updateFilterProfile,
  updateView,
  userAccess,

});
// ---- Koleksiyon model dosyaları / TPs ----
const MODEL_FILES_INDEX = path.join(MODEL_FILES_ROOT, 'index.json');
function ensureModelFilesRoot(){ fs.mkdirSync(MODEL_FILES_ROOT,{recursive:true}); }
// 5 ayrı route her istekte bunu çağırıyor; boyut+mtime imzalı önbellek gereksiz
// diskten yeniden okuma/ayrıştırmayı önler. Çağıranlardan biri (yükleme rotası)
// döndürülen diziyi push() ile mutasyona uğratıp geri yazıyor, bu yüzden önbellek
// isabetinde KLON döndürülür — aksi halde push, henüz yazılmamışken önbelleği
// bozardı.
let modelFilesIndexCache = null;
function readModelFilesIndex(){
  ensureModelFilesRoot();
  let tag = null;
  try { const stat = fs.statSync(MODEL_FILES_INDEX); tag = `${stat.size}-${stat.mtimeMs}`; } catch (_) { tag = null; }
  if (tag && modelFilesIndexCache && modelFilesIndexCache.tag === tag) return JSON.parse(JSON.stringify(modelFilesIndexCache.value));
  for(const file of [MODEL_FILES_INDEX, MODEL_FILES_INDEX+'.bak']){
    if(!fs.existsSync(file)) continue;
    try{
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(Array.isArray(data)){ if(tag && file===MODEL_FILES_INDEX) modelFilesIndexCache={tag,value:data}; return data; }
    }
    catch(err){ logRuntimeFailure('modelFilesIndexRead', err); }
  }
  return [];
}
function writeModelFilesIndex(items){
  ensureModelFilesRoot();
  atomicWriteJson(MODEL_FILES_INDEX,items);
}
function safeModelFileKey(value){ return String(value||'').trim().replace(/[^A-Za-z0-9._-]/g,'_').slice(0,160); }
function publicModelFileMeta(item){
  return {id:item.id,modelKey:item.modelKey,modelLabel:item.modelLabel||'',filename:item.filename,mimeType:item.mimeType||'application/octet-stream',size:item.size||0,createdAt:item.createdAt,plmSource:item.plmSource||'',plmLanguage:item.plmLanguage||'',plmId:item.plmId||'',downloadUrl:`/api/model-files/${encodeURIComponent(item.id)}`};
}
function modelStoredFileExists(item){
  try { return Boolean(item && item.storedName && fs.existsSync(resolveStoredFile(MODEL_FILES_ROOT,item.storedName))); }
  catch (_) { return false; }
}
function purgeModelFilesByKeys(rawKeys){
  const keys=new Set((Array.isArray(rawKeys)?rawKeys:[]).map(safeModelFileKey).filter(Boolean));
  if(!keys.size) return {deletedFiles:0,deletedBytes:0,modelKeys:[]};
  const index=readModelFilesIndex();
  const targets=index.filter(item=>keys.has(item.modelKey));
  let deletedBytes=0;
  const failures=[];
  for(const item of targets){
    try{
      const full=resolveStoredFile(MODEL_FILES_ROOT,item.storedName);
      if(fs.existsSync(full)) fs.unlinkSync(full);
      if(fs.existsSync(full)) throw new Error('Dosya fiziksel depodan kaldırılamadı.');
      deletedBytes+=Number(item.size)||0;
    }catch(err){ failures.push(`${item.filename||item.id}: ${err.message}`); }
  }
  if(failures.length){
    const err=new Error(`Bazı model dosyaları bilgisayardan silinemedi: ${failures.join(' · ')}`);
    err.statusCode=500; throw err;
  }
  writeModelFilesIndex(index.filter(item=>!keys.has(item.modelKey)));
  return {deletedFiles:targets.length,deletedBytes,modelKeys:[...keys]};
}
app.get('/api/model-files',userAccess.requireAnyArea('source', 'koleksiyon'),(req,res)=>{
  try{
    const raw=req.query.modelKey;
    const keys=new Set((Array.isArray(raw)?raw:[raw]).filter(Boolean).map(safeModelFileKey));
    const plmIds=[...keys].map(technicalSheetOwnership.plmIdFromCanonicalTechnicalSheetKey).filter(Boolean);
    const index=readModelFilesIndex();
    const ownership=technicalSheetOwnership.resolveTechnicalSheetOwnership(index,plmIds,{fileExists:modelStoredFileExists});
    if(ownership.migrated.length)writeModelFilesIndex(index);
    const files=index.filter(item=>{
      if(keys.size&&!keys.has(item.modelKey))return false;
      if(item.plmSource!=='technical-sheet')return true;
      const plmId=normalizePlmId(item.plmId),status=ownership.statusByPlmId[plmId];
      return Boolean(status&&status.status==='ready'&&item.modelKey===technicalSheetOwnership.canonicalTechnicalSheetKey(plmId)&&modelStoredFileExists(item));
    }).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(publicModelFileMeta);
    res.json({files});
  }catch(err){apiError(res,err,'Model dosyaları okunamadı.');}
});
app.post('/api/model-files/purge',userAccess.requireArea('source'),(req,res)=>{
  try{
    const result=purgeModelFilesByKeys(req.body&&req.body.modelKeys);
    res.json({ok:true,...result,deletedFromStorage:true});
  }catch(err){apiError(res,err,'Model dosyaları kalıcı depodan temizlenemedi.');}
});
app.post('/api/model-files',userAccess.requireArea('source'),(req,res)=>{
  try{
    const body=req.body||{}, file=body.file||{};
    const modelKey=safeModelFileKey(body.modelKey), modelLabel=String(body.modelLabel||'').trim().slice(0,300);
    if(!modelKey) return res.status(400).json({error:'Model anahtarı zorunlu.'});
    if(!file.filename||!file.base64) return res.status(400).json({error:'Dosya adı ve içeriği zorunlu.'});
    const buffer=Buffer.from(String(file.base64),'base64');
    if(!buffer.length) return res.status(400).json({error:'Dosya içeriği boş.'});
    if(buffer.length>50*1024*1024) return res.status(413).json({error:'Tek bir model dosyası 50 MB’ı aşamaz.'});
    ensureModelFilesRoot();
    const id=`mf_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const filename=safeMailFilename(file.filename,'model-file');
    const storedName=`${id}_${filename}`;
    fs.writeFileSync(resolveStoredFile(MODEL_FILES_ROOT,storedName),buffer);
    const index=readModelFilesIndex();
    const item={id,modelKey,modelLabel,filename,storedName,mimeType:String(file.mimeType||'application/octet-stream').replace(/[\r\n]/g,''),size:buffer.length,lastModified:Number(file.lastModified)||null,createdAt:new Date().toISOString()};
    index.push(item); writeModelFilesIndex(index);
    res.json({ok:true,file:publicModelFileMeta(item)});
  }catch(err){apiError(res,err,'Model dosyası yüklenemedi.');}
});
app.get('/api/model-files/:id',userAccess.requireAnyArea('source', 'koleksiyon'),(req,res)=>{
  try{
    const id=String(req.params.id||'').replace(/[^A-Za-z0-9_-]/g,'');
    const item=readModelFilesIndex().find(x=>x.id===id);
    if(!item) return res.status(404).json({error:'Model dosyası bulunamadı.'});
    const full=resolveStoredFile(MODEL_FILES_ROOT,item.storedName);
    if(!fs.existsSync(full)) return res.status(404).json({error:'Model dosyasının içeriği bulunamadı.'});
    res.download(full,item.filename);
  }catch(err){apiError(res,err,'Model dosyası indirilemedi.');}
});
app.delete('/api/model-files/:id',userAccess.requireArea('source'),(req,res)=>{
  try{
    const id=String(req.params.id||'').replace(/[^A-Za-z0-9_-]/g,'');
    const index=readModelFilesIndex(), item=index.find(x=>x.id===id);
    if(!item) return res.status(404).json({error:'Model dosyası bulunamadı.'});
    const full=resolveStoredFile(MODEL_FILES_ROOT,item.storedName);
    try{ fs.unlinkSync(full); }
    catch(err){ if(err && err.code!=='ENOENT') throw err; }
    // Fiziksel dosya silinmeden indeks kaydını kaldırma. Böylece kullanıcının
    // "sil" işlemi hem listeden hem kalıcı Buyer Log belleğinden kesin olarak siler.
    if(fs.existsSync(full)) throw new Error('Dosya kalıcı bellekten kaldırılamadı.');
    writeModelFilesIndex(index.filter(x=>x.id!==id));
    res.json({ok:true,deletedFromStorage:true});
  }catch(err){apiError(res,err,'Model dosyası silinemedi.');}
});

// ---- Koleksiyon görselleri ve görsel kayıt ayarları route'ları → server/routes/collection-image-routes.js ----
require('./routes/collection-image-routes')(app, {
  apiError,
  assertModelImageMutable,
  collectionImageOptimizationStatus,
  express,
  getModelImageSettings,
  loadOverrides,
  modelImageRegistry,
  saveCollectionImage,
  userAccess,

});
/* ===================================================================
   PAYLAŞILAN GÖRSEL DAĞITIMI — durum ve elle tetikleme.

   Çekme/yayma normalde arka planda ve BLOKE ETMEDEN çalışır; bu uçlar
   yalnız durumu göstermek ve kullanıcı istediğinde bir turu öne çekmek
   içindir. Görsellerin ÇİZİMİ hiçbir zaman bu uçlara bağlı değildir. */
app.get('/api/model-images/shared/status', userAccess.requireArea('koleksiyon'), async (_req, res) => {
  try {
    const status = modelImageDistribution.status();
    res.set('Cache-Control', 'no-store').json({ ok: true, available: await sharedModelImageStore.available(), ...status });
  } catch (err) { apiError(res, err, 'Paylaşılan görsel durumu okunamadı.'); }
});
app.post('/api/model-images/shared/sync', userAccess.requireArea('koleksiyon'), express.json({ limit: '32kb' }), async (req, res) => {
  try {
    assertModelImageMutable();
    const result = await syncAuthorizedCollectionImages(req.currentUser.id);
    res.set('Cache-Control','no-store').json({ ok:true, scope:'koleksiyon', ...result });
  } catch (err) { apiError(res, err, 'Koleksiyon görselleri eşitlenemedi.'); }
});

/* ON-DEMAND SHARED IMAGE HYDRATION. No PLM/ASAS call is allowed here.
   Visible/current-view identities are deduped, resolved, looked up in the
   shared index and only matching pack slices are copied into the local image
   cache. Shared miss is a normal result, not an authentication trigger. */
app.post('/api/model-images/shared/hydrate', userAccess.requireArea('koleksiyon'), express.json({ limit: '64kb' }), async (req, res) => {
  try {
    assertModelImageMutable();
    await refreshCollectionPermissionScope();
    const ownerId = String(req.body && req.body.ownerId || '').trim();
    if (!ownerId) return res.status(400).json({ error:'Koleksiyon sahibi zorunludur.', code:'COLLECTION_OWNER_REQUIRED' });
    if (!userAccess.collectionAccessLevel(req.currentUser, ownerId)) {
      return res.status(403).json({ error:'Bu Koleksiyon görsellerine erişim yetkiniz bulunmuyor.', code:'COLLECTION_ACCESS_DENIED' });
    }
    await collectionReplication.syncOwner(req.currentUser.id, ownerId).catch(error => logRuntimeFailure('collectionReplicaDownload', error));
    const result = await syncCollectionWorkspaceImagesForUser(req.currentUser.id, ownerId);
    res.set('Cache-Control','no-store').json({ ok:true, scope:'koleksiyon', ...result });
  } catch (err) { apiError(res, err, 'Koleksiyon görselleri yerel önbelleğe alınamadı.'); }
});
app.put('/api/model-images/settings', userAccess.requireArea('source'), express.json({ limit:'32kb' }), (req, res) => {
  try {
    const raw=req.body&&req.body.maxKb;
    if(!Number.isFinite(Number(raw))||Number(raw)<1||Number(raw)>1024)return res.status(400).json({error:'Görsel boyut limiti 1-1024 KB arasında olmalıdır.',code:'VALIDATION_ERROR'});
    const settings=saveModelImageSettings({maxKb:raw});
    userAccess.appendAudit(req.currentUser,'MODEL_IMAGE_LIMIT_UPDATE','model-images',{maxKb:settings.maxKb});
    res.json({ok:true,...settings,...collectionImageOptimizationStatus(50)});
  } catch (err) { apiError(res, err, 'Görsel boyut limiti kaydedilemedi.'); }
});
app.put('/api/model-images/:id/optimize', userAccess.requireAnyArea('source','koleksiyon','cp','orders'), express.json({ limit: '2mb' }), (req, res) => {
  try {
    assertModelImageMutable();
    const body=req.body||{};
    const image=replaceCollectionImage(req.params.id,{filename:body.filename,mimeType:body.mimeType,base64:body.base64});
    res.json({ok:true,image});
  } catch (err) { apiError(res, err, 'Model görseli optimize edilemedi.'); }
});
app.post('/api/model-images/optimization/complete', userAccess.requireAnyArea('source','koleksiyon','cp','orders'), (_req, res) => {
  try { res.json({ok:true,...completeCollectionImageOptimization()}); }
  catch (err) { apiError(res, err, 'Model görseli optimizasyonu tamamlanamadı.'); }
});
app.get('/api/collection-images/:id', userAccess.requireAnyArea('source','koleksiyon','cp','orders','backlog','lfl','overview','priceanalysis','opencosting','shipping'), (req, res) => {
  try {
    const found = getCollectionImage(req.params.id);
    if (!found) return res.status(404).json({ error: 'Koleksiyon görseli bulunamadı.' });
    res.setHeader('Content-Type', found.item.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(fs.statSync(found.full).size));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(found.full);
  } catch (err) { apiError(res, err, 'Koleksiyon görseli okunamadı.'); }
});
/* v10.90 — TÜM GÖRSELLERİ SİL ARTIK TAM SIFIRLAMADIR.
   Eskiden bu uç yalnız BİRİNCİ katmanı (fiziksel dosyalar + index) siliyordu.
   Görsel sahipliği ise üç yerde yaşıyor:
     1) kalıcı varlık deposu (collection-images)
     2) genel model görseli kaydı (overrides.imagemap)  ← CP/Orders/Koleksiyon
        hepsi görseli buradan çözer
     3) Koleksiyon satırlarının kendi img/imgRef alanları
   2 ve 3 kalınca "kayıt görsel var diyor → dosya yok → 404 → kırık <img>"
   durumu oluşuyordu. Aşamalar sırayla yürür, her aşama adıyla raporlanır ve
   sonunda sayımla DOĞRULANIR; doğrulama geçmezse başarı DÖNMEZ. Yeniden
   çalıştırmak güvenlidir (idempotent). maxKb gibi görsel AYARLARI ayrı
   dosyadadır ve korunur. */
app.delete('/api/model-images/all', userAccess.requireArea('source'), userAccess.requirePermission('manageModelConnections'), (req, res) => {
  if (modelImageResetInProgress) {
    return res.status(409).json({ error:'Model görseli sıfırlama işlemi zaten sürüyor.', code:'MODEL_IMAGE_RESET_BUSY', stage:'lock' });
  }
  if (modelImageImportLocks.size) {
    return res.status(409).json({ error:'Model görseli içe aktarma işlemi sürerken sıfırlama yapılamaz.', code:'MODEL_IMAGE_IMPORT_BUSY', stage:'lock' });
  }
  modelImageResetInProgress = true;
  let stage = 'assets';
  try {
    const assets = deleteAllCollectionImages();
    stage = 'registry';
    const registry = clearAllModelImageLinks();
    // Sahiplik kaydı silinen depoya aitti; kalırsa sıfırlamadan sonra
    // hiçbir dosyaya karşılık gelmeyen "otomatik" kayıtlar kalırdı.
    plmImageOwnership.saveOwnership(plmImageOwnership.emptyStore());
    stage = 'collection-rows';
    const collection = collectionWorkspaces.clearAllRowImages();
    // Sayfa projeksiyonu önbelleği CP/Orders satırlarını _imageRef/_imageUrl
    // GÖMÜLÜ hâlde diskte tutar. Düşürülmezse yeniden başlatmadan sonra
    // silinmiş referanslar önbellekten geri gelir ve kırık görsel yeniden çıkar.
    stage = 'page-cache';
    const pageCacheUsers = pageProjectionCache.invalidateAll();
    stage = 'verify';
    const remainingRows = collectionWorkspaces.countRowImages();
    const verify = {
      storedImages: assets.remainingIndexed,
      storedFiles: assets.remainingFiles,
      registryRefs: Object.keys(loadOverrides().imagemap || {}).length,
      collectionImageRefs: remainingRows.refs,
    };
    if (verify.storedImages || verify.storedFiles || verify.registryRefs || verify.collectionImageRefs) {
      const error = new Error('Model görseli sıfırlaması doğrulanamadı; bazı görsel kayıtları hâlâ duruyor.');
      error.statusCode = 500; error.code = 'MODEL_IMAGE_RESET_INCOMPLETE'; error.stage = 'verify'; error.verify = verify;
      throw error;
    }
    const result = {
      deleted: assets.deleted, requested: assets.requested, orphansRemoved: assets.orphansRemoved,
      registryCleared: registry.cleared, ordersRevision: registry.revision,
      collectionWorkspacesCleared: collection.workspaces, collectionRowsCleared: collection.rows, collectionRefsCleared: collection.refs,
      pageCacheUsersInvalidated: pageCacheUsers,
      verify,
    };
    userAccess.appendAudit(req.currentUser,'MODEL_IMAGES_DELETE_ALL','model-images',result);
    res.json({ ok:true, ...result });
  } catch (err) {
    const failedStage = err && err.stage || stage;
    try { userAccess.appendAudit(req.currentUser,'MODEL_IMAGES_DELETE_ALL_FAILED','model-images',{ stage: failedStage, error: err && err.message }); } catch (_) {}
    const status = (err && err.statusCode) || 500;
    if (status >= 500) logRuntimeFailure('modelImageReset', err);
    // Başarı ASLA taklit edilmez: hangi aşamada durulduğu istemciye söylenir,
    // sistem kurtarılabilir kalır ve komut yeniden çalıştırılabilir.
    res.status(status).json({ error: (err && err.message) || 'Tüm model görselleri silinemedi.', code: (err && err.code) || 'MODEL_IMAGE_RESET_FAILED', stage: failedStage, verify: (err && err.verify) || null });
  } finally {
    modelImageResetInProgress = false;
  }
});
app.delete('/api/collection-images/:id', userAccess.requireArea('koleksiyon'), (req, res) => {
  try { res.json({ ok: true, deleted: deleteCollectionImage(req.params.id) }); }
  catch (err) { apiError(res, err, 'Koleksiyon görseli silinemedi.'); }
});

// ---- CP görselleri route'ları → server/routes/cp-image-routes.js ----
require('./routes/cp-image-routes')(app, {
  apiError,
  assertModelImageMutable,
  deleteCollectionImage,
  fs,
  getCollectionImage,
  saveCollectionImage,
  userAccess,

});
// ---- Fiyatlama e-posta taslakları (.eml) ----
// Model dosyaları kalıcı MODEL_FILES_ROOT altında saklanır. E-posta taslakları ise
// kalıcı veri değildir: yalnız Outlook/varsayılan istemciye açma komutu verilene
// kadar işletim sisteminin geçici klasöründe tutulur ve hemen ardından temizlenir.
const EMAIL_DRAFT_DIR = EMAIL_DRAFT_ROOT;
const LEGACY_EMAIL_DRAFT_DIR = path.join(__dirname, 'data', 'email-drafts');
function removeDirectoryContents(dir){
  try{
    if(!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(name=>{
      const full=path.join(dir,name);
      try{ fs.rmSync(full,{recursive:true,force:true}); }catch(_){}
    });
    try{ fs.rmdirSync(dir); }catch(_){}
  }catch(_){}
}
// Önceki sürümlerin diskte bırakmış olabileceği taslak ve ayrı ek kopyalarını
// sunucu başlarken temizle.
removeDirectoryContents(EMAIL_DRAFT_DIR);
removeDirectoryContents(LEGACY_EMAIL_DRAFT_DIR);
function ensureEmailDraftDir(){ fs.mkdirSync(EMAIL_DRAFT_DIR,{recursive:true}); }
function deleteTransientDraft(fullPath, attempt=0){
  try{ fs.unlinkSync(fullPath); return; }
  catch(err){
    if(err && err.code==='ENOENT') return;
    // Outlook dosyayı birkaç saniye kilitli tutabilir. Kalıcı saklama yapmadan,
    // kilit kalkana kadar kısa süreli yeniden dene.
    if(attempt<15) setTimeout(()=>deleteTransientDraft(fullPath,attempt+1),2000).unref();
    else logRuntimeFailure('emailDraftCleanup',err);
  }
}
function scheduleTransientDraftCleanup(fullPath){
  // Açma komutunun dosyayı okuyabilmesi için kısa bir pencere bırak; sonrasında
  // dosya ve tüm MIME ekleriyle birlikte tek .eml silinir.
  setTimeout(()=>deleteTransientDraft(fullPath),12000).unref();
}
function mimeBase64(value) {
  const raw = Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(String(value || ''), 'utf8').toString('base64');
  return raw.replace(/.{1,76}/g, '$&\r\n').trim();
}
function mimeHeader(value) { return `=?UTF-8?B?${Buffer.from(String(value || ''), 'utf8').toString('base64')}?=`; }
function safeMailFilename(value, fallback) {
  const name = path.basename(String(value || fallback || 'file')).replace(/[\r\n"\\/:*?<>|]/g, '_').trim();
  return name || fallback || 'file';
}
const PRICING_ATTACHMENT_LIMIT_BYTES = Math.floor(9.5 * 1024 * 1024);
function pricingMailAttachments(payload) {
  const list = [];
  if (payload && payload.attachment && payload.attachment.base64) list.push(payload.attachment);
  if (Array.isArray(payload && payload.attachments)) {
    payload.attachments.forEach(item => { if (item && item.base64) list.push(item); });
  }
  return list;
}
function base64DecodedSize(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return 0;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(text.length * 3 / 4) - pad);
}
function buildPricingEml(payload) {
  const mixed = `mixed_${crypto.randomBytes(12).toString('hex')}`;
  const related = `related_${crypto.randomBytes(12).toString('hex')}`;
  const alt = `alt_${crypto.randomBytes(12).toString('hex')}`;
  const to = String(payload.to || '').replace(/[\r\n]/g, '').trim();
  const subject = String(payload.subject || 'Quotation Request').replace(/[\r\n]/g, ' ').trim();
  const text = String(payload.text || '');
  const html = String(payload.html || '');
  const attachments = pricingMailAttachments(payload);
  const inlineImages = Array.isArray(payload.inlineImages) ? payload.inlineImages : [];
  const lines = [
    'X-Unsent: 1',
    `To: ${to}`,
    `Subject: ${mimeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/related; boundary="${related}"`,
    '',
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    mimeBase64(text),
    `--${alt}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    mimeBase64(html),
    `--${alt}--`,
  ];
  inlineImages.forEach((img, i) => {
    const filename = safeMailFilename(img.filename, `Pricing_Preview_${i + 1}.jpg`);
    const mimeType = /^image\//i.test(String(img.mimeType || '')) ? img.mimeType : 'image/jpeg';
    const cid = String(img.cid || `pricing-preview-${i + 1}@buyerlog`).replace(/[<>\r\n]/g, '');
    lines.push(
      `--${related}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${cid}>`,
      `Content-Disposition: inline; filename="${filename}"`,
      '',
      mimeBase64(Buffer.from(String(img.base64 || ''), 'base64'))
    );
  });
  lines.push(`--${related}--`);
  attachments.forEach((attachment, i) => {
    const filename = safeMailFilename(attachment.filename, i === 0 ? 'Quotation_Request.xlsx' : `Model_File_${i}`);
    const mimeType = String(attachment.mimeType || 'application/octet-stream').replace(/[\r\n]/g, '');
    lines.push(
      `--${mixed}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      mimeBase64(Buffer.from(String(attachment.base64), 'base64'))
    );
  });
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}
// .eml taslağını işletim sisteminin varsayılan e-posta uygulamasında açar (Windows:
// Outlook/Start-Process, macOS: Mail/open, Linux masaüstü: xdg-open). Açılamazsa false
// döner; UI bu durumda .eml dosyasını indirme bağlantısı olarak sunar.
function openEmailDraft(fullPath) {
  return platform.openPathExternally(fullPath);
}
app.post('/api/email-drafts/pricing', (req, res) => {
  let fullPath='';
  try {
    const body = req.body || {};
    if (!body.subject) return res.status(400).json({ error: 'E-posta konusu zorunlu.' });
    const attachments = pricingMailAttachments(body);
    const attachmentBytes = attachments.reduce((sum, item) => sum + base64DecodedSize(item.base64), 0);
    if (attachmentBytes > PRICING_ATTACHMENT_LIMIT_BYTES) {
      return res.status(413).json({ error: 'E-posta eklerinin toplamı 9,5 MB’ı aşmamalıdır.' });
    }
    const id = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    const prefix = String(body.kind || 'Pricing').replace(/[^A-Za-z0-9_-]/g, '') || 'Pricing';
    const filename = `${prefix}_Draft_${id}.eml`;
    const emlText=buildPricingEml(body);
    ensureEmailDraftDir();
    fullPath = path.join(EMAIL_DRAFT_DIR, filename);
    fs.writeFileSync(fullPath, emlText, 'utf8');
    const opened = openEmailDraft(fullPath);
    if(opened){
      scheduleTransientDraftCleanup(fullPath);
      return res.json({ok:true,filename,opened:true,transient:true,attachmentBytes});
    }
    // İstemci otomatik açılamadıysa indirme için içerik cevaba konur; sunucudaki
    // geçici dosya aynı istekte silinir. Tarayıcı bağlantısı pencere kapanınca yok edilir.
    deleteTransientDraft(fullPath);
    fullPath='';
    return res.json({ok:true,filename,opened:false,transient:true,emlBase64:Buffer.from(emlText,'utf8').toString('base64'),attachmentBytes});
  } catch (err) {
    if(fullPath) deleteTransientDraft(fullPath);
    apiError(res, err, 'E-posta taslağı oluşturulamadı.');
  }
});
// Eski sürüm bağlantılarının kalıcı taslak deposuna dönüşmesini engelle.
app.get('/api/email-drafts/:filename', (_req, res) => {
  res.status(410).json({ error: 'Taslaklar kalıcı olarak saklanmaz. Yeni bir taslak oluşturun.' });
});

// ---- Ön Maliyet, Aylık Döviz Kurları ve Nakliye Kıyaslaması route'ları → server/routes/costing-fx-shipping-routes.js ----
require('./routes/costing-fx-shipping-routes')(app, {
  addShippingRows,
  apiError,
  createOpenCosting,
  currentUserIsModerator,
  deleteOpenCosting,
  deleteShippingRows,
  fxMonthResolved,
  loadFx,
  loadOpenCostings,
  loadShipping,
  patchShippingRow,
  publishSharedMasterChange,
  recordOrderCode,
  rejectUnauthorizedOrders,
  requestRevision,
  saveFx,
  sourceUserId,
  updateOpenCosting,
  userAccess,
  withOrderAccess,

});
/* ===================================================================
   YAŞAM DÖNGÜSÜ — yalnız BL_AUTOEXIT=1 açıkça verilirse kullanılabilen
   eski geliştirme modu. Normal Windows başlatıcıları BL_KEEP_ALIVE=1 kullanır;
   bu nedenle tarayıcı sekmeleri kapansa bile sunucu kapanmaz.
   Her açık sekme kendine bir istemci kimliği üretir ve düzenli aralıklarla
   /api/heartbeat'e bildirir; sekme kapanırken /api/goodbye gönderir.
   - Sekme yenileme: goodbye sonrası kısa bekleme penceresinde yeni heartbeat
     gelir, sunucu kapanmaz.
   - Son sekme kapanınca: bekleme penceresi dolar, sunucu kendini kapatır.
   - Sekme çökerse: 90 sn heartbeat gelmeyen istemci düşmüş sayılır.
   Üretim başlatıcılarında bu otomatik kapanma modu devre dışıdır.
   =================================================================== */
const AUTO_EXIT = process.env.BL_AUTOEXIT === '1' && process.env.BL_KEEP_ALIVE !== '1';
const clients = new Map(); // clientId -> lastBeat (ms)
let sawAnyClient = false;
let shutdownTimer = null;

function scheduleShutdownCheck(delayMs) {
  if (!AUTO_EXIT) return;
  // Zaten bekleyen bir kapanma sayacı varsa onu SIFIRLAMA. Süpürme döngüsü
  // 10 sn'de bir çalıştığı için, her turda yeniden zamanlamak sayacı sürekli
  // ileri iter ve sunucu hiç kapanmazdı.
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (clients.size === 0 && sawAnyClient) {
      console.log('Tüm Buyer Log sekmeleri kapandı — sunucu kapatılıyor.');
      cleanupOrphanExcel();
      process.exit(0);
    }
  }, delayMs);
}
// Yeni kalp atışı gelince bekleyen kapanma iptal edilir (sekme yenileme durumu).
function cancelShutdownCheck() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

app.post('/api/heartbeat', (req, res) => {
  const id = String((req.body || {}).id || req.query.id || '');
  if (id) { clients.set(id, Date.now()); sawAnyClient = true; cancelShutdownCheck(); }
  res.json({ ok: true, autoExit: AUTO_EXIT });
});
app.post('/api/goodbye', (req, res) => {
  const id = String((req.body || {}).id || req.query.id || '');
  if (id) clients.delete(id);
  res.json({ ok: true });
  if (AUTO_EXIT && clients.size === 0) scheduleShutdownCheck(10000); // yenileme için 10 sn tolerans
});
if (AUTO_EXIT) {
  // Süpürme: veda sinyali hiç ulaşmadıysa (tarayıcı çökmesi, tüm pencerenin
  // aniden kapatılması, uyku) istemci "düşmüş" sayılır. İstemci 20 sn'de bir
  // kalp atışı gönderdiği için 55 sn sessizlik güvenli bir eşiktir; süpürme
  // 10 sn'de bir çalışır. Böylece pencere en geç ~1 dakikada kendini kapatır.
  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of clients) if (now - t > 55000) clients.delete(id);
    if (clients.size === 0 && sawAnyClient) scheduleShutdownCheck(5000);
  }, 10000).unref();
}

const PORT = config.port || 6194;
const REQUESTED_HOST = String(config.host || '127.0.0.1').trim() || '127.0.0.1';

// --- Ağ maruziyeti güvenlik kilidi (barındırma/telefon erişimi önkoşulu) ---
// Dış erişim parolası etkin değilken yalnız localhost'a bağlanmak güvenlidir. Loopback
// DIŞI bir adrese kimlik doğrulama olmadan bağlanmak istenirse, çökmek yerine güvenli biçimde
// 127.0.0.1'e düşülür (bkz. lib/net-guard) — böylece watchdog altında sonsuz yeniden başlatma
// oluşmaz ve uygulama her zaman ayakta kalır.
// Loopback-dışı bağlanma yalnız ortak dış parola veya tüm aktif hesaplarda zorunlu kullanıcı
// parolası ETKİNSE güvenlidir (bkz. lib/auth, lib/user-access, lib/net-guard).
const { resolveBindHost } = require('./lib/net-guard');
const activeAgentAccounts = userAccess.allPublicProfiles().filter(profile => profile.enabled !== false);
const secureUserGate = activeAgentAccounts.length > 0 && activeAgentAccounts.every(profile => profile.passwordRequired === true);
// Buyer Log has a mandatory signed user session in addition to the optional outer
// password gate. LAN binding is safe when either gate is configured. If an active
// account ever loses its password, the existing net guard automatically falls back
// to localhost instead of exposing that account on the network.
const bind = resolveBindHost(REQUESTED_HOST, auth.enabled || secureUserGate);
if (bind.downgraded) {
  console.warn(`GÜVENLİK: ${bind.requested} adresine kimlik doğrulama olmadan bağlanılamaz; yalnız 127.0.0.1'e bağlanıldı. `
    + `Ağ/telefon erişimi için tüm aktif kullanıcı hesaplarına şifre tanımlayın veya config.auth.passwordHash/BL_AUTH_PASSWORD ayarlayın.`);
}
const HOST = bind.host;

if (process.env.NODE_ENV !== 'test') {
  console.log(`Buyer Log runtime config: ${CONFIG_PATH} · port=${PORT} · host=${REQUESTED_HOST}`);
}

const httpServer = app.listen(PORT, HOST, () => {
  markStartup('SERVER_READY', { host: HOST, port: PORT });
  const displayHost = HOST === '127.0.0.1' ? 'localhost' : HOST;
  console.log(`Buyer Log sunucusu çalışıyor: http://${displayHost}:${PORT}`);
  console.log(`Dinleme adresi: ${HOST} (yerel kullanım için varsayılan 127.0.0.1)`);
  console.log(`Moderatör kaynak klasörü: ${sourceFolderForUser('moderator') || '(seçilmedi)'}`);
  // Açılışta kimlik doğrulama yolu MUTLAKA hafif kalır. Büyük model snapshot'ı
  // burada hydrate edilmez ve tüm kullanıcı page-cache warm-up'ı ana HTTP
  // sürecinde başlatılmaz. gzip/JSON parse ile CP/Orders/Overview projection
  // üreticileri büyük datasetlerde Node.js event loop'unu saniyelerce bloke edip
  // /api/user-login isteğini "Giriş yapılıyor…" durumunda bırakabiliyordu.
  //
  // Hazır page-cache varsa /api/data onu doğrudan kullanır. Cache eksikse yalnız
  // ilgili kullanıcının ilk veri isteğinde oluşturulur; explicit Refresh de yeni
  // generation'ı üretir. Scheduled automation veya başka ham-veri tüketicileri
  // kendi çalışma anında ensureDataLoaded(ownerId) çağırır.
  try { quotationStore.cleanupExpired(); } catch (err) { logRuntimeFailure('quotationRetentionCleanup', err); }
  setInterval(()=>{ try { quotationStore.cleanupExpired(); } catch (err) { logRuntimeFailure('quotationRetentionCleanup', err); } },24*60*60*1000).unref?.();
  // v5.57 — deterministic scheduled automations. The timer is lightweight and
  // only evaluates stored e-mail/mixed recipes while Buyer Log server is running.
  /* v6.36 — TEK TUR KİPİ (Windows Görev Zamanlayıcı için).
     BL_AUTOMATION_RUN=1 ile başlatıldığında sunucu normal dinleme yapmaz gibi
     davranmaz — açılır, planlı otomasyonların TEK turunu çalıştırır ve KENDİ
     kapanır. Böylece zamanlayıcı betiğinin süre tahmin edip süreci dışarıdan
     öldürmesi gerekmez: iş bitince süreç zaten biter. */
  if (process.env.BL_AUTOMATION_RUN === '1') {
    console.log('Otomasyon tek tur kipi: planlı otomasyonlar çalıştırılıyor…');
    ensureDataLoaded('moderator')
      .catch(err=>logRuntimeFailure('automationRunModeLoad',err))
      .then(()=>runScheduledAutomations())
      .catch(err=>logRuntimeFailure('automationRunMode',err))
      .finally(()=>{
        console.log('Otomasyon tek tur kipi tamamlandı; sunucu kapanıyor.');
        try{ cleanupOrphanExcel(); }catch(_){ }
        process.exit(0);
      });
    return;
  }
  setTimeout(()=>runScheduledAutomations().catch(err=>logRuntimeFailure('automationScheduler',err)),5000).unref?.();
  setInterval(()=>runScheduledAutomations().catch(err=>logRuntimeFailure('automationScheduler',err)),60000).unref();
});
httpServer.on('error', error => {
  /* EADDRINUSE bir çökme DEĞİLDİR: portu başka bir Buyer Log kopyası tutuyor,
     yani uygulama zaten çalışıyor ve hizmet veriyor. Bunu ölümcül hata sayıp
     yeniden başlatmak, her denemede aynı duvara çarpan sonsuz bir döngü
     üretiyordu — üretim logunda 229 kez, dakikada 26 yeniden başlatma.
     Doğru davranış: durumu açıkça söyle, bu fazlalık kopyayı kapat ve
     gözetmene yeniden başlatmamasını bildir. */
  if (error && error.code === 'EADDRINUSE') {
    const where = `${bind.host}:${PORT}`;
    console.log(`Buyer Log ${where} adresinde zaten çalışıyor; bu ikinci kopya kapanıyor.`);
    logRuntimeFailure('portAlreadyInUse', new Error(`${where} kullanımda; ikinci kopya kapatıldı.`));
    try { cleanupOrphanExcel(); } catch (_) {}
    process.exit(EXIT_ALREADY_RUNNING);
    return;
  }
  scheduleFatalRestart('HTTP server error', error);
});

// Sunucu kapanırken (Ctrl+C veya konsol penceresi kapatılırken), varsa RefreshExcel.ps1'in
// başlattığı ama kapanamamış bir Excel sürecini temizlemeye çalışır (best-effort — Windows'ta
// konsol kapatma sinyalleri her zaman güvenilir yakalanamayabilir; asıl güvence
// RefreshExcel.ps1'in bir SONRAKİ çalıştırmada aynı PID'yi kontrol edip temizlemesidir).
function cleanupOrphanExcel() {
  try {
    // Artık Excel süreçleri yalnız Windows'taki RefreshExcel.ps1 tarafından üretilir;
    // diğer platformlarda temizlenecek bir şey yoktur.
    if (!platform.IS_WINDOWS) return;
    const pidFile = process.env.BUYER_LOG_EXCEL_PID_FILE || path.join(__dirname, 'data', 'excel.pid');
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return;
    require('child_process').execSync(
      `powershell -NoProfile -Command "if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${pid} -Force }"`,
      { timeout: 5000, windowsHide: true }
    );
    fs.unlinkSync(pidFile);
  } catch (e) { /* best-effort, sessiz geç */ }
}
process.on('exit', cleanupOrphanExcel);
process.on('SIGINT', () => { cleanupOrphanExcel(); process.exit(0); });
process.on('SIGTERM', () => { cleanupOrphanExcel(); process.exit(0); });
