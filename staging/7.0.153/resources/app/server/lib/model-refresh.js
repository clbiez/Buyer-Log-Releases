'use strict';

const modelQuery = require('./modelQuery');
const modelHorizon = require('./modelHorizon');
const modelScopes = require('./model-scopes');
const modelFields = require('./model-fields');
const { createSourceQueryCoordinator } = require('./horizon-source-planner');

const DEFAULT_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;
const filterValueTypes = require('./filter-value-types');
const { parseASASRows, parseAntrepoRows, antrepoParseMeta, findAntrepoHit, orderCodeKey, orderLineKey, antrepoMatchKey, normalizeAntrepoMatchRule, normalizeAntrepoMatchConfig, antrepoMatchConfigLabel, dynamicAntrepoMatchKey, auditAntrepoMatching, ANTREPO_MATCH_RULE_LABELS, matchOperandForRole, matchOperandForSource, matchConditionsForPair } = require('./parse');
const { parseLFLRows, withFabricDimensions } = require('./lfl');

class ModelRefreshError extends Error {
  constructor(message, code = 'MODEL_REFRESH_FAILED', statusCode = 500, extra = {}) {
    super(message);
    this.name = 'ModelRefreshError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

function connectionLabel(item) {
  const name = String(item && (item.name || item.catalog || item.server) || '').trim() || 'Veri modeli';
  const server = String(item && item.server || '').trim();
  const catalog = String(item && item.catalog || '').trim();
  return `${name}${server || catalog ? ` (${[server, catalog].filter(Boolean).join(' / ')})` : ''}`;
}

function debugGeneratedDax(label, query, options = {}) {
  const enabled = options.debugDax === true || String(process.env.BUYER_LOG_DEBUG_DAX || '').trim() === '1';
  if (!enabled) return;
  const message = `[MODEL_QUERY_DAX] ${label}\n${String(query || '')}`;
  if (typeof options.debugLogger === 'function') options.debugLogger(message);
  else console.debug(message);
}

// Kumaş alanları ana ASAS rolünün parçasıdır; ayrı Fabric rolü yoktur.
function normalizedRole(item) {
  return item && item.role === 'antrepo' ? 'antrepo' : 'asas';
}

function selectRefreshConnections(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).filter(item => item && item.refreshEnabled !== false && item.server && item.catalog);
  const selected = { asas: null, antrepo: null };
  const warnings = [];
  for (const role of ['asas', 'antrepo']) {
    const matches = list.filter(item => normalizedRole(item) === role);
    // Aynı roldeki birden çok bağlantı artık DESTEKLENİYOR: her biri farklı
    // hedefleri besleyebilir (ör. bir ASAS bağlantısı CP + Backlog, çoğaltılmış
    // ikinci bir ASAS bağlantısı LFL). Hedef çakışırsa listedeki ilk bağlantı kazanır.
    selected[role] = matches[0] || null;
    selected[`${role}List`] = matches;
  }
  if (!selected.asas && options.includeAsas !== false) {
    throw new ModelRefreshError(
      'Refresh için aktif bir ASAS veri modeli bağlantısı bulunamadı. Data Model Connection ekranında Siparişler rolündeki bağlantıyı “Refresh’te kullan” olarak işaretleyin.',
      'MODEL_REFRESH_ASAS_CONNECTION_MISSING', 400);
  }
  if (!selected.antrepo && options.includeAntrepo !== false) warnings.push('Aktif Antrepo veri modeli bağlantısı bulunamadı; Antrepo bilgileri boş olarak yenilendi.');
  return { ...selected, warnings };
}


// Sorguya gömülecek sipariş kodu sayısı için üst sınır. Üstünde sorgu metni
// yönetilemez ölçüde büyür; o durumda süzme uygulama tarafında yapılır.
const ORDER_CODE_PUSHDOWN_LIMIT = 10000;
// Sorguya gömülecek sipariş kodu listesinin karakter bütçesi. Karar SAYIYA değil
// BOYUTA bakar: kod uzunlukları değişkendir ve asıl sınırlayıcı olan üretilen
// sorgunun büyüklüğüdür. Bütçe aşılırsa süzme uygulama tarafında yapılır.
const ORDER_CODE_PUSHDOWN_BUDGET = 2000000;

// Kod listesini DAX değer listesine çevirir; bütçeyi aşarsa null döner.
function buildOrderCodeList(codes) {
  let length = 0;
  const parts = [];
  for (const code of codes) {
    const literal = `"${String(code).replace(/"/g, '""')}"`;
    length += literal.length + 2;
    if (length > ORDER_CODE_PUSHDOWN_BUDGET) return null;
    parts.push(literal);
  }
  return parts.join(', ');
}

// Eski kayıtların renk-parçası normalizasyonu için korunan yardımcı. Yeni kumaş
// kayıtları Sipariş Kod + Model Adı + Renk Kod tam kimliğiyle oluşturulur.


// Antrepo tarafındaki sipariş kodu sütununun DAX adı, alan eşlemesinden okunur.

function normalizedConnectionMapping(item) {
  const fallbackTable = String(item && item.horizon && item.horizon.table || '').trim();
  const source = item && item.mapping && typeof item.mapping === 'object' ? item.mapping : {};
  const mapping = {};
  const invalidHeaders = [];
  for (const [header, value] of Object.entries(source)) {
    const entry = modelFields.normalizeMappingEntry(value, fallbackTable);
    if (entry && entry.name) mapping[header] = entry;
    else invalidHeaders.push(header);
  }
  return { mapping, invalidHeaders };
}

/* v10.14 — ÇALIŞMA ZAMANI FIELD MAPPING ONARIMI.
 *
 * Tabular model şeması, kaydedilmiş eşlemeden sonra değişebilir. Bu durumda
 * DAX motoru "Column 'X' in table 'Y' cannot be found" der; eski davranış
 * yalnız ham hatayı gösteriyordu. Burada hata, onu üreten GERÇEK bağlantı ve
 * saklanmış Buyer Log alanıyla ilişkilendirilir. İstemci böylece doğru kaynağın
 * Field Mapping düzenleyicisini tek tıkla açabilir.
 *
 * Tahmin yapılmaz: fiziksel sütun kayıtlı mapping/cpColumns içinde bulunamıyorsa
 * veya rol kataloğunda birebir başlık/takma ad değilse onarım eylemi üretilmez.
 */
function fieldMappingRepairFromError(item, error) {
  const message = String(error && (error.publicMessage || error.message) || error || '');
  const match = message.match(/Column\s+['"]([^'"]+)['"]\s+in\s+table\s+['"]([^'"]+)['"]\s+cannot\s+be\s+found/i)
    || message.match(/Column\s+['"]([^'"]+)['"][\s\S]{0,120}?table\s+['"]([^'"]+)['"]/i);
  if (!match) return null;

  const missingColumn = String(match[1] || '').trim();
  const missingTable = String(match[2] || '').trim();
  if (!missingColumn) return null;

  const fold = value => String(value == null ? '' : value)
    .trim().normalize('NFC').toLocaleUpperCase('tr-TR');
  const role = normalizedRole(item);
  const normalized = normalizedConnectionMapping(item);
  const entries = Object.entries(normalized.mapping || {});
  const samePhysical = ([, entry]) => entry && fold(entry.name) === fold(missingColumn)
    && (!missingTable || !entry.table || fold(entry.table) === fold(missingTable));
  const sameColumn = ([, entry]) => entry && fold(entry.name) === fold(missingColumn);

  let matched = entries.find(samePhysical) || entries.find(sameColumn) || null;

  // CP'ye taşınan ilave model sütunları da aynı DAX'a katılır. Bunlardan biri
  // silindiyse kanonik mapping listesinde olmayabilir; yine doğru başlığı bul.
  if (!matched) {
    const extra = (Array.isArray(item && item.cpColumns) ? item.cpColumns : []).find(column =>
      column && fold(column.name) === fold(missingColumn)
      && (!missingTable || !column.table || fold(column.table) === fold(missingTable)));
    if (extra && extra.header) {
      matched = [String(extra.header), {
        table: String(extra.table || missingTable || ''),
        name: String(extra.name || missingColumn),
        kind: extra.kind === 'measure' ? 'measure' : 'column',
      }];
    }
  }

  const fields = modelFields.fieldsForRole(role);
  if (!matched) {
    const field = fields.find(candidate =>
      [candidate.header, ...(candidate.aliases || [])].some(name => fold(name) === fold(missingColumn)));
    if (field) matched = [field.header, { table: missingTable, name: missingColumn, kind: 'column' }];
  }
  if (!matched) return null;

  const [header, entry] = matched;
  const field = fields.find(candidate => candidate.header === header) || null;
  return {
    kind: 'field-mapping',
    reason: 'missing-column',
    sourceId: String(item && item.id || ''),
    sourceName: String(item && (item.name || item.catalog || item.server) || ''),
    role,
    header: String(header || ''),
    table: String(entry && entry.table || missingTable || ''),
    column: String(entry && entry.name || missingColumn || ''),
    expected: field ? [field.header, ...(field.aliases || [])].slice(0, 6) : [String(header || '')],
    required: Boolean(field && field.required),
    targets: Array.isArray(item && item._scopeTargets) ? item._scopeTargets.slice() : [],
  };
}

/**
 * v3.46'daki depolama hatası eşleme nesnelerini "[object Object]" metnine
 * çevirebildi. Refresh sırasında kullanıcıdan tekrar seçim istemek yerine model
 * şeması taranır, bozuk/zorunlu eksik alanlar otomatik eşlenir ve bağlantı nesnesi
 * yerinde güncellenir. Çağıran katman güncellenen bağlantıları kalıcı kaydeder.
 */
async function ensureConnectionMapping(item, options = {}) {
  const role = normalizedRole(item);
  const normalized = normalizedConnectionMapping(item);
  const missingBefore = modelFields.missingRequired(role, normalized.mapping);
  // V6.62 ile eklenen Teknik Resim zorunlu bir sipariş alanı değildir; ancak
  // eski, eksiksiz bağlantılar yalnız zorunlu alanlara bakıldığı için yeni alanı
  // kendiliğinden öğrenemezdi. ASAS bağlantısında bir kez şema taraması yapıp
  // alanı bulursak mevcut eşlemeye ekler ve kalıcı bağlantıya kaydederiz.
  const enhancementFields = role === 'asas' ? ['Teknik Resim', 'Ürün Tanım'] : [];
  const mappingEnhancementScanVersion = Math.max(0, Number(item && item.mappingEnhancementScanVersion) || 0);
  const missingEnhancements = mappingEnhancementScanVersion < 1
    ? enhancementFields.filter(header => !normalized.mapping[header]) : [];
  const productDescriptionRepairNeeded = role === 'asas' && modelFields.productDescriptionNeedsRepair(normalized.mapping);
  const brokenManualQuery = item && item.mode === 'manual' && /\[object Object\]/i.test(String(item.query || ''));
  const needsRepair = normalized.invalidHeaders.length > 0 || missingBefore.length > 0 || missingEnhancements.length > 0 || productDescriptionRepairNeeded || brokenManualQuery;

  // Eşleme "eksiksiz" olsa bile kimlik alanları yanlış sütuna bağlanmış olabilir;
  // bu durumda sorgu sorunsuz çalışır ama hiçbir satır birebir eşleşmez.
  const suspectWarnings = modelFields.suspectIdentityMappings(role, normalized.mapping).map(item2 =>
    `${connectionLabel(item)}: "${item2.header}" alanı "${item2.column}" sütununa bağlı. ` +
    `Bu alan sipariş eşleşmesinde birebir kullanılıyor; beklenen sütun adları: ${item2.expected.slice(0, 4).join(', ')}. ` +
    `Yanlışsa Kaynak > bağlantı > alan eşlemesinden düzeltin.`);

  if (!needsRepair) {
    item.mapping = normalized.mapping;
    return { repaired: false, mapping: item.mapping, warnings: suspectWarnings };
  }

  // Eşleme sağlam fakat eski üretilmiş manuel DAX bozuksa yeniden şema taramaya
  // gerek yok; bağlantıyı otomatik moda döndürmek yeterlidir.
  if (brokenManualQuery && normalized.invalidHeaders.length === 0 && missingBefore.length === 0) {
    item.mapping = normalized.mapping;
    item.mode = 'auto';
    item.query = '';
    return {
      repaired: true,
      mapping: item.mapping,
      repairedHeaders: [],
      warnings: [`${connectionLabel(item)} içindeki bozuk eski manuel DAX kaldırıldı; bağlantı otomatik sorgu moduna geçirildi.`, ...suspectWarnings],
    };
  }

  const discoverSchema = options.discoverSchema || modelQuery.discoverSchema;
  const telemetry = typeof options.telemetry === 'function' ? options.telemetry : null;
  const schemaStartedMs = Date.now();
  if (telemetry) telemetry({ type:'start', category:'query', connection:connectionLabel(item), operation:'schema-discovery', timestampMs:schemaStartedMs });
  let schema;
  try {
    schema = await discoverSchema({
      server: item.server,
      catalog: item.catalog,
      timeoutMs: options.schemaTimeoutMs || 120000,
    }, options.queryOptions || {});
  } catch (err) {
    if (telemetry) telemetry({ type:'end', category:'query', connection:connectionLabel(item), operation:'schema-discovery', timestampMs:Date.now(), durationMs:Date.now() - schemaStartedMs, error:String(err && err.message || err) });
    throw new ModelRefreshError(
      `${connectionLabel(item)} alan eşlemesi bozuk veya eksik ve model şeması otomatik okunamadı: ${String(err && err.message || err)}`,
      'MODEL_REFRESH_MAPPING_REPAIR_FAILED', 502,
      { invalidHeaders: normalized.invalidHeaders, missingRequired: missingBefore });
  }
  if (telemetry) telemetry({ type:'end', category:'query', connection:connectionLabel(item), operation:'schema-discovery', timestampMs:Date.now(), durationMs:Date.now() - schemaStartedMs });

  const auto = modelFields.autoMapSchema(role, schema);
  // Otomatik eşleme temel olur; bozulmamış kullanıcı seçimleri daha sonra üzerine
  // yazılarak özel seçimler korunur.
  const repairedMapping = modelFields.repairAsasProductDescriptionMapping(
    { ...(auto.mapping || {}), ...normalized.mapping }, schema);
  const missingAfter = modelFields.missingRequired(role, repairedMapping);
  if (missingAfter.length) {
    throw new ModelRefreshError(
      `${connectionLabel(item)} alan eşlemesi otomatik onarıldı ancak zorunlu alanlar modelde bulunamadı: ${missingAfter.join(', ')}`,
      'MODEL_REFRESH_MAPPING_REPAIR_INCOMPLETE', 422,
      { invalidHeaders: normalized.invalidHeaders, missingRequired: missingAfter, schemaErrors: schema.errors || [] });
  }

  item.mapping = repairedMapping;
  const productDescriptionRepaired = productDescriptionRepairNeeded
    && modelFields.fieldKey(repairedMapping['Ürün Tanım'] && repairedMapping['Ürün Tanım'].name) === modelFields.fieldKey('Ürün Ana Tanım');
  if (missingEnhancements.length) item.mappingEnhancementScanVersion = 1;
  if (productDescriptionRepaired) item.mappingEnhancementScanVersion = Math.max(2, Number(item.mappingEnhancementScanVersion) || 0);
  if (brokenManualQuery) {
    item.mode = 'auto';
    item.query = '';
  }
  const repairedHeaders = [...new Set([
    ...normalized.invalidHeaders,
    ...missingBefore,
    ...missingEnhancements.filter(header => repairedMapping[header]),
    ...(productDescriptionRepaired ? ['Ürün Tanım'] : []),
  ])];
  return {
    repaired: true,
    mapping: repairedMapping,
    repairedHeaders,
    warnings: [
      `${connectionLabel(item)} alan eşlemesi otomatik onarıldı${repairedHeaders.length ? `: ${repairedHeaders.join(', ')}` : ''}.`,
      ...(brokenManualQuery ? [`${connectionLabel(item)} otomatik sorgu moduna geçirildi.`] : []),
      ...modelFields.suspectIdentityMappings(role, repairedMapping).map(field =>
        `${connectionLabel(item)}: "${field.header}" alanı "${field.column}" sütununa bağlı; sipariş eşleşmesi bu alanı birebir kullanıyor.`),
    ],
  };
}

function alignHorizonWithMapping(item, mapping) {
  const horizon = { ...(item && item.horizon || {}) };
  const warnings = [];
  let repaired = false;

  const alignField = (header, tableKey, fieldKey, active) => {
    if (!active) return;
    const entry = modelFields.normalizeMappingEntry(mapping && mapping[header], horizon.table);
    if (!entry || !entry.name) {
      // Eşlemede bu başlık yoksa, kullanıcının ufukta ELLE yazdığı sütuna güvenilir.
      // Antrepo (IAS) rolünün alan kataloğunda "Sezon" yoktur; eskiden bu durum
      // sezon filtresini tamamen engelliyordu. Artık yalnız gidilecek hiçbir sütun
      // bilgisi yoksa hata verilir.
      if (String(horizon[fieldKey] || '').trim()) return;
      throw new ModelRefreshError(
        `${connectionLabel(item)} için ${header} sütunu ne alan eşlemesinde ne de ufuk ayarında belirtilmiş; zaman ufku uygulanamadı.`,
        'MODEL_REFRESH_HORIZON_MAPPING_MISSING', 400, { header });
    }
    if (entry.kind === 'measure') {
      throw new ModelRefreshError(
        `${connectionLabel(item)} için ${header} bir ölçüye eşlenmiş. Sezon/tarih filtresi normal bir model sütununa bağlanmalıdır.`,
        'MODEL_REFRESH_HORIZON_MEASURE_INVALID', 400, { header, entry });
    }
    const nextTable = String(entry.table || horizon.table || '').trim();
    const nextField = String(entry.name || '').trim();
    if (!nextTable || !nextField) return;
    // Kullanıcı ufuk sütununu elle doldurduysa eşlemeden gelen değer onu ezmez.
    if (String(horizon[fieldKey] || '').trim() && String(horizon[tableKey] || '').trim()) return;
    if (String(horizon[tableKey] || '').trim() !== nextTable || String(horizon[fieldKey] || '').trim() !== nextField) {
      horizon[tableKey] = nextTable;
      horizon[fieldKey] = nextField;
      repaired = true;
      warnings.push(`${header} filtresi model eşlemesine göre ${nextTable}[${nextField}] alanına bağlandı.`);
    }
  };

  alignField('Sezon', 'seasonTable', 'seasonField', Array.isArray(horizon.seasons) && horizon.seasons.length > 0);
  alignField('Orijinal Exfactory Merch Tarih', 'dateTable', 'dateField', Boolean(horizon.dateStart || horizon.dateEnd));

  if (repaired && item) item.horizon = horizon;
  return { horizon, repaired, warnings };
}

function sameMappingEntry(a, b, fallbackTable = '') {
  const left = modelFields.normalizeMappingEntry(a, fallbackTable);
  const right = modelFields.normalizeMappingEntry(b, fallbackTable);
  return Boolean(left && right && left.kind === right.kind
    && String(left.table || fallbackTable) === String(right.table || fallbackTable)
    && String(left.name || '') === String(right.name || ''));
}

function matchingProjectionMapping(item, role, existingMapping, ruleValue) {
  if (role !== 'asas' && role !== 'antrepo') return {};
  const config = normalizeAntrepoMatchConfig(ruleValue);
  const fallbackTable = String(item && item.horizon && item.horizon.table || '').trim();
  const out = {};
  // Yalnız sipariş ↔ antrepo birleştirmesini kısıtlayan koşullar projekte edilir.
  // Başka bir kaynak çiftine ait koşulu buraya eklemek sorgunun granülerliğini
  // sessizce değiştirir ve satırları böler.
  for (const condition of matchConditionsForPair(config, 'asas', 'antrepo')) {
    // Operand önce KAYNAK KİMLİĞİYLE aranır: aynı rolde birden çok bağlantı
    // varsa her biri kendi sütununu projekte etmelidir.
    const side = matchOperandForSource(condition, item && item.id, role);
    let entry = null;
    if (side && side.table && side.name) entry = { table: side.table, name: side.name, kind: 'column' };
    const canonical = side && (side.canonicalHeader || side.header);
    if (!entry && canonical && existingMapping && existingMapping[canonical]) entry = existingMapping[canonical];
    entry = modelFields.normalizeMappingEntry(entry, fallbackTable);
    if (!entry || !entry.name || entry.kind === 'measure') continue;
    // Aynı model sütunu zaten kanonik bir başlıkla sorgulanıyorsa ikinci kez
    // SUMMARIZECOLUMNS'a eklemek hata üretir. Parser kanonik alanı config içindeki
    // canonicalHeader üzerinden okuyabilir.
    const duplicate = Object.values(existingMapping || {}).some(value => sameMappingEntry(value, entry, fallbackTable));
    if (!duplicate) out[`__MATCH_${condition.id}`] = entry;
  }
  return out;
}


// IAS sorgusu yalnız Backlog/CP'nin gerçekten kullandığı satır alanlarını projekte
// eder. Sezon/MAG/MMYG gibi Ufuk alanları filtre ifadesinde kullanılmaya devam
// eder; çıktı gruplamasına katılmaz. Bu alanların farklı boyut tablolarından
// gelmesi eski sorguda gereksiz kombinasyonlar üretebiliyordu.
function antrepoProjectionMapping(mapping, ruleValue) {
  const source = mapping && typeof mapping === 'object' ? mapping : {};
  const excluded = new Set(modelFields.fieldsForRole('antrepo')
    .filter(field => field.usedBy === 'Ufuk')
    .map(field => field.header));
  // Net Alım Sipariş Miktarı IAS projeksiyonuna alınmaz; sipariş toplamının
  // tek yetkili kaynağı ASAS'tır. IAS yalnız parsiyel Yükleme Toplam Adet ve
  // operasyon alanlarını sağlar.

  const config = normalizeAntrepoMatchConfig(ruleValue);
  const requiredByRule = new Set(config.conditions
    .map(condition => {
      const side = matchOperandForRole(condition, 'antrepo');
      return side && (side.canonicalHeader || side.header);
    })
    .filter(Boolean));
  const out = {};
  for (const [header, entry] of Object.entries(source)) {
    if (header === 'Net Alım Sipariş Miktarı') continue;
    if (excluded.has(header) && !requiredByRule.has(header)) continue;
    out[header] = entry;
  }
  return out;
}

// IAS sorgusunun başlayacağı gerçek parsiyel fact/grain tablosu. İthalat
// Dosya No ve Konteyner No gibi alanlar ölçü değil, fact satırının normal
// sütunlarıdır. SUMMARIZECOLUMNS yerine bu tablo satır satır projekte edilir.
function antrepoGrainTable(mapping, fallbackTable = '') {
  const headers = ['İthalat Dosya No', 'Konteyner No'];
  for (const header of headers) {
    const entry = modelFields.normalizeMappingEntry(mapping && mapping[header], fallbackTable);
    if (entry && entry.kind === 'column' && entry.table) return entry.table;
  }
  return '';
}

/* v7.83 — FİLTRE DEĞERLERİNİN TİPİ KAYNAĞIN ŞEMASINDAN ÇÖZÜLÜR.

   Kaydedilmiş bir koşul, kurulduğu andaki arayüz tahminini (`valueType`)
   taşır. Model sütunu sayıysa ve kayıtta 'text' yazıyorsa DAX'a `IN { "123" }`
   yazılıyor ve yenileme tip hatasıyla düşüyordu. Şema tipi otoriterdir ve
   kayıtlı tahmini ezer.

   BEST-EFFORT: şema okunamazsa (VPN, yetki, zaman aşımı) çözücü null döner ve
   predicate üreticisi kayıtlı `valueType` ile bugünkü davranışına düşer. Tip
   metadata'sı için bir yenilemeyi DURDURMAK, düzelttiğinden büyük bir zarardır.
   Şema keşfi 10 dakika önbelleklidir; yenileme başına ek bir tarama doğurmaz. */
async function resolveColumnTypes(item, options = {}) {
  if (typeof options.columnType === 'function') return options.columnType;
  if (options.columnType === false) return null;
  try {
    const discoverSchema = options.discoverSchema || modelQuery.discoverSchema;
    const schema = await discoverSchema({
      server: item && item.server, catalog: item && item.catalog,
      timeoutMs: options.schemaTimeoutMs || 120000,
    }, options.queryOptions || {});
    return filterValueTypes.columnTypeIndex(schema);
  } catch (_) {
    return null;
  }
}
function buildConnectionQuery(item, options = {}) {
  const mode = item && item.mode === 'manual' ? 'manual' : 'auto';
  const role = normalizedRole(item);
  if (mode === 'manual') {
    const query = String(item && item.query || '').trim();
    if (!query) throw new ModelRefreshError(`${connectionLabel(item)} için manuel sorgu boş.`, 'MODEL_REFRESH_QUERY_MISSING', 400);
    return { query, headerMap: null, warnings: [], role, mode, generated: false };
  }
  const horizon = item && item.horizon || {};
  if (!String(horizon.table || '').trim()) {
    throw new ModelRefreshError(`${connectionLabel(item)} için otomatik sorgu tablosu seçilmedi.`, 'MODEL_REFRESH_TABLE_MISSING', 400);
  }
  const baseMapping = item && item.mapping && Object.keys(item.mapping).length ? item.mapping : null;
  const cpMapping = {};
  const scopeTargets = Array.isArray(item && item._scopeTargets) ? item._scopeTargets : [];
  const includeCpColumns = !scopeTargets.length || scopeTargets.includes('cp');
  if (includeCpColumns) {
    for (const col of Array.isArray(item && item.cpColumns) ? item.cpColumns : []) {
      if (!col || !col.header || !col.name) continue;
      cpMapping[col.header] = { table: col.table || '', name: col.name, kind: col.kind === 'measure' ? 'measure' : 'column', folder: col.folder || '' };
    }
  }
  const mappedBase = baseMapping ? { ...baseMapping, ...cpMapping } : (Object.keys(cpMapping).length ? cpMapping : null);
  const matchMapping = matchingProjectionMapping(item, role, mappedBase || {}, options.matchRule);
  const fullMapping = mappedBase ? { ...mappedBase, ...matchMapping } : (Object.keys(matchMapping).length ? matchMapping : null);
  if (!fullMapping) {
    throw new ModelRefreshError(`${connectionLabel(item)} için alan eşlemesi yapılmadı.`, 'MODEL_REFRESH_MAPPING_MISSING', 400);
  }
  const missing = modelFields.missingRequired(role, fullMapping);
  if (missing.length) {
    throw new ModelRefreshError(`${connectionLabel(item)} için zorunlu alanlar eşleştirilmedi: ${missing.join(', ')}`, 'MODEL_REFRESH_MAPPING_INCOMPLETE', 400, { missingRequired: missing });
  }
  // Ufuk sütunları çıktıdan çıkarılsa bile sezon/tarih filtrelerinin hangi model
  // alanına bağlı olduğu önce tam eşleme üzerinden çözülür.
  const aligned = alignHorizonWithMapping(item, fullMapping);
  const mapping = role === 'antrepo'
    ? antrepoProjectionMapping(fullMapping, options.matchRule)
    : fullMapping;
  const horizonWithExtra = options.extraExpression
    ? { ...aligned.horizon, extraExpression: options.extraExpression }
    : aligned.horizon;
  let built;
  if (role === 'antrepo') {
    const grainTable = antrepoGrainTable(mapping, aligned.horizon.table);
    if (!grainTable) {
      throw new ModelRefreshError(
        `${connectionLabel(item)} için IAS parsiyel fact tablosu belirlenemedi. Field Mapping içinde İthalat Dosya No alanını gerçek bir model sütununa bağlayın.`,
        'MODEL_REFRESH_ANTREPO_GRAIN_MISSING', 422,
        { requiredField: 'İthalat Dosya No' });
    }
    // IAS satırları artık gruplanmaz. Gerçek fact tablosunun her satırı ayrı bir
    // parsiyel olarak SELECTCOLUMNS ile projekte edilir; ölçüler o satırın
    // bağlamında hesaplanır. Böylece farklı sipariş/renk kombinasyonları çapraz
    // çoğalmaz ve aynı siparişin parsiyelleri tek satırda toplanmaz.
    built = modelHorizon.buildFactRowQuery(horizonWithExtra, mapping, { grainTable, columnType: options.columnType });
  } else {
    built = modelHorizon.buildMappedQuery(horizonWithExtra, mapping, { columnType: options.columnType });
  }
  return {
    query: built.query,
    headerMap: built.headerMap || null,
    warnings: [...(aligned.warnings || []), ...(built.warnings || [])],
    role,
    mode,
    horizonRepaired: Boolean(aligned.repaired),
    generated: true,
  };
}

async function queryConnectionRows(item, options = {}) {
  if (options.signal && options.signal.aborted) {
    throw new ModelRefreshError('Yenileme kullanıcı tarafından durduruldu.', 'REFRESH_CANCELLED', 409);
  }
  const telemetry = typeof options.telemetry === 'function' ? options.telemetry : null;
  const label = connectionLabel(item);
  const mappingStartedMs = Date.now();
  if (telemetry) telemetry({ type:'start', category:'wait', connection:label, operation:'mapping-check', timestampMs:mappingStartedMs });
  let repair;
  try {
    repair = await ensureConnectionMapping(item, options);
  } catch (error) {
    if (telemetry) telemetry({ type:'end', category:'wait', connection:label, operation:'mapping-check', timestampMs:Date.now(), durationMs:Date.now() - mappingStartedMs, error:String(error && error.message || error) });
    throw error;
  }
  const mappingMs = Date.now() - mappingStartedMs;
  if (telemetry) telemetry({ type:'end', category:'wait', connection:label, operation:'mapping-check', timestampMs:Date.now(), durationMs:mappingMs });
  const columnType = await resolveColumnTypes(item, options);
  const built = buildConnectionQuery(item, { extraExpression: options.extraExpression, matchRule: options.matchRule, columnType });
  debugGeneratedDax(label, built.query, options);
  const runRows = options.runModelRows || modelQuery.runModelRows;
  const queryStartedMs = Date.now();
  const queryPlan={
    connectionId:item.id, server:item.server, catalog:item.catalog, role:item.role,
    query:built.query, requiredFields:built.headerMap||null,
    queryOptions:Object.fromEntries(Object.entries(options.queryOptions||{}).filter(([key])=>key!=='signal')),
  };
  const execute=()=>runRows({
    server: item.server,
    catalog: item.catalog,
    query: built.query,
    headerMap: built.headerMap,
    // Uygulamanın ürettiği sorgular kullanıcı metni değildir; uzunluk sınırı ayrıdır.
    generated: Boolean(built.generated),
    maxRows: 2000000,
    timeoutMs: options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
  }, { ...(options.queryOptions || {}), signal:options.signal || (options.queryOptions && options.queryOptions.signal) });
  let result;
  try {
    result = options.queryCoordinator
      ? await options.queryCoordinator.run(queryPlan, execute)
      : await execute();
  } catch (error) {
    if (telemetry) telemetry({ type:'measure', category:'query', connection:label, operation:'model-query-failed', timestampMs:queryStartedMs, durationMs:Date.now() - queryStartedMs, error:String(error && error.message || error) });
    const repairAction = fieldMappingRepairFromError(item, error);
    if (repairAction && repairAction.sourceId && repairAction.header) {
      throw new ModelRefreshError(
        String(error && (error.publicMessage || error.message) || error),
        'MODEL_REFRESH_FIELD_MAPPING_REQUIRED',
        422,
        {
          repairAction,
          originalCode: String(error && error.code || ''),
        });
    }
    throw error;
  }
  const providerMs = Number(result.elapsedMs) || 0;
  const parseMs = Number(result.parseMs) || 0;
  const connectionOpenMs = Number(result.connectionOpenMs) || 0;
  const executeMs = Number(result.executeMs) || 0;
  const writeMs = Number(result.writeMs) || 0;
  const retryMs = Number(result.retryMs) || 0;
  const setupMs = Number(result.setupMs) || 0;
  const cleanupMs = Number(result.cleanupMs) || 0;
  const overheadMs = Number(result.overheadMs) || Math.max(0, providerMs - connectionOpenMs - executeMs - writeMs - retryMs);
  if (telemetry) {
    let componentStartedMs = queryStartedMs;
    const components = [
      ['wait', 'provider-setup', setupMs || overheadMs],
      ['connection-open', 'connection-open', connectionOpenMs],
      ['query', 'server-query', executeMs],
      ['retry', 'retry', retryMs],
      ['wait', 'result-write', writeMs],
      ['wait', 'provider-cleanup', cleanupMs],
      ['wait', 'node-parse', parseMs],
    ];
    for (const [category, operation, durationMs] of components) {
      telemetry({ type:'measure', category, connection:label, operation, timestampMs:componentStartedMs, durationMs });
      componentStartedMs += durationMs;
    }
  }
  if (result.truncated) {
    throw new ModelRefreshError(`${connectionLabel(item)} sonucu 2.000.000 satır sınırına ulaştı; eksik veriyle refresh yapılmadı. Ufuk ayarını daraltın.`, 'MODEL_REFRESH_TRUNCATED', 409);
  }
  // Boş-ölçü satırı eleme koruması yalnız DAX'ı ayakta tutmak için vardır; sonuçta
  // görünmesi gerekmez. Ayrıştırıcılar zaten yok sayıyor, ama önizleme ve sütun
  // listelerinde kafa karıştırmasın diye burada temizlenir.
  const rows = Array.isArray(result.rows) ? result.rows : [];
  for (const row of rows) {
    if (row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, modelHorizon.BLANK_ROW_GUARD)) {
      delete row[modelHorizon.BLANK_ROW_GUARD];
    }
  }
  return {
    item,
    rows,
    query: built.query,
    queryFingerprint: options.queryCoordinator ? options.queryCoordinator.fingerprint(queryPlan) : '',
    warnings: [...(repair.warnings || []), ...(built.warnings || [])],
    mappingRepaired: Boolean(repair.repaired || built.horizonRepaired),
    repairedHeaders: repair.repairedHeaders || [],
    summary: {
      at: new Date().toISOString(),
      ok: true,
      rowCount: Number(result.rowCount) || (Array.isArray(result.rows) ? result.rows.length : 0),
      elapsedMs: Number(result.elapsedMs) || 0,
      provider: String(result.provider || ''),
      outFile: '',
      error: '',
    },
    // Bileşenlerin toplamı bağlantının gerçek uçtan uca süresidir. PowerShell
    // süreç/sağlayıcı hazırlığı ve bağlantı açma artık SQL execution'a karışmaz.
    timings: {
      totalMs: mappingMs + providerMs + parseMs,
      mappingMs,
      connectionOpenMs: Number(result.connectionOpenMs) || 0,
      executeMs: Number(result.executeMs) || 0,
      writeMs: Number(result.writeMs) || 0,
      parseMs,
      retryMs: Number(result.retryMs) || 0,
      setupMs,
      cleanupMs,
      overheadMs,
      uiBlockingMs: Number(result.uiBlockingMs) || 0,
    },
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values || []), results = new Array(items.length);
  const limit = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 2));
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length:limit }, () => worker()));
  return results;
}

