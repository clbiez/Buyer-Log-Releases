// Buyer Log revisioned JSON store. Existing file formats remain backward compatible:
// files without _revision are treated as revision 0 and upgraded on the next write.

'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER_DATA_ROOT: DATA_DIR, APP_DATA_ROOT: USER_DATA_ROOT, atomicWriteJson } = require('./user-data');
const BLBusinessRules = require('../public/business-rules');
const BLFreight = require('../public/freight-calc');
const modelHorizon = require('./lib/modelHorizon');
const modelScopes = require('./lib/model-scopes');
const modelFields = require('./lib/model-fields');
// Park edilmiş modül bağlantılarının normalleştirmesi tek yerden gelir; yazma
// yolu (binding-writer) ile depo aynı kuralı paylaşır.
const bindingWriter = require('./lib/data-domain/binding-writer');
const refreshGroups = require('./lib/data-domain/refresh-groups');
const { orderLineKey, plmImageKey, plmColourImageKey, plmColourImageNameKey, plmImageKeysFor, DEFAULT_ANTREPO_MATCH_RULE, defaultAntrepoMatchConfig, normalizeAntrepoMatchConfig } = require('./lib/parse');
const { withFileLeaseSync } = require('./lib/shared-file-transaction');
const { PROFILE_SCHEMA_VERSION, pageOf, normalizeProfileStore, setFavorite, markUsed, removeProfile } = require('./lib/profile-store');
const { readJsonWithValidatedBackup } = require('./lib/safe-json-read');
const modelImageRegistry = require('./lib/model-image-registry');
const cpSharedStore = require('./lib/cp-shared-store');

const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');
const REFRESH_HISTORY_FILE = path.join(DATA_DIR, 'source-refresh-history.json');
const REFRESH_HISTORY_LIMIT = 10;
/* Kayıt SAYISI sınırı tek başına yetmiyordu: tek bir yenileme 8.600 satırlık
   bir "details" listesi üretebiliyor ve 10 kayıt dosyayı 55 MB a çıkarıyordu.
   Dosya delta senkronuna girdiği ve yama üst düzey anahtar başına üretildiği
   için ("items" tek bir dizi anahtarı) her yenilemede 55 MB ın TAMAMI yeni bir
   paket olarak ağa yazılıyordu. Satır sınırı bunun ilk ayağını keser; ikinci
   ayak DELTA_MIRROR_EXCLUDED. */
const REFRESH_HISTORY_DETAIL_LIMIT = 1000;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const VIEWS_FILE = path.join(DATA_DIR, 'views.json');
const FILTERS_FILE = path.join(DATA_DIR, 'filters.json');
/* v7.81 — Horizon şablonları: Data Management'ta kaydedilen hazır ufuklar.
   Kişisel kopya kullanıcının profil klasöründe, paylaşılan kopya ortak
   dosyada durur (scopedProfileFile userId'siz çağrılınca ortak döner). */
const HORIZON_TEMPLATES_FILE = path.join(DATA_DIR, 'horizon-templates.json');
const SHIP_FILE = path.join(DATA_DIR, 'shipping-comparison.json');
const OPEN_COSTING_FILE = path.join(DATA_DIR, 'open-costing.json');
// FX artık kullanıcı tercihi değil, bütün Buyer Log kullanıcılarının aynı
// kanonik veriyi kullandığı ortak iş verisidir. DATA_DIR içindeki dosya delta
// store'a zaten aynalanan, atomik ve revizyonlu ortak persistence yoludur.
const LEGACY_FX_FILE = path.join(DATA_DIR, 'fx-rates.json');
// Önceki sürümlerin cihaz/kullanıcı kopyası yalnız ilk migration için okunur.
const FX_FILE = path.join(USER_DATA_ROOT, 'fx-rates.json');
const USER_SOURCE_DATA_DIR = path.join(DATA_DIR, 'user-source-data');
const USER_FX_DATA_DIR = path.join(USER_DATA_ROOT, 'user-source-data');

/* ===================================================================
   ORTAK STORE'LARIN DELTA MOTORUNA AYNALANMASI

   saveRevisioned dokuz ayrı store'un ortak yazma yoludur; ayna buraya
   konunca hepsi tek değişiklikle delta motoruna girer.

   Belge BİR SEVİYE düzleştirilerek kaydedilir: overrides.json'ın notesmap,
   pricingRules, imagemap gibi üst seviye bölümleri ayrı alanlar olur. Böylece
   alan bazlı merge bölüm düzeyinde çalışır — bir kullanıcı not yazarken bir
   diğeri fiyat kuralı değiştirirse ikisi de korunur. Bugünkü davranış tüm
   dosyayı ezmek olduğu için bu kesin bir iyileşme.

   Kayıt kimliği veri köküne göreli yoldur ('overrides.json',
   'user-preferences/u1.json'), yani kullanıcıya özel dosyalar ayrı kayıtlarda
   kalır ve birbirine karışmaz.

   delta-only fazında eski dosya yazması YALNIZ okuma yolu da taşınmış
   store'lar için bırakılır. Taşınmamış bir store'un eski dosyası yazılmaya
   devam eder; aksi hâlde o store okuyacak bir şey bulamazdı. */
const DELTA_STORE_COLLECTION = 'store';
const { createDocumentApi, toDocumentRecord } = require('./lib/delta-store');
let deltaStore = null;
let deltaDocuments = createDocumentApi(null, DELTA_STORE_COLLECTION);
function attachDeltaStore(store) { deltaStore = store || null; deltaDocuments = createDocumentApi(deltaStore, DELTA_STORE_COLLECTION); cpSharedStore.attachDeltaStore(deltaStore); return deltaStore; }
function documents() { return deltaDocuments; }

/* Kayıt kimliği veri köküne göreli yoldur. İki kök var: ortak store'lar
   DATA_DIR altında, kullanıcıya özel olanlar (döviz gibi) USER_DATA_ROOT
   altında. Kök öneki kimliğe yazılır, böylece iki kökteki aynı adlı dosya
   birbirine karışmaz ve hiçbir kimlik '..' içermez. */
function deltaStoreId(file) {
  const resolved = path.resolve(file);
  for (const [prefix, root] of [['', DATA_DIR], ['user/', USER_DATA_ROOT]]) {
    const relative = path.relative(root, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return prefix + relative.split(path.sep).join('/');
    }
  }
  return `abs/${resolved.split(path.sep).join('/')}`;
}
/* saveRevisioned ailesinin TAMAMI hem yazma hem okuma yolunu delta üzerinden
   geçiriyor, yani hepsi taşınmış sayılır. Ayrı yazma yolu olan store'lar
   (koleksiyon çalışma alanları, e-posta grupları, quotation'lar) kendi
   modüllerinde ayrıca taşınır; buradan geçmedikleri için etkilenmezler. */
function deltaReadsStore() { return documents().isAuthoritative; }
function deltaWritesLegacy(file) { return deltaMirrorExcluded(file) || documents().writesLegacy; }
/* Delta aynasına GİRMEYEN store lar. Yenileme geçmişi cihazın kendi denetim
   günlüğüdür: hangi satırların değiştiğini anlatır, değişikliğin KENDİSİNİ
   değil — asıl veri (overrides, ship, settings) zaten ayrı senkron oluyor.
   Aynalandığında her yenilemede megabaytlarca paket üretiyor, karşılığında
   hiçbir cihaza yeni bilgi taşımıyordu. */
const DELTA_MIRROR_EXCLUDED = new Set([REFRESH_HISTORY_FILE]);
function deltaMirrorExcluded(file) {
  const resolved = path.resolve(file);
  for (const excluded of DELTA_MIRROR_EXCLUDED) {
    if (resolved === path.resolve(excluded)) return true;
    // Kullanıcıya özel kopyalar (…/user/<id>/source-refresh-history.json) da kapsam dışı.
    if (path.basename(resolved) === path.basename(excluded)) return true;
  }
  return false;
}
function mirrorToDelta(file, value) {
  if (!deltaStore || deltaMirrorExcluded(file)) return;
  // Ayna beklenmez ve sonucuna bakılmaz; delta-store hatasını kendi içinde
  // yutup raporlar, eski dosya yazması her hâlükârda tamamlanmıştır.
  // Ateşle-unut bir çağrı hiçbir koşulda yakalanmamış reddedilme üretmemeli.
  documents().mirror(deltaStoreId(file), value);
}
/* Taşınmış store'ların mevcut içeriğini tohumlama biçiminde döndürür. Dosya
   yollarını db.js'in kendisi bildiği için çağıranın yol kurgusu yapmasına
   gerek kalmaz; yeni bir store taşındığında yalnız burası genişler. */
function deltaSeedPayload() {
  /* saveRevisioned ailesinin tamamı. Var olmayan dosyalar atlanır: tohumlama
     boş bir varsayılanı kayıt hâline getirip sonradan gelen gerçek veriyi
     gölgelemesin. Kullanıcıya özel dosyalar (görünümler, filtreler, döviz)
     ilk yazıldıklarında aynalanır; tohumlama yalnız mevcut ortak veriyi taşır. */
  const payload = {};
  for (const file of [OVERRIDES_FILE, SETTINGS_FILE, SHIP_FILE, OPEN_COSTING_FILE, VIEWS_FILE, FILTERS_FILE, HORIZON_TEMPLATES_FILE, LEGACY_FX_FILE]) {
    if (!fs.existsSync(file)) continue;
    try { payload[deltaStoreId(file)] = toDocumentRecord(readJsonWithBackup(file, () => ({ _revision: 0 }))); }
    catch (_) { /* okunamayan dosya tohumlanmaz; eski yolu kullanmaya devam eder */ }
  }
  return payload;
}
function readFromDelta(file) {
  if (deltaMirrorExcluded(file)) return null;
  const record = documents().read(deltaStoreId(file));
  return record ? cloneFallback(record) : null;
}
/* "Bu store'un okunacak bir içeriği var mı?" Çağıranlar bugüne kadar bunu
   fs.existsSync ile soruyordu; delta-only fazında eski dosya hiç yazılmadığı
   için o soru yanlış cevap verir ve store her açılışta boş görünürdü. */
function storeExists(file) {
  return Boolean(readFromDelta(file)) || fs.existsSync(file);
}

class RevisionConflictError extends Error {
  constructor(storeName, expectedRevision, currentRevision, revisionKey = null) {
    super(`${storeName} başka bir pencere veya işlem tarafından değiştirildi. Güncel veriyi yeniden yükleyip tekrar deneyin.`);
    this.name = 'RevisionConflictError';
    this.code = 'REVISION_CONFLICT';
    this.statusCode = 409;
    this.storeName = storeName;
    this.expectedRevision = Number(expectedRevision);
    this.currentRevision = Number(currentRevision);
    this.revisionKey = revisionKey || null;
  }
}
function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function ensureFxDir() { fs.mkdirSync(USER_DATA_ROOT, { recursive: true }); }

function safeUserDataId(userId) {
  return String(userId || 'moderator').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'moderator';
}
function scopedSourceFile(baseFile, userId) {
  if (!userId || userId === 'moderator') return baseFile;
  return path.join(USER_SOURCE_DATA_DIR, safeUserDataId(userId), path.basename(baseFile));
}
function scopedFxFile(userId) {
  if (!userId || userId === 'moderator') return FX_FILE;
  return path.join(USER_FX_DATA_DIR, safeUserDataId(userId), path.basename(FX_FILE));
}

function cloneFallback(value) { return typeof value === 'function' ? value() : JSON.parse(JSON.stringify(value)); }
function revisionOf(value) { const n = Number(value && value._revision); return Number.isInteger(n) && n >= 0 ? n : 0; }
function expectedNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/^W\//, '').replace(/^"|"$/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function assertRevision(storeName, current, expected) {
  const wanted = expectedNumber(expected);
  if (wanted != null && wanted !== revisionOf(current)) throw new RevisionConflictError(storeName, wanted, revisionOf(current));
}
function revisioned(value, nextRevision) { return { ...(value && typeof value === 'object' ? value : {}), _revision: nextRevision, _updatedAt: new Date().toISOString() }; }
// overrides.json ve benzeri store'lar her istek gövdesinde (ör. /api/data içinde
// iki kez) yeniden okunup parse ediliyordu. Store'lar yalnız bu modüldeki
// saveRevisioned() üzerinden değişebildiği için dosyanın boyut+mtime imzası
// güvenilir bir "değişmedi" göstergesidir (static-gzip.js'teki aynı desen).
// Önbellek isabetinde bile her çağıran taze, bağımsız bir nesne almaya devam
// eder (JSON.parse'ın önceki davranışıyla birebir) — döndürülen nesne üzerinde
// yapılacak bir mutasyon önbelleği bozmasın diye derin kopya alınır.
const jsonReadCache = new Map();
function readJsonWithBackup(file, fallback) {
  /* Delta yetkili fazda kayıt motordan okunur. Bu tek nokta saveRevisioned
     ailesinin TAMAMINI kapsıyor: overrides, ayarlar, görünümler, filtreler,
     nakliye, ön maliyet, döviz ve yenileme geçmişi hepsi buradan geçiyor.
     Delta boş, hydrate edilmemiş ya da okunamaz durumdaysa eski dosyaya
     düşülür — geçiş sırasında hiçbir veri görünmez olamaz. */
  const fromDelta = readFromDelta(file);
  if (fromDelta) return fromDelta;
  let tag = null;
  try { const stat = fs.statSync(file); tag = `${stat.size}-${stat.mtimeMs}`; } catch (_) { tag = null; }
  if (tag) {
    const cached = jsonReadCache.get(file);
    if (cached && cached.tag === tag) return cloneFallback(cached.value);
  }
  const parsed = readJsonWithValidatedBackup(file, {
    fallback: () => cloneFallback(fallback),
    restore: value => atomicWriteJson(file, value),
  });
  try {
    const stat = fs.statSync(file);
    jsonReadCache.set(file, { tag: `${stat.size}-${stat.mtimeMs}`, value: parsed });
  } catch (_) {}
  return parsed;
}
function saveRevisioned(file, value, fallback, expectedRevision, storeName) {
  return withFileLeaseSync(file,()=>{
  const current = storeExists(file) ? readJsonWithBackup(file, fallback) : cloneFallback(fallback);
  assertRevision(storeName || path.basename(file), current, expectedRevision);
  const saved = revisioned(value, revisionOf(current) + 1);
  if (deltaWritesLegacy(file)) atomicWriteJson(file, saved);
  mirrorToDelta(file, saved);
  return saved;
  });
}

