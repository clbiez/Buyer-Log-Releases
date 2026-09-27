'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rules = require('../public/business-rules');
const { createTableSearch } = require('./helpers/bl-table-search');
const serverLfl = require('../server/lib/lfl');

const ROOT = path.join(__dirname, '..');
const LFL = fs.readFileSync(path.join(ROOT, 'public', 'lfl.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'lfl.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function loadApi(collectionBridge = null) {
  const windowApi = {
    classifyDtrByManufacturer() { return 'DTR'; },
    isNonDtrManufacturer() { return false; },
  };
  if (collectionBridge) windowApi.BLCollection = collectionBridge;
  const context = {
    BLTableSearch: createTableSearch(),
    BLBusinessRules: rules,
    window: windowApi,
    document: {
      getElementById() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(LFL, context, { filename: 'public/lfl.js' });
  return context.window.__lflTest;
}

function clientRow(id, season, dates, fob = 10, quantity = 100) {
  return {
    id,
    orderCode: id,
    modelName: `MODEL-${id}`,
    mag: 'MAG1',
    mmyg: 'MMYG1',
    classification: 'K1',
    manufacturer: 'MFR',
    country: 'TURKIYE',
    buyingGroup: 'BG',
    buyer: 'BUYER',
    season,
    fob,
    quantity,
    ...dates,
  };
}

function sourceRow(overrides = {}) {
  return {
    'Sipariş Kod': '1001',
    'Model Adı': 'MODEL A',
    'Net Alım Sipariş Miktarı': 100,
    'FOB Fiyatı': 10,
    Üretici: 'MFR',
    Sezon: 'S7',
    Klasman: 'K1',
    MAG: 'MAG1',
    MMYG: 'MMYG1',
    'Buyer Grup (TR)': 'BG',
    'Siparişin Üretildiği Ülke': 'TÜRKİYE',
    Buyer: 'BUYER',
    'Model Bütçe Tarih Yıl Ay Gün': '2027-05-10',
    'Sipariş Yerleştirme MerchTarih': '2027-04-03',
    'Retail Depo Tarih Yıl Ay Gün': '2027-06-15',
    ...overrides,
  };
}

test('LFL server projects In-Store, OPD and Retail Date into independent month fields', () => {
  const parsed = serverLfl.parseLFLRows([sourceRow()], 'ASAS');
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.inStore, '2027-05-10');
  assert.equal(row.inStoreMonth, '2027-05');
  assert.equal(row.opd, '2027-04-03');
  assert.equal(row.opdMonth, '2027-04');
  assert.equal(row.retailDate, '2027-06-15');
  assert.equal(row.retailDateMonth, '2027-06');
  assert.deepEqual(parsed.meta.dimensions.inStoreMonths, ['2027-05']);
  assert.deepEqual(parsed.meta.dimensions.opdMonths, ['2027-04']);
  assert.deepEqual(parsed.meta.dimensions.retailDateMonths, ['2027-06']);
});

test('LFL source keeps a row without In-Store when OPD or Retail Date can define its period', () => {
  const parsed = serverLfl.parseLFLRows([
    sourceRow({
      'Model Bütçe Tarih Yıl Ay Gün': '',
      'Sipariş Yerleştirme MerchTarih': '2027-04-03',
      'Retail Depo Tarih Yıl Ay Gün': '',
    }),
  ], 'ASAS');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].inStoreMonth, '');
  assert.equal(parsed.rows[0].opdMonth, '2027-04');
});

test('default In-Store comparison preserves the legacy S7 vs S6 filtering behavior', () => {
  const api = loadApi();
  const rows = [
    clientRow('s7-may', 'S7', { inStore: '2027-05-10', inStoreMonth: '2027-05', opd: '2027-04-01', opdMonth: '2027-04', retailDate: '2027-06-01', retailDateMonth: '2027-06' }),
    clientRow('s6-may', 'S6', { inStore: '2026-05-10', inStoreMonth: '2026-05', opd: '2026-04-01', opdMonth: '2026-04', retailDate: '2026-06-01', retailDateMonth: '2026-06' }),
  ];
  assert.deepEqual(
    api.filterRows(rows, { season: 'S7', months: new Set(['2027-05']) }).map(row => row.id),
    ['s7-may'],
  );
  assert.deepEqual(
    api.filterRows(rows, { season: 'S6', dateField: 'inStore', periods: new Set(['2026-05']) }).map(row => row.id),
    ['s6-may'],
  );
});

test('OPD and Retail Date filtering use their real source fields', () => {
  const api = loadApi();
  const rows = [
    clientRow('a', 'S7', { inStoreMonth: '2027-05', opdMonth: '2027-03', retailDateMonth: '2027-07' }),
    clientRow('b', 'S7', { inStoreMonth: '2027-05', opdMonth: '2027-04', retailDateMonth: '2027-08' }),
  ];
  assert.deepEqual(api.filterRows(rows, { season: 'S7', dateField: 'opd', periods: new Set(['2027-04']) }).map(row => row.id), ['b']);
  assert.deepEqual(api.filterRows(rows, { season: 'S7', dateField: 'retailDate', periods: new Set(['2027-07']) }).map(row => row.id), ['a']);
});

test('independent scenarios honor OPD and Retail Date period fields', () => {
  const api = loadApi();
  const rows = [
    clientRow('current-opd', 'S7', {
      inStoreMonth: '2027-09',
      opd: '2027-04-03',
      opdMonth: '2027-04',
      retailDate: '2027-08-15',
      retailDateMonth: '2027-08',
    }, 12, 100),
    clientRow('compare-retail', 'S6', {
      inStoreMonth: '2026-09',
      opd: '2026-03-01',
      opdMonth: '2026-03',
      retailDate: '2027-05-15',
      retailDateMonth: '2027-05',
    }, 10, 100),
  ];

  const result = api.scenarioComparisonResult(rows, {
    name: 'Cross date fields',
    currentSeason: 'S7',
    compareSeason: 'S6',
    currentDateField: 'opd',
    compareDateField: 'retailDate',
    currentMonths: ['2027-04'],
    compareMonths: ['2027-05'],
    filters: {},
    inheritGlobal: false,
  });

  assert.deepEqual(result.currentRows.map(row => row.id), ['current-opd']);
  assert.deepEqual(result.previousRows.map(row => row.id), ['compare-retail']);
  assert.equal(result.currentDateField, 'opd');
  assert.equal(result.compareDateField, 'retailDate');
  assert.equal(api.scenarioPeriodLabel('S7', ['2027-04'], 'opd'), 'S7 · OPD · Nisan 2027');
  assert.equal(api.scenarioPeriodLabel('S6', ['2027-05'], 'retailDate'), 'S6 · Retail Date · Mayıs 2027');
});

test('same season can produce two independent month datasets', () => {
  const api = loadApi();
  const rows = [
    clientRow('may', 'S7', { inStoreMonth: '2027-05' }, 10, 100),
    clientRow('apr', 'S7', { inStoreMonth: '2027-04' }, 8, 100),
    clientRow('jan', 'S7', { inStoreMonth: '2027-01' }, 6, 100),
    clientRow('feb', 'S7', { inStoreMonth: '2027-02' }, 4, 100),
  ];
  const current = api.filterRows(rows, { season: 'S7', dateField: 'inStore', periods: new Set(['2027-05', '2027-04']) });
  const compare = api.filterRows(rows, { season: 'S7', dateField: 'inStore', periods: new Set(['2027-01', '2027-02']) });
  assert.deepEqual(current.map(row => row.id), ['may', 'apr']);
  assert.deepEqual(compare.map(row => row.id), ['jan', 'feb']);
  assert.equal(api.summary(current).avg, 9);
  assert.equal(api.summary(compare).avg, 5);
  assert.equal(api.metricBetween(api.summary(current), api.summary(compare), 'change'), 80);
});

test('current and comparison sides may use different date fields', () => {
  const api = loadApi();
  const rows = [
    clientRow('current', 'S7', { inStoreMonth: '2027-05', opdMonth: '2027-03', retailDateMonth: '2027-08' }),
    clientRow('compare', 'S7', { inStoreMonth: '2027-01', opdMonth: '2027-02', retailDateMonth: '2027-05' }),
  ];
  const current = api.filterRows(rows, { season: 'S7', dateField: 'inStore', periods: new Set(['2027-05']) });
  const compare = api.filterRows(rows, { season: 'S7', dateField: 'retailDate', periods: new Set(['2027-05']) });
  assert.deepEqual(current.map(row => row.id), ['current']);
  assert.deepEqual(compare.map(row => row.id), ['compare']);
});

test('rows with null selected date field never leak into that period', () => {
  const api = loadApi();
  const rows = [
    clientRow('missing-opd', 'S7', { inStoreMonth: '2027-05', opd: '', opdMonth: '', retailDateMonth: '2027-06' }),
    clientRow('has-opd', 'S7', { inStoreMonth: '2027-05', opd: '2027-04-01', opdMonth: '2027-04', retailDateMonth: '2027-06' }),
  ];
  assert.deepEqual(api.filterRows(rows, { season: 'S7', dateField: 'opd', periods: new Set() }).map(row => row.id), ['has-opd']);
});

test('shared comparison header formatter keeps same-season period sets distinguishable', () => {
  const api = loadApi();
  const current = { season: 'S7', dateField: 'inStore', selectedPeriods: new Set(['2027-05', '2027-04']) };
  const compare = { season: 'S7', dateField: 'inStore', selectedPeriods: new Set(['2027-01', '2027-02']) };
  assert.equal(api.comparisonColumnHeader(current, 'FOB'), 'S7 FOB\nMayıs 2027\nNisan 2027');
  assert.equal(api.comparisonColumnHeader(compare, 'FOB'), 'S7 FOB\nOcak 2027\nŞubat 2027');
  assert.equal(api.comparisonColumnHeader({ season: 'S7', selectedPeriods: new Set() }, 'FOB'), 'S7 FOB');
});

test('Bangladesh and Bangladeş share the same LFL country identity', () => {
  const api = loadApi();
  assert.equal(api.countryIdentity('Bangladesh'), 'BD');
  assert.equal(api.countryIdentity('Bangladeş'), 'BD');
  const row = clientRow('country-alias', 'S7', { inStoreMonth: '2027-04' });
  row.country = 'Bangladeş';
  assert.deepEqual(
    api.filterRows([row], {
      season: 'S7',
      dateField: 'inStore',
      periods: new Set(['2027-04']),
      country: new Set(['Bangladesh']),
    }).map(item => item.id),
    ['country-alias'],
  );
});

test('LFL Trial carries Collection Product Description into the synthetic row', () => {
  const api = loadApi({
    fobFor() { return { fob: 10, source: 'fob', base: 10, royalty: 0, hologram: 0 }; },
    monthCodeFor() { return '2027-04'; },
    quantityFor() { return 100; },
  });
  const scope = {
    season: 'S7',
    months: ['2027-04'],
    filters: { productDescription: ['CU4E - T-Shirt'], country: ['Bangladeş'] },
  };
  const draft = api.trialDraftFromModel({
    id: 'trial-product-description',
    modelKod: 'MODEL-A',
    mag: 'MAG1',
    mmyg: 'MMYG1',
    urunTipi: 'K1',
    productMainDefinition: 'CU4E - T-Shirt',
    country: 'Bangladesh',
    buyingGroup: 'BG',
    buyer: 'BUYER',
    quantity: 100,
  }, scope, { fob: 10 });
  assert.equal(draft.productDescription, 'CU4E - T-Shirt');
  assert.equal(api.countryIdentity(draft.country), 'BD');

  const built = api.trialRowFrom(draft, scope);
  assert.ok(built.row);
  assert.equal(built.row.productDescription, 'CU4E - T-Shirt');
  assert.deepEqual(
    api.filterRows([built.row], {
      season: 'S7',
      dateField: 'inStore',
      periods: new Set(['2027-04']),
      productDescription: new Set(['CU4E - T-Shirt']),
      country: new Set(['Bangladeş']),
    }).map(row => row.id),
    ['trial:trial-product-description'],
  );
});

test('LFL Trial reports a selected filter dimension that is missing from a Collection model', () => {
  const api = loadApi();
  const scope = {
    season: 'S7',
    months: ['2027-04'],
    filters: { productDescription: ['CU4E - T-Shirt'] },
  };
  const notices = api.trialScopeNotices({
    id: 'missing-product-description',
    productDescription: '',
    inStoreMonth: '2027-04',
  }, scope);
  assert.ok(notices.some(item => item.field === 'productDescription'));
});

test('LFL UI exposes independent date-field selectors and multiline table headers', () => {
  assert.match(HTML, /id="lflCurrentDateField"[^>]*>[\s\S]*?value="inStore"[\s\S]*?value="opd"[\s\S]*?value="retailDate"/);
  assert.match(HTML, /id="lflCompareDateField"[^>]*>[\s\S]*?value="inStore"[\s\S]*?value="opd"[\s\S]*?value="retailDate"/);
  assert.match(LFL, /periods:\{current:\{dateField:'inStore'\},compare:\{dateField:'inStore'\}\}/);
  assert.match(LFL, /currentDateField:normalizeDateField\(state\.periods\.current\.dateField\)/);
  assert.match(LFL, /compareDateField:normalizeDateField\(state\.periods\.compare\.dateField\)/);
  assert.match(LFL, /data-scenario-date-field="current"/);
  assert.match(LFL, /data-scenario-date-field="compare"/);
  assert.match(CSS, /#lflGroupTable,#lflManufacturerVolumeTable/);
  assert.match(CSS, /white-space:pre-line!important/);
  assert.match(CSS, /min-height:42px/);
});