/**
 * Bir bağlantının etkin kapsamlarını çalıştırır.
 * Aynı kapsam birden çok hedefi besliyorsa TEK sorgu çalışır; hedefler ayrı
 * kapsamlara konmuşsa her biri kendi koşullarıyla ayrı sorgu olur.
 * Döner: Map(hedef → { scope, run })
 */
// Bir roldeki TÜM aktif bağlantıların kapsamlarını birlikte çözer.
// Her hedef tek bir (bağlantı, kapsam) çiftine bağlanır; ilk talep eden kazanır.
function resolveRoleTargets(items, role) {
  const claimed = new Map();
  const conflicts = [];
  for (const item of items) {
    for (const scope of effectiveScopes(item)) {
      if (scope.enabled === false) continue;
      for (const target of scope.targets || []) {
        if (claimed.has(target)) {
          conflicts.push(`${connectionLabel(item)} · ${modelScopes.scopeLabel(scope)} kapsamı ${target.toUpperCase()} hedefini de istiyor, ancak bu hedef ${connectionLabel(claimed.get(target).item)} tarafından karşılanıyor.`);
          continue;
        }
        claimed.set(target, { item, scope });
      }
    }
  }
  return { claimed, conflicts };
}

function effectiveScopes(item) {
  if (Array.isArray(item.scopes) && item.scopes.length) return item.scopes;
  // Kapsamsız (eski) kayıt rolün tüm hedeflerini besler sayılır — ancak kullanıcının
  // Veri Yönetimi'nden bilerek kapattığı modüller HARİÇ; yoksa kapatılan besleme
  // bu kurtarma dalından geri girerdi.
  const detached = new Set((Array.isArray(item.parkedBindings) ? item.parkedBindings : [])
    .map(entry => String(entry && entry.moduleId || '').trim()).filter(Boolean));
  const targets = modelScopes.allowedTargets(normalizedRole(item)).filter(target => !detached.has(target));
  if (!targets.length) return [];
  return [{
    id: `${item.id || 'conn'}-default`, name: '',
    targets,
    enabled: true, limitToCpOrders: false, horizon: item.horizon || {},
  }];
}