function normalizeLandedMultipliers(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const tr = Number(raw.tr);
  const overseas = Number(raw.overseas);
  return {
    tr: Number.isFinite(tr) && tr > 0 ? tr : 1.05,
    overseas: Number.isFinite(overseas) && overseas > 0 ? overseas : 1.11,
  };
}

function defaultOverrides() {
  return {
    notesmap: {}, submap: {}, suppfobmap: {}, suppfobmetamap: {}, delmap: {}, licensormap: {}, imagemap: {},
    // Kullanıcı tanımlı boş not sütunları (CP/Orders, Packet 9). Tanımlar (id,
    // label, group) ortak listede; DEĞERLER notesmap gibi sipariş+model+renk
    // anahtarıyla saklanır — ham ASAS verisine YAZILMAZ.
    noteColumnDefs: [], noteColumnValues: {},
    // Elle revize edilen CP tarihleri. { [ocode]: { ex?: 'YYYY-MM-DD', retail?: ..., mb?: ... } }
    // Alan yoksa o tarih için revizyon yok demektir; model yenilemesi bunları ezmez.
    datemap: {},
    pricingRules: [], transitRules: [], nonDtrManufacturers: [],
    // Koleksiyon Landed hesaplarında satır bazlı değer girilmezse kullanılan ortak varsayılanlar.
    landedMultipliers: { tr: 1.05, overseas: 1.11 },
    // Nakliye Kıyaslama'daki Navlun Hesaplama alanının birim ücretleri ve
    // hacimsel ağırlık katsayısı. Kaynak Excel'in tablo başındaki üç satırı
    // varsayılandır; kullanıcı rota ekleyip çıkarabilir.
    freightRates: BLFreight.defaultSettings(),
    // ASAS ↔ IAS eşleştirmesi kullanıcı tarafından 1+ tam eşitlik koşuluyla düzenlenir.
    // Eski metin alanı geriye dönük uyumluluk için tutulur; üretim config'i kullanır.
    antrepoMatchRule: DEFAULT_ANTREPO_MATCH_RULE,
    antrepoMatchConfig: defaultAntrepoMatchConfig(),
    // Antrepo ana kaynağı varsayılan olarak Excel'dir. Database yalnız kullanıcı
    // özellikle seçtiğinde devreye girer.
    antrepoSourceMode: 'excel',
    // ASAS ana kaynağı da Antrepo ile aynı mantıkla Excel/Database arasında
    // seçilebilir; varsayılan Excel'dir.
    asasSourceMode: 'excel',
    // LFL kaynağı da aynı mantıkla seçilir; varsayılan Excel'dir.
    lflSourceMode: 'excel',
    // v4.50: mevcut kurulumlarda kalmış özel/eski koşulları bir kez güvenli
    // varsayılan üçlüye döndürmek için şema sürümü. Kullanıcı daha sonra
    // Matching Rule ekranından yeniden değiştirebilir.
    antrepoMatchConfigVersion: 3,
    _revision: 0, _revisions: { orders: 0, suppFob: 0, pricingRules: 0, transitRules: 0, nonDtrManufacturers: 0, landedMultipliers: 0, freightRates: 0, antrepoMatchRule: 0, antrepoSourceMode: 0, asasSourceMode: 0, lflSourceMode: 0, noteColumnDefs: 0 },
  };
}
/* ===================================================================
   NOT YAZARI (v7.29)

   Kullanıcı talebi: "Overview ekranında sadece kullanıcının aldığı notlar
   görünsün. Diğer kullanıcıların girdiği notlar CP ve Orders ekranında
   görünsün, overview ekranına gelmesin."

   Bunun için notun KİM tarafından yazıldığı bilinmeli. v7.28'e kadar notlarda
   yalnız metin ve tarih (NotesAt/EkNotAt) vardı. Artık her not alanı yazıldığı
   anda NotesBy/NotesByName (ve EkNotBy/EkNotByName) ile damgalanır.

   YAZAR SUNUCUDA BELİRLENİR (§32). İstemciden gelen bir "yazar" alanı asla
   kabul edilmez; damga oturumun sahibi olan req.currentUser'dan gelir. Aksi
   hâlde herhangi bir istemci notu başkasının adına yazabilirdi.

   ESKİ KAYITLAR: yazar bilgisi hiç tutulmadığı için geçmiş notların gerçek
   yazarı veriden çıkarılamaz. Kullanıcının açık talimatıyla yazarı bulunmayan
   tüm eski notlara LEGACY_NOTE_AUTHOR adı yazılır. Bu bir GERİ DOLDURMADIR,
   ölçüm değil: not METNİNE dokunulmaz, yalnız eksik yazar alanı eklenir ve
   işlem tekrarlanabilir (idempotent) — ikinci kez çalıştığında hiçbir şeyi
   değiştirmez. Damgası olan bir not asla yeniden yazılmaz. */
const LEGACY_NOTE_AUTHOR_ID = 'legacy-note-author';
const LEGACY_NOTE_AUTHOR_NAME = 'GÖKBERK ÇELEBİ';
const NOTE_AUTHOR_FIELDS = [
  { field: 'Notes', at: 'NotesAt', by: 'NotesBy', byName: 'NotesByName' },
  { field: 'EkNot', at: 'EkNotAt', by: 'EkNotBy', byName: 'EkNotByName' },
];
function backfillLegacyNoteAuthors(notesmap) {
  const map = notesmap && typeof notesmap === 'object' ? notesmap : {};
  for (const key of Object.keys(map)) {
    const record = map[key];
    if (!record || typeof record !== 'object') continue;
    let next = null;
    for (const spec of NOTE_AUTHOR_FIELDS) {
      const text = record[spec.field] == null ? '' : String(record[spec.field]);
      if (!text.trim()) continue;                       // boş not damgalanmaz
      if (String(record[spec.by] || '').trim()) continue; // yazarı zaten var — dokunma
      next = next || { ...record };
      next[spec.by] = LEGACY_NOTE_AUTHOR_ID;
      next[spec.byName] = LEGACY_NOTE_AUTHOR_NAME;
    }
    if (next) map[key] = next;
  }
  return map;
}

function loadOverrides() {
  ensureDataDir();
  // readJsonWithBackup delta yetkili fazda kaydı motordan, aksi hâlde eski
  // dosyadan getirir; aşağıdaki normalizasyon iki kaynağa da aynı uygulanır.
  const parsed = storeExists(OVERRIDES_FILE) ? readJsonWithBackup(OVERRIDES_FILE, defaultOverrides) : defaultOverrides();
  const base = defaultOverrides();
  const merged = { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  merged._revisions = { ...base._revisions, ...(parsed && parsed._revisions || {}) };
  merged._revision = revisionOf(parsed);
  // v4.73: Onaylar modülü kaldırıldı. CP notları ayrı notesmap içinde korunur;
  // eski apprmap içindeki Notes/EkNot alanları bir kez taşınır, onay statüleri silinir.
  const legacyApprovals = parsed && parsed.apprmap && typeof parsed.apprmap === 'object' ? parsed.apprmap : {};
  const migratedNotes = { ...(parsed && parsed.notesmap && typeof parsed.notesmap === 'object' ? parsed.notesmap : {}) };
  Object.entries(legacyApprovals).forEach(([key, rec]) => {
    if (!rec || typeof rec !== 'object') return;
    const current = migratedNotes[key] && typeof migratedNotes[key] === 'object' ? migratedNotes[key] : {};
    const next = { ...current };
    if (!Object.prototype.hasOwnProperty.call(next, 'Notes') && Object.prototype.hasOwnProperty.call(rec, 'Notes')) next.Notes = rec.Notes;
    if (!Object.prototype.hasOwnProperty.call(next, 'EkNot') && Object.prototype.hasOwnProperty.call(rec, 'EkNot')) next.EkNot = rec.EkNot;
    if (Object.keys(next).length) migratedNotes[key] = next;
  });
  merged.notesmap = backfillLegacyNoteAuthors(migratedNotes);
  delete merged.apprmap;
  // Eski kurulumlar yalnız metin kuralı veya v4.41'in Model Adı = Model Adı
  // varsayılanını taşıyabilir. Normalize işlemi bunları yeni güvenli üçlüye
  // yükseltir; kullanıcı tarafından oluşturulan manuel koşul dizileri korunur.
  merged.antrepoMatchRule = DEFAULT_ANTREPO_MATCH_RULE;
  // v4.50 migrasyonu: sipariş eşleştirmesi bir kez zorunlu varsayılan üçlüye
  // döner. Yeni sürümde kullanıcı yeniden kaydederse version 3 ile korunur.
  const matchConfigVersion = Number(parsed && parsed.antrepoMatchConfigVersion) || 0;
  merged.antrepoMatchConfigVersion = 3;
  merged.antrepoMatchConfig = matchConfigVersion >= 3
    ? normalizeAntrepoMatchConfig(parsed && parsed.antrepoMatchConfig ? parsed.antrepoMatchConfig : null)
    : defaultAntrepoMatchConfig();
  const antrepoSourceMode = String(parsed && parsed.antrepoSourceMode || 'excel').toLowerCase();
  merged.antrepoSourceMode = ['database', 'dashboard'].includes(antrepoSourceMode) ? antrepoSourceMode : 'excel';
  merged.asasSourceMode = String(parsed && parsed.asasSourceMode || 'excel').toLowerCase() === 'database'
    ? 'database' : 'excel';
  merged.lflSourceMode = String(parsed && parsed.lflSourceMode || 'excel').toLowerCase() === 'database'
    ? 'database' : 'excel';
  merged.landedMultipliers = normalizeLandedMultipliers(parsed && parsed.landedMultipliers);
  merged.freightRates = BLFreight.normalizeSettings(parsed && parsed.freightRates);
  // License Royalty v2: eski TR / Non-TR kayıtları okunurken tek
  // sözleşme kaydına dönüştürülür. Efektif ülke oranları ve varsa eski farklı
  // hologram tutarları korunur.
  merged.pricingRules = BLBusinessRules.migrateLicenseRoyaltyRules(
    Array.isArray(merged.pricingRules) ? merged.pricingRules : []
  );
  // Shared Hub modunda CP iş verisinin kanonik sahibi satır bazlı cp-order
  // kayıtlarıdır. Eski map şekli renderer/business logic için yalnız projection.
  cpSharedStore.overlay(merged);
  return merged;
}
function protectCriticalOverrideSections(current, incoming) {
  const base = current && typeof current === 'object' ? current : defaultOverrides();
  const source = incoming && typeof incoming === 'object' ? incoming : {};
  const next = { ...source, _revisions:{ ...(source._revisions || {}) } };
  // Generic/legacy writers sometimes save a partial overrides object. A real
  // UI edit increments the section revision; a structural data-loss write
  // does not. Therefore only preserve a non-empty section when it becomes
  // empty WITHOUT its own revision advancing.
  for (const field of ['pricingRules','transitRules','nonDtrManufacturers']) {
    const before = Array.isArray(base[field]) ? base[field] : [];
    const after = Array.isArray(next[field]) ? next[field] : [];
    const beforeRev = Number(base._revisions && base._revisions[field]) || 0;
    const afterRev = Number(next._revisions && next._revisions[field]) || 0;
    if (before.length > 0 && after.length === 0 && afterRev <= beforeRev) {
      next[field] = JSON.parse(JSON.stringify(before));
      next._revisions[field] = beforeRev;
    }
  }
  return next;
}
function saveOverrides(overrides, expectedRevision = null) {
  ensureDataDir();
  const protectedOverrides = protectCriticalOverrideSections(loadOverrides(), overrides);
  return saveRevisioned(OVERRIDES_FILE, protectedOverrides, defaultOverrides, expectedRevision, 'Sipariş geçersiz kılma verileri');
}
function replacePricingRules(rules, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.pricingRules) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('License Royalty Calculations', wanted, current);
  ov.pricingRules = Array.isArray(rules) ? rules : [];
  ov._revisions.pricingRules = current + 1;
  const saved = saveOverrides(ov);
  return { rules: saved.pricingRules, revision: saved._revisions.pricingRules };
}
function transitRuleComparable(rule) {
  if (!rule || typeof rule !== 'object') return '';
  return JSON.stringify({
    id: String(rule.id || ''), exfStart: rule.exfStart || '', exfEnd: rule.exfEnd || '',
    seasons: Array.isArray(rule.seasons) ? rule.seasons : [], countries: Array.isArray(rule.countries) ? rule.countries : [],
    delType: rule.delType || '', days: Number(rule.days),
  });
}
function mergeTransitRules(baseRules, incomingRules, currentRules, wanted, current) {
  const toMap = rules => new Map((Array.isArray(rules) ? rules : []).filter(rule => rule && rule.id != null).map(rule => [String(rule.id), rule]));
  const base = toMap(baseRules), incoming = toMap(incomingRules), remote = toMap(currentRules);
  const merged = new Map(remote);
  for (const [id, before] of base) {
    const local = incoming.get(id) || null, remoteValue = remote.get(id) || null;
    const localChanged = transitRuleComparable(before) !== transitRuleComparable(local);
    if (!localChanged) continue;
    const remoteChanged = transitRuleComparable(before) !== transitRuleComparable(remoteValue);
    if (remoteChanged && transitRuleComparable(local) !== transitRuleComparable(remoteValue)) {
      throw new RevisionConflictError('Transit kuralları', wanted, current);
    }
    if (local) merged.set(id, local); else merged.delete(id);
  }
  for (const [id, local] of incoming) {
    if (base.has(id)) continue;
    const remoteValue = remote.get(id);
    if (remoteValue && transitRuleComparable(remoteValue) !== transitRuleComparable(local)) {
      throw new RevisionConflictError('Transit kuralları', wanted, current);
    }
    merged.set(id, local);
  }
  // Uzakta sonradan gelen kayıtlar korunur; yerel sırayı da gereksiz yere bozma.
  const orderedIds = [...incoming.keys(), ...remote.keys()];
  return [...new Set(orderedIds)].map(id => merged.get(id)).filter(Boolean);
}
function replaceTransitRules(rules, expectedRevision = null, baseRules = null) {
  const wanted = expectedNumber(expectedRevision);
  // saveOverrides kendi atomik/lease yolunu kullanır. Araya başka bir overrides
  // yazısı girerse güncel snapshot ile en fazla iki kez yeniden birleştirir.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ov = loadOverrides();
    const current = Number(ov._revisions.transitRules) || 0;
    let nextRules = Array.isArray(rules) ? rules : [];
    if (wanted != null && wanted !== current) {
      if (!Array.isArray(baseRules)) throw new RevisionConflictError('Transit kuralları', wanted, current);
      nextRules = mergeTransitRules(baseRules, nextRules, ov.transitRules, wanted, current);
    }
    ov.transitRules = nextRules;
    ov._revisions.transitRules = current + 1;
    try {
      const saved = saveOverrides(ov, ov._revision);
      return { rules: saved.transitRules, revision: saved._revisions.transitRules };
    } catch (error) {
      if (!(error instanceof RevisionConflictError) || attempt === 2) throw error;
    }
  }
  throw new RevisionConflictError('Transit kuralları', wanted, 0);
}
// Manuel ASAS ↔ IAS koşulları tek revizyon altında atomik olarak saklanır.
function replaceAntrepoMatchRule(config, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.antrepoMatchRule) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Eşleştirme kuralı', wanted, current, 'antrepoMatchRule');
  ov.antrepoMatchRule = DEFAULT_ANTREPO_MATCH_RULE;
  ov.antrepoMatchConfig = normalizeAntrepoMatchConfig(config);
  ov.antrepoMatchConfigVersion = 3;
  ov._revisions.antrepoMatchRule = current + 1;
  const saved = saveOverrides(ov);
  return { config: saved.antrepoMatchConfig, rule: saved.antrepoMatchRule, revision: saved._revisions.antrepoMatchRule };
}

