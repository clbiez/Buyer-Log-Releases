'use strict';

/* v7.81 — VERİ YÖNETİMİ ARAYÜZ SÖZLEŞMESİ.
 *
 * public/data-management.js DOM'a bağlıdır ve node içinde ayrıştırılamaz;
 * proje kuralı gereği (CLAUDE.md §2) kaynak metin eşleştirmesiyle sınanır.
 *
 * Buradaki iddialar üslup tercihi değil, canlı ölçümde görülmüş kusurları
 * kilitler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const UI = read('public/data-management.js');
const CSS = read('public/data-management.css');
const INDEX = read('public/index.html');

/* Satır sonları bu depoda karışık (CRLF + LF). Çok satırlı ankraj kullanan her
   eşleştirme satır sonuna DUYARSIZ olmalı (CLAUDE.md §3). */
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const multiline = lines => new RegExp(lines.map(escapeRegex).join('\\r?\\n\\s*'));

/* ------------------------------------------------------------------ */

test('v7.81 tamamen kopmuş modül liste görünümünden geri bağlanabilir', () => {
  /* Canlı ölçümde görülen çıkmaz sokak: bağlantısı kalmayan modülün satırı
     yalnız "Hiçbir kaynağa bağlı değil" yazıyordu ve hiçbir bağlanma yolu
     sunmuyordu. Kullanıcı matrise geçmesi gerektiğini TAHMİN etmek zorundaydı.
     Boş satır da connectables() çağırmalı. */
  const emptyBranch = UI.match(/if \(!module\.feeds\.length\) \{[\s\S]*?\n    \}/);
  assert.ok(emptyBranch, 'boş modül satırı dalı bulunamadı');
  assert.match(emptyBranch[0], /connectables\(module\)/,
    'bağlantısı olmayan modül satırı bağlanma yolu sunmuyor — çıkmaz sokak');
});

test('v7.81 matris dört hâli birbirinden ayırır', () => {
  // unavailable / locked / on / off — dördü de ayrı çizilir.
  assert.match(UI, /state === 'unavailable'/);
  assert.match(UI, /state === 'locked'/);
  // İmkânsız ve kilitli hücreler DÜĞME OLMAMALI: tıklanıp hiçbir şey olmaması
  // (ya da geri sıçraması) kullanıcıya yanlış bir zihinsel model öğretir.
  const unavailableCell = UI.match(/if \(state === 'unavailable'\) \{[\s\S]*?\n        \}/);
  const lockedCell = UI.match(/if \(state === 'locked'\) \{[\s\S]*?\n        \}/);
  assert.ok(unavailableCell && lockedCell);
  assert.doesNotMatch(unavailableCell[0], /data-toggle/);
  assert.doesNotMatch(lockedCell[0], /data-toggle/);
});

test('v7.81 kilitli bağlantıda "kopar" düğmesi gösterilmez', () => {
  assert.match(UI, /model\.canManage && !feed\.locked \? `<button[^`]*dmDisconnect/);
});

test('v7.81 yazma sırasında hücre kilitlenir — çift tıklama iki istek göndermez', () => {
  assert.match(UI, /if \(busyCell\) return;/);
  assert.match(UI, /busyCell = cell;/);
});

test('v7.81 iyimser güncelleme YAPILMAZ', () => {
  /* Sunucu kilitli bir hedefi reddedebilir. Ekranın bir an için "kapandı"
     demesi, geri sıçrayan bir anahtardan farksız olurdu. İstek biter, sonra
     tazelenir. */
  const toggle = UI.match(/async function toggleBinding\([\s\S]*?\n  \}/);
  assert.ok(toggle, 'toggleBinding bulunamadı');
  assert.match(toggle[0], /await load\(\);/);
  // Yerel model doğrudan değiştirilmemeli.
  assert.doesNotMatch(toggle[0], /model\.matrix\.cells\[[^\]]*\]\s*=/);
});

test('v7.81 yazma isteği KAYNAK BAŞINA revizyon taşır', () => {
  /* Bütün deponun revizyonunu göndermek, ASAS'ı düzenleyenin IAS'ı düzenleyeni
     engellemesi demekti (ölçüldü). Yalnız dokunulan kaynağın parmak izi gider. */
  assert.match(UI, /expectedSourceRevision: source \? source\.revision : ''/);
  assert.doesNotMatch(UI, /'If-Match': `"\$\{model\.revision\}"`/,
    'bağlantı yazması global revizyona bağlanmamalı');
});

test('v7.81 yetkisi olmayan kullanıcıya yazma denetimi çizilmez', () => {
  assert.match(UI, /if \(!model\.canManage\) return '';/);
  assert.match(UI, /const disabled = !model\.canManage/);
});

/* ------------------------------------------------------------------ */

test('v7.81 ekran §4 görünmez <section> tuzağına düşmez', () => {
  /* app.css: `section{display:none}` bütün belgeye uygulanır. Kendisine
     display veren bir kural bulamayan her <section> SESSİZCE kaybolur. */
  const shell = INDEX.match(/<section id="view-source">[\s\S]*?<\/section>/);
  assert.ok(shell, 'view-source bölümü yok');
  assert.doesNotMatch(shell[0].replace(/^<section id="view-source">/, ''), /<section/,
    'iç içe <section> kullanılmış — kendisine display veren bir kural yoksa kaybolur');
});

test('v7.81 modül stili yalnız token kullanır, yeni ton uydurmaz', () => {
  // DESIGN_SYSTEM.md: renk yalnız token'lardan gelir.
  const hex = CSS.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hex, [], `modül CSS'inde sabit renk var: ${hex.join(', ')}`);
  assert.match(CSS, /var\(--acc\)/);
  assert.match(CSS, /var\(--line\)/);
});