/**
 * Roldeki bağlantıların kapsamlarını çalıştırır.
 * Döner: { byTarget: Map(hedef → {item, scope, run}), warnings }
 */
async function runRoleScopes(items, role, options = {}, perScopeOptions = () => ({})) {
  const { claimed, conflicts } = resolveRoleTargets(items, role);
  let entries = [...claimed.entries()];
  if (Array.isArray(options.targets) && options.targets.length) {
    const wanted = new Set(options.targets);
    entries = entries.filter(([target]) => wanted.has(target));
  }
  // Aynı (bağlantı, kapsam) çiftini iki kez sorgulamayalım.
  const jobs = new Map();
  for (const [, entry] of entries) {
    const key = `${entry.item.id}|${entry.scope.id}`;
    if (!jobs.has(key)) jobs.set(key, entry);
  }
  const results = await mapWithConcurrency([...jobs.entries()], options.maxConcurrency || 2, async ([key, entry]) => {
    const scoped = { ...entry.item, horizon: entry.scope.horizon, _scopeTargets: entry.scope.targets || [] };
    const extra = await perScopeOptions(entry.scope, entry.item);
    return [key, await queryConnectionRows(scoped, { ...options, ...extra })];
  });
  const runs = new Map(results);
  const byTarget = new Map();
  for (const [target, entry] of entries) {
    byTarget.set(target, { ...entry, run: runs.get(`${entry.item.id}|${entry.scope.id}`) });
  }
  return { byTarget, warnings: conflicts };
}

