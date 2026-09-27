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
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app-main.js'), 'utf8');

function between(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, 'start marker missing: ' + start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, 'end marker missing: ' + end);
  return source.slice(a, b);
}

function loadApi(collectionBridge) {
  const context = {
    BLTableSearch: createTableSearch(),
    BLBusinessRules: rules,
    window: {
      BLCollection: collectionBridge,
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

test('Collection bridge gives LFL Trial the effective FOB cell directly', () => {
  const fobFor = between(APP, '  fobFor(row){', '  seasonFor(row)');
  assert.match(fobFor, /kolEffectiveValue\(row,'fob'\)/);
  assert.match(fobFor, /source:'fob'/);
  assert.doesNotMatch(fobFor, /this\.priceFor\(row\)/);
  assert.doesNotMatch(fobFor, /kolComputeFobFromConfirmed\(/);
});

test('LFL Trial ignores cached/manual Trial price and uses current Collection FOB', () => {
  const bridge = {
    fobFor() { return { fob: 2.83, source: 'fob', base: 2.83, royalty: 25, hologram: 0 }; },
    monthCodeFor() { return '2027-04'; },
    quantityFor() { return 100; },
  };
  const api = loadApi(bridge);
  const scope = { season: 'S7', months: ['2027-04'], filters: {} };
  const model = {
    id: 'trial-fob-source',
    modelKod: 'MODEL-A',
    mag: 'MAG1',
    mmyg: 'MMYG1',
    urunTipi: 'K1',
    country: 'Bangladesh',
    buyingGroup: 'BG',
    buyer: 'BUYER',
    quantity: 100,
  };
  const draft = api.trialDraftFromModel(model, scope, {
    fob: 1.67,
    priceSource: 'best',
    inStoreMonth: '2027-04',
  });
  assert.equal(draft.fob, 2.83);
  assert.equal(draft.priceSource, 'fob');
  assert.equal(draft.priceBase, 2.83);
});

test('active and reopened Trial drafts are refreshed from live Collection rows', () => {
  const apply = between(LFL, '  function applyTrialRows(){', '  function trialConfiguredCount()');
  assert.match(apply, /bridge=window\.BLCollection/);
  assert.match(apply, /collectionById=new Map/);
  assert.match(apply, /trialDraftFromModel\(model,scope,item\)/);
  assert.match(apply, /fields\.delete\('fob'\)/);

  const panel = between(LFL, '  function openTrialPanel(options){', '  window.openLflTrialFromCollection=');
  assert.match(panel, /found\?trialDraftFromModel\(found\.model,scope,item\)/);
  assert.match(panel, /filter\(field=>field!=='fob'\)/);
});

test('FOB cannot be manually suggested or edited inside LFL Trial', () => {
  assert.match(LFL, /if\(field==='fob'\)return null;/);
  const editor = between(LFL, '  function trialIssueEditor(', '  function openTrialPanel(');
  assert.match(editor, /field==='fob'/);
  assert.match(editor, /readonly aria-readonly="true"/);
  assert.match(editor, /LFL Trial her zaman Koleksiyon’daki hesaplanmış FOB değerini kullanır/);
});
