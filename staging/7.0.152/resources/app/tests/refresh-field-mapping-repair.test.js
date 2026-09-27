'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fieldMappingRepairFromError } = require('../server/lib/model-refresh');

const ROOT = path.join(__dirname, '..');

test('missing tabular column is converted to a precise field-mapping repair action', () => {
  const repair = fieldMappingRepairFromError({
    id: 'ias-main',
    name: 'IAS Database',
    role: 'antrepo',
    horizon: { table: 'Siparis Bilgileri' },
    mapping: {
      'Buyer Grup (TR)': {
        table: 'Siparis Bilgileri',
        name: 'Buyer Grup (TR)',
        kind: 'column',
      },
    },
    _scopeTargets: ['cp', 'orders', 'backlog'],
  }, new Error("Query (10, 28) Column 'Buyer Grup (TR)' in table 'Siparis Bilgileri' cannot be found or may not be used in this expression. (DAX sorgusunda sözdizimi hatası var.)"));

  assert.ok(repair);
  assert.equal(repair.kind, 'field-mapping');
  assert.equal(repair.sourceId, 'ias-main');
  assert.equal(repair.header, 'Buyer Grup (TR)');
  assert.equal(repair.table, 'Siparis Bilgileri');
  assert.equal(repair.column, 'Buyer Grup (TR)');
  assert.deepEqual(repair.targets, ['cp', 'orders', 'backlog']);
});

test('unrelated database errors do not invent a field-mapping repair', () => {
  const repair = fieldMappingRepairFromError({
    id: 'ias-main',
    role: 'antrepo',
    mapping: {},
  }, new Error('VPN connection timed out'));
  assert.equal(repair, null);
});

test('refresh failure UI carries repair metadata into Data Management and retries after save', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app-main.js'), 'utf8');
  const management = fs.readFileSync(path.join(ROOT, 'public', 'data-management.js'), 'utf8');
  const mapping = fs.readFileSync(path.join(ROOT, 'public', 'data-management-mapping.js'), 'utf8');

  assert.match(app, /data-refresh-repair/);
  assert.match(app, /mappingRepair/);
  assert.match(app, /BLRetryRefreshAfterFieldMapping/);
  assert.match(app, /err\.repairAction=jobState\.repairAction\|\|null/);
  assert.match(management, /openMappingEditor\(sourceId, mappingRepair = null\)/);
  assert.match(management, /repairedTarget/);
  assert.match(mapping, /reopen\(payload\.warnings \|\| \[\], \{ header, entry \}\)/);
});