async function runConnectionScopes(item, options = {}, perScopeOptions = () => ({})) {
  // Kapsam tanımlanmamışsa bağlantının tek ufku, rolün izin verdiği tüm hedefleri
  // besleyen bir kapsam sayılır. Böylece eski kayıtlar ve doğrudan kurulan
  // bağlantı nesneleri davranış değiştirmeden çalışır.
  const scopes = (Array.isArray(item.scopes) && item.scopes.length)
    ? item.scopes
    : [{ id: `${item.id || 'conn'}-default`, name: '', targets: modelScopes.allowedTargets(normalizedRole(item)), enabled: true, horizon: item.horizon || {} }];
  let byTarget = modelScopes.scopeByTarget(scopes);
  // Kısmi yenileme: yalnız istenen sayfaların kapsamları çalışır. Bir sayfayı tek
  // başına güncellerken diğerlerinin sorgusu hiç atılmaz.
  if (Array.isArray(options.targets) && options.targets.length) {
    const wanted = new Set(options.targets);
    byTarget = new Map([...byTarget].filter(([target]) => wanted.has(target)));
  }
  const uniqueScopes = [...new Map([...byTarget.values()].map(scope => [scope.id, scope])).values()];
  // Kapsamlar birbirinden bağımsız sorgulardır; sırayla çalıştırmak toplam süreyi
  // gereksiz yere sürelerin toplamına çıkarırdı.
  const results = await mapWithConcurrency(uniqueScopes, options.maxConcurrency || 2, async scope => {
    const scoped = { ...item, horizon: scope.horizon, _scopeTargets: scope.targets || [] }; // kapsamın ufku geçerlidir
    const extra = await perScopeOptions(scope);
    return [scope.id, await queryConnectionRows(scoped, { ...options, ...extra })];
  });
  const runs = new Map(results);
  const out = new Map();
  for (const [target, scope] of byTarget) out.set(target, { scope, run: runs.get(scope.id) });
  return out;
}