function replaceAntrepoSourceMode(mode, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.antrepoSourceMode) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Antrepo veri kaynağı', wanted, current, 'antrepoSourceMode');
  const normalizedMode = String(mode || '').toLowerCase();
  ov.antrepoSourceMode = ['database', 'dashboard'].includes(normalizedMode) ? normalizedMode : 'excel';
  ov._revisions.antrepoSourceMode = current + 1;
  const saved = saveOverrides(ov);
  return { mode: saved.antrepoSourceMode, revision: saved._revisions.antrepoSourceMode };
}
function replaceAsasSourceMode(mode, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.asasSourceMode) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('ASAS veri kaynağı', wanted, current, 'asasSourceMode');
  ov.asasSourceMode = String(mode || '').toLowerCase() === 'database' ? 'database' : 'excel';
  ov._revisions.asasSourceMode = current + 1;
  const saved = saveOverrides(ov);
  return { mode: saved.asasSourceMode, revision: saved._revisions.asasSourceMode };
}
function replaceLflSourceMode(mode, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.lflSourceMode) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('LFL veri kaynağı', wanted, current, 'lflSourceMode');
  ov.lflSourceMode = String(mode || '').toLowerCase() === 'database' ? 'database' : 'excel';
  ov._revisions.lflSourceMode = current + 1;
  const saved = saveOverrides(ov);
  return { mode: saved.lflSourceMode, revision: saved._revisions.lflSourceMode };
}
function replaceNonDtrManufacturers(manufacturers, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.nonDtrManufacturers) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Non-DTR üreticiler', wanted, current, 'nonDtrManufacturers');
  ov.nonDtrManufacturers = BLBusinessRules.normalizeManufacturerList(manufacturers);
  ov._revisions.nonDtrManufacturers = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  return { manufacturers: saved.nonDtrManufacturers, revision: saved._revisions.nonDtrManufacturers };
}
function replaceFreightRates(value, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.freightRates) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Navlun ücretleri', wanted, current, 'freightRates');
  ov.freightRates = BLFreight.normalizeSettings(value);
  ov._revisions.freightRates = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  return { freight: BLFreight.normalizeSettings(saved.freightRates), revision: saved._revisions.freightRates };
}
// Kullanıcı tanımlı boş not sütunları (Packet 9). normalizeCpModelColumns ile
// aynı desen: id temizlenir, ad ve id çakışması elenir, dizi sınırlanır.
function normalizeNoteColumnDefs(raw) {
  const seen = new Set(), labels = new Set(), out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const item = value && typeof value === 'object' ? value : {};
    const id = String(item.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      || `note_${Math.random().toString(36).slice(2, 10)}`;
    const label = String(item.label == null ? '' : item.label).replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = id.toLowerCase(), labelKey = label.toLocaleLowerCase('tr');
    if (!label || seen.has(key) || labels.has(labelKey)) continue;
    seen.add(key); labels.add(labelKey);
    out.push({ id, label, group: String(item.group == null ? '' : item.group).replace(/\s+/g, ' ').trim().slice(0, 40) });
    if (out.length >= 40) break;
  }
  return out;
}
function replaceNoteColumnDefs(value, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.noteColumnDefs) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Not sütunları', wanted, current, 'noteColumnDefs');
  ov.noteColumnDefs = normalizeNoteColumnDefs(value);
  // Silinen bir sütunun değerleri de temizlenir; aksi hâlde yeniden aynı adla
  // eklenince eski değerler hayalet gibi geri gelirdi.
  const validIds = new Set(ov.noteColumnDefs.map(def => def.id));
  ov.noteColumnValues = ov.noteColumnValues || {};
  Object.keys(ov.noteColumnValues).forEach(key => {
    const bucket = ov.noteColumnValues[key];
    if (!bucket || typeof bucket !== 'object') { delete ov.noteColumnValues[key]; return; }
    Object.keys(bucket).forEach(id => { if (!validIds.has(id)) delete bucket[id]; });
    if (!Object.keys(bucket).length) delete ov.noteColumnValues[key];
  });
  ov._revisions.noteColumnDefs = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  // Sütun tanımı silinince satırların noteColumns projection'ı da değişir.
  for (const key of cpSharedStore.legacyKeys({ noteColumnValues: saved.noteColumnValues })) {
    cpSharedStore.mirrorPatchDetached(key, { noteColumns: saved.noteColumnValues[key] || null });
  }
  return { columns: saved.noteColumnDefs, revision: saved._revisions.noteColumnDefs };
}
function replaceLandedMultipliers(value, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.landedMultipliers) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Landed çarpanları', wanted, current, 'landedMultipliers');
  ov.landedMultipliers = normalizeLandedMultipliers(value);
  ov._revisions.landedMultipliers = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  return { multipliers: normalizeLandedMultipliers(saved.landedMultipliers), revision: saved._revisions.landedMultipliers };
}
// Kullanıcı düzenlemeleri sipariş + model + renk koduyla saklanır. İstemci model
// ve renk kodunu göndermezse (ör. yalnız Order Code sütunu olan Excel içe aktarma)
// eski sipariş bazlı anahtar kullanılır; okuma tarafı ikisini de tanır.
function overrideWriteKey(orderCode, patch) {
  const model = patch && patch.model;
  const ccode = patch && patch.ccode;
  if (model && ccode) return orderLineKey(orderCode, model, ccode);
  return orderCode;
}

function applyOrderPatch(ov, orderCode, patch, options = null) {
  const oc = overrideWriteKey(orderCode, patch);
  // Satır ilk kez düzenlendiğinde, o siparişe ait eski (sipariş bazlı) kayıt
  // tohum olarak alınır: notlar sıfırdan başlamaz.
  const seed = (map) => (oc === orderCode ? {} : { ...(map[orderCode] || {}) });
  if (patch.notes && typeof patch.notes === 'object') {
    ov.notesmap = ov.notesmap || {};
    // Yazar YALNIZ sunucudaki oturumdan gelir; patch içindeki bir yazar alanı
    // dikkate alınmaz (§32).
    const actor = options && options.actor && typeof options.actor === 'object' ? options.actor : null;
    const actorId = actor && actor.id != null ? String(actor.id).trim() : '';
    const actorName = actor && actor.name != null ? String(actor.name).trim() : '';
    const previous = { ...seed(ov.notesmap), ...(ov.notesmap[oc] || {}) };
    const next = { ...previous };
    const stampNoteField = (field, atField, byField, byNameField) => {
      if (!Object.prototype.hasOwnProperty.call(patch.notes, field)) return;
      const incoming = patch.notes[field] == null ? '' : String(patch.notes[field]);
      const before = previous[field] == null ? '' : String(previous[field]);
      next[field] = incoming;
      if (incoming === before) return;
      if (!incoming.trim()) {
        // Not silindi: tarih ve yazar da düşer, yoksa boş bir nota ait yazar
        // damgası kalır ve sonraki yazan kişinin notu ona atfedilirdi.
        next[atField] = '';
        delete next[byField];
        delete next[byNameField];
        return;
      }
      next[atField] = new Date().toISOString();
      // Yazar bilinmiyorsa (oturumsuz bir iç çağrı) eski damga KORUNUR; boş bir
      // yazar yazmak, notu "yazarı bilinmiyor" durumuna düşürmek olurdu.
      if (actorId || actorName) {
        next[byField] = actorId || actorName;
        next[byNameField] = actorName || actorId;
      }
    };
    for (const spec of NOTE_AUTHOR_FIELDS) stampNoteField(spec.field, spec.at, spec.by, spec.byName);
    ov.notesmap[oc] = next;
  }
  if (patch.noteColumns && typeof patch.noteColumns === 'object') {
    ov.noteColumnValues = ov.noteColumnValues || {};
    const bucket = { ...seed(ov.noteColumnValues), ...(ov.noteColumnValues[oc] || {}) };
    const validIds = new Set((ov.noteColumnDefs || []).map(def => def.id));
    for (const [id, value] of Object.entries(patch.noteColumns)) {
      if (!validIds.has(id)) continue; // silinmiş/bilinmeyen sütuna yazılmaz
      const text = value == null ? '' : String(value);
      if (text) bucket[id] = text; else delete bucket[id];
    }
    if (Object.keys(bucket).length) ov.noteColumnValues[oc] = bucket; else delete ov.noteColumnValues[oc];
  }
  if (patch.subManufacturer != null) ov.submap[oc] = patch.subManufacturer;
  if (Object.prototype.hasOwnProperty.call(patch, 'licensor')) ov.licensormap[oc] = patch.licensor == null ? '' : String(patch.licensor).trim();
  if (Object.prototype.hasOwnProperty.call(patch, 'suppFob')) {
    ov.suppfobmap[oc] = patch.suppFob == null ? null : patch.suppFob;
    ov.suppfobmetamap = ov.suppfobmetamap || {};
    const incomingMeta = patch.suppFobMeta && typeof patch.suppFobMeta === 'object' ? patch.suppFobMeta : null;
    ov.suppfobmetamap[oc] = incomingMeta && incomingMeta.source === 'rule' ? { ...incomingMeta, source: 'rule' } : { source: 'manual', updatedAt: new Date().toISOString() };
  }
  if (patch.delType != null) ov.delmap[oc] = patch.delType;
  // CP görseli PLM ID + Colour Code kimliğine bağlıdır. Aynı PLM'nin farklı
  // renkleri ayrı görseller kullanır; aynı PLM+Colour Code kimliğini paylaşan
  // sipariş satırları ise tek görseli paylaşır. Boş değer silme tombstone'udur.
  if (Object.prototype.hasOwnProperty.call(patch, 'imageRef')) {
    ov.imagemap = ov.imagemap || {};
    const imagePlmId = patch.imagePlmId != null ? patch.imagePlmId : patch.plmId;
    const imageColourCode = patch.imageColourCode != null ? patch.imageColourCode : (patch.colourCode != null ? patch.colourCode : patch.ccode);
    const imageKey = plmColourImageKey(imagePlmId, imageColourCode);
    if (!imageKey) {
      const err = new Error('CP görseli için PLM ID ve Colour Code zorunludur.');
      err.code = 'VALIDATION_ERROR';
      err.statusCode = 400;
      throw err;
    }
    const ref = patch.imageRef == null ? '' : String(patch.imageRef).trim();
    ov.imagemap[imageKey] = ref;
  }
  if (patch.dates && typeof patch.dates === 'object') applyDatePatch(ov, oc, patch.dates, orderCode);
}