test('v7.81 ekran açılış kritik yolunda değil — lazy yüklenir', () => {
  const perf = read('public/perf-runtime.js');
  /* Sıra önemli: yardımcı modüller onları çağıran ekrandan ÖNCE yüklenir —
     ekran window.BLDataFilterEditor ve window.BLDataSourceWizard'ı hazır
     bulmalı. data-management.js listenin SONUNDA olmalı. */
  const group = perf.match(/dataManagement:\[([^\]]*)\]/);
  assert.ok(group, 'dataManagement lazy grubu yok');
  const files = group[1].split(',').map(entry => entry.trim().replace(/^'|'$/g, '').split('?')[0]);
  assert.equal(files[files.length - 1], 'data-management.js', 'ekran en sonda yüklenmeli');
  assert.ok(files.includes('data-management-filter.js'));
  const appMain = read('public/app-main.js');
  assert.match(appMain, multiline([
    "if(tab==='source'){",
    "void window.BLPerf.ensureFeature('dataManagement').then(()=>{",
  ]));
});

test('v7.81 ekran sekmesi kayıt defteriyle tutarlı', () => {
  assert.match(INDEX, /<button data-tab="source"/);
  const registry = require('../server/lib/module-registry');
  assert.equal(registry.describe('source').route, 'source');
  assert.equal(registry.describe('source').navigable, true);
});

/* ------------------------------------------------------------------ */
/* v7.81 (P7) — SAYFA ROZETİ → VERİ YÖNETİMİ (§35). */

test('v7.81 sayfa rozeti kaynağı ve filtre özetini gösterir, istek atmaz', () => {
  const appMain = read('public/app-main.js');
  /* KORUNAN KAYGI AYNEN GEÇERLİ: rozet çizimi ağ isteği atmamalı.
     Veri zaten state'te (modelScopes + appliedHorizons). İlk yazımda
     rozeti yeni bir uca bağlamıştım; bu test onu yakaladı ve uç
     kaldırıldı.

     DEĞİŞEN: "son yenileme" bilgisi rozetten çıktı. Kullanıcı kararı
     "sayfa başlarında minimal bir şekilde SADECE seçili horizonun filtre
     özeti görünsün" — yenileme saati araç çubuğunda zaten var. */
  assert.match(appMain, /horizonSummarySource/);
  assert.match(appMain, /horizonSummaryChip/);
  const badge = appMain.match(/function renderHorizonBadges\(\)\{[\s\S]*?\n\}/);
  assert.ok(badge, 'renderHorizonBadges bulunamadı');
  assert.doesNotMatch(badge[0], /fetch\(/, 'rozet çizimi ağ isteği atmamalı');
  assert.match(badge[0], /state\.modelScopes/);
});

test('v7.81 rozette "Yönet" yok; ufka giden tek kapı Veri Yönetimi', () => {
  const appMain = read('public/app-main.js');
  /* KARAR TERSİNE ÇEVRİLDİ (kullanıcı isteği): rozette Yönet/Kaydet gibi
     eylemler vardı ve yetki yoksa kişisel düzenleyiciye düşüyordu. Kişisel
     katman kalkınca geri düşecek bir yer de kalmadı. */
  const code = appMain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /action==='manage'/);
  assert.doesNotMatch(code, /openCompactHorizonManager/);
  assert.match(code, /function openDataSourceAndFilters\(/);
  /* Yetkisi olmayan kullanıcı çıkmaza sokulmaz: ne olduğu söylenir. */
  const entry = code.slice(code.indexOf('function openDataSourceAndFilters('), code.indexOf('function openDataSourceAndFilters(') + 1200);
  assert.match(entry, /BLCanAccessArea\('source'\)/);
  assert.match(entry, /showToast/);
});

test('v7.81 rozetten filtreye giden kısayol kaldırıldı', () => {
  /* Eskiden rozetteki çipler ve "+ Filtre ekle" doğrudan düzenleyiciyi
     açıyordu — kısayol buydu. Kullanıcı kararıyla başlık salt okunur oldu;
     filtre Veri Yönetimi'nde kurulur. Kısayolun kalması, kaldırılan
     katmana açılan bir kapı bırakmak olurdu. */
  const appMain = read('public/app-main.js');
  const code = appMain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /horizonFilterChip/);
  assert.doesNotMatch(code, /horizonFilterAdd/);
});

test('v7.81 odaklanma ikinci bir yükleme başlatmaz', () => {
  /* Sekmeye geçiş zaten load() tetikliyor. focusModule ayrıca load() çağırsaydı
     aynı anda iki istek giderdi. Uçuştaki yükleme paylaşılır. */
  assert.match(UI, /let loadPromise = null;/);
  assert.match(UI, /if \(!loadPromise\) loadPromise = runLoad\(\)/);
  const focus = UI.match(/function focusModule\(moduleId\) \{[\s\S]*?\n  \}/);
  assert.ok(focus);
  assert.match(focus[0], /if \(model && !loadPromise\) apply\(\);/);
});

test('v7.81 matris görünümündeyken odaklanma listeye geçer', () => {
  // Matriste modül SATIRI yoktur; aksi hâlde "Yönet" sessizce hiçbir şey yapmaz.
  const focus = UI.match(/function focusModule\(moduleId\) \{[\s\S]*?\n  \}/);
  assert.match(focus[0], /if \(view !== 'list'\) \{ view = 'list'; render\(\); \}/);
});

/* ------------------------------------------------------------------ */
/* v7.81 (P3-yazma) — ORTAK FİLTRE DÜZENLEYİCİSİ. */

const FILTER_UI = read('public/data-management-filter.js');
const SERVER = require('./helpers/server-source')();