// v4.09: Antrepo'yu ASAS sipariş kodlarına göre daraltan mekanizma kaldırıldı.
// Gerekçe: bu daraltma, iki modelden gelen sipariş kodu biçimleri birebir
// tutmadığında Antrepo satırlarını sessizce eleyip CP'de yanlış "Üretimde"
// üretiyordu. Antrepo artık yalnız kendi kapsam koşullarıyla çalışır ve
// ASAS sorgusunu beklemez (iki sorgu paralel gider).

/**
 * Antrepo sonucunun CP tarafıyla gerçekten eşleşip eşleşmediğini raporlar.
 *
 * Bu rapor olmadan, sütun adı tutmadığında ya da anahtarlar uyuşmadığında sistem
 * SESSİZCE bütün siparişleri "Üretimde" gösteriyordu: kullanıcı için hata yok,
 * uyarı yok, yalnız yanlış veri. Artık her yenilemede kaç satır geldiği, hangi
 * sütunların hangi model sütunlarından okunduğu ve kaç siparişin eşleştiği
 * bildirimde görünür.
 */
function describeAntrepoMatch(target, map, orders, run, ruleValue) {
  const label = String(target || '').toUpperCase();
  const meta = antrepoParseMeta(map) || {};
  const warnings = [];
  const columns = Array.isArray(meta.columns) ? meta.columns : [];
  const config = normalizeAntrepoMatchConfig(ruleValue);

  if (meta.ok === false) {
    warnings.push(
      `Antrepo (${label}): ${meta.reason || 'sonuç okunamadı.'} Modelden dönen sütunlar: ${columns.length ? columns.join(', ') : '(yok)'}. ` +
      `Horizon ve Bağlantı içindeki IAS Field Mapping alanlarını doğrulayın.`);
    return warnings;
  }

  const diag = {};
  let matched = 0;
  const unmatchedSamples = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const hit = findAntrepoHit(map, order, { rule: config, diag });
    if (hit) matched++;
    else if (unmatchedSamples.length < 5) {
      unmatchedSamples.push(dynamicAntrepoMatchKey(order, 'asas', config) || '(eksik koşul)');
    }
  }

  const total = Array.isArray(orders) ? orders.length : 0;
  warnings.push(
    `Antrepo (${label}): eşleştirme kuralı "${antrepoMatchConfigLabel(config)}". ` +
    `Modelden ${meta.dataRows || 0} satır, ${meta.keyCount || 0} kayıt; ${total} ASAS satırının ${matched} tanesi bütün koşullarla birebir eşleşti.`);

  if (!meta.matchableRows) {
    warnings.push(
      `Antrepo (${label}): seçili koşulların tamamı dolu olan IAS satırı bulunamadı. ` +
      `ASAS - IAS Eşleştirme Kuralı ekranındaki sütun seçimlerini ve IAS Field Mapping ayarlarını doğrulayın.`);
  } else if (meta.matchableRows < (meta.dataRows || 0)) {
    warnings.push(
      `Antrepo (${label}): ${(meta.dataRows || 0) - meta.matchableRows} IAS satırında seçili koşullardan en az biri boş olduğu için satır eşleştirmeye alınmadı.`);
  }
  if (diag.ambiguous) {
    if (label === 'BACKLOG') {
      warnings.push(
        `Antrepo (${label}): ${diag.ambiguous} ASAS siparişi birden fazla birebir IAS kaydına denk geldi. ` +
        `Bu kayıtlar Backlog'da ayrı parsiyeller olarak korunur; her parsiyelin miktarı IAS Yükleme Toplam Adet alanından alınır.`);
    } else if (label === 'CP') {
      warnings.push(
        `Antrepo (${label}): ${diag.ambiguous} ASAS satırı birden fazla birebir IAS kaydına denk geldi. ` +
        `CP'nin mevcut çalışma düzeni gereği Tahmini Antrepo Giriş Tarihi en yeni olan IAS satırı, alanları başka satırlarla birleştirilmeden, tek parça hâlinde kullanılır.`);
    } else {
      warnings.push(
        `Antrepo (${label}): ${diag.ambiguous} ASAS satırı birden fazla birebir IAS kaydına denk geldi; hedef ekran kendi parsiyel kuralına göre bu kayıtları işler.`);
    }
  }
  if (diag.targetIncomplete) {
    warnings.push(
      `Antrepo (${label}): ${diag.targetIncomplete} ASAS satırında seçili koşullardan en az biri boş olduğu için IAS verisi bağlanmadı.`);
  }
  if (matched < total) {
    const iasSamples = Object.values(map || {}).slice(0, 5)
      .map(entry => dynamicAntrepoMatchKey(entry, 'ias', config) || '(eksik koşul)');
    warnings.push(
      `Antrepo (${label}): eşleşmeyen ASAS anahtar örnekleri — ${unmatchedSamples.join(' , ') || '(yok)'}. ` +
      `IAS anahtar örnekleri — ${iasSamples.join(' , ') || '(yok)'}. Bütün koşullar AND ile bağlıdır; tek fark bile eşleşmeyi engeller.`);
  }

  const counts = Array.isArray(meta.statusCounts) ? meta.statusCounts : [];
  if (counts.length) {
    const shown = counts.slice(0, 12).map(([name, count]) => `${name} ${count}`).join(' · ');
    const rest = counts.length > 12 ? ` (+${counts.length - 12} statü daha)` : '';
    warnings.push(`Antrepo (${label}): modelden gelen statü dağılımı — ${shown}${rest}.`);
  }
  if (meta.blankStatus) {
    warnings.push(`Antrepo (${label}): ${meta.blankStatus} satırda Supplier Portal Statü boş geldi; eşleşse bile bu satırlar CP'de Üretimde görünür.`);
  }
  if (meta.blankLoadedQty) {
    warnings.push(
      `Antrepo (${label}): ${meta.blankLoadedQty} IAS satırında Yükleme Toplam Adet boş veya sayısal değil. ` +
      `Backlog parsiyel miktarı bu alan olmadan doğru hesaplanamaz; IAS Field Mapping içindeki Yükleme Toplam Adet eşlemesini ve kaynak veriyi kontrol edin.`);
  }
  if (total && !matched) {
    const audit = auditAntrepoMatching(orders, map, config);
    const risky = Object.values(audit.fields || {})
      .filter(field => field.shared === 0)
      .map(field => field.label)
      .slice(0, 4);
    warnings.push(
      `Antrepo (${label}): HİÇBİR satır eşleşmedi; IAS bilgisi bağlanmadı. ` +
      `${risky.length ? `Ortak değeri olmayan koşullar: ${risky.join(' · ')}. ` : ''}` +
      `ASAS - IAS Eşleştirme Kuralı ekranındaki Denetle işlevini kullanın.`);
  }
  return warnings;
}