// Tarih revizyonu: 'YYYY-MM-DD' kaydeder, null gelirse revizyonu KALDIRIR
// (hücre veritabanından gelen değere döner). Boş kalan kayıt tamamen silinir.
const DATE_OVERRIDE_FIELDS = { exFactory: 'ex', retailDate: 'retail', inStoreDate: 'mb' };
function applyDatePatch(ov, oc, dates, legacyKey) {
  ov.datemap = ov.datemap || {};
  const seed = (legacyKey != null && legacyKey !== oc) ? (ov.datemap[legacyKey] || {}) : {};
  const record = { ...seed, ...(ov.datemap[oc] || {}) };
  for (const [incoming, stored] of Object.entries(DATE_OVERRIDE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(dates, incoming)) continue;
    const value = dates[incoming];
    if (value == null || value === '') { delete record[stored]; continue; }
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) continue; // biçimsiz değer sessizce yok sayılır
    record[stored] = text;
  }
  if (Object.keys(record).length) ov.datemap[oc] = record;
  else delete ov.datemap[oc];
}
function patchOrderOverride(orderCode, patch, expectedRevision = null, expectedSuppFobRevision = null, options = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Sipariş düzenlemeleri', wanted, current, 'orders');
  const touchesSuppFob=Object.prototype.hasOwnProperty.call(patch||{},'suppFob');
  const currentSuppFob=Number(ov._revisions.suppFob)||0, wantedSuppFob=expectedNumber(expectedSuppFobRevision);
  if(touchesSuppFob && wantedSuppFob!=null && wantedSuppFob!==currentSuppFob)throw new RevisionConflictError('Sipariş Supp. FOB düzenlemeleri',wantedSuppFob,currentSuppFob,'suppFob');
  applyOrderPatch(ov, orderCode, patch || {}, options);
  ov._revisions.orders = current + 1;
  if(touchesSuppFob)ov._revisions.suppFob=currentSuppFob+1;
  const saved = saveOverrides(ov, ov._revision);
  const cpKey = overrideWriteKey(orderCode, patch || {});
  cpSharedStore.mirrorPatchDetached(cpKey, cpSharedStore.patchFromOrderPatch(saved, cpKey, patch || {}), { actor: options && options.actor });
  return { overrides: saved, revision: saved._revisions.orders, revisions: { orders: saved._revisions.orders, suppFob: saved._revisions.suppFob }, updated: 1 };
}
function patchOrderOverrides(items, expectedRevision = null, expectedSuppFobRevision = null, options = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Sipariş düzenlemeleri', wanted, current, 'orders');
  const touchesSuppFob=(Array.isArray(items)?items:[]).some(item=>item&&item.patch&&Object.prototype.hasOwnProperty.call(item.patch,'suppFob'));
  const currentSuppFob=Number(ov._revisions.suppFob)||0,wantedSuppFob=expectedNumber(expectedSuppFobRevision);
  if(touchesSuppFob&&wantedSuppFob!=null&&wantedSuppFob!==currentSuppFob)throw new RevisionConflictError('Sipariş Supp. FOB düzenlemeleri',wantedSuppFob,currentSuppFob,'suppFob');
  let updated = 0;
  const cpTouched = [];
  // Geçersiz satırlar sessizce atlanır ancak hangi satırların ve neden atlandığı
  // çağırana bildirilir; yalnız "updated" sayısına bakan bir istemci artık
  // eksik satırların farkına varamamaktan etkilenmez.
  const skipped = [];
  for (const item of modelImageRegistry.normalizeItems(items)) {
    const orderCode = Number(item && item.orderCode);
    if (!Number.isFinite(orderCode)) { skipped.push({ orderCode: item && item.orderCode, reason: 'invalid-order-code' }); continue; }
    if (!item.patch || typeof item.patch !== 'object') { skipped.push({ orderCode, reason: 'missing-patch' }); continue; }
    applyOrderPatch(ov, orderCode, item.patch, options); cpTouched.push({ key: overrideWriteKey(orderCode, item.patch), patch: item.patch }); updated += 1;
  }
  if (!updated) return { overrides: ov, revision: current, updated: 0, skipped };
  ov._revisions.orders = current + 1;
  if(touchesSuppFob)ov._revisions.suppFob=currentSuppFob+1;
  const saved = saveOverrides(ov, ov._revision);
  for (const item of cpTouched) cpSharedStore.mirrorPatchDetached(item.key, cpSharedStore.patchFromOrderPatch(saved, item.key, item.patch), { actor: options && options.actor });
  return { overrides: saved, revision: saved._revisions.orders, revisions: { orders: saved._revisions.orders, suppFob: saved._revisions.suppFob }, updated, skipped };
}

function patchPlmImageLinks(items, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('PLM görsel bağlantıları', wanted, current, 'orders');
  ov.imagemap = ov.imagemap || {};
  let updated = 0;
  const skipped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const plmId = item && item.plmId;
    const colourCode = item && item.colourCode;
    const colour = item && (item.colour || item.color);
    const key = colourCode == null || String(colourCode).trim()==='' ? plmImageKey(plmId) : plmColourImageNameKey(plmId, colourCode, colour);
    if (!key) { skipped.push({ plmId, colourCode, reason: 'invalid-key' }); continue; }
    const ref = item && item.imageRef != null ? String(item.imageRef).trim() : '';
    /* v6.38 — MEZAR TAŞI TEMİZLİĞİ.
       Gösterim önce renk anahtarına bakar; orada boş bir kayıt (silme mezar
       taşı) varsa eski PLM-only anahtara HİÇ düşmez. Bu yüzden PLM'den yeniden
       çekilen bir görseli eski anahtara yazmak yetmiyordu: görsel diske
       yazılıyor ama mezar taşı onu gölgeliyor ve ekranda görünmüyordu.
       Kullanıcı yeniden yükleme istediğine göre silme kaydı da kalkmalıdır. */
    if (ref) {
      for (const existing of plmImageKeysFor(ov.imagemap, plmId)) {
        if (existing === key) continue;
        if (String(ov.imagemap[existing] == null ? '' : ov.imagemap[existing]).trim() === '') delete ov.imagemap[existing];
      }
    }
    ov.imagemap[key] = ref;
    updated += 1;
  }
  if (!updated) return { overrides: ov, revision: current, updated: 0, skipped };
  ov._revisions.orders = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  return { overrides: saved, revision: saved._revisions.orders, updated, skipped };
}

/* v10.90 — GENEL MODEL GÖRSELİ KAYDININ SIFIRLANMASI.
   imagemap'in tek işi "bu model/renk kimliği şu anda şu görsele sahip"
   demektir; başka hiçbir iş verisi taşımaz. Depodaki bütün görseller
   silindiğinde bu kayıtların hepsi geçersizdir. Eskiden temizlenmedikleri
   için canonicalModelImageKnown() hâlâ "görsel var" diyor, çözümlenen URL
   404 dönüyor ve hücrede kırık görsel simgesi kalıyordu. */
function clearAllModelImageLinks(expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Model görsel bağlantıları', wanted, current, 'orders');
  const map = ov.imagemap && typeof ov.imagemap === 'object' ? ov.imagemap : {};
  const cleared = Object.keys(map).length;
  // Boş kayıt üzerinde yeniden çalıştırmak güvenlidir: yazma yapılmaz,
  // revizyon boşuna artmaz.
  if (!cleared) { ov.imagemap = {}; return { overrides: ov, revision: current, cleared: 0 }; }
  ov.imagemap = {};
  ov._revisions.orders = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  return { overrides: saved, revision: saved._revisions.orders, cleared };
}

function patchSuppFobOverrides(items, expectedRevision = null, options = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.suppFob) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Sipariş Supp. FOB düzenlemeleri', wanted, current, 'suppFob');
  ov.suppfobmetamap = ov.suppfobmetamap || {};
  let updated = 0;
  const touched = [];
  const skipped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const orderCode = Number(item && item.orderCode), value = Number(item && item.suppFob);
    if (!Number.isFinite(orderCode) || !Number.isFinite(value)) { skipped.push({ orderCode: item && item.orderCode, reason: 'invalid-order-code-or-value' }); continue; }
    // Supp. FOB modele ve modelin rengine göre değişir: satır bazlı anahtar.
    const oc = overrideWriteKey(orderCode, item);
    ov.suppfobmap[oc] = value;
    const meta = item && item.suppFobMeta && typeof item.suppFobMeta === 'object' ? item.suppFobMeta : null;
    if (meta && meta.source === 'rule') {
      ov.suppfobmetamap[oc] = {
        source: 'rule', ruleId: meta.ruleId == null ? '' : String(meta.ruleId), opdStart: meta.opdStart == null ? '' : String(meta.opdStart), opdEnd: meta.opdEnd == null ? '' : String(meta.opdEnd),
        seasons: Array.isArray(meta.seasons) ? meta.seasons.map(String).filter(Boolean) : (meta.season ? [String(meta.season)] : []),
        licensor: meta.licensor == null ? '' : String(meta.licensor), license: meta.license == null ? '' : String(meta.license),
        royalty: Number(meta.royalty),
        trCommission: meta.trCommission == null || meta.trCommission === '' ? null : Number(meta.trCommission),
        ydCommission: meta.ydCommission == null || meta.ydCommission === '' ? null : Number(meta.ydCommission),
        commissionGroup: meta.commissionGroup == null ? '' : String(meta.commissionGroup),
        commission: meta.commission == null || meta.commission === '' ? null : Number(meta.commission),
        effectiveRoyalty: meta.effectiveRoyalty == null || meta.effectiveRoyalty === '' ? null : Number(meta.effectiveRoyalty),
        hologramCost: Number(meta.hologramCost), applied: meta.applied === true, updatedAt: new Date().toISOString(),
      };
    } else ov.suppfobmetamap[oc] = { source: 'manual', updatedAt: new Date().toISOString() };
    touched.push(oc);
    updated += 1;
  }
  if (!updated) return { overrides: ov, revision: current, updated: 0, skipped };
  ov._revisions.suppFob = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  for (const key of touched) cpSharedStore.mirrorPatchDetached(key, { suppFob: saved.suppfobmap[key] ?? null, suppFobMeta: saved.suppfobmetamap[key] ?? null }, { actor: options && options.actor });
  return { overrides: saved, revision: saved._revisions.suppFob, updated, skipped };
}
function clearDeliveryOverrides(expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Sipariş düzenlemeleri', wanted, current);
  if (!ov.delmap || !Object.keys(ov.delmap).length) return { overrides: ov, revision: current, changed: false };
  const clearedKeys = Object.keys(ov.delmap);
  ov.delmap = {};
  ov._revisions.orders = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  for (const key of clearedKeys) cpSharedStore.mirrorPatchDetached(key, { delivery: null });
  return { overrides: saved, revision: saved._revisions.orders, changed: true };
}

