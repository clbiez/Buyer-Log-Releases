'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rules = require('../public/business-rules');
const UI = fs.readFileSync(path.join(ROOT, 'public', 'license-royalty-commissions.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const DB = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

test('License Royalty v2 ülkeye göre Royalty + yüzde komisyon uygular', () => {
  const rule = { royalty:18, trCommission:3, ydCommission:2, hologramCost:0.05 };
  assert.equal(rules.pricingRuleEffectiveRoyalty(rule, 'TR'), 21);
  assert.equal(rules.pricingRuleEffectiveRoyalty(rule, 'Türkiye'), 21);
  assert.equal(rules.pricingRuleEffectiveRoyalty(rule, 'Bangladesh'), 20);
  assert.equal(rules.calculateFinalFobWithRule(1, rule, 'YD'), 1.30);
  assert.equal(rules.calculateFinalFobWithRule(1, rule, 'TR'), 1.32);
  assert.equal(rules.calculateSuppFobWithRule(1.30, rule, 'YD'), 1);
});

test('eski TR / Non-TR çiftleri efektif oranları kaybetmeden tek kayda migrate olur', () => {
  const migrated = rules.migrateLicenseRoyaltyRules([
    { id:'tr-old', opdStart:'2026-01-01', opdEnd:'2026-12-31', seasons:['S7'], countryGroup:'TR', licensor:'ERMODA', license:'Example', royalty:21, hologramCost:0.079 },
    { id:'yd-old', opdStart:'2026-01-01', opdEnd:'2026-12-31', seasons:['S7'], countryGroup:'Non-TR', licensor:'ERMODA', license:'Example', royalty:20, hologramCost:0.057 },
  ]);
  assert.equal(migrated.length, 1);
  const rule = migrated[0];
  assert.equal(rule.royalty, 20);
  assert.equal(rule.trCommission, 1);
  assert.equal(rule.ydCommission, 0);
  assert.equal(rule.legacyTrHologramCost, 0.079);
  assert.equal(rule.legacyYdHologramCost, 0.057);
  assert.equal(rules.calculateFinalFobWithRule(1, rule, 'TR'), 1.34);
  assert.equal(rules.calculateFinalFobWithRule(1, rule, 'YD'), 1.31);
  assert.deepEqual(new Set(rule.legacyRuleIds), new Set(['tr-old','yd-old']));
});

test('tek taraflı eski kayıt diğer ülkeye yanlışlıkla uygulanmaz', () => {
  const [rule] = rules.migrateLicenseRoyaltyRules([
    { id:'yd-only', countryGroup:'Non-TR', licensor:'ERMODA', license:'Only YD', royalty:18, hologramCost:0.05 },
  ]);
  assert.equal(rule.ydCommission, 0);
  assert.equal(rule.trCommission, null);
  assert.equal(rules.pricingRuleCommissionForCountry(rule, 'Bangladesh'), 0);
  assert.equal(rules.pricingRuleCommissionForCountry(rule, 'TR'), null);
  assert.equal(rules.calculateFinalFobWithRule(1, rule, 'TR'), null);
});

test('arayüz ülke satırını kaldırır, TR/YD komisyon ve çift Final FOB gösterir', () => {
  assert.match(INDEX, /license-royalty-commissions\.js/);
  assert.match(UI, /id="_ruleTrCommission"/);
  assert.match(UI, /id="_ruleYdCommission"/);
  assert.match(UI, /id="_ruleCheckFinalYd"/);
  assert.match(UI, /id="_ruleCheckFinalTr"/);
  assert.doesNotMatch(UI, /id="_ruleCountry"/);
  assert.match(UI, /Royalty % \+ Ülke Komisyonu %/);
});

test('sunucu yeni komisyon alanlarını saklar ve countryGroup zorunluluğunu kaldırır', () => {
  const start = SERVER.indexOf("app.put('/api/pricing-rules'");
  const end = SERVER.indexOf('const normalizeTransitDelType', start);
  const block = SERVER.slice(start, end);
  assert.match(block, /migrateLicenseRoyaltyRules\(incoming\)/);
  assert.match(block, /trCommission: nullablePercent\(r\.trCommission\)/);
  assert.match(block, /ydCommission: nullablePercent\(r\.ydCommission\)/);
  assert.match(block, /sameCountrySide/);
  assert.doesNotMatch(block, /countryGroup: normalizePricingCountryGroup\(r\.countryGroup\)/);
  assert.doesNotMatch(block, /r\.countryGroup && r\.licensor/);
});

test('db okuma migrasyonu ve Supp FOB metadata komisyon detaylarını korur', () => {
  assert.match(DB, /merged\.pricingRules = BLBusinessRules\.migrateLicenseRoyaltyRules/);
  assert.match(DB, /trCommission: meta\.trCommission/);
  assert.match(DB, /ydCommission: meta\.ydCommission/);
  assert.match(DB, /effectiveRoyalty: meta\.effectiveRoyalty/);
});