// IAS model sonucunu Backlog'a vermeden önce yalnız kesin, tahminsiz veri
// bütünlüğü kontrolleri uygulanır. Sipariş miktarının aşılması tek başına hata
// değildir; manuel IAS verisinde gerçek fazla yüklemeler bulunabildiği için oran
// veya tolerans üzerinden satır silinmez ya da refresh engellenmez.
function validateAntrepoIntegrity(target, map, orders, ruleValue) {
  const meta = antrepoParseMeta(map) || {};
  const label = String(target || '').toUpperCase();
  const warnings = [];
  if (meta.ok === false) {
    // IAS'da hiç satır bulunmaması geçerli bir durumdur: ASAS siparişlerinin
    // tamamı henüz üretimde olabilir. Başlıksız/boş sonuçta zorunlu alanları
    // tahmin etmeyiz ama refresh'i de yanlışlıkla engellemeyiz. Satır geldiyse
    // ve zorunlu sütunlar çözülemiyorsa veri bütünlüğü hatasıdır.
    const returnedRows = Math.max(Number(meta.dataRows) || 0, Number(meta.rowCount) || 0);
    if (!returnedRows) return warnings;
    throw new ModelRefreshError(
      `Antrepo (${label}) veri bütünlüğü hatası: ${meta.reason || 'zorunlu IAS sütunları çözülemedi.'} Yanlış Backlog üretilmedi.`,
      'MODEL_REFRESH_ANTREPO_COLUMNS_MISSING', 422,
      { target: label, missing: meta.missing || [] });
  }
  if (Number(meta.blankLoadedQty) > 0) {
    throw new ModelRefreshError(
      `Antrepo (${label}) veri bütünlüğü hatası: ${meta.blankLoadedQty} IAS satırında Yükleme Toplam Adet boş veya sayısal değil. Parsiyel miktarı tahmin edilmedi ve yanlış Backlog üretilmedi.`,
      'MODEL_REFRESH_ANTREPO_LOADED_QTY_MISSING', 422,
      { target: label, blankLoadedQty: meta.blankLoadedQty });
  }

  // IAS Net Alım Sipariş Miktarı bilinçli olarak doğrulanmaz; bu alan Backlog
  // hesabında kullanılmaz. Sipariş toplamı her zaman ASAS'tan gelir.

  if (Number(meta.keyCount) !== Number(meta.matchableRows)) {
    throw new ModelRefreshError(
      `Antrepo (${label}) veri bütünlüğü hatası: eşleşebilir IAS satırlarının tamamı bağımsız parsiyel olarak korunamadı. Yanlış Backlog üretilmedi.`,
      'MODEL_REFRESH_ANTREPO_ROW_GRAIN_LOST', 409,
      { target: label, keyCount: meta.keyCount, matchableRows: meta.matchableRows });
  }
  if (meta.blankPartialIdentity > 0) {
    warnings.push(
      `Antrepo (${label}): ${meta.blankPartialIdentity} IAS satırında İthalat Dosya No boş geldi. Fact satırları yine ayrı parsiyel olarak korunmuştur; kaynak veri kalitesi için dosya numarasını kontrol edin.`);
  }
  return warnings;
}