function clearDeliveryOverridesForOrders(orderCodes, expectedRevision = null) {
  const ov = loadOverrides();
  const current = Number(ov._revisions.orders) || 0;
  const wanted = expectedNumber(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Sipariş düzenlemeleri', wanted, current);
  const keys = new Set((Array.isArray(orderCodes) ? orderCodes : []).map(value => String(Number(value))).filter(value => value !== 'NaN'));
  if (!keys.size || !ov.delmap || !Object.keys(ov.delmap).length) return { overrides: ov, revision: current, changed: false };
  let changed = false;
  const clearedKeys = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(ov.delmap, key)) { delete ov.delmap[key]; clearedKeys.push(key); changed = true; }
  }
  if (!changed) return { overrides: ov, revision: current, changed: false };
  ov._revisions.orders = current + 1;
  const saved = saveOverrides(ov, ov._revision);
  for (const key of clearedKeys) cpSharedStore.mirrorPatchDetached(key, { delivery: null });
  return { overrides: saved, revision: saved._revisions.orders, changed: true };
}
function mergeCpUpdateOverrides(result, options = null) {
  const ov = loadOverrides();
  let ordersChanged = false, suppFobChanged = false;
  const touched = new Map();
  const mark = (key, field) => { if (!touched.has(key)) touched.set(key, new Set()); touched.get(key).add(field); };
  for (const [key, value] of Object.entries(result && result.submap || {})) {
    if (ov.submap[key] !== value) { ov.submap[key] = value; ordersChanged = true; mark(key, 'subManufacturer'); }
  }
  ov.suppfobmetamap = ov.suppfobmetamap || {};
  for (const [key, value] of Object.entries(result && result.suppfobmap || {})) {
    if (ov.suppfobmap[key] !== value) { ov.suppfobmap[key] = value; suppFobChanged = true; mark(key, 'suppFob'); }
    const nextMeta = { source: 'manual', origin: 'cpupdate' };
    if (JSON.stringify(ov.suppfobmetamap[key] || null) !== JSON.stringify(nextMeta)) { ov.suppfobmetamap[key] = nextMeta; suppFobChanged = true; mark(key, 'suppFobMeta'); }
  }
  if (!ordersChanged && !suppFobChanged) return { overrides: ov, changed: false };
  if (ordersChanged) ov._revisions.orders = (Number(ov._revisions.orders) || 0) + 1;
  if (suppFobChanged) ov._revisions.suppFob = (Number(ov._revisions.suppFob) || 0) + 1;
  const saved = saveOverrides(ov, ov._revision);
  for (const [key, fields] of touched) {
    const patch = {};
    if (fields.has('subManufacturer')) patch.subManufacturer = saved.submap[key] ?? null;
    if (fields.has('suppFob')) patch.suppFob = saved.suppfobmap[key] ?? null;
    if (fields.has('suppFobMeta')) patch.suppFobMeta = saved.suppfobmetamap[key] ?? null;
    cpSharedStore.mirrorPatchDetached(key, patch, { actor: options && options.actor });
  }
  return { overrides: saved, changed: true, ordersRevision: saved._revisions.orders, suppFobRevision: saved._revisions.suppFob };
}

function defaultRefreshHistory() { return { items: [], _revision: 0 }; }
/* Bir kaydın detay listesini sınıra indirir ve kırpılan satır sayısını kayda
   yazar. Kırpma DEĞİŞMEZ olmalı: aynı kayıt tekrar normalize edildiğinde
   detailsTotal ilk ölçülen değerde kalır, yoksa her kaydetmede küçülürdü. */
function trimRefreshHistoryDetails(item) {
  if (!item || typeof item !== 'object') return item;
  const details = Array.isArray(item.details) ? item.details : [];
  const total = Number.isFinite(Number(item.detailsTotal)) && Number(item.detailsTotal) >= details.length
    ? Number(item.detailsTotal) : details.length;
  if (details.length <= REFRESH_HISTORY_DETAIL_LIMIT) {
    return total === details.length ? item : { ...item, detailsTotal: total };
  }
  return { ...item, details: details.slice(0, REFRESH_HISTORY_DETAIL_LIMIT), detailsTotal: total };
}
function normalizeRefreshHistoryItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index, time: Date.parse(item && item.createdAt || '') }))
    .sort((a, b) => {
      const at = Number.isFinite(a.time) ? a.time : -Infinity;
      const bt = Number.isFinite(b.time) ? b.time : -Infinity;
      return bt - at || a.index - b.index;
    })
    .slice(0, REFRESH_HISTORY_LIMIT)
    .map(entry => trimRefreshHistoryDetails(entry.item));
}
function loadRefreshHistory(userId = null) {
  ensureDataDir();
  const file = scopedSourceFile(REFRESH_HISTORY_FILE, userId);
  const parsed = storeExists(file) ? readJsonWithBackup(file, defaultRefreshHistory) : defaultRefreshHistory();
  const rawItems = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  const items = normalizeRefreshHistoryItems(rawItems);
  const changed = rawItems.length !== items.length || items.some((item, index) => item !== rawItems[index]);
  if (changed) {
    const saved = revisioned({ items }, revisionOf(parsed) + 1);
    atomicWriteJson(file, saved);
    return saved;
  }
  return { items, _revision: revisionOf(parsed), _updatedAt: parsed && parsed._updatedAt || null };
}
function saveRefreshHistory(store, expectedRevision = null, userId = null) {
  ensureDataDir();
  const file = scopedSourceFile(REFRESH_HISTORY_FILE, userId);
  return saveRevisioned(file, { items: normalizeRefreshHistoryItems(store && store.items) }, defaultRefreshHistory, expectedRevision, 'Güncelleme geçmişi');
}

