/* Buyer Log v2.92 — shared, dependency-free business rules for browser and Node.js */
(function attachBuyerLogBusinessRules(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BLBusinessRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBuyerLogBusinessRules() {
  'use strict';

  const DEFAULT_TRANSIT_DAYS = Object.freeze({
    Gemi: 70,
    'Uçak': 15,
    'Gemi+Uçak': 35,
    'Gemi+Tır': 70,
  });
  const TURKISH_ASCII_MAP = Object.freeze({ 'İ': 'I', 'Ş': 'S', 'Ç': 'C', 'Ö': 'O', 'Ü': 'U', 'Ğ': 'G' });

  function norm(value) {
    return String(value == null ? '' : value).trim();
  }

  function turkNorm(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[İŞÇÖÜĞ]/g, character => TURKISH_ASCII_MAP[character])
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* CP/Backlog status hücreleri yalnız yalın enum değildir. Gerçek veride
     "Loading Operations 5.003" gibi miktar suffix'leri ve
     "Loading Operations 773 | In Transit 1.390" gibi birden fazla aşamanın
     aynı hücrede birleştiği değerler bulunur. Status sınıflandırması bu display
     miktarlarından etkilenmemeli; bütün tüketiciler aynı canonical stage'i
     görmelidir. */
  const OPERATIONAL_STAGE_ALIASES = Object.freeze({
    PRODUCTION: Object.freeze(['URETIMDE', 'URETIM', 'PRODUCTION', 'IN PRODUCTION']),
    LOADING: Object.freeze(['YUKLEME OPERASYONLARI', 'LOADING OPERATIONS']),
    IN_TRANSIT: Object.freeze(['YOL OPERASYONLARI', 'YOLDA', 'IN TRANSIT']),
    CUSTOMS: Object.freeze(['GUMRUK-LIMAN OPERASYONLARI', 'GUMRUK LIMAN OPERASYONLARI', 'CUSTOMS & PORT', 'CUSTOMS AND PORT', 'CUSTOMS']),
    IN_WAREHOUSE: Object.freeze(['DEPODA', 'IN WAREHOUSE']),
    AWAITING_RETAIL_TRANSFER: Object.freeze(['RETAILE AKTARIM BEKLENIYOR', 'RETAILE AKTARIM BEKLIYOR', 'AWAITING RETAIL TRANSFER']),
    SHORTAGE: Object.freeze(['EKSIK YUKLEME', 'SHORTAGE', 'DEPODA - EKSIK YUKLEME', 'DEPODA EKSIK YUKLEME', 'IN WAREHOUSE - SHORTAGE', 'IN WAREHOUSE SHORTAGE']),
  });
  const OPERATIONAL_STAGE_RANK = Object.freeze({
    UNKNOWN: 0,
    PRODUCTION: 10,
    LOADING: 20,
    IN_TRANSIT: 30,
    CUSTOMS: 40,
    IN_WAREHOUSE: 50,
    AWAITING_RETAIL_TRANSFER: 60,
    // Shortage bir progression stage değil operasyonel istisnadır; görünürse
    // mevcut business davranışı korunarak öncelikli sınıflandırılır.
    SHORTAGE: 100,
  });
  const OPERATIONAL_STAGE_ALIAS_ENTRIES = Object.freeze(Object.entries(OPERATIONAL_STAGE_ALIASES));

  function isStatusQuantitySuffix(value) {
    const suffix = String(value == null ? '' : value).trim();
    return /^\d[\d.,\s]*$/.test(suffix);
  }

  function statusSegmentMatchesAlias(segment, alias) {
    if (segment === alias) return true;
    if (!segment.startsWith(`${alias} `)) return false;
    return isStatusQuantitySuffix(segment.slice(alias.length + 1));
  }

  function operationalStageForSegment(value) {
    const segment = turkNorm(value);
    if (!segment) return 'UNKNOWN';
    // Legacy production status'larında alt aşama metni suffix olarak gelir
    // ("Üretimde - Kesimde", "Üretimde/Planlama"). Bu davranış isProductionStatus
    // için yıllardır destekleniyor; canonical stage helper bunu kaybetmemeli.
    if (segment === 'URETIMDE' || segment.startsWith('URETIMDE ') || segment.startsWith('URETIMDE-') || segment.startsWith('URETIMDE/')) return 'PRODUCTION';
    if (segment === 'PRODUCTION' || segment.startsWith('PRODUCTION ') || segment.startsWith('PRODUCTION-') || segment.startsWith('PRODUCTION/')) return 'PRODUCTION';
    if (segment === 'IN PRODUCTION' || segment.startsWith('IN PRODUCTION ') || segment.startsWith('IN PRODUCTION-') || segment.startsWith('IN PRODUCTION/')) return 'PRODUCTION';
    for (const [stage, aliases] of OPERATIONAL_STAGE_ALIAS_ENTRIES) {
      if (aliases.some(alias => statusSegmentMatchesAlias(segment, alias))) return stage;
    }
    return 'UNKNOWN';
  }

  function operationalStageOf(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return 'UNKNOWN';
    const segments = /[|;\n]/.test(raw)
      ? raw.split(/[|;\n]+/).map(part => part.trim()).filter(Boolean)
      : [raw];
    let best = 'UNKNOWN';
    for (const segment of segments.length ? segments : [raw]) {
      const stage = operationalStageForSegment(segment);
      if ((OPERATIONAL_STAGE_RANK[stage] || 0) > (OPERATIONAL_STAGE_RANK[best] || 0)) best = stage;
    }
    return best;
  }

  function isProductionStatus(value) {
    return operationalStageOf(value) === 'PRODUCTION';
  }

  function isShortageStatus(value) {
    return operationalStageOf(value) === 'SHORTAGE';
  }

  function isWarehouseShortageStatus(value) {
    const key = turkNorm(value);
    return ['DEPODA - EKSIK YUKLEME', 'DEPODA EKSIK YUKLEME', 'IN WAREHOUSE - SHORTAGE', 'IN WAREHOUSE SHORTAGE']
      .some(alias => statusSegmentMatchesAlias(key, alias));
  }

  function manufacturerKey(value) {
    return turkNorm(value);
  }

  function normalizeManufacturerList(value) {
    return normalizeList(value, manufacturerKey);
  }

  function isNonDtrManufacturer(manufacturer, manufacturers) {
    const key = manufacturerKey(manufacturer);
    if (!key) return false;
    return normalizeManufacturerList(manufacturers).some(item => manufacturerKey(item) === key);
  }

  // LFL policy: the maintained manufacturer list is the single classification source.
  // A listed manufacturer is NON-DTR; every other order is DTR.
  function classifyDtrByManufacturer(manufacturer, manufacturers) {
    return isNonDtrManufacturer(manufacturer, manufacturers) ? 'NON-DTR' : 'DTR';
  }

  function normalizeTransitDelType(value) {
    const key = turkNorm(value).replace(/\s+/g, '');
    const hasShip = key.includes('GEMI') || key.includes('SEA') || key.includes('SHIP');
    const hasAir = key.includes('UCAK') || key.includes('AIR');
    const hasTruck = key.includes('TIR') || key.includes('TRUCK');
    if (hasShip && hasAir) return 'Gemi+Uçak';
    if (hasShip && hasTruck) return 'Gemi+Tır';
    if (hasAir) return 'Uçak';
    if (hasShip) return 'Gemi';
    return '';
  }

  function transitCountryKey(value) {
    const key = turkNorm(value);
    const aliases = {
      TR: 'TURKEY', TURKIYE: 'TURKEY', TURKEY: 'TURKEY',
      HINDISTAN: 'INDIA', INDIA: 'INDIA',
      BANGLADES: 'BANGLADESH', BANGLADESH: 'BANGLADESH',
      CIN: 'CHINA', CHINA: 'CHINA',
      MISIR: 'EGYPT', EGYPT: 'EGYPT',
      FAS: 'MOROCCO', MOROCCO: 'MOROCCO',
      ENDONEZYA: 'INDONESIA', INDONESIA: 'INDONESIA',
      MYANMAR: 'MYANMAR',
    };
    return aliases[key] || key;
  }

  function normalizeList(value, keyFn = turkNorm) {
    const source = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    const seen = new Set();
    const output = [];
    for (const item of source) {
      const text = norm(item);
      const key = keyFn(text);
      if (text && key && !seen.has(key)) {
        seen.add(key);
        output.push(text);
      }
    }
    return output.sort((a, b) => a.localeCompare(b, 'tr'));
  }

  function defaultDateOrdinal(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
      const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (match) return Math.trunc(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return Math.trunc(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  // License Royalty Calculations'ta tarih grubu seçerken JavaScript'in geçersiz
  // tarihleri sessizce normalize etmesine izin verme. Boş tarih açık uçlu,
  // biçimi bozuk tarih ise geçersiz kayıt kabul edilir.
  function validRuleDate(value) {
    const text = norm(value);
    if (!text) return { ordinal: null, invalid: false };
    const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
      return valid ? { ordinal: Math.trunc(date.getTime() / 86400000), invalid: false } : { ordinal: null, invalid: true };
    }
    const ordinal = defaultDateOrdinal(value);
    return ordinal == null ? { ordinal: null, invalid: true } : { ordinal, invalid: false };
  }

  // Collection'ın Licensor otomasyonu için ortak, exact ve tarih-grubu bazlı
  // çözüm. Kuralın ülke/sezon eşleştirmesi bu fonksiyonun sorumluluğunda
  // değildir; yalnız License → en yeni geçerli tarih grubu → Licensor zincirini
  // çözer. Kaynaktaki ilk yazım korunur, yalnız gösterim sıralanır.
  function resolveLatestLicensorsForLicense(license, rules) {
    const wanted = norm(license);
    const wantedKey = turkNorm(wanted);
    const empty = { license: wanted, latestDate: '', licensors: [], ambiguous: false, licensorsLabel: '', displayValue: '' };
    if (!wantedKey) return empty;
    const candidates = (Array.isArray(rules) ? rules : []).map(rule => {
      const start = validRuleDate(rule && rule.opdStart);
      const end = validRuleDate(rule && rule.opdEnd);
      return { rule, start, end };
    }).filter(item => {
      const rule = item.rule || {};
      return turkNorm(norm(rule.license)) === wantedKey
        && norm(rule.licensor)
        && !item.start.invalid && !item.end.invalid;
    });
    if (!candidates.length) return empty;
    const freshness = item => [item.start.ordinal == null ? -Infinity : item.start.ordinal, item.end.ordinal == null ? -Infinity : item.end.ordinal];
    let latest = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
      const current = candidates[index], left = freshness(current), right = freshness(latest);
      if (left[0] > right[0] || (left[0] === right[0] && left[1] > right[1])) latest = current;
    }
    const latestStart = latest.start.ordinal, latestEnd = latest.end.ordinal;
    const latestGroup = candidates.filter(item => item.start.ordinal === latestStart && item.end.ordinal === latestEnd);
    const licensors = normalizeList(latestGroup.map(item => item.rule.licensor), turkNorm);
    // Aynı Licensor'ı gösteren birden çok kural belirsizlik değildir; belirsizlik
    // yalnız DISTINCT Licensor sayısı > 1 olduğunda oluşur. Belirsiz durumda otomatik
    // değer ÜRETİLMEZ: eskiden 'DTR/Y' gibi birleşik bir Licensor yazılıyordu ve satır
    // hem çözülmüş görünüyor hem de DTR benzeri komisyonsuz FOB'a düşebiliyordu.
    const ambiguous = licensors.length > 1;
    return {
      license: wanted,
      latestDate: norm(latest.rule.opdStart) || norm(latest.rule.opdEnd) || '',
      licensors,
      ambiguous,
      licensorsLabel: licensors.join(' / '),
      displayValue: ambiguous ? '' : (licensors[0] || ''),
    };
  }

  // License → Licensor bağımlılığının tek durum sözleşmesi. Boş License için
  // Licensor hiçbir zaman varsayılan/placeholder değer almaz; dolu License ise
  // yalnız geçerli tarih aralığı ve dolu Licensor içeren bir License Royalty
  // kuralından çözülebilir. Bu saf yardımcı browser ve Node tarafında aynıdır.
  function resolveLicenseLicensor(license, rules) {
    const resolved = resolveLatestLicensorsForLicense(license, rules);
    const hasLicense = Boolean(turkNorm(norm(license)));
    if (!hasLicense) {
      return { ...resolved, hasLicense: false, hasRule: false, status: 'empty' };
    }
    if (resolved.ambiguous) {
      // Kural var ama hangisinin geçerli olduğu belli değil: otomatik Licensor,
      // royalty ve FOB durur, açık Licensor seçimi beklenir.
      return { ...resolved, hasLicense: true, hasRule: true, status: 'ambiguous' };
    }
    if (resolved.displayValue) {
      return { ...resolved, hasLicense: true, hasRule: true, status: 'resolved' };
    }
    return { ...resolved, hasLicense: true, hasRule: false, status: 'missing-rule' };
  }

  // Otomatik Licensor atamanın tek kapısı. NON-DTR MANUFACTURERS listesi DTR
  // sınıflandırmasının tek doğruluk kaynağıdır: listedeki bir üretici için otomatik
  // DTR yazılmaz, Licensor açık seçim bekler. Manuel seçim bu fonksiyonun
  // üstündedir ve çağıranları tarafından korunur.
  function resolveAutoLicensor(license, rules, options) {
    const opts = options || {};
    const state = resolveLicenseLicensor(license, rules);
    if (state.status !== 'resolved') return state;
    if (turkNorm(state.displayValue) !== 'DTR') return state;
    if (!isNonDtrManufacturer(opts.manufacturer, opts.nonDtrManufacturers)) return state;
    return { ...state, displayValue: '', status: 'manufacturer-conflict' };
  }

  // Otomatik çözümün değer üretemediği, fakat kuralın da eksik olmadığı
  // durumlar. Bu satırlarda royalty/FOB hesaplanmaz.
  function isUnresolvedLicensorStatus(status) {
    return status === 'ambiguous' || status === 'manufacturer-conflict';
  }

  function transitRuleSeasonMatches(rule, season) {
    const values = normalizeList(rule && rule.seasons, turkNorm);
    if (!values.length) return true;
    const key = turkNorm(season);
    return !!key && values.some(value => turkNorm(value) === key);
  }

  function transitRuleCountryMatches(rule, country) {
    const values = normalizeList(rule && rule.countries, transitCountryKey);
    if (!values.length) return true;
    const key = transitCountryKey(country);
    return !!key && values.some(value => transitCountryKey(value) === key);
  }

  function transitRuleSpecificity(rule, dateOrdinal = defaultDateOrdinal) {
    const countries = normalizeList(rule && rule.countries, transitCountryKey);
    const seasons = normalizeList(rule && rule.seasons, turkNorm);
    const start = dateOrdinal(rule && rule.exfStart);
    const end = dateOrdinal(rule && rule.exfEnd);
    const bounded = (start != null ? 1 : 0) + (end != null ? 1 : 0);
    const span = start != null && end != null ? Math.max(0, end - start) : Number.MAX_SAFE_INTEGER;
    return [
      countries.length ? 1 : 0,
      seasons.length ? 1 : 0,
      bounded,
      countries.length ? -countries.length : 0,
      seasons.length ? -seasons.length : 0,
      -span,
    ];
  }

  function compareTransitSpecificity(a, b, dateOrdinal = defaultDateOrdinal) {
    const left = transitRuleSpecificity(a, dateOrdinal);
    const right = transitRuleSpecificity(b, dateOrdinal);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
  }

  function findTransitRule(rules, exFactory, season, country, delType, dateOrdinal = defaultDateOrdinal) {
    const wantedType = normalizeTransitDelType(delType);
    if (!wantedType) return null;
    const day = dateOrdinal(exFactory);
    const matches = (Array.isArray(rules) ? rules : []).filter(rule => {
      if (normalizeTransitDelType(rule && rule.delType) !== wantedType) return false;
      const start = dateOrdinal(rule && rule.exfStart);
      const end = dateOrdinal(rule && rule.exfEnd);
      const dateMatches = (start == null && end == null)
        || (day != null && (start == null || day >= start) && (end == null || day <= end));
      return dateMatches
        && transitRuleSeasonMatches(rule, season)
        && transitRuleCountryMatches(rule, country)
        && Number.isFinite(Number(rule && rule.days));
    });
    matches.sort((a, b) => compareTransitSpecificity(a, b, dateOrdinal));
    return matches[0] || null;
  }

  function defaultTransitDays(delType) {
    const key = normalizeTransitDelType(delType);
    return key ? DEFAULT_TRANSIT_DAYS[key] : null;
  }

  function resolveTransitDays(options, dateOrdinal = defaultDateOrdinal) {
    const input = options || {};
    const fallback = defaultTransitDays(input.delType);
    if (!input.forceRules && !isProductionStatus(input.status)) {
      return { days: fallback, rule: null, dynamic: false };
    }
    const rule = findTransitRule(input.rules, input.exFactory, input.season, input.country, input.delType, dateOrdinal);
    return rule
      ? { days: Number(rule.days), rule, dynamic: true }
      : { days: fallback, rule: null, dynamic: false };
  }

  function roundHalfUp(value, decimals = 2) {
    const number = Number(value);
    const precision = Number.isInteger(decimals) && decimals >= 0 && decimals <= 12 ? decimals : 2;
    if (!Number.isFinite(number)) return 0;
    const factor = 10 ** precision;
    const sign = number < 0 ? -1 : 1;
    return sign * (Math.floor(Math.abs(number) * factor + 0.5 + 1e-10) / factor);
  }

  function computePriorityFlags(input, dateOrdinal = defaultDateOrdinal) {
    const values = input || {};
    const exFactory = dateOrdinal(values.exFactory);
    const retailDate = dateOrdinal(values.retailDate);
    const inStoreDate = dateOrdinal(values.inStoreDate);
    const antArrival = dateOrdinal(values.antArrival);
    const handoverDate = dateOrdinal(values.handoverDate);
    const shipConfirmationDate = dateOrdinal(values.shipConfirmationDate);
    const today = dateOrdinal(values.today == null ? new Date() : values.today);
    const status = norm(values.status);
    const operationalStage = operationalStageOf(status);
    const production = operationalStage === 'PRODUCTION';
    // Shortage'ın operasyonel hesaplamalara etkisi ile structured SHORTAGE
    // sinyalinin üretilmesi ayrı kararlardır. Eksik miktar transit/ETA hesabını
    // etkilemeye devam edebilir; sinyal yalnız çağıran katman shortageNote=true
    // verdiğinde üretilir.
    const shortageDetected = values.shortage === true || Number(values.shortageQty) > 0 || isShortageStatus(status);
    const shortageNote = Object.prototype.hasOwnProperty.call(values, 'shortageNote')
      ? values.shortageNote === true
      : (values.shortage === true || Number(values.shortageQty) > 0);
    const shortage = shortageDetected;
    // Shortage siparişleri üretimde değildir. Operasyonel transit hesabında
    // siparişin tamamı ASAS Ex-Factory tarihinde yüklenmiş kabul edilir; bu nedenle geçmiş bir
    // Ex-Factory tarihi bugüne taşınmaz. Transit kuralı yine ülke/sezon/yükleme
    // tipine göre çözülür.
    const transitInfo = resolveTransitDays({
      delType: values.delType,
      exFactory: values.exFactory,
      season: values.season,
      country: values.country,
      status,
      rules: values.rules,
      forceRules: shortage,
    }, dateOrdinal);
    const transitDays = transitInfo.days;
    const exr = exFactory != null && retailDate != null ? retailDate - exFactory : null;

    let delayBase = null;
    if (production) delayBase = exFactory != null && today != null && exFactory < today ? today : exFactory;
    else if (shortage) delayBase = exFactory;
    const delayEstimatedAntrepo = delayBase != null && transitDays != null ? delayBase + Number(transitDays) : null;
    const isDelay = delayEstimatedAntrepo != null && retailDate != null && delayEstimatedAntrepo > retailDate;

    let mbAntrepo = null;
    if (production || shortage) {
      if (exFactory != null && transitDays != null) {
        const effectiveExFactory = production && today != null && exFactory < today ? today : exFactory;
        mbAntrepo = effectiveExFactory + Number(transitDays);
      }
    } else {
      mbAntrepo = antArrival;
    }
    const mbGap = mbAntrepo != null && inStoreDate != null ? inStoreDate - mbAntrepo : null;
    const mbDelay = mbGap != null && mbGap < 14;

    const handoverWarning = shipConfirmationDate != null
      && handoverDate == null
      && !production
      && !shortage
      && operationalStage !== 'IN_WAREHOUSE'
      && today != null
      && today - shipConfirmationDate >= 3;
    // Shortage satırındaki antrepo tarihi gerçek bir IAS varış kaydı değil,
    // Ex-Factory + transit varsayımıdır. Bu sentetik tarih üzerinden Ant. Delay
    // üretmek, siparişi hâlâ yükleme bekliyormuş gibi gösterirdi.
    const antDelay = antArrival != null
      && today != null
      && antArrival < today
      && !shortage
      && operationalStage !== 'IN_WAREHOUSE'
      && operationalStage !== 'AWAITING_RETAIL_TRANSFER';
    const discountDelayDays = exFactory != null && today != null ? today - exFactory : null;
    const discountWarning = production && discountDelayDays != null && discountDelayDays > 9;

    /* Operasyonel gerçekler burada yalnız boolean/sayısal alanlar ve structured
       signals olarak üretilir. Eski CP warning-as-Priority metni
       (Handover / Delay / Ant. Delay / MB Delay / Discount / Shortage / In Time)
       kaldırılmıştır. Action Priority yalnız Unified OrderDecision tarafından
       üretilir; business-rules presentation etiketi üretmez.

       estimatedAntrepo: üretim/eksik yükleme satırında PROJEKSİYON
       (yükleme tarihi + transit), diğerlerinde IAS'ın gerçek antrepo varışı.
       retailGap: retailDate − estimatedAntrepo (pozitif = tampon, negatif =
       hedefin gerisinde). 'ANTREPO-RETAIL' sütununun işaretçe tersidir. */
    const estimatedAntrepoSource = mbAntrepo == null ? null : ((production || shortage) ? 'projected' : 'actual');
    const retailGap = mbAntrepo != null && retailDate != null ? retailDate - mbAntrepo : null;
    const latestSafeLoad = retailDate != null && transitDays != null ? retailDate - Number(transitDays) : null;

    // Structured operational signals are the canonical machine-readable facts.
    // Presentation and Action Priority are resolved downstream by OrderDecision.
    const signals = [];
    if (antDelay) signals.push({ code: 'ANTREPO_DELAY', source: 'business_rules' });
    if (isDelay) signals.push({ code: 'DELIVERY_DELAY', source: 'business_rules' });
    if (mbDelay) signals.push({ code: 'MODEL_BUDGET_DELAY', source: 'business_rules' });
    if (handoverWarning) signals.push({ code: 'HANDOVER_PENDING', source: 'business_rules', actionFloor: 'ACTION_THIS_WEEK' });
    if (discountWarning) signals.push({ code: 'DISCOUNT_DELAY', source: 'business_rules' });
    if (shortageNote) signals.push({ code: 'SHORTAGE', source: 'business_rules' });

    return {
      signals, exr, discountWarning, mbGap, transitDays, transitInfo, shortage, shortageNote,
      production, isDelay, mbDelay, antDelay, handoverWarning,
      delayBase, estimatedAntrepo: mbAntrepo, estimatedAntrepoSource, retailGap, latestSafeLoad,
    };
  }

  /* License Royalty v2: ülke artık kuralın eşleşme boyutu değil, aynı
     Licensor + License sözleşmesinin komisyon varyantıdır. TR/YD komisyonu
     Royalty'ye eklenir; hologram tutarı yüzde değildir. */
  function pricingRuleCountryGroup(value) {
    const raw = norm(value);
    if (!raw) return '';
    const key = turkNorm(raw).replace(/[\s_]+/g, '-');
    if (key === 'TR' || key === 'TURKIYE' || key === 'TURKEY') return 'TR';
    if (key === 'NON-TR' || key === 'NONTR' || key === 'YD' || key === 'YURT-DISI' || key === 'YURTDISI' || key === 'OVERSEAS') return 'YD';
    return 'YD';
  }

  function pricingRuleCommissionForCountry(rule, countryOrGroup) {
    if (!rule || typeof rule !== 'object') return null;
    const group = pricingRuleCountryGroup(countryOrGroup);
    if (!group) return null;
    const key = group === 'TR' ? 'trCommission' : 'ydCommission';
    if (Object.prototype.hasOwnProperty.call(rule, key)) {
      const raw = rule[key];
      if (raw == null || String(raw).trim() === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    }
    const legacyGroup = rule.countryGroup ? pricingRuleCountryGroup(rule.countryGroup) : '';
    if (legacyGroup) return legacyGroup === group ? 0 : null;
    return 0;
  }

  function pricingRuleEffectiveRoyalty(rule, countryOrGroup) {
    if (!rule || typeof rule !== 'object') return null;
    const royalty = Number(rule.royalty);
    if (!Number.isFinite(royalty) || royalty < 0 || royalty > 100) return null;
    if (countryOrGroup == null || String(countryOrGroup).trim() === '') return royalty;
    const commission = pricingRuleCommissionForCountry(rule, countryOrGroup);
    if (commission == null) return null;
    const total = royalty + commission;
    return Number.isFinite(total) && total >= 0 && total <= 100 ? total : null;
  }

  function pricingRuleHologramForCountry(rule, countryOrGroup) {
    if (!rule || typeof rule !== 'object') return null;
    const group = pricingRuleCountryGroup(countryOrGroup);
    const legacyKey = group === 'TR' ? 'legacyTrHologramCost' : group === 'YD' ? 'legacyYdHologramCost' : '';
    if (legacyKey && Object.prototype.hasOwnProperty.call(rule, legacyKey)) {
      const legacy = Number(rule[legacyKey]);
      if (Number.isFinite(legacy) && legacy >= 0) return legacy;
    }
    const value = Number(rule.hologramCost);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function normalizeRoyaltySeasons(value) {
    const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    const seen = new Set(), out = [];
    for (const item of raw) {
      const text = norm(item), key = turkNorm(text);
      if (text && key && !seen.has(key)) { seen.add(key); out.push(text); }
    }
    return out.sort((a, b) => a.localeCompare(b, 'tr'));
  }

  function royaltyMigrationConditionKey(rule) {
    return [
      norm(rule && rule.opdStart),
      norm(rule && rule.opdEnd),
      normalizeRoyaltySeasons(rule && rule.seasons != null ? rule.seasons : rule && rule.season).map(turkNorm).join('~'),
      turkNorm(rule && (rule.licensor != null ? rule.licensor : rule.manufacturer)),
      turkNorm(rule && rule.license),
    ].join('|');
  }

  function migrateLicenseRoyaltyRules(rules) {
    const input = Array.isArray(rules) ? rules : [];
    const modern = [];
    const legacy = new Map();
    input.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const source = { ...raw };
      source.licensor = norm(source.licensor != null ? source.licensor : source.manufacturer);
      delete source.manufacturer;
      source.license = norm(source.license);
      source.seasons = normalizeRoyaltySeasons(source.seasons != null ? source.seasons : source.season);
      delete source.season;
      const hasModernCommission = Object.prototype.hasOwnProperty.call(source, 'trCommission')
        || Object.prototype.hasOwnProperty.call(source, 'ydCommission');
      const legacyGroup = source.countryGroup ? pricingRuleCountryGroup(source.countryGroup) : '';
      if (hasModernCommission || !legacyGroup) {
        delete source.countryGroup;
        if (!hasModernCommission) {
          source.trCommission = 0;
          source.ydCommission = 0;
        }
        modern.push(source);
        return;
      }
      const key = royaltyMigrationConditionKey(source);
      if (!legacy.has(key)) legacy.set(key, []);
      legacy.get(key).push({ source, group: legacyGroup, index });
    });

    for (const entries of legacy.values()) {
      const tr = entries.find(item => item.group === 'TR');
      const yd = entries.find(item => item.group === 'YD');
      const samples = [tr, yd].filter(Boolean);
      if (!samples.length) continue;
      const effective = samples.map(item => Number(item.source.royalty)).filter(Number.isFinite);
      const baseRoyalty = effective.length ? Math.min(...effective) : Number(samples[0].source.royalty);
      const primary = (yd || tr).source;
      const merged = { ...primary };
      delete merged.countryGroup;
      merged.royalty = baseRoyalty;
      merged.trCommission = tr && Number.isFinite(Number(tr.source.royalty)) ? Number(tr.source.royalty) - baseRoyalty : null;
      merged.ydCommission = yd && Number.isFinite(Number(yd.source.royalty)) ? Number(yd.source.royalty) - baseRoyalty : null;
      const trHologram = tr ? Number(tr.source.hologramCost) : null;
      const ydHologram = yd ? Number(yd.source.hologramCost) : null;
      const validTrHologram = Number.isFinite(trHologram) && trHologram >= 0;
      const validYdHologram = Number.isFinite(ydHologram) && ydHologram >= 0;
      if (validTrHologram && validYdHologram && trHologram !== ydHologram) {
        merged.hologramCost = ydHologram;
        merged.legacyTrHologramCost = trHologram;
        merged.legacyYdHologramCost = ydHologram;
      } else {
        const hologram = validYdHologram ? ydHologram : validTrHologram ? trHologram : Number(primary.hologramCost);
        merged.hologramCost = hologram;
        delete merged.legacyTrHologramCost;
        delete merged.legacyYdHologramCost;
      }
      merged.legacyRuleIds = entries.map(item => String(item.source.id || '')).filter(Boolean);
      merged.migratedFromCountrySplit = true;
      modern.push(merged);
    }
    return modern;
  }

  function decimalFraction(value) {
    if (value == null || value === '') return null;
    let text = String(value).trim().replace(',', '.');
    if (!text || !Number.isFinite(Number(text))) return null;
    if (/[eE]/.test(text)) text = Number(text).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    let sign = 1n;
    if (text.startsWith('-')) { sign = -1n; text = text.slice(1); }
    else if (text.startsWith('+')) text = text.slice(1);
    const parts = text.split('.');
    const whole = (parts[0] || '0').replace(/\D/g, '') || '0';
    const fraction = (parts[1] || '').replace(/\D/g, '');
    return { num: sign * BigInt(whole + fraction), den: 10n ** BigInt(fraction.length) };
  }

  function roundFractionHalfUp(num, den, decimals = 2) {
    if (den === 0n) return null;
    const scale = 10n ** BigInt(decimals);
    let scaled = num * scale;
    const sign = scaled < 0n ? -1n : 1n;
    if (scaled < 0n) scaled = -scaled;
    let quotient = scaled / den;
    const remainder = scaled % den;
    if (remainder * 2n >= den) quotient += 1n;
    return Number(sign * quotient) / Number(scale);
  }

  function calculateSuppFobWithRule(fob, rule, countryOrGroup) {
    const fobFraction = decimalFraction(fob);
    const royalty = pricingRuleEffectiveRoyalty(rule, countryOrGroup);
    const hologram = pricingRuleHologramForCountry(rule, countryOrGroup);
    const royaltyFraction = decimalFraction(royalty);
    const hologramFraction = decimalFraction(hologram);
    if (!fobFraction || !royaltyFraction || !hologramFraction) return null;
    if (!Number.isFinite(royalty) || royalty < 0 || royalty > 100) return null;
    const baseNum = fobFraction.num * hologramFraction.den - hologramFraction.num * fobFraction.den;
    const baseDen = fobFraction.den * hologramFraction.den;
    const royaltyBase = 100n * royaltyFraction.den - royaltyFraction.num;
    return roundFractionHalfUp(baseNum * royaltyBase, baseDen * royaltyFraction.den * 100n, 2);
  }

  function calculateFinalFobWithRule(suppFob, rule, countryOrGroup) {
    const suppFraction = decimalFraction(suppFob);
    const royalty = pricingRuleEffectiveRoyalty(rule, countryOrGroup);
    const hologram = pricingRuleHologramForCountry(rule, countryOrGroup);
    const royaltyFraction = decimalFraction(royalty);
    const hologramFraction = decimalFraction(hologram);
    if (!suppFraction || !royaltyFraction || !hologramFraction) return null;
    if (!Number.isFinite(royalty) || royalty < 0 || royalty >= 100) return null;
    const royaltyBase = 100n * royaltyFraction.den - royaltyFraction.num;
    if (royaltyBase === 0n) return null;
    const baseNum = suppFraction.num * 100n * royaltyFraction.den;
    const baseDen = suppFraction.den * royaltyBase;
    const num = baseNum * hologramFraction.den + hologramFraction.num * baseDen;
    const den = baseDen * hologramFraction.den;
    return roundFractionHalfUp(num, den, 2);
  }

  // Main CP/Koleksiyon policy: numeric generation first; for the same generation S precedes W.
  function seasonNumberLetterParts(value) {
    const raw = norm(value);
    const upper = raw.toLocaleUpperCase('tr-TR');
    const numberMatch = upper.match(/-?\d+(?:[.,]\d+)?/);
    const number = numberMatch ? Number(numberMatch[0].replace(',', '.')) : Number.POSITIVE_INFINITY;
    const letterMatch = upper.match(/[A-ZÇĞİÖŞÜ]/);
    const letter = letterMatch ? letterMatch[0] : '';
    const letterRank = letter === 'S' ? 0 : (letter === 'W' ? 1 : 2);
    return { number: Number.isFinite(number) ? number : Number.POSITIVE_INFINITY, letterRank, raw };
  }

  function compareSeasonNumberThenLetter(a, b) {
    const left = seasonNumberLetterParts(a);
    const right = seasonNumberLetterParts(b);
    return (left.number - right.number)
      || (left.letterRank - right.letterRank)
      || left.raw.localeCompare(right.raw, 'tr', { numeric: true, sensitivity: 'base' });
  }

  // Programın kanonik sezon sırası — en yeniden en eskiye:
  //   ... > W11 > S11 > W10 > S10 > W9 > S9 > ... > W6 > S6 > ...
  // Yani önce kuşak numarası BÜYÜKTEN küçüğe, aynı numarada W önce S sonra gelir.
  // (compareSeasonNumberThenLetter bunun tersi yönde çalışır ve S'yi öne alır; o
  // yüzden ayrı bir karşılaştırıcı gerekti.) Sezon listelenen her yerde — hızlı
  // filtre çipleri dahil — bu sıra kullanılır.
  function compareSeasonNewestFirst(a, b) {
    const left = seasonNumberLetterParts(a);
    const right = seasonNumberLetterParts(b);
    if (left.number !== right.number) {
      // Tanınmayan/numarasız değerler (POSITIVE_INFINITY) her zaman en sona.
      if (!Number.isFinite(left.number)) return 1;
      if (!Number.isFinite(right.number)) return -1;
      return right.number - left.number;
    }
    // Aynı kuşakta W (letterRank 1) önce, S (letterRank 0) sonra gelmeli.
    if (left.letterRank !== right.letterRank) return right.letterRank - left.letterRank;
    return left.raw.localeCompare(right.raw, 'tr', { numeric: true, sensitivity: 'base' });
  }

  // Existing LFL policy: keep each textual prefix series together, then sort its numeric suffix.
  function seasonPrefixParts(value) {
    const match = norm(value).match(/^(.*?)(\d+)\s*$/);
    return match ? { prefix: match[1], number: Number(match[2]) } : null;
  }

  function compareSeasonPrefixThenNumber(a, b) {
    const left = seasonPrefixParts(a);
    const right = seasonPrefixParts(b);
    if (left && right && left.prefix === right.prefix) return left.number - right.number;
    return String(a).localeCompare(String(b), 'tr', { numeric: true });
  }

  function previousSeasonByPrefix(current, seasons) {
    const parsed = seasonPrefixParts(current);
    if (parsed) {
      const exact = (seasons || []).find(value => {
        const candidate = seasonPrefixParts(value);
        return candidate && candidate.prefix === parsed.prefix && candidate.number === parsed.number - 1;
      });
      if (exact) return exact;
    }
    const sorted = [...(seasons || [])].sort(compareSeasonPrefixThenNumber);
    const index = sorted.indexOf(current);
    return index > 0 ? sorted[index - 1] : '';
  }

  return Object.freeze({
    DEFAULT_TRANSIT_DAYS,
    norm,
    turkNorm,
    operationalStageOf,
    isProductionStatus,
    isShortageStatus,
    isWarehouseShortageStatus,
    manufacturerKey,
    normalizeManufacturerList,
    isNonDtrManufacturer,
    classifyDtrByManufacturer,
    normalizeTransitDelType,
    transitCountryKey,
    normalizeList,
    defaultDateOrdinal,
    resolveLatestLicensorsForLicense,
    resolveLicenseLicensor,
    resolveAutoLicensor,
    isUnresolvedLicensorStatus,
    transitRuleSeasonMatches,
    transitRuleCountryMatches,
    transitRuleSpecificity,
    compareTransitSpecificity,
    findTransitRule,
    defaultTransitDays,
    resolveTransitDays,
    roundHalfUp,
    computePriorityFlags,
    pricingRuleCountryGroup,
    pricingRuleCommissionForCountry,
    pricingRuleEffectiveRoyalty,
    pricingRuleHologramForCountry,
    migrateLicenseRoyaltyRules,
    decimalFraction,
    roundFractionHalfUp,
    calculateSuppFobWithRule,
    calculateFinalFobWithRule,
    seasonNumberLetterParts,
    compareSeasonNumberThenLetter,
    compareSeasonNewestFirst,
    seasonPrefixParts,
    compareSeasonPrefixThenNumber,
    previousSeasonByPrefix,
  });
});