test('v7.81 filtre çipi artık eski 1.619 satırlık modalı açmıyor', () => {
  const branch = UI.match(/const filter = event\.target\.closest\('\[data-open-filter\]'\);[\s\S]*?\n    \}/);
  assert.ok(branch, 'filtre dalı bulunamadı');
  assert.match(branch[0], /openFilterEditor\(moduleId, sourceId\)/);
  assert.doesNotMatch(branch[0], /openDataSourceAndFilters/);
});

test('v7.81 ezilmiş katman ÇIKMAZ değil: düzenleyici açılır ve durumu söyler', () => {
  /* KORUNAN KUSUR (canlı kullanımda görüldü): kişisel/ön ayar katmanı varken
     ekran "önce onu kaldırın" deyip düzenleyiciyi hiç açmıyordu. Uyarı
     doğruydu — ortak filtreyi değiştirmek kullanıcının gördüğünü değiştirmez —
     ama kaldırılacak yer BAŞKA BİR EKRANDI ve kullanıcı orada bırakılıyordu.
     Artık açılır, hangi katmanın kazandığını söyler ve kaldırılabiliyorsa
     kaldırma yolunu taşır. */
  const fn = UI.match(/function openFilterEditor\(moduleId, sourceId\) \{[\s\S]*?\n  \}/);
  assert.ok(fn);
  /* Yorumlar ELENİR: bu dosyanın kendi açıklama metni "önce onu kaldırın"
     ifadesini anlatım olarak içeriyor ve ham eşleştirme onu kod sanardı. */
  const code = fn[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /showToast\([^)]*önce onu kaldırın/);
  assert.doesNotMatch(code, /if \(feed\.layer !== 'source'\) \{\s*\r?\n?\s*if \(typeof showToast/);
  assert.match(code, /layerNote/);
  assert.match(fn[0], /removable: Boolean\(feed\.layerRemovable\)/);
  // Yetki kontrolü kalkmadı.
  assert.match(fn[0], /if \(!model\.canManage\)/);
  // Düzenleyici uyarıyı gerçekten çiziyor ve kaldırma düğmesini bağlıyor.
  assert.match(FILTER_UI, /function layerBanner\(\)/);
  assert.match(FILTER_UI, /data-clear-layer/);
});

test('v7.81 ezen katman varken DÜZENLENEN şey ortak filtredir', () => {
  /* Ekranda görünen ad/metin ezen katmanındır; düzenleyiciye ortak katmanın
     adı verilir. Yoksa kullanıcı kişisel ufkunu ortak filtrenin üstüne yazardı. */
  const fn = UI.match(/function openFilterEditor\(moduleId, sourceId\) \{[\s\S]*?\n  \}/);
  assert.match(fn[0], /filterName: layerNote \? \(feed\.sharedFilterName \|\| ''\) : feed\.filterName/);
});

test('v7.81 yalnız KİŞİSEL katman kaldırılabilir', () => {
  /* Ön ayar ve rol şablonu çalışma alanının kararıdır; buradan silinseydi
     başka kullanıcıları da etkilerdi. Sunucu bunu istemciye bırakmaz. */
  assert.match(SERVER, /code: 'LAYER_NOT_PERSONAL'/);
  const route = SERVER.match(/app\.post\('\/api\/data-management\/layer'[\s\S]*?\n\}\);/);
  assert.ok(route, 'katman uç noktası bulunamadı');
  assert.match(route[0], /layerKey === 'personalDefault'/);
  assert.match(route[0], /layerKey === 'personal'/);
  assert.doesNotMatch(route[0], /'preset'|'roleTemplate'|'roleDefault'/);
  // TÜM modülleri etkileyen varsayılan ayrıca sorulur.
  const clear = UI.match(/async function clearPersonalLayer\([\s\S]*?\n  \}/);
  assert.ok(clear);
  assert.match(clear[0], /personalDefault/);
  assert.match(clear[0], /confirm/);
});

test('v7.81 paylaşım kararı kullanıcıya sorulur, varsayılan uydurulmaz', () => {
  // Paylaşılan filtrede İKİ ayrı kaydetme düğmesi çıkar (§19).
  assert.match(FILTER_UI, /data-save="split"/);
  assert.match(FILTER_UI, /data-save="shared"/);
  /* "Ayır" seçeneği YALNIZ paylaşım varken çıkmalı; paylaşılmayan bir filtrede
     iki düğme göstermek olmayan bir karar sordurur. `shared` koşulunun içinde
     olduğu doğrulanır (şablonda satır sonu olabilir). */
  const savePart = FILTER_UI.match(/\$\{shared[\s\S]{0,600}?data-save="split"/);
  assert.ok(savePart, '"ayır" düğmesi shared koşuluna bağlı değil');
  // Ve mod sunucuya AÇIKÇA gider; istemci varsayılan uydurmaz.
  assert.match(FILTER_UI, /body: JSON\.stringify\(\{[\s\S]{0,200}?mode,/);
});

test('v7.81 alan listesi TÜM şema sütunlarını sunar', () => {
  // §17: yalnız eşlenmiş alanlar değil. /api/horizon/fields bunu zaten döndürüyor.
  assert.match(FILTER_UI, /\/api\/horizon\/fields\?target=/);
  assert.match(
    FILTER_UI,
    /const pickField = event\.target\.closest\('\[data-pick-field\]'\);[\s\S]{0,1200}?fieldsFor\(\)\.map/,
    'alan seçici TÜM şema sütunlarını fieldsFor().map üzerinden sunmalı',
  );
});

test('v7.81 değerler database’den okunur, uydurulmaz', () => {
  assert.match(FILTER_UI, /\/api\/horizon\/values\?/);
  /* Liste yüklü veriden geliyorsa bu SÖYLENİR: kısmi bir liste tam liste
     sanılmamalı (§152). */
  assert.match(FILTER_UI, /payload\.source && payload\.source !== 'database'/);
  /* Erişilemezse kullanıcı kilitlenmez: elle yazabilir. Bu yetenek ortak
     seçiciye taşındı (allowFree); filtre düzenleyicisi onu talep eder. */
  assert.match(FILTER_UI, /allowFree: true/);
});

test('v7.81 düzenleyici yazarken kaynak sürümü taşır', () => {
  assert.match(FILTER_UI, /expectedSourceRevision: context\.revision/);
});

test('v7.81 düzenleyici modal-içinde-modal kurmaz', () => {
  // §48: satır içinde açılır, ayrı bir overlay değil.
  assert.doesNotMatch(FILTER_UI, /warnOverlay|modalCard/);
  assert.match(UI, /data-filter-slot=/);
});

/* ------------------------------------------------------------------ */
/* v7.81 (§8) — KAYNAK EKLEME SİHİRBAZI. */

const WIZARD = read('public/data-management-source.js');

test('v7.81 kaynak sihirbazı desteklenen database discovery ve credential güvenliğini gösterir', () => {
  const code = WIZARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /SQL Server/i);
  assert.match(code, /type="password"/i);
  assert.match(code, /encrypted credential store/i);
  assert.match(code, /Database olarak eklenirse yalnız bu bilgisayarda/i);
});

test('v7.81 kaynak türleri profil kaydından gelir, sabit listeden değil', () => {
  assert.match(WIZARD, /\/api\/data-management\/source-options/);
  assert.doesNotMatch(WIZARD, /const PROFILES\s*=\s*\[/);
  // Modül seçenekleri de seçilen profilden türer.
  assert.match(WIZARD, /profile \? profile\.feedableModules : \[\]/);
});

test('v7.81 tür değişince geçersiz modül seçimi temizlenir', () => {
  /* ASAS için LFL seçip sonra IAS'a geçen kullanıcı, sunucunun reddedeceği
     bir seçimle "Kaynağı ekle"ye basardı. */
  assert.match(
    WIZARD,
    /const profile = event\.target\.closest\('\[data-profile\]'\);[\s\S]{0,700}?draft\.moduleIds = draft\.moduleIds\.filter/,
    'kaynak türü değişince geçersiz modül seçimleri temizlenmeli',
  );
});

test('v7.81 sihirbaz ikinci bir bağlantı sınaması yazmaz', () => {
  // /api/model-connections/inspect zaten var ve çalışıyor (CLAUDE.md §9).
  assert.match(WIZARD, /\/api\/model-connections\/inspect/);
  assert.match(WIZARD, /\/api\/model-connections\/automap/);
});

test('v7.81 eşleme başarısız olsa bile eklenen kaynak geri alınmaz', () => {
  /* Kaynak zaten eklendi; eşleme ayrı bir adım. Hata akışı geri almamalı,
     yoksa kullanıcı baştan başlardı. */
  const fn = WIZARD.match(/async function runAutoMap\(\)[\s\S]*?\n  \}/);
  assert.ok(fn);
  // Kullanıcıya kaynağın DURDUĞU ve eşlemenin sonra düzeltilebileceği söylenir.
  assert.match(fn[0], /Kaynak eklendi; eşlemeyi kaynak ayrıntısından düzeltebilirsiniz/);
  // Ve hiçbir geri alma / silme çağrısı yapılmaz.
  assert.doesNotMatch(fn[0], /method: 'DELETE'|planSourceDelete|rollback/);
});

test('v7.81 yazarken panel yeniden çizilmez — imleç kaybolmaz', () => {
  const fn = WIZARD.match(/function onInput\(event\)[\s\S]*?\n  \}/);
  assert.ok(fn);
  assert.doesNotMatch(fn[0], /render\(\)/);
  assert.match(WIZARD, /function syncNext\(\)/);
});

test('v7.81 sihirbaz lazy grupta ve ekrandan ÖNCE yüklenir', () => {
  const perf = read('public/perf-runtime.js');
  const group = perf.match(/dataManagement:\[([^\]]*)\]/);
  assert.ok(group);
  const files = group[1].split(',').map(entry => entry.trim().replace(/^'|'$/g, '').split('?')[0]);
  assert.ok(files.includes('data-management-source.js'));
  assert.ok(files.indexOf('data-management-source.js') < files.indexOf('data-management.js'),
    'sihirbaz ekrandan önce yüklenmeli');
});

test('v7.81 sihirbaz uyarıları birikir, birbirini ezmez', () => {
  /* Canlı ölçümde görüldü: "kaynak KAPALI eklendi çünkü bu türde zaten aktif
     biri var" uyarısı, hemen ardından gelen eşleme hatası tarafından
     siliniyordu — kullanıcı en önemli bilgiyi kaybediyordu. */
  assert.match(WIZARD, /function say\(text, tone = 'info'\)/);
  assert.match(WIZARD, /if \(!messages\.includes\(value\)\) messages\.push\(value\)/);
  // Hiçbir yerde tek bir mesaj değişkenine ATAMA kalmamalı.
  assert.doesNotMatch(WIZARD, /\bmessage = /);
  // Ve şiddeti en yüksek ton kazanmalı: uyarı, bilgi tarafından bastırılmamalı.
  assert.match(WIZARD, /if \(TONE_RANK\[tone\] > TONE_RANK\[messageTone\]\) messageTone = tone;/);
});

test('v7.81 eşleme hata metni kendini tekrar etmez', () => {
  /* "Otomatik eşleme çalışmadı: Otomatik eşleme çalışmadı." cümlesi, yedek
     metin ile ön ekin aynı olmasından çıkıyordu. */
  const fallback = WIZARD.match(/throw new Error\(payload\.error \|\| T\('([^']*)'/);
  assert.ok(fallback, 'automap yedek metni bulunamadı');
  assert.doesNotMatch(fallback[1], /Otomatik eşleme çalışmadı/);
});

/* ------------------------------------------------------------------ */
/* v7.81 (P4-yazma) — ALAN EŞLEME DÜZENLEYİCİSİ. */

const MAPPING_UI = read('public/data-management-mapping.js');
const PICKER_UI = read('public/data-management-picker.js');

test('v7.81 eşleme düzenleyicisi eski modalı açmıyor', () => {
  /* Pencere DALIN KENDİSİYLE sınırlanır: 200 karakterlik bir kesit hemen
     altındaki legacy dalını da içine alıyor ve o dal (haklı olarak) eski
     modalı çağırıyor. İddia yanlış yere bakıyordu. */
  const branch = UI.match(/const mapping = event\.target\.closest\('\[data-open-mapping\]'\);\r?\n\s*if \(mapping\) \{[^}]*\}/);
  assert.ok(branch, 'eşleme dalı bulunamadı');
  assert.match(branch[0], /openMappingEditor\(/);
  assert.doesNotMatch(branch[0], /openDataSourceAndFilters/);
});

test('v7.81 tek alan yazılır — tam eşleme gönderilmez', () => {
  /* Bayat bir görünüm üzerinden tam eşleme göndermek, o arada eklenmiş bir
     alanı sessizce düşürürdü. */
  assert.match(MAPPING_UI, /mappingEntry: \{ header, entry \}/);
  assert.doesNotMatch(MAPPING_UI, /body: JSON\.stringify\(\{[^}]*\bmapping:/);
});

test('v7.81 düzenleyici normal kayıtta açık kalır; canlı onarım hedefi kaydedilince yenilemeyi tekrarlar', () => {
  /* Normal gözden geçirmede kapanmak, üç sorunlu alanı düzeltmek için paneli
     üç kez açtırırdı. Bu davranış korunur. Yalnız refresh hatasından gelen
     TEK hedef alan başarıyla kaydedildiğinde editör kapanır ve aynı kapsam
     otomatik yeniden denenir. */
  assert.match(UI, /onSaved: async \(warnings, saved\) => \{/);
  assert.match(UI, /openMappingEditor\(sourceId, repair\);/);
  assert.match(UI, /if \(repairedTarget\)[\s\S]*BLRetryRefreshAfterFieldMapping/);
  const write = MAPPING_UI.match(/async function write\(header, entry\)[\s\S]*?\n  \}/);
  assert.ok(write);
  // Yazma sonrası kendi DOM'una çizmemeli: yuva o sırada yok edilmiş olur.
  assert.match(write[0], /close\(\{ notify: false \}\)/);
});

test('v7.81 düzenleyici kaynağın KENDİ ayrıntısında açılır', () => {
  assert.match(UI, /data-mapping-slot=/);
  assert.match(UI, /expandedSourceId = sourceId;\s*\n\s*mappingEditorSourceId = sourceId;/);
});

test('v7.81 düzenleyici açıkken aynı liste iki kez çizilmez', () => {
  /* Aynı iki satırın ekranda iki kez görünmesi §48'in istemediği gürültüydü
     (canlı ölçümde görüldü). */
  assert.match(UI, /\$\{mappingEditorSourceId === source\.id \? '' : mappingSection\(source\)\}/);
});

test('v7.81 şema önbelleklenir ama HATA önbelleklenmez', () => {
  /* Ekran her kayıttan sonra yeniden çizilip düzenleyici yeniden açıldığı
     için şema her seferinde okunsaydı gereksiz DMV sorgusu üretirdi.
     Geçici bir arıza ise kalıcı bir engel olmamalı. */
  assert.match(MAPPING_UI, /const schemaCache = new Map\(\);/);
  assert.match(MAPPING_UI, /schemaCache\.set\(key, \{ schema, error: '' \}\)/);
  const fail = MAPPING_UI.match(/schemaError = String\(error && error\.message \|\| error\);[\s\S]{0,160}/);
  assert.ok(fail);
  assert.doesNotMatch(fail[0], /schemaCache\.set/);
});

test('v7.81 şema okunamazsa düzenleyici kilitlenmez', () => {
  // Kullanıcı sütun adını elle yazabilmeli; aksi hâlde kurtarılabilir bir
  // durum çıkmaza dönerdi.
  assert.match(MAPPING_UI, /allowFree: true/);
  assert.match(MAPPING_UI, /Sütun adını yazıp Enter/);
});

test('v7.81 seçici TEK bir ortak modüldür', () => {
  // §9: aynı işlev için ikinci bir component üretme.
  assert.match(PICKER_UI, /window\.BLDataPicker = \{ open, close \}/);
  const filterUi = read('public/data-management-filter.js');
  assert.match(filterUi, /window\.BLDataPicker\?\.open\?\./);
  // Filtre düzenleyicisinde yerel bir seçici kopyası KALMAMALI.
  assert.doesNotMatch(filterUi, /picker\.className = 'dmfPicker'/);
});

test('v7.81 kesilen uzun liste sessiz kalmaz', () => {
  /* Sessizce ilk N'i göstermek, kullanıcının aradığı sütunu "yok" sanmasına
     yol açardı. */
  assert.match(PICKER_UI, /sonuç daha var — aramayı daraltın/);
});

/* ------------------------------------------------------------------ */
/* v7.81 — ARAÇLAR: "Kaynak Veri" ayarlar menüsünün yerine geçen bölüm.
 *
 * Korunan kusur: on üç iş tek bir etiketsiz açılır yığında duruyordu. Hiçbiri
 * ne yaptığını söylemiyordu; kullanıcı doğru olanı bulmak için sırayla açıp
 * kapatıyordu. Üstelik menü kaydırılabilir bir kapsayıcının içinde kırpılıyordu.
 */

/* Araç kaydını DESEN EŞLEŞTİRMEKLE değil, ÇALIŞTIRARAK sınıyoruz.

   Desen eşleştirme burada iki kez yanılttı: kayıt biçimi (tek satır / çok
   satır) değişince iddia kırılıyor ama kusur yok, ya da tersi. Kayıt saf veri
   olduğu için küçük bir kum havuzunda değerlendirilebilir; böylece sınanan şey
   metnin şekli değil, kaydın KENDİSİ olur. */
function loadToolGroups() {
  const block = UI.match(/const TOOL_GROUPS = \[[\s\S]*?\n  \];/);
  assert.ok(block, 'TOOL_GROUPS bulunamadı');
  const stubs = {
    openTransitRulesModal() {}, openLandedMultipliersModal() {}, openSuppFobRulesModal() {},
    openNonDtrManufacturersModal() {}, triggerEndeksmatikUpload() {}, chooseSourceFolder() {},
    openSyncLocalDataModal() {}, openModelImageLimitModal() {}, openBrowserDebugSettingsModal() {},
    document: { getElementById: () => null }, window: {}, model: { environment: {} },
    feature: () => Promise.resolve(),
  };
  const factory = new Function(...Object.keys(stubs), `${block[0]}; return TOOL_GROUPS;`);
  return factory(...Object.values(stubs));
}

test('v7.81 her araç NE YAPTIĞINI yazar — iki dilde', () => {
  /* Bir kurulum ekranında asıl maliyet tıklama değil, doğru aracı bulmaktır.
     Etiket tek başına yetmez: "Yol Süreleri" neyi etkiler? */
  const groups = loadToolGroups();
  const tools = groups.flatMap(group => group.tools);
  assert.equal(tools.length, 13, `13 araç beklenir, bulunan: ${tools.length}`);

  for (const item of groups.concat(tools)) {
    const name = item.id;
    for (const field of ['label', 'hint']) {
      assert.ok(item[field] && item[field].tr && item[field].en,
        `${name}: ${field} iki dilde dolu olmalı`);
      assert.ok(item[field].tr.trim().length > 3, `${name}: ${field}.tr anlamlı olmalı`);
      assert.ok(item[field].en.trim().length > 3, `${name}: ${field}.en anlamlı olmalı`);
    }
  }
  // Satır içi olmayan her araç gerçekten bir şey çalıştırmalı.
  for (const tool of tools) {
    if (tool.inline) continue;
    assert.equal(typeof tool.run, 'function', `${tool.id}: çalıştırılabilir olmalı`);
  }
  // Kimlikler benzersiz: aynı id iki satırı birbirine bağlardı.
  const ids = tools.map(tool => tool.id);
  assert.equal(new Set(ids).size, ids.length, 'araç kimlikleri benzersiz olmalı');
});

test('v7.81 araçlar üç soruya göre gruplanır, düz bir yığın değil', () => {
  const groups = UI.match(/const TOOL_GROUPS = \[[\s\S]*?\n  \];/)[0];
  for (const id of ['rules', 'reference', 'storage']) {
    assert.match(groups, new RegExp(`id: '${id}'`), `${id} grubu olmalı`);
  }
  // Gruplar da kendi açıklamasını taşır: "bu grupta ne var?" sorusu kalmamalı.
  assert.match(groups, /Ortak kurallar: değiştirmek herkesin gördüğü sayıyı değiştirir/);
});

test('v7.81 Araçlar YETKİSİ OLMAYANA çizilmez', () => {
  // Yapılandırmayı değiştiremeyecek kullanıcıya çalışmayan satırlar göstermek,
  // onu erişemeyeceği bir yola sokar.
  // v20260926: yetki ARAÇ BAZINDA — ortak ayar düzenleyicileri Moderatörün
  // verdiği izni ister; cihaza özel araçlar (kaynak klasör vb.) Kaynak Veri
  // alanı olan herkese açıktır. Yetkisiz araç yine hiç çizilmez.
  const fn = UI.match(/function toolsPanel\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fn);
  assert.match(fn[0], /const groups = visibleToolGroups\(\);\s*if \(!groups\.length\) return '';/);
  assert.match(UI, /function visibleToolGroups\(\) \{[\s\S]*?group\.tools\.filter\(toolAllowed\)/);
  const run = UI.match(/async function runTool\(id\) \{[\s\S]*?\n  \}/);
  assert.ok(run);
  assert.match(run[0], /!toolAllowed\(tool\)/, 'sunucuya gitmeden önce yetki de kontrol edilmeli');
  for (const id of ['transit', 'landed', 'royalty', 'nondtr', 'fx']) {
    assert.match(UI, new RegExp(`\\{ id: '${id}', requires: 'manageBusinessRules'`), `${id} ortak ayar izni istemeli`);
  }
  assert.match(UI, /\{ id: 'endeksmatik', requires: 'manageModelConnections'/);
});

test('v7.81 Data Maintenance SATIR İÇİ açılır, ikinci bir arayüz yazılmadan', () => {
  /* Data Maintenance bir tanı yüzeyidir: kullanıcı analiz çıktısına bakarken
     ekranın geri kalanını da görmek ister. Aynı fonksiyon iki yüzeyi de
     besler — ikinci bir kopya §9'a aykırı olurdu. */
  const run = UI.match(/async function runTool\(id\) \{[\s\S]*?\n  \}/)[0];
  assert.match(run, /openDataMaintenanceModal\(slot\)/);
  const app = read('public/app-main.js');
  assert.match(app, /async function openDataMaintenanceModal\(host=null\)\{/);
  assert.match(app, /const inline=Boolean\(host\);/);
  // Satır içi hâlde arka plana tıklamak paneli KAPATMAMALI: ekranın kendisi arka plan.
  assert.match(app, /if\(!inline\)modal\.addEventListener\('click'/);
});

test('v7.81 araç satırı açılır menü DEĞİL — kırpılacak bir kapsayıcı yok', () => {
  /* v7.33'teki kusur menünün kaydırılabilir bir kapsayıcıda kırpılmasıydı.
     Çözüm menüyü doğru konumlandırmak değil, menü KULLANMAMAK oldu. */
  assert.doesNotMatch(CSS, /\.dmToolList[^}]*position:\s*fixed/);
  assert.doesNotMatch(CSS, /\.dmToolList[^}]*position:\s*absolute/);
  assert.match(CSS, /\.dmToolList \{[^}]*border:/);
});

/* ------------------------------------------------------------------ */
/* v7.81 — KAYNAK MODU VE OTOMATİK YENİLEME: "Kaynak Veri" şeridinden taşındı.
 *
 * Korunan kusur: "Excel mi, Database mi?" kararı şeritte, bağlantı
 * kartlarından UZAKTA duruyordu. Kullanıcı model bağlantısını kurup neden
 * sorgulanmadığını anlamıyordu — çünkü mod Excel'de kalmıştı.
 *
 * İkinci ve daha sinsi risk: markup taşınırken bir öznitelik değişirse
 * app-main.js'teki renderer hiçbir düğme bulamaz; düğmeler ekranda durur ama
 * HEPSİ pasif görünür ve hangi modun seçili olduğu okunamaz.
 */

function loadSourceModes() {
  const block = UI.match(/const SOURCE_MODES = \[[\s\S]*?\n  \];/);
  assert.ok(block, 'SOURCE_MODES bulunamadı');
  const stubs = { setAsasSourceMode() {}, setAntrepoSourceMode() {}, setLflSourceMode() {} };
  return new Function(...Object.keys(stubs), `${block[0]}; return SOURCE_MODES;`)(...Object.values(stubs));
}

test('v7.81 taşınan mod denetimleri renderer’ın ARADIĞI seçicilerle örtüşür', () => {
  /* İki taraf da gerçek kaynaktan okunur: elle yazılmış bir seçici listesi
     dosya değişince sessizce eskir (CLAUDE.md §5). */
  const APP_SRC = read('public/app-main.js');
  const produced = new Set();
  for (const group of loadSourceModes()) {
    produced.add(`#${group.id} [${group.attr}]`);
    produced.add(`[${group.attr}]`);
    produced.add(`#${group.fileId}`);
  }

  const queried = [...APP_SRC.matchAll(/querySelectorAll\('(#?[A-Za-z0-9_-]*\s*\[data-[a-z-]+\])'\)/g)]
    .map(match => match[1]).filter(selector => /source-mode/.test(selector));
  assert.ok(queried.length >= 3, 'renderer seçicileri bulunamadı — test kendini kandırmasın');
  for (const selector of new Set(queried)) {
    assert.ok(produced.has(selector), `renderer "${selector}" arıyor ama ekran üretmiyor`);
  }

  const byId = [...APP_SRC.matchAll(/getElementById\('((?:asas|antrepo|lfl)SourceFile)'\)/g)].map(m => m[1]);
  for (const id of new Set(byId)) {
    assert.ok(produced.has(`#${id}`), `renderer #${id} arıyor ama ekran üretmiyor`);
  }
});

test('v7.81 mod düğmeleri her çizimde yeniden bağlanır', () => {
  /* Eski bağlama açılışta TEK SEFER yapılıyordu; bu ekran her çizimde DOM'u
     baştan kurduğu için o bağlama kaybolurdu ve düğmeler ölü kalırdı. */
  assert.doesNotMatch(read('public/app-main.js'),
    /querySelectorAll\('#asasSourceControl \[data-asas-source-mode\]'\)\.forEach\(btn=>btn\.addEventListener/);
  const click = UI.match(/for \(const group of SOURCE_MODES\) \{[\s\S]*?\n    \}/);
  assert.ok(click, 'olay delegasyonu bulunamadı');
  assert.match(click[0], /group\.set\(btn\.getAttribute\(group\.attr\)\)/);
  assert.match(click[0], /if \(!model\.canManage \|\| btn\.disabled\) return;/);
});

test('v7.81 çizimden sonra aktif mod yeniden uygulanır', () => {
  /* Bu çağrı olmadan düğmeler doğru yerde ama hepsi pasif görünür:
     kullanıcı hangi modun seçili olduğunu göremez. */
  /* render() SONUNDA çağrılmalı: DOM baştan kurulduğu için aktif durum
     yeniden uygulanmazsa tüm düğmeler pasif görünür. */
  const renderFn = UI.match(/syncSourceModes\(\);\r?\n\s*\}/);
  assert.ok(renderFn, 'render sonunda syncSourceModes çağrılmalı');
  const sync = UI.match(/function syncSourceModes\(\) \{[\s\S]*?\n  \}/);
  assert.ok(sync);
  for (const fn of ['renderAsasSourceControl', 'renderAntrepoSourceControl',
    'renderLflSourceControl', 'renderAutoRefreshState']) {
    assert.match(sync[0], new RegExp(fn), `${fn} yeniden uygulanmalı`);
    // Fonksiyonun kendisi app-main.js'te KALMALI: ikinci bir kopya yazılmadı.
    assert.ok(read('public/app-main.js').includes(`function ${fn}(`),
      `${fn} app-main.js'te kalmalı — ikinci bir kopya yazılmadı`);
  }
  // Bir renderer patlarsa ekranın tamamı düşmemeli.
  assert.match(sync[0], /catch \(_\)/);
});

test('v7.81 otomatik yenileme Yenileme bölümünde, kendi zamanlayıcısını yazmadan', () => {
  assert.match(UI, /id="autoRefreshSelect"/);
  assert.match(UI, /id="autoRefreshNote"/);
  // Değer ve zamanlayıcı app-main.js'te; burada yalnız seçim iletilir (§9).
  assert.match(UI, /setAutoRefreshMinutes\(event\.target\.value\)/);
  assert.doesNotMatch(UI, /setInterval|setTimeout\([^)]*autoRefresh/i);
  assert.match(read('public/app-main.js'), /function setAutoRefreshMinutes\(/);
});

test('v7.81 şeritte ikinci bir kopya kalmaz', () => {
  for (const id of ['sourceModeGroup', 'autoRefreshSelect', 'asasSourceControl',
    'antrepoSourceControl', 'lflSourceControl']) {
    assert.doesNotMatch(INDEX, new RegExp(id), `${id} şeritten kaldırılmış olmalı`);
  }
});

/* ------------------------------------------------------------------ */
/* v7.81 — "KAYNAK VERİ" ŞERİDİ KALDIRILDI.
 *
 * Karar veren her denetim Veri Yönetimi'ne taşındıktan sonra şerit boşaldı:
 * açılan çekmecede yalnız bir süre sayacı ve iki GİZLİ dosya girdisi kaldı.
 * Boş bir çekmeceyi açan düğme, öğretecek hiçbir şeyi olmayan bir tıklamadır.
 *
 * KALDIRIRKEN İKİ ÖLÜMCÜL TUZAK VARDI ve ikisi de yaşandı:
 *   · getElementById('sourceToggle').addEventListener(...)   → KORUMASIZ
 *   · MutationObserver(...).observe(getElementById('sourceBar'), ...) → observe(null)
 * İkisi de app-main.js'in ÜST SEVİYESİNDE; element yokken TypeError fırlatıp
 * dosyanın geri kalanını hiç çalıştırmıyorlar — uygulama açılmıyor.
 */

test('v7.81 şerit, perdesi ve kenar düğmesi kalkar', () => {
  for (const id of ['sourceBar', 'sourceToggle', 'sourceBackdrop', 'railSourceBtn']) {
    assert.doesNotMatch(INDEX, new RegExp(id), `${id} kaldırılmış olmalı`);
  }
  const appMain = read('public/app-main.js');
  assert.doesNotMatch(appMain, /sourceBar|sourceToggle|railSourceBtn/);
});

test('v7.81 KALDIRILAN elemana korumasız erişim kalmaz', () => {
  /* Bu sınıf hata sessiz değil, ölümcüldür: üst seviyede patlar ve app-main.js
     hiç çalışmaz. İki biçim de aranır — ikincisini ilk taramam kaçırmıştı. */
  const appMain = read('public/app-main.js');
  const ids = new Set([...INDEX.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(match => match[1]));
  const gone = ['sourceBar', 'sourceToggle', 'railSourceBtn', 'sourceBackdrop', 'chooseFolderBtn',
    'backupSettingsBtn', 'syncLocalDataBtn', 'transitRulesBtn', 'sourceSettingsBtn',
    'dataMaintenanceBtn', 'asasSourceControl', 'autoRefreshSelect'];
  for (const id of gone) {
    assert.ok(!ids.has(id), `${id} index.html'de kalmamalı`);
    // (a) getElementById('x').y
    assert.ok(!appMain.includes(`getElementById('${id}').`),
      `${id}: korumasız erişim — app-main.js üst seviyede patlar`);
    // (b) f(document.getElementById('x'), …)
    assert.ok(!appMain.includes(`(document.getElementById('${id}')`),
      `${id}: argüman olarak korumasız geçiliyor — observe(null) TypeError verir`);
  }
});

test('v7.81 şeridin taşıdığı canlı bilgi KAYBOLMADI', () => {
  /* #sourceStatusInline, refreshWarnChips()'in TEK barınağıydı (diğer iki
     hedef zaten yok). Silinseydi yenileme uyarıları hiçbir yerde görünmezdi. */
  const appMain = read('public/app-main.js');
  assert.match(appMain, /\['serverStatus','sourceStatusInline','sourceHint'\]/,
    'uyarı çipi hedefleri değişmiş — bu test güncellenmeli');
  assert.match(INDEX, /id="sourceStatusInline"/, 'durum satırı bir yerde yaşamalı');
  assert.match(read('public/app.css'), /\.topSourceStatus\{/);
  // Yenileme süre sayacı Veri Yönetimi › Yenileme bölümünde.
  assert.match(UI, /data-source-timer="all"/);
  assert.match(appMain, /querySelectorAll\('\[data-source-timer\]'\)/,
    'sayacı güncelleyen kod seçiciyle çalışmalı — taşınınca bozulmasın');
});

test('v7.81 gizli dosya girdileri KALIR', () => {
  // Araçlar bölümü bunları tetikliyor; şeritle birlikte silinselerdi
  // "Kur Excel'i" ve Antrepo yükleme sessizce ölürdü.
  assert.match(INDEX, /id="sourceFxFile"/);
  assert.match(INDEX, /id="fileAntrepo"/);
  assert.match(UI, /getElementById\('sourceFxFile'\)/);
});