function addRefreshHistory(record, userId = null) {
  const details = Array.isArray(record && record.details) ? record.details : []; if (!details.length) return null;
  const store = loadRefreshHistory(userId); const createdAt = record.createdAt || new Date().toISOString();
  const item = { id: record.id || `refresh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt, sources: record.sources && typeof record.sources === 'object' ? record.sources : {}, summary: record.summary && typeof record.summary === 'object' ? record.summary : {}, details };
  store.items.unshift(item); saveRefreshHistory(store, store._revision, userId); return item;
}
function deleteRefreshHistory(id, expectedRevision = null, userId = null) {
  ensureDataDir();
  const cleanId = String(id || '').trim();
  if (!cleanId) {
    const error = new Error('Silinecek geçmiş kaydı belirtilmedi.');
    error.statusCode = 400; error.code = 'REFRESH_HISTORY_ID_REQUIRED'; throw error;
  }
  const store = loadRefreshHistory(userId);
  assertRevision('ASAS & ANTREPO geçmişi', store, expectedRevision);
  const before = store.items.length;
  store.items = store.items.filter(item => String(item && item.id || '') !== cleanId);
  if (store.items.length === before) {
    const error = new Error('Güncelleme geçmişi kaydı bulunamadı.');
    error.statusCode = 404; error.code = 'REFRESH_HISTORY_NOT_FOUND'; throw error;
  }
  return saveRefreshHistory(store, store._revision, userId);
}
function clearRefreshHistory(expectedRevision = null, userId = null) {
  ensureDataDir();
  const store = loadRefreshHistory(userId);
  assertRevision('ASAS & ANTREPO geçmişi', store, expectedRevision);
  if (!store.items.length) return store;
  store.items = [];
  return saveRefreshHistory(store, store._revision, userId);
}


function loadSettings() {
  ensureDataDir(); const parsed = storeExists(SETTINGS_FILE) ? readJsonWithBackup(SETTINGS_FILE, { _revision: 0 }) : { _revision: 0 };
  return { ...(parsed && typeof parsed === 'object' ? parsed : {}), _revision: revisionOf(parsed) };
}
function saveSettings(settings, expectedRevision = null) { ensureDataDir(); return saveRevisioned(SETTINGS_FILE, settings, { _revision: 0 }, expectedRevision, 'Ayarlar'); }

function getUserSourceFolder(userId, fallback = null) {
  const settings = loadSettings();
  const id = String(userId || 'moderator');
  const mapped = settings.sourceFolders && typeof settings.sourceFolders === 'object' ? settings.sourceFolders[id] : null;
  if (mapped) return String(mapped);
  if (id === 'moderator' && settings.sourceFolder) return String(settings.sourceFolder);
  return fallback ? String(fallback) : null;
}
function setUserSourceFolder(userId, folder, expectedRevision = null) {
  const settings = loadSettings();
  const id = String(userId || 'moderator');
  const value = String(folder || '').trim();
  settings.sourceFolders = settings.sourceFolders && typeof settings.sourceFolders === 'object' ? { ...settings.sourceFolders } : {};
  if (value) settings.sourceFolders[id] = value; else delete settings.sourceFolders[id];
  // Keep the pre-v2.92 moderator setting readable by older packages and restored backups.
  if (id === 'moderator') settings.sourceFolder = value || null;
  return saveSettings(settings, expectedRevision == null ? settings._revision : expectedRevision);
}

// --- Veri modeli bağlantıları -----------------------------------------------
// Kaynak Excel dosyalarındaki pivotların bağlı olduğu SSAS Tabular modelleri.
// Bu kayıtlar ana Yenile akışının ve INTAKE raporunun doğrudan veri kaynağıdır;
// aktif ASAS, Antrepo ve INTAKE rolleri bu bağlantı ayarları üzerinden sorgulanır.
const MODEL_CONNECTION_LIMIT = 20;
const MODEL_CONNECTION_DEFAULT_SEASONS = Object.freeze(['W6', 'W7', 'S6', 'S7']);
const MODEL_CONNECTION_DEFAULT_INTAKE = Object.freeze({
  id: 'mc_intake_default', name: 'INTAKE', server: 'lcwtabular_s20',
  catalog: 'WSSI Intake Raporu4', role: 'intake', refreshEnabled: true,
});

function normalizeCustomFields(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map(entry => {
    const header = String((entry && entry.header) || (typeof entry === 'string' ? entry : '') || '').trim().slice(0, 200);
    return header ? { header, custom: true } : null;
  }).filter(entry => {
    if (!entry) return false;
    const key = entry.header.toLocaleLowerCase('tr');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

// CP tablosuna veri modelinden eklenen salt-okunur sütunlar. Her bağlantı kendi
// seçtiği model alanlarını taşır; DAX çıktısındaki iç başlık kullanıcı etiketinden
// bağımsız ve kararlıdır, böylece sütun adı sonradan değiştirilebilir.
function normalizeCpModelColumns(raw) {
  const seen = new Set(), labels = new Set(), out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const item = value && typeof value === 'object' ? value : {};
    const id = String(item.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      || `cpx_${Math.random().toString(36).slice(2, 10)}`;
    const label = String(item.label == null ? '' : item.label).replace(/\s+/g, ' ').trim().slice(0, 120);
    const entry = modelFields.normalizeMappingEntry(item.source || item, item.table || '');
    const key = id.toLowerCase(), labelKey = label.toLocaleLowerCase('tr');
    if (!label || !entry || !entry.name || seen.has(key) || labels.has(labelKey)) continue;
    seen.add(key); labels.add(labelKey);
    out.push({
      id, label, header: `__CPX_${id}`,
      table: entry.table || '', name: entry.name, kind: entry.kind === 'measure' ? 'measure' : 'column',
      folder: entry.folder || '',
      // v7.42: tablo üstündeki başlık bandı (kullanıcı seçer). Boşsa arayüz eski
      // varsayılanı "Database"i kullanır; burada uydurma değer yazılmaz (§152).
      group: String(item.group == null ? '' : item.group).replace(/\s+/g, ' ').trim().slice(0, 40),
    });
    if (out.length >= 40) break;
  }
  return out;
}

// Alan eşlemesi: { 'Uygulamanın beklediği başlık': {table,name,kind,folder} }
// Eski düz metin kayıtları da okunur. Nesneleri String(...) ile dönüştürmek
// "[object Object]" bozulmasına yol açtığı için bütün girdiler ortak normalizatörden
// geçirilir ve yapılandırılmış biçimde saklanır.
function normalizeMapping(raw, fallbackTable = '') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [header, column] of Object.entries(source)) {
    const key = String(header || '').trim().slice(0, 200);
    const entry = modelFields.normalizeMappingEntry(column, fallbackTable);
    if (key && entry && entry.name) out[key] = entry;
    if (Object.keys(out).length >= 100) break;
  }
  return out;
}

function normalizeModelConnection(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const id = String(item.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    || `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const legacyFabricRole = item.role === 'fabric';
  const role = legacyFabricRole ? 'fabric' : (['antrepo', 'intake', 'custom'].includes(item.role) ? item.role : 'asas');
  const horizon = modelHorizon.normalizeHorizon(item.horizon);
  // One-time v3.48 migration. Legacy untouched ASAS connections had no horizon,
  // so Refresh pulled the entire model. Apply the compact default only once and
  // only when the user has not already configured seasons or dates. The marker
  // lets a user deliberately clear the seasons later without them reappearing.
  /* Park edilmiş bağlantılar kapsam normalizasyonundan ÖNCE okunur: kullanıcının
     bilerek kapattığı modülü normalizeScopes'un "eski kayıt kurtarma" dalları
     geri yaratmasın (ör. IAS → Siparişler). */
  const parkedBindings = legacyFabricRole ? [] : bindingWriter.normalizeParked(item.parkedBindings);
  const defaultSeasonsApplied = item.defaultSeasonsApplied === true;
  if (role === 'asas' && !defaultSeasonsApplied && !horizon.seasons.length && !horizon.dateStart && !horizon.dateEnd) {
    horizon.seasons = [...MODEL_CONNECTION_DEFAULT_SEASONS];
  }
  return {
    id,
    name: text(item.name, 80),
    server: text(item.server, 128),
    catalog: text(item.catalog, 128),
    engine: text(item.engine, 40) || (role === 'custom' ? 'relational-sql' : ''),
    connector: item.connector && typeof item.connector === 'object' ? {
      kind: text(item.connector.kind, 40), family: text(item.connector.family, 80),
      provider: text(item.connector.provider, 240), driver: text(item.connector.driver, 240),
      server: text(item.connector.server, 512), port: Number(item.connector.port) > 0 ? Number(item.connector.port) : null,
      database: text(item.connector.database, 240), dsn: text(item.connector.dsn, 240),
      serviceName: text(item.connector.serviceName, 240), sid: text(item.connector.sid, 240),
      auth: item.connector.auth && typeof item.connector.auth === 'object' ? {
        type: text(item.connector.auth.type, 40), username: text(item.connector.auth.username, 300),
        passwordRequired: Boolean(item.connector.auth.passwordRequired), officeManaged: Boolean(item.connector.auth.officeManaged),
      } : { type: 'unknown', username: '', passwordRequired: false, officeManaged: false },
      options: item.connector.options && typeof item.connector.options === 'object' ? {
        encrypt: text(item.connector.options.encrypt, 20), trustServerCertificate: text(item.connector.options.trustServerCertificate, 20),
        applicationName: text(item.connector.options.applicationName, 120),
      } : {},
    } : null,
    discovery: item.discovery && typeof item.discovery === 'object' ? {
      origin: text(item.discovery.origin, 40), workbookName: text(item.discovery.workbookName, 240),
      connectionName: text(item.discovery.connectionName, 180), importedAt: text(item.discovery.importedAt, 40),
    } : null,
    query: String(item.query == null ? '' : item.query).slice(0, 20000),
    format: item.format === 'json' ? 'json' : 'csv',
    outputName: text(item.outputName, 120).replace(/[\\/:*?"<>|]/g, ''),
    // 'auto' → sorgu ufuk + alan eşlemesinden üretilir; 'manual' → yazılan DAX çalışır.
    mode: item.mode === 'manual' ? 'manual' : 'auto',
    // Hangi sayfa ailesini besliyor: asas (CP/Backlog/LFL) veya antrepo.
    role,
    // Ayrı Fabric rolü v4.72'de kaldırıldı. Eski kayıt silinmeden okunur ancak
    // hiçbir yenileme akışına katılmaz; kullanıcı bağlantı ekranını kaydettiğinde
    // arayüzde gizlenen bu eski kayıt temizlenir.
    refreshEnabled: legacyFabricRole ? false : item.refreshEnabled !== false,
    defaultSeasonsApplied: true,
    // Optional ASAS fields are discovered once during upgrade. Persisting this
    // marker prevents the two schema DMV queries from repeating every refresh
    // when the source model legitimately does not contain those optional fields.
    mappingEnhancementScanVersion: Math.max(0, Number(item.mappingEnhancementScanVersion) || 0),
    horizon,
    // Hedef başına ufuk. Boşsa mevcut tek ufuktan üretilir; eski kayıtlar aynen çalışır.
    scopes: legacyFabricRole ? [] : modelScopes.normalizeScopes(
      item.scopes, role, horizon, modelHorizon.normalizeHorizon,
      parkedBindings.map(entry => entry.moduleId)),
    /* v7.81 — PARK EDİLMİŞ MODÜL BAĞLANTILARI.
       Bir modül bağlantısı ayrı bir kayıt değil, bir kapsamın targets[]
       dizisindeki eleman. Son hedefi de çıkarınca kapsam kayboluyor ve onunla
       birlikte o kapsamın FİLTRESİ de. Kapatılan bağlantının kapsam kimliği,
       adı ve ufku burada saklanır; tekrar açıldığında aynen geri gelir.
       Eski kayıtlarda bu alan yoktur ve boş dizi olur — davranış değişmez. */
    parkedBindings,
    mapping: normalizeMapping(item.mapping, item.horizon && item.horizon.table),
    // Katalogda olmayan, kullanıcının elle eklediği alanlar. Antrepo rolünde "Sezon"
    // gibi rol kataloğunda bulunmayan sütunları eşleyebilmek için gerekli.
    customFields: normalizeCustomFields(item.customFields),
    // CP Columns panelinden eklenen veri-modeli sütunları.
    cpColumns: normalizeCpModelColumns(item.cpColumns),
    lastRun: item.lastRun && typeof item.lastRun === 'object' ? {
      at: text(item.lastRun.at, 40),
      ok: Boolean(item.lastRun.ok),
      rowCount: Number(item.lastRun.rowCount) || 0,
      elapsedMs: Number(item.lastRun.elapsedMs) || 0,
      provider: text(item.lastRun.provider, 20),
      outFile: text(item.lastRun.outFile, 400),
      error: text(item.lastRun.error, 400),
    } : null,
  };
}
function normalizeModelConnections(list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeModelConnection)
    .filter(item => item.server && item.catalog)
    .slice(0, MODEL_CONNECTION_LIMIT);
  if (!items.some(item => item.role === 'intake')) {
    if (items.length >= MODEL_CONNECTION_LIMIT) items.pop();
    items.push(normalizeModelConnection(MODEL_CONNECTION_DEFAULT_INTAKE));
  }
  // Refresh için her rolde yalnız bir aktif bağlantı bırakılır. Kullanıcı birden
  // fazla eski kayıtla yükseltme yaptıysa listedeki ilk kayıt güvenli varsayılandır.
  const activeRoles = new Set();
  items.forEach(item => {
    if (!item.refreshEnabled || item.role === 'custom') return;
    if (activeRoles.has(item.role)) item.refreshEnabled = false;
    else activeRoles.add(item.role);
  });
  return items;
}
function loadModelConnections() {
  const settings = loadSettings();
  const revision = Number(settings._revisions && settings._revisions.modelConnections) || 0;
  // Yeni kurulumlarda INTAKE veritabanı bağlantısı ayar ekranında hazır görünür.
  // Kullanıcı Kaydet ile kendi değerlerini yazdığında bu varsayılan kayıt tamamen
  // normal modelConnections dizisiyle değiştirilir; Excel kaynağına başvurulmaz.
  const raw = Array.isArray(settings.modelConnections)
    ? settings.modelConnections
    : [MODEL_CONNECTION_DEFAULT_INTAKE];
  return { items: normalizeModelConnections(raw), revision };
}
function replaceModelConnections(items, expectedRevision = null) {
  const settings = loadSettings();
  settings._revisions = settings._revisions && typeof settings._revisions === 'object' ? { ...settings._revisions } : {};
  const current = Number(settings._revisions.modelConnections) || 0;
  const wanted = expectedRevision == null ? null : Number(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Veri modeli bağlantıları', wanted, current, 'modelConnections');
  settings.modelConnections = normalizeModelConnections(items);
  settings._revisions.modelConnections = current + 1;
  const saved = saveSettings(settings, settings._revision);
  return { items: saved.modelConnections, revision: saved._revisions.modelConnections };
}
/* YENİLEME GRUPLARI (v7.81).
   Tanım ORTAKtır: "Buying Core" ekip genelinde aynı şeyi ifade etmeli.
   Çalıştırma ise kullanıcı başına olur — yenileme zaten öyle çalışıyor
   (her kullanıcı kendi Horizon'uyla kendi anlık görüntüsünü çeker). */
function loadRefreshGroups() {
  const settings = loadSettings();
  const revision = Number(settings._revisions && settings._revisions.refreshGroups) || 0;
  return { items: refreshGroups.normalizeGroups(settings.refreshGroups), revision };
}
function replaceRefreshGroups(items, expectedRevision = null) {
  const settings = loadSettings();
  settings._revisions = settings._revisions && typeof settings._revisions === 'object' ? { ...settings._revisions } : {};
  const current = Number(settings._revisions.refreshGroups) || 0;
  const wanted = expectedRevision == null ? null : Number(expectedRevision);
  if (wanted != null && wanted !== current) throw new RevisionConflictError('Yenileme grupları', wanted, current, 'refreshGroups');
  settings.refreshGroups = refreshGroups.normalizeGroups(items);
  settings._revisions.refreshGroups = current + 1;
  const saved = saveSettings(settings, settings._revision);
  return { items: saved.refreshGroups, revision: saved._revisions.refreshGroups };
}

// Bir bağlantının son çalıştırma bilgisini yazar. Kullanıcı düzenlemesi değil,
// çalıştırma sonucu olduğu için revizyon çakışması aranmaz.
function recordModelConnectionRun(id, lastRun) {
  const settings = loadSettings();
  const items = normalizeModelConnections(settings.modelConnections);
  const index = items.findIndex(item => item.id === String(id));
  if (index < 0) return null;
  items[index] = normalizeModelConnection({ ...items[index], lastRun });
  settings.modelConnections = items;
  const saved = saveSettings(settings, settings._revision);
  return saved.modelConnections[index];
}

function defaultProfileStore() {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION, kind: 'profile', userId: null,
    favoriteByPage: {}, lastUsedByPage: {}, favoriteId: null, items: [], _revision: 0,
  };
}
function scopedProfileFile(baseFile, userId) {
  const safe = String(userId || 'shared').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'shared';
  if (!userId) return baseFile;
  return path.join(DATA_DIR, 'user-profiles', safe, path.basename(baseFile));
}
function loadProfileFile(file, userId = null, kind = 'profile') {
  ensureDataDir();
  const parsed = storeExists(file) ? readJsonWithBackup(file, defaultProfileStore) : defaultProfileStore();
  const store = normalizeProfileStore(parsed, { userId, kind });
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const needsMigration = parsed.schemaVersion !== PROFILE_SCHEMA_VERSION
    || parsed.kind !== kind
    || !parsed.favoriteByPage || !parsed.lastUsedByPage
    || rawItems.length !== store.items.length
    || store.items.some(item => item.schemaVersion !== PROFILE_SCHEMA_VERSION
      || item.userId !== (userId || item.userId || null)
      || item.moduleId !== pageOf(item) || item.tableId !== pageOf(item));
  if (fs.existsSync(file) && needsMigration) {
    const saved = revisioned(store, revisionOf(parsed) + 1);
    atomicWriteJson(file, saved);
    return { ...store, _revision: revisionOf(saved), _updatedAt: saved._updatedAt || null };
  }
  return { ...store, _revision: revisionOf(parsed), _updatedAt: parsed._updatedAt || null };
}
function saveProfileFile(file, data, expectedRevision = null, storeName = 'Profil verileri', userId = null, kind = 'profile') {
  const normalized = normalizeProfileStore(data, { userId, kind });
  return saveRevisioned(file, normalized, defaultProfileStore, expectedRevision, storeName);
}
function addProfile(file, name, data, expectedRevision, storeName, userId = null, kind = 'profile') {
  const store = loadProfileFile(file, userId, kind); assertRevision(storeName, store, expectedRevision);
  const now = new Date().toISOString();
  const page = pageOf({ data });
  const id = 'p' + Date.now() + Math.round(Math.random() * 1000);
  const next = normalizeProfileStore({ ...store, items: [...store.items, {
    id, name, createdAt: now, updatedAt: now, userId, moduleId: page || null, tableId: page || null,
    schemaVersion: PROFILE_SCHEMA_VERSION, data,
  }] }, { userId, kind });
  return saveProfileFile(file, next, store._revision, storeName, userId, kind);
}
function deleteProfile(file, id, expectedRevision, storeName, userId = null, kind = 'profile') {
  const store = loadProfileFile(file, userId, kind); assertRevision(storeName, store, expectedRevision);
  const next = removeProfile(store, id);
  return saveProfileFile(file, next, store._revision, storeName, userId, kind);
}
function setFavoriteProfile(file, id, expectedRevision, storeName, userId = null, kind = 'profile') {
  const store = loadProfileFile(file, userId, kind); assertRevision(storeName, store, expectedRevision);
  const next = setFavorite(store, id);
  return saveProfileFile(file, next, store._revision, storeName, userId, kind);
}
function markUsedProfile(file, id, expectedRevision, storeName, userId = null, kind = 'profile') {
  const store = loadProfileFile(file, userId, kind); assertRevision(storeName, store, expectedRevision);
  const next = markUsed(store, id);
  return saveProfileFile(file, next, store._revision, storeName, userId, kind);
}
function updateProfile(file, id, data, expectedRevision, storeName, userId = null, kind = 'profile', name = null) {
  const store = loadProfileFile(file, userId, kind); assertRevision(storeName, store, expectedRevision);
  const item = store.items.find(it => it.id === id); if (!item) throw new Error('Profil bulunamadı: ' + id);
  const now = new Date().toISOString();
  const nextItems = store.items.map(candidate => candidate.id === id
    ? { ...candidate, ...(name != null && String(name).trim() ? { name: String(name).trim() } : {}), data, updatedAt: now, schemaVersion: PROFILE_SCHEMA_VERSION }
    : candidate);
  const next = normalizeProfileStore({ ...store, items: nextItems }, { userId, kind });
  return saveProfileFile(file, next, store._revision, storeName, userId, kind);
}


/* ===================================================================
   v7.23 — NAKLİYE KIYASLAMASI ARTIK KULLANICIYA ÖZGÜ

   Kullanıcı talebi: "Overview, OAB, Koleksiyon, Orders ve CP sayfaları
   dışındaki tüm sayfalar kullanıcıya özgü alanlardır. ... shipping
   comparisonlar ... her kullanıcının ekranında özel olmalıdır, diğer
   kullanıcılar görmemeli ve ekranlarına yansımamalıdır."

   Önceki hâl: TEK paylaşılan dosya (shipping-comparison.json). Bu hem
   gizlilik talebine aykırıydı hem de 100 kullanıcılı senaryoda tek dosya
   üzerinde revizyon çakışması üretiyordu.

   ESKİ VERİ NE OLACAK? (§142 — veri kaybı sıfır tolerans)
   Paylaşılan dosyadaki satırların SAHİBİ yok: dosya kimin hangi satırı
   eklediğini hiç yazmamış. Uydurma sahiplik ATAMIYORUZ. Bunun yerine:

     · Eski paylaşılan dosya SALT OKUNUR bir "devralınan" kova olur; bir daha
       hiç yazılmaz (geri dönüş için olduğu gibi durur).
     · Her kullanıcı okumada kendi satırlarını + henüz devralmadıysa eski
       satırları görür — yani kimse ekranındaki veriyi kaybetmez.
     · Kullanıcı ilk yazma işlemini yaptığı anda eski satırlar KENDİ dosyasına
       kopyalanır (devralma) ve o andan sonra yalnız kendi kopyasını düzenler.
       Böylece bir kullanıcının düzenlemesi diğerininkini değiştirmez.
   =================================================================== */
function defaultShipping() { return { rows: [], legacyAdopted: false, _revision: 0 }; }
function shippingFileFor(userId) { return scopedProfileFile(SHIP_FILE, userId); }
function readShippingFile(file, fallbackDefault) {
  ensureDataDir();
  const parsed = storeExists(file) ? readJsonWithBackup(file, fallbackDefault) : fallbackDefault();
  return {
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    legacyAdopted: Boolean(parsed.legacyAdopted),
    _revision: revisionOf(parsed),
    _updatedAt: parsed._updatedAt || null,
  };
}
// Devralınan (eski paylaşılan) satırlar. Bu dosya v7.23'ten sonra YAZILMAZ.
function legacyShippingRows() {
  if (!fs.existsSync(SHIP_FILE)) return [];
  const parsed = readJsonWithBackup(SHIP_FILE, defaultShipping);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}
function loadShipping(userId) {
  // userId verilmezse eski davranış (paylaşılan dosya) korunur; çağıranların
  // hepsi kullanıcı geçirir, bu yalnız araç/gerilemeye karşı emniyet supabı.
  if (!userId) return readShippingFile(SHIP_FILE, defaultShipping);
  const personal = readShippingFile(shippingFileFor(userId), defaultShipping);
  if (personal.legacyAdopted) return personal;
  const legacy = legacyShippingRows();
  if (!legacy.length) return personal;
  const own = new Set(personal.rows.map(row => row && row._shipId));
  const inherited = legacy.filter(row => row && !own.has(row._shipId)).map(row => ({ ...row, _inherited: true }));
  return { ...personal, rows: inherited.concat(personal.rows) };
}
function saveShipping(data, expectedRevision = null, userId = null) {
  const file = userId ? shippingFileFor(userId) : SHIP_FILE;
  const rows = (data.rows || []).map(({ _inherited, ...row }) => row);
  return saveRevisioned(file, { rows, legacyAdopted: userId ? true : Boolean(data.legacyAdopted) }, defaultShipping, expectedRevision, 'Nakliye kıyaslama');
}
function shippingColourOptions(record) {
  const row = record && typeof record === 'object' ? record : {};
  const clean = value => String(value == null ? '' : value).trim();
  const source = Array.isArray(row._colourOptions)
    ? row._colourOptions
    : [{ colour: row.colour, colorCode: row.colorCode ?? row.colourCode }];
  const seen = new Set(), options = [];
  source.forEach(item => {
    const colour = clean(item && item.colour);
    const colorCode = clean(item && (item.colorCode ?? item.colourCode));
    const identity = colorCode || colour;
    if (!identity) return;
    const key = identity.toLocaleUpperCase('tr-TR');
    if (seen.has(key)) return;
    seen.add(key); options.push({ colour, colorCode });
  });
  return options;
}
function mergeShippingColourOptions(target, incoming) {
  if (!target) return target;
  const options = [], seen = new Map();
  [...shippingColourOptions(target), ...shippingColourOptions(incoming)].forEach(option => {
    const identity = option.colorCode || option.colour;
    const key = identity.toLocaleUpperCase('tr-TR');
    const existing = seen.get(key);
    if (existing) {
      if (!existing.colour && option.colour) existing.colour = option.colour;
      if (!existing.colorCode && option.colorCode) existing.colorCode = option.colorCode;
      return;
    }
    seen.set(key, option); options.push(option);
  });
  if (options.length) {
    target._colourOptions = options;
    target.colour = options.map(option => option.colour).join(', ');
    target.colorCode = options.map(option => option.colorCode).join(', ');
  }
  return target;
}
function shippingModelKey(record) {
  const row = record && typeof record === 'object' ? record : {};
  const normalize = value => String(value == null ? '' : value).trim().toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ç/g, 'C').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/Ğ/g, 'G');
  const explicit = normalize(row._modelKey);
  if (explicit) return explicit;
  const plm = normalize(row.plm ?? row.plmId ?? row['PLM ID']);
  if (plm) return `PLM:${plm}`;
  const model = normalize(row.styleName ?? row.modelName ?? row.modelKod ?? row.model);
  if (model) return `MODEL:${model}\u001f${normalize(row.season)}`;
  const rawOrder = row.orderCode ?? row['Order Code'] ?? row.ocode ?? row.siparisKod ?? row._sourceOrderCode;
  const order = Number(String(rawOrder == null ? '' : rawOrder).replace(/\./g, '').trim());
  return Number.isFinite(order) ? `ORDER:${order}` : '';
}
function addShippingRows(newRows, expectedRevision = null, userId = null) {
  const store = loadShipping(userId); assertRevision('Nakliye kıyaslama', store, expectedRevision);
  const existingKeys = new Set(store.rows.map(shippingModelKey).filter(Boolean));
  const existingByKey = new Map(store.rows.map(row => [shippingModelKey(row), row]).filter(([key]) => key));
  const added = [], skipped = [];
  (Array.isArray(newRows) ? newRows : []).forEach(row => {
    const key = shippingModelKey(row);
    if (key && existingKeys.has(key)) {
      mergeShippingColourOptions(existingByKey.get(key), row);
      skipped.push(key); return;
    }
    if (key) existingKeys.add(key);
    const addedRow = { ...row, ...(key ? { _modelKey: key } : {}), _shipId: 's' + Date.now() + Math.round(Math.random() * 100000) };
    mergeShippingColourOptions(addedRow, row);
    added.push(addedRow);
    if (key) existingByKey.set(key, addedRow);
  });
  store.rows.push(...added);
  const saved = saveShipping(store, store._revision, userId);
  return { ...saved, addedCount: added.length, skippedCount: skipped.length, skippedModelKeys: skipped };
}
function patchShippingRow(shipId, patch, expectedRevision = null, userId = null) {
  const store = loadShipping(userId); assertRevision('Nakliye kıyaslama', store, expectedRevision);
  const row = store.rows.find(r => r._shipId === shipId);
  if (!row) throw new Error('Satır bulunamadı: ' + shipId);
  Object.assign(row, patch);
  return saveShipping(store, store._revision, userId);
}
function deleteShippingRows(shipIds, expectedRevision = null, userId = null) {
  const store = loadShipping(userId); assertRevision('Nakliye kıyaslama', store, expectedRevision);
  const idSet = new Set(shipIds);
  store.rows = store.rows.filter(r => !idSet.has(r._shipId));
  return saveShipping(store, store._revision, userId);
}