async function loadFromModelConnections(items, options = {}) {
  const includeAntrepo = options.includeAntrepo !== false;
  const includeAsas = options.includeAsas !== false;
  // LFL'in kaynağı artık ASAS'tan bağımsız seçilebilir. Belirtilmezse eski davranış
  // korunur (LFL, ASAS ile aynı kaynağı kullanır).
  const includeLfl = options.includeLfl === undefined ? includeAsas : options.includeLfl !== false;
  // ASAS bağlantısı, sipariş hedeflerinden VEYA LFL'den en az biri Database'den
  // besleniyorsa gereklidir.
  const needsAsasConnection = includeAsas || includeLfl;
  const selected = selectRefreshConnections(items, { includeAntrepo, includeAsas: needsAsasConnection });

  // 1) ASAS kapsamları. CP, Orders, Backlog ve LFL aynı kapsamdaysa tek sorgu; ayrı
  //    kapsamlardaysa her hedef kendi koşullarıyla ayrı sorgu alır. ASAS Kaynağı
  //    Excel seçiliyse bu bağlantı hiç sorgulanmaz; çağıran katman ASAS Excel'den
  //    okunan sipariş/LFL satırlarını presetAsasOrdersByTarget/presetLfl ile geçirir.
  // Antrepo artık ASAS sipariş kodlarına bağlı olmadığı için iki bağlantı
  // her zaman paralel başlar.
  // Yalnız gerçekten Database'den beslenen hedefler sorgulanır: ASAS Excel + LFL
  // Database seçiliyken CP/Orders/Backlog kapsamları boşuna çalıştırılmaz.
  const requestedTargets = Array.isArray(options.targets) && options.targets.length
    ? options.targets : ['cp', 'orders', 'backlog', 'lfl', 'priceanalysis'];
  const asasQueryTargets = requestedTargets.filter(target => (target === 'lfl' ? includeLfl : includeAsas));
  const queryCoordinator = options.queryCoordinator || createSourceQueryCoordinator();
  const queryOptions = { ...options, queryCoordinator };
  const asasPromise = needsAsasConnection && asasQueryTargets.length
    ? runRoleScopes(selected.asasList, 'asas', { ...queryOptions, targets: asasQueryTargets })
    : null;
  const antrepoPromise = includeAntrepo && selected.antrepoList.length
    ? runRoleScopes(selected.antrepoList, 'antrepo', queryOptions)
    : null;
  const asasResult = asasPromise ? await asasPromise : { byTarget: new Map(), warnings: [] };
  const asasByTarget = asasResult.byTarget;
  if (asasPromise && !asasByTarget.size) {
    const wanted = Array.isArray(options.targets) && options.targets.length ? ` (${options.targets.join(', ')})` : '';
    throw new ModelRefreshError(
      `${connectionLabel(selected.asas)} için${wanted} etkin bir kapsam yok; hangi sayfaları besleyeceği tanımlanmalı.`,
      'MODEL_REFRESH_NO_SCOPE', 400);
  }

  const connectionWarnings = [...asasResult.warnings];
  const asasOrdersByTarget = {};
  const fabricHeaderInfoByTarget = {};
  if (includeAsas) {
    for (const target of ['cp', 'orders', 'backlog', 'priceanalysis']) {
      const entry = asasByTarget.get(target);
      if (!entry) continue;
      const parsed = parseASASRows(entry.run.rows, options.matchRule);
      if (!parsed || !Array.isArray(parsed.orders)) {
        throw new ModelRefreshError(
          `${connectionLabel(selected.asas)} · ${modelScopes.scopeLabel(entry.scope)} sonucunda “Sipariş Kod” alanı bulunamadı.`,
          'MODEL_REFRESH_ASAS_PARSE_FAILED', 422);
      }
      asasOrdersByTarget[target] = parsed.orders;
      fabricHeaderInfoByTarget[target] = parsed.fabricHeaderInfo || null;
    }
  } else {
    const preset = options.presetAsasOrdersByTarget || {};
    for (const target of ['cp', 'orders', 'backlog', 'priceanalysis']) {
      if (preset[target]) asasOrdersByTarget[target] = preset[target];
    }
  }

  // 2) LFL kendi kapsamından; kapsamı yoksa CP kapsamının satırlarından üretilir.
  //    ASAS Excel modunda LFL de aynı ASAS çalışma kitabından (presetLfl) gelir.
  const wantsLfl = !Array.isArray(options.targets) || !options.targets.length || options.targets.includes('lfl');
  let parsedLfl;
  if (!includeLfl) {
    const presetLfl = wantsLfl && options.presetLfl ? options.presetLfl : null;
    parsedLfl = presetLfl ? { rows: presetLfl.rows, meta: presetLfl.meta } : { rows: null, meta: null };
  } else {
    const lflEntry = wantsLfl ? (asasByTarget.get('lfl') || asasByTarget.get('cp') || asasByTarget.get('backlog')) : null;
    if (!lflEntry) parsedLfl = { rows: null, meta: null };
    else
    try { parsedLfl = parseLFLRows(lflEntry.run.rows, connectionLabel(selected.asas)); }
    catch (err) {
      parsedLfl = { rows: [], meta: { rowCount: 0, warnings: [`LFL verisi model sonucundan üretilemedi: ${err.message}`], dimensions: {} } };
    }
  }
  const enrichedLflRows = Array.isArray(parsedLfl.rows) ? parsedLfl.rows : [];
  parsedLfl = { ...parsedLfl, rows: enrichedLflRows, meta: withFabricDimensions(parsedLfl.meta, enrichedLflRows || []) };

  // 3) Antrepo (IAS) yalnız CP, Orders ve Backlog için çalışır. Sipariş kodu daraltması
  //    yoktur: her kapsam kendi koşullarının döndürdüğü tüm satırları getirir ve
  //    eşleştirme Sipariş Kod + Model/Ürün Ad + Renk Kod koşullarının tamamı
  //    birebir sağlandığında yapılır.
  const antrepoMapByTarget = {};
  let antrepoRuns = [];
  if (antrepoPromise) {
    const antrepoResult = await antrepoPromise;
    connectionWarnings.push(...antrepoResult.warnings);
    for (const [target, entry] of antrepoResult.byTarget) {
      const run = entry.run;
      const map = parseAntrepoRows(run.rows, options.matchRule);
      connectionWarnings.push(...validateAntrepoIntegrity(target, map, asasOrdersByTarget[target] || [], options.matchRule));
      antrepoMapByTarget[target] = map && typeof map === 'object' ? map : {};
      antrepoRuns.push(run);
      connectionWarnings.push(...describeAntrepoMatch(target, map, asasOrdersByTarget[target] || [], run, options.matchRule));
    }
    /* Kapatılan IAS beslemesi SESSİZ KALMAZ. Siparişler'den IAS bağlantısını
       kaldırmak desteklenen bir karardır (ASAS verisi gelmeye ve yenilenmeye
       devam eder), ama sayfa eksik sütunlarla açılacağı için bunun nedeni
       görünür olmalı — yoksa kullanıcı boş antrepo sütunlarını arıza sanar. */
    for (const target of requestedTargets) {
      if (!modelScopes.allowedTargets('antrepo').includes(target)) continue;
      if (antrepoResult.byTarget.has(target)) continue;
      const label = modelScopes.TARGET_LABELS[target] || target;
      connectionWarnings.push(
        `${label} sayfası antrepo verisi olmadan yenilendi: ${connectionLabel(selected.antrepo)} bağlantısı bu modül için kapalı. Sipariş satırları güncel, antrepo/sevkiyat sütunları boş.`);
    }
  }

  const uniqueRuns = values => [...new Map((values || []).filter(Boolean).map(run => [
    run.queryFingerprint || `${run.item && run.item.id || ''}|${run.query || ''}`,
    run,
  ])).values()];
  const asasRuns = includeAsas ? uniqueRuns([...asasByTarget.values()].map(entry => entry.run)) : [];
  // Tek Antrepo scope'u CP/Orders/Backlog'u birlikte besleyebilir. Aynı run'ı üç
  // kez raporlamak süre/persistence satırlarını çoğaltıyordu; sorgu yalnız bir kez
  // çalıştığı için bağlantı listesi de tekil olmalıdır.
  antrepoRuns = uniqueRuns(antrepoRuns);
  const primary = asasOrdersByTarget.cp || asasOrdersByTarget.orders || asasOrdersByTarget.backlog || [];
  const warnings = [
    ...selected.warnings,
    ...connectionWarnings,
    ...asasRuns.flatMap(run => run.warnings || []),
    ...antrepoRuns.flatMap(run => run.warnings || []),
    ...(parsedLfl.meta && parsedLfl.meta.warnings || []),
    ...Object.values(fabricHeaderInfoByTarget).flatMap(info => info && Array.isArray(info.warnings) ? info.warnings : []),
  ];
  const warningDetails = [...new Map(
    Object.values(fabricHeaderInfoByTarget)
      .flatMap(info => info && Array.isArray(info.warningDetails) ? info.warningDetails : [])
      .map(detail => [`${String(detail && detail.id || '')}\u0000${String(detail && detail.message || '')}`, detail])
  ).values()];
  const scopeSummary = [...asasByTarget.entries()].map(([target, entry]) => ({
    connection: connectionLabel(entry.item), target, scope: modelScopes.scopeLabel(entry.scope), rowCount: entry.run.rows.length,
    // Ufuk rozeti bu alanları kullanır: sayfada hangi sınırla çalışıldığı görünsün.
    horizon: modelHorizon.describeHorizon(entry.scope.horizon),
    personalHorizon: Boolean(entry.scope._personalHorizon),
    orderCount: Array.isArray(asasOrdersByTarget[target]) ? asasOrdersByTarget[target].length : null,
  }));
  const appliedHorizons = Object.fromEntries([...asasByTarget.entries()].map(([target, entry]) => [target, entry.scope.horizon || {}]));

  const partialTargets = Array.isArray(options.targets) && options.targets.length ? options.targets.slice() : null;
  return {
    partialTargets,
    loadedAt: new Date().toISOString(),
    // Geriye dönük alanlar: CP kümesi birincil kabul edilir (Genel Bakış sipariş özeti, Koleksiyon ve
    // Ön Maliyet gibi hedefi ayrıca tanımlanmamış sayfalar bunu kullanır).
    asasOrders: primary,
    antrepoMap: antrepoMapByTarget.cp || antrepoMapByTarget.orders || antrepoMapByTarget.backlog || {},
    asasOrdersByTarget,
    antrepoMapByTarget,
    fabricHeaderInfo: fabricHeaderInfoByTarget.cp || fabricHeaderInfoByTarget.orders || fabricHeaderInfoByTarget.backlog || null,
    fabricHeaderInfoByTarget,
    lflRows: parsedLfl.rows,
    lflMeta: parsedLfl.meta,
    lflLoadedAt: new Date().toISOString(),
    sources: {
      asas: includeAsas ? `Model: ${connectionLabel(selected.asas)}` : null,
      antrepo: includeAntrepo && selected.antrepo ? `Model: ${connectionLabel(selected.antrepo)}` : null,
      lfl: includeLfl ? `Model: ${connectionLabel(selected.asas)}` : null,
    },
    warnings,
    warningDetails,
    scopes: scopeSummary,
    appliedHorizons,
    mappingRepairs: [...asasRuns, ...antrepoRuns].filter(run => run && run.mappingRepaired).length,
    runs: [...asasRuns, ...antrepoRuns],
    queryMetrics: queryCoordinator.metrics(),
  };
}

module.exports = {
  ModelRefreshError,
  DEFAULT_REFRESH_TIMEOUT_MS,
  connectionLabel,
  selectRefreshConnections,
  runConnectionScopes,
  runRoleScopes,
  resolveRoleTargets,
  effectiveScopes,
  normalizedRole,
  normalizedConnectionMapping,
  fieldMappingRepairFromError,
  ensureConnectionMapping,
  alignHorizonWithMapping,
  buildConnectionQuery, resolveColumnTypes,
  antrepoProjectionMapping,
  antrepoGrainTable,
  validateAntrepoIntegrity,
  queryConnectionRows,
  mapWithConcurrency,
  ORDER_CODE_PUSHDOWN_LIMIT,
  ORDER_CODE_PUSHDOWN_BUDGET,
  buildOrderCodeList,
  loadFromModelConnections,
};
