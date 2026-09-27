'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rules = require('../public/business-rules');
const { createTableSearch } = require('./helpers/bl-table-search');

const ROOT = path.join(__dirname, '..');
const LFL = fs.readFileSync(path.join(ROOT, 'public', 'lfl.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function loadApi() {
  const context = {
    BLTableSearch: createTableSearch(),
    BLBusinessRules: rules,
    window: {
      classifyDtrByManufacturer() { return 'DTR'; },
      isNonDtrManufacturer() { return false; },
    },
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

function row(id, season, month, quantity, fob) {
  return {
    id,
    orderCode: id,
    modelName: 'MODEL-' + id,
    mag: 'CU4E',
    mmyg: 'MMYG1',
    classification: 'KEY ORME BODY K.KOL-LISANS',
    manufacturer: 'MFR',
    country: 'BANGLADEŞ',
    buyingGroup: 'LİSANS',
    buyer: 'BUYER',
    season,
    inStore: month + '-10',
    inStoreMonth: month,
    fob,
    quantity,
  };
}

test('Multi-dimensional Comparison exposes a saved-summary refresh button', () => {
  assert.match(HTML, /id="lflScenarioRefreshBtn"[^>]*>[\s\S]*?#i-refresh[\s\S]*?Özetleri Yenile/);
  assert.match(LFL, /lflScenarioRefreshBtn/);
  assert.match(LFL, /addEventListener\('click',refreshComparisonScenarios\)/);
});

test('saved comparison refresh reloads source but restores the exact saved scenario definitions', () => {
  assert.match(LFL, /async function refreshComparisonScenarios\(\)/);
  assert.match(LFL, /serializeComparisonScenario\(item,index\)/);
  assert.match(LFL, /await load\(true,\{silent:true,preserveOnError:true\}\)/);
  assert.match(LFL, /state\.customCompare\.scenarios=snapshots\.map\(\(item,index\)=>normalizeComparisonScenario\(item,index\)\)/);
  assert.match(LFL, /saveCustomCompare\(\);lflScenarioCache\.clear\(\)/);
  assert.match(LFL, /async function load\(force=false,options=\{\}\)/);
  assert.match(LFL, /options\.preserveOnError/);
});

test('same saved filters automatically include newly arrived matching LFL rows after refresh', () => {
  const api = loadApi();
  const scenario = {
    id: 'saved-1',
    name: 'CU4E - Mayıs LFL',
    currentSeason: 'S7',
    compareSeason: 'S6',
    currentDateField: 'inStore',
    compareDateField: 'inStore',
    currentMonths: ['2027-05'],
    compareMonths: ['2026-05'],
    filters: {
      mag: ['CU4E'],
      country: ['BANGLADEŞ'],
      buyingGroup: ['LİSANS'],
    },
    inheritGlobal: false,
  };
  const originalRows = [
    row('current-1', 'S7', '2027-05', 100, 2),
    row('compare-1', 'S6', '2026-05', 100, 1),
  ];
  const before = api.scenarioComparisonResult(originalRows, scenario, {});
  assert.equal(before.currentQty, 100);
  assert.equal(before.current.avg, 2);

  const refreshedRows = [
    ...originalRows,
    row('current-new', 'S7', '2027-05', 50, 4),
  ];
  const after = api.scenarioComparisonResult(refreshedRows, scenario, {});
  assert.equal(after.currentQty, 150);
  assert.ok(Math.abs(after.current.avg - (400 / 150)) < 1e-12);
  assert.deepEqual(Array.from(after.filters.mag), ['CU4E']);
  assert.deepEqual(Array.from(after.filters.country), ['BANGLADEŞ']);
});