function defaultOpenCostings() { return { items: [], _revision: 0 }; }
function cloneJson(value) { return JSON.parse(JSON.stringify(value == null ? {} : value)); }
function loadOpenCostings() { ensureDataDir(); const parsed = storeExists(OPEN_COSTING_FILE) ? readJsonWithBackup(OPEN_COSTING_FILE, defaultOpenCostings) : defaultOpenCostings(); return { items: Array.isArray(parsed.items) ? parsed.items : [], _revision: revisionOf(parsed), _updatedAt: parsed._updatedAt || null }; }
function saveOpenCostings(store, expectedRevision = null) { return saveRevisioned(OPEN_COSTING_FILE, { items: store.items || [] }, defaultOpenCostings, expectedRevision, 'Ön maliyet'); }
function createOpenCosting(record, expectedRevision = null) { const store = loadOpenCostings(); assertRevision('Ön maliyet', store, expectedRevision); const now = new Date().toISOString(); const item = { ...cloneJson(record), id: 'oc-' + Date.now() + '-' + Math.round(Math.random() * 100000), createdAt: now, updatedAt: now }; store.items.unshift(item); const saved = saveOpenCostings(store, store._revision); return { items: saved.items, item, _revision: saved._revision }; }
function updateOpenCosting(id, record, expectedRevision = null) { const store = loadOpenCostings(); assertRevision('Ön maliyet', store, expectedRevision); const index = store.items.findIndex(item => item.id === id); if (index < 0) throw new Error('Açık maliyet kaydı bulunamadı: ' + id); const previous = store.items[index]; const item = { ...cloneJson(record), id, createdAt: previous.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() }; store.items[index] = item; const saved = saveOpenCostings(store, store._revision); return { items: saved.items, item, _revision: saved._revision }; }
function deleteOpenCosting(id, expectedRevision = null) { const store = loadOpenCostings(); assertRevision('Ön maliyet', store, expectedRevision); store.items = store.items.filter(item => item.id !== id); const saved = saveOpenCostings(store, store._revision); return { items: saved.items, _revision: saved._revision }; }

function defaultFx() { return { base: 'USD', currencies: [], months: {}, updatedAt: null, sourceFile: null, sourceType: null, sourceModifiedAt: null, _revision: 0 }; }
function fxHasValues(value) {
  return Boolean(value && typeof value === 'object' && Object.values(value.months || {}).some(rates => rates && Object.keys(rates).length));
}
function legacyFxFiles() {
  const files = [FX_FILE];
  try {
    for (const entry of fs.existsSync(USER_FX_DATA_DIR) ? fs.readdirSync(USER_FX_DATA_DIR, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) files.push(path.join(USER_FX_DATA_DIR, entry.name, path.basename(FX_FILE)));
    }
  } catch (_) {}
  return [...new Set(files)].filter(file => fs.existsSync(file));
}
function migrateLegacyFxToShared() {
  // Bir shared dosya/delta kaydı varsa asla eski yerel kopyalarla üzerine yazma.
  if (storeExists(LEGACY_FX_FILE)) return;
  const candidates = legacyFxFiles().map(file => {
    try { return { file, value: readJsonWithBackup(file, defaultFx) }; } catch (_) { return null; }
  }).filter(item => item && fxHasValues(item.value));
  if (!candidates.length) return;
  // Aynı tarihli dosyalarda yol sırası sabittir; eski veri kaybı yaratmadan
  // farklı ay/döviz hücrelerini birleştirir, çakışan hücrede en yeni kayıt kazanır.
  candidates.sort((a, b) => {
    const at = Date.parse(a.value.updatedAt || a.value._updatedAt || '') || 0;
    const bt = Date.parse(b.value.updatedAt || b.value._updatedAt || '') || 0;
    return at - bt || a.file.localeCompare(b.file, 'en');
  });
  const merged = defaultFx();
  for (const { value } of candidates) {
    merged.base = typeof value.base === 'string' && value.base ? value.base : merged.base;
    merged.currencies = [...new Set([...merged.currencies, ...(Array.isArray(value.currencies) ? value.currencies.filter(Boolean) : [])])];
    for (const [month, rates] of Object.entries(value.months || {})) {
      if (!rates || typeof rates !== 'object') continue;
      merged.months[month] = { ...(merged.months[month] || {}), ...rates };
    }
    merged.updatedAt = value.updatedAt || merged.updatedAt;
    merged.sourceFile = value.sourceFile || merged.sourceFile;
    merged.sourceType = value.sourceType || merged.sourceType;
    merged.sourceModifiedAt = value.sourceModifiedAt || merged.sourceModifiedAt;
  }
  saveRevisioned(LEGACY_FX_FILE, merged, defaultFx, null, 'Döviz kurları');
}
function loadFx(_userId = null) {
  ensureDataDir(); ensureFxDir(); migrateLegacyFxToShared();
  const parsed = storeExists(LEGACY_FX_FILE) ? readJsonWithBackup(LEGACY_FX_FILE, defaultFx) : defaultFx();
  return { base: typeof parsed.base === 'string' && parsed.base ? parsed.base : 'USD', currencies: Array.isArray(parsed.currencies) ? parsed.currencies : [], months: parsed.months && typeof parsed.months === 'object' ? parsed.months : {}, updatedAt: parsed.updatedAt || null, sourceFile: parsed.sourceFile || null, sourceType: parsed.sourceType || null, sourceModifiedAt: parsed.sourceModifiedAt || null, _revision: revisionOf(parsed), _updatedAt: parsed._updatedAt || null };
}
function saveFx(data, expectedRevision = null, _userId = null) {
  ensureDataDir(); ensureFxDir();
  const clean = { base: typeof data.base === 'string' && data.base ? data.base : 'USD', currencies: Array.isArray(data.currencies) ? [...new Set(data.currencies.filter(Boolean))] : [], months: data.months && typeof data.months === 'object' ? data.months : {}, updatedAt: data.updatedAt || new Date().toISOString(), sourceFile: data.sourceFile || null, sourceType: data.sourceType || null, sourceModifiedAt: data.sourceModifiedAt || null };
  return saveRevisioned(LEGACY_FX_FILE, clean, defaultFx, expectedRevision, 'Döviz kurları');
}
function fxMonthResolved(store, monthKey) { const months = store.months || {}; if (months[monthKey]) return { month: monthKey, rates: months[monthKey], exact: true }; const keys = Object.keys(months).filter(k => months[k] && Object.keys(months[k]).length).sort(); if (!keys.length) return { month: null, rates: {}, exact: false }; const prev = keys.filter(k => k <= monthKey).pop(); const chosen = prev || keys[0]; return { month: chosen, rates: months[chosen] || {}, exact: false }; }

// Profile APIs accepted a shared-store signature before v2.91. Keep those overloads so
// existing integrations and restored backups continue to work while new UI calls are scoped
// by the selected user ID.
function profileArgs(args, operation) {
  const values = Array.from(args);
  if (operation === 'add') {
    return values.length >= 4
      ? { userId: values[0], name: values[1], data: values[2], revision: values[3] }
      : { userId: null, name: values[0], data: values[1], revision: values[2] };
  }
  if (operation === 'update') {
    return values.length >= 4
      ? { userId: values[0], id: values[1], data: values[2], revision: values[3], name: values[4] }
      : { userId: null, id: values[0], data: values[1], revision: values[2], name: values[3] };
  }
  return values.length >= 3
    ? { userId: values[0], id: values[1], revision: values[2] }
    : { userId: null, id: values[0], revision: values[1] };
}
/* v7.81 — Profil türü dosyadan çözülür. Eskiden beş ayrı yerde
   "VIEWS_FILE ? 'view' : 'filter'" sabit kodluydu; üçüncü tür (horizon
   şablonu) eklenince hepsi sessizce 'filter' derdi ve şablonlar filtre
   profilleriyle aynı kovaya düşerdi. */
function profileKindOf(baseFile) {
  if (baseFile === VIEWS_FILE) return 'view';
  if (baseFile === HORIZON_TEMPLATES_FILE) return 'horizonTemplate';
  return 'filter';
}
function addScopedProfile(baseFile, storeName, args) {
  const a = profileArgs(args, 'add');
  const kind = profileKindOf(baseFile);
  return addProfile(scopedProfileFile(baseFile, a.userId), a.name, a.data, a.revision, storeName, a.userId, kind);
}
function updateScopedProfile(baseFile, storeName, args) {
  const a = profileArgs(args, 'update');
  const kind = profileKindOf(baseFile);
  return updateProfile(scopedProfileFile(baseFile, a.userId), a.id, a.data, a.revision, storeName, a.userId, kind, a.name);
}
function deleteScopedProfile(baseFile, storeName, args) {
  const a = profileArgs(args, 'id');
  const kind = profileKindOf(baseFile);
  return deleteProfile(scopedProfileFile(baseFile, a.userId), a.id, a.revision, storeName, a.userId, kind);
}
function favoriteScopedProfile(baseFile, storeName, args) {
  const a = profileArgs(args, 'id');
  const kind = profileKindOf(baseFile);
  return setFavoriteProfile(scopedProfileFile(baseFile, a.userId), a.id, a.revision, storeName, a.userId, kind);
}
function usedScopedProfile(baseFile, storeName, args) {
  const a = profileArgs(args, 'id');
  const kind = profileKindOf(baseFile);
  return markUsedProfile(scopedProfileFile(baseFile, a.userId), a.id, a.revision, storeName, a.userId, kind);
}


/* KİŞİSEL BACKUP SNAPSHOT / RESTORE
   Yalnız kullanıcıya özel store'lar dahildir. Ortak FX, ayarlar, business
   rules ve diğer paylaşılan veriler burada özellikle yoktur. */
function userBackupStoreSnapshot(userId) {
  return {
    views: loadViewsForBackup(userId),
    filters: loadFiltersForBackup(userId),
    shipping: loadShipping(userId),
    refreshHistory: loadRefreshHistory(userId),
  };
}
function loadViewsForBackup(userId) {
  return loadProfileFile(scopedProfileFile(VIEWS_FILE, userId), userId, 'view');
}
function loadFiltersForBackup(userId) {
  return loadProfileFile(scopedProfileFile(FILTERS_FILE, userId), userId, 'filter');
}
function restoreUserBackupStores(userId, snapshot = {}) {
  const result = {};
  if (snapshot.views) {
    const current = loadViewsForBackup(userId);
    result.views = saveProfileFile(scopedProfileFile(VIEWS_FILE, userId), snapshot.views, current._revision, 'Görünümler', userId, 'view');
  }
  if (snapshot.filters) {
    const current = loadFiltersForBackup(userId);
    result.filters = saveProfileFile(scopedProfileFile(FILTERS_FILE, userId), snapshot.filters, current._revision, 'Filtre profilleri', userId, 'filter');
  }
  if (snapshot.shipping) {
    const current = loadShipping(userId);
    result.shipping = saveShipping(snapshot.shipping, current._revision, userId);
  }
  if (snapshot.refreshHistory) {
    const current = loadRefreshHistory(userId);
    result.refreshHistory = saveRefreshHistory(snapshot.refreshHistory, current._revision, userId);
  }
  return result;
}

/* Seçilebilir backup/restore: CP Tracker Ex-Factory revizyonları datemap içindeki
   yalnız "ex" alanıdır. Retail / In Store revizyonları ve diğer CP alanları
   aynı kayıtta bulunsa bile bu kapsam onları değiştirmez. */
function cpExFactoryRevisionSnapshot() {
  const ov = loadOverrides(), dates = {};
  for (const [key, record] of Object.entries(ov.datemap || {})) {
    const value = record && record.ex != null ? String(record.ex).trim() : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) dates[String(key)] = value;
  }
  return { schemaVersion: 1, dates };
}
async function restoreCpExFactoryRevisions(snapshot, { actor = null } = {}) {
  const source = snapshot && snapshot.dates && typeof snapshot.dates === 'object' ? snapshot.dates : {};
  const incoming = {};
  for (const [key, value] of Object.entries(source)) {
    const text = value == null ? '' : String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) && String(key).trim()) incoming[String(key)] = text;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ov = loadOverrides(), datemap = { ...(ov.datemap || {}) };
    const currentKeys = Object.keys(datemap).filter(key => datemap[key] && datemap[key].ex != null && String(datemap[key].ex).trim());
    const touched = new Set([...currentKeys, ...Object.keys(incoming)]);
    let cleared = 0, restored = 0;

    for (const key of touched) {
      const current = datemap[key] && typeof datemap[key] === 'object' ? { ...datemap[key] } : {};
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        if (current.ex !== incoming[key]) restored += 1;
        current.ex = incoming[key];
      } else if (Object.prototype.hasOwnProperty.call(current, 'ex')) {
        delete current.ex; cleared += 1;
      }
      if (Object.keys(current).length) datemap[key] = current;
      else delete datemap[key];
    }

    ov.datemap = datemap;
    ov._revisions = { ...(ov._revisions || {}) };
    ov._revisions.orders = (Number(ov._revisions.orders) || 0) + 1;
    try {
      const saved = saveOverrides(ov, ov._revision);
      // Shared Hub'ın kanonik cp-order kayıtlarına da TAM dates kaydını yaz:
      // böylece restore yalnız ex'i değiştirirken retail/mb alanları korunur.
      for (const key of touched) {
        await cpSharedStore.mirrorPatch(key, { dates: saved.datemap && saved.datemap[key] ? saved.datemap[key] : null }, { actor });
      }
      return { restored, cleared, total: Object.keys(incoming).length, revision: Number(saved._revisions && saved._revisions.orders) || 0 };
    } catch (error) {
      if (!(error instanceof RevisionConflictError) || attempt === 2) throw error;
    }
  }
  throw new RevisionConflictError('CP Ex-Factory revizyonları', 0, 0, 'orders');
}

module.exports = {
  attachDeltaStore, DELTA_STORE_COLLECTION, deltaStoreId, deltaSeedPayload, userBackupStoreSnapshot, restoreUserBackupStores, cpExFactoryRevisionSnapshot, restoreCpExFactoryRevisions,
  RevisionConflictError, revisionOf, expectedNumber, applyDatePatch, overrideWriteKey, normalizeLandedMultipliers,
  NOTE_AUTHOR_FIELDS, LEGACY_NOTE_AUTHOR_ID, LEGACY_NOTE_AUTHOR_NAME, backfillLegacyNoteAuthors,
  loadOverrides, saveOverrides, replacePricingRules, replaceTransitRules, replaceNonDtrManufacturers, replaceLandedMultipliers, replaceFreightRates, replaceAntrepoMatchRule, replaceAntrepoSourceMode, replaceAsasSourceMode, replaceLflSourceMode, replaceNoteColumnDefs, normalizeNoteColumnDefs, patchOrderOverride, patchOrderOverrides, patchPlmImageLinks, clearAllModelImageLinks, patchSuppFobOverrides, clearDeliveryOverrides, clearDeliveryOverridesForOrders, mergeCpUpdateOverrides, defaultOverrides, loadSettings, saveSettings,
  normalizeMapping, normalizeCustomFields, normalizeCpModelColumns, normalizeModelConnection, normalizeModelConnections, loadModelConnections, replaceModelConnections, recordModelConnectionRun, MODEL_CONNECTION_LIMIT, MODEL_CONNECTION_DEFAULT_SEASONS,
  loadRefreshGroups, replaceRefreshGroups,
  loadViews: userId => loadProfileFile(scopedProfileFile(VIEWS_FILE, userId), userId, 'view'),
  addView: function () { return addScopedProfile(VIEWS_FILE, 'Görünümler', arguments); },
  updateView: function () { return updateScopedProfile(VIEWS_FILE, 'Görünümler', arguments); },
  deleteView: function () { return deleteScopedProfile(VIEWS_FILE, 'Görünümler', arguments); },
  setFavoriteView: function () { return favoriteScopedProfile(VIEWS_FILE, 'Görünümler', arguments); },
  markUsedView: function () { return usedScopedProfile(VIEWS_FILE, 'Görünümler', arguments); },
  loadFilterProfiles: userId => loadProfileFile(scopedProfileFile(FILTERS_FILE, userId), userId, 'filter'),
  /* v7.81 — Horizon şablonları. userId verilirse kişisel, verilmezse
     PAYLAŞILAN depo okunur/yazılır; "paylaş" eylemi ortak depoya yazmaktır. */
  loadHorizonTemplates: userId => loadProfileFile(scopedProfileFile(HORIZON_TEMPLATES_FILE, userId), userId, 'horizonTemplate'),
  addHorizonTemplate: function () { return addScopedProfile(HORIZON_TEMPLATES_FILE, 'Horizon şablonları', arguments); },
  updateHorizonTemplate: function () { return updateScopedProfile(HORIZON_TEMPLATES_FILE, 'Horizon şablonları', arguments); },
  deleteHorizonTemplate: function () { return deleteScopedProfile(HORIZON_TEMPLATES_FILE, 'Horizon şablonları', arguments); },
  addFilterProfile: function () { return addScopedProfile(FILTERS_FILE, 'Filtre profilleri', arguments); },
  updateFilterProfile: function () { return updateScopedProfile(FILTERS_FILE, 'Filtre profilleri', arguments); },
  deleteFilterProfile: function () { return deleteScopedProfile(FILTERS_FILE, 'Filtre profilleri', arguments); },
  setFavoriteFilterProfile: function () { return favoriteScopedProfile(FILTERS_FILE, 'Filtre profilleri', arguments); },
  markUsedFilterProfile: function () { return usedScopedProfile(FILTERS_FILE, 'Filtre profilleri', arguments); },
  loadShipping, shippingModelKey, addShippingRows, patchShippingRow, deleteShippingRows,
  loadOpenCostings, createOpenCosting, updateOpenCosting, deleteOpenCosting,
  loadFx, saveFx, fxMonthResolved, loadRefreshHistory, addRefreshHistory, deleteRefreshHistory, clearRefreshHistory, REFRESH_HISTORY_LIMIT, REFRESH_HISTORY_DETAIL_LIMIT, getUserSourceFolder, setUserSourceFolder,
};
