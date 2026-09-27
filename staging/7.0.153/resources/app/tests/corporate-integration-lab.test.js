'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lab = require('../server/lib/corporate-integration-lab');

function overview() {
  return {
    sources: [
      {
        id: 'mc_asas', name: 'ASAS', profileId: 'asas-orders', profileLabel: 'Sipariş Verisi',
        engine: 'tabular-dax', shape: 'rows', status: 'ready', moduleCount: 5,
        capabilities: ['field-mapping', 'filters', 'schema-discovery'],
        connection: { server: 'corp-model', catalog: 'ASAS' }, queryMode: 'generated',
        mappedFieldCount: 4, mapping: { ok: 4, review: 0, blocking: 0, needsAttention: 0, problems: [] },
        lastRun: { at: '2026-09-11T18:10:00.000Z', ok: true, rowCount: 3, error: '' },
      },
      {
        id: 'mc_ias', name: 'IAS', profileId: 'ias-warehouse', profileLabel: 'Antrepo Verisi',
        engine: 'tabular-dax', shape: 'rows', status: 'needs-mapping', moduleCount: 3,
        capabilities: ['field-mapping', 'filters', 'schema-discovery'],
        connection: { server: 'corp-model', catalog: 'IAS' }, queryMode: 'manual',
        mappedFieldCount: 3,
        mapping: { ok: 3, review: 1, blocking: 1, needsAttention: 2, problems: [{ header: 'Renk Kod', status: 'unmapped', required: true }] },
        lastRun: { at: '2026-09-11T18:05:00.000Z', ok: true, rowCount: 4, error: '' },
      },
    ],
    modules: [
      { id: 'cp', label: 'CP', connectedCount: 2 },
      { id: 'orders', label: 'Orders', connectedCount: 2 },
    ],
    summary: { sourceCount: 2, readyCount: 1, problemCount: 1, fedModuleCount: 2, totalFedModules: 2 },
  };
}

test('environment is evidence-based and never calls a local run corporate-live', () => {
  assert.equal(lab.deriveEnvironment({ supported: true, probes: [] }).mode, 'LOCAL_SIMULATION');
  assert.equal(lab.deriveEnvironment({ supported: true, probes: [{ kind: 'live-connectivity', ok: true, simulated: true }] }).mode, 'LOCAL_SIMULATION');
  const live = lab.deriveEnvironment({ supported: true, probes: [{ kind: 'live-connectivity', ok: true, simulated: false, at: '2026-09-11T18:00:00.000Z' }] });
  assert.equal(live.mode, 'CORPORATE_LIVE');
  assert.equal(live.validationRequired, false);
});

test('IAS inspector reports row loss, duplicates, mapping blockers and one-record trace', () => {
  const rows = [
    { 'Sipariş Kod': '450123', 'Ürün Ad': 'TSHIRT', 'Renk Kod': 'BLK', 'Yükleme Toplam Adet': 20 },
    { 'Sipariş Kod': '450123', 'Ürün Ad': 'TSHIRT', 'Renk Kod': 'BLK', 'Yükleme Toplam Adet': 20 },
    { 'Sipariş Kod': '450124', 'Ürün Ad': 'TSHIRT', 'Renk Kod': 'WHT', 'Yükleme Toplam Adet': 10 },
    { 'Sipariş Kod': '', 'Ürün Ad': 'TSHIRT', 'Renk Kod': 'RED', 'Yükleme Toplam Adet': 5 },
  ];
  const inspected = lab.inspectSource({
    source: overview().sources[1],
    rawRows: rows,
    normalizedRows: rows.slice(0, 3),
    modelRows: rows.slice(0, 2),
    traceValue: '450123',
  });

  assert.deepEqual(inspected.pipeline.map(stage => stage.id), ['source', 'connectivity', 'query', 'raw', 'normalization', 'mapping', 'model', 'reference']);
  assert.equal(inspected.metrics.rawRows, 4);
  assert.equal(inspected.metrics.normalizedRows, 3);
  assert.equal(inspected.metrics.modelRows, 2);
  assert.equal(inspected.metrics.rowLoss, 2);
  assert.equal(inspected.metrics.duplicateRows, 1);
  assert.equal(inspected.metrics.missingOrderKeys, 1);
  assert.equal(inspected.pipeline.find(stage => stage.id === 'mapping').status, 'fail');
  assert.equal(inspected.trace.value, '450123');
  assert.equal(inspected.trace.stages.raw.matches, 2);
  assert.equal(inspected.trace.stages.model.matches, 2);
});

test('live probe evidence separates connectivity success from query failure', () => {
  const inspected = lab.inspectSource({
    source: { ...overview().sources[1], mapping: { ok: 3, review: 0, blocking: 0, needsAttention: 0, problems: [] } },
    rawRows: [],
    liveProbe: {
      kind: 'live-connectivity',
      sourceId: 'mc_ias',
      ok: true,
      provider: 'MSOLAP',
      tableCount: 12,
      elapsedMs: 42,
      queryOk: false,
      queryRowCount: 0,
      queryCode: 'MODEL_QUERY_FAILED',
      queryError: "Column 'Buyer Grup (TR)' cannot be found",
      queryRuns: [{ id: 'cp', ok: false, code: 'MODEL_QUERY_FAILED' }],
    },
  });
  assert.equal(inspected.pipeline.find(stage => stage.id === 'connectivity').status, 'pass');
  assert.equal(inspected.pipeline.find(stage => stage.id === 'query').status, 'fail');
  assert.equal(inspected.status, 'fail');
  assert.equal(inspected.liveProbe.queryCode, 'MODEL_QUERY_FAILED');
});


test('IAS inspector uses the existing ASAS-IAS join audit as model-stage evidence', () => {
  const inspected = lab.inspectSource({
    source: { ...overview().sources[1], mapping: { ok: 3, review: 0, blocking: 0, needsAttention: 0, problems: [] } },
    rawRows: [{ 'Sipariş Kod': '450123' }, { 'Sipariş Kod': '450124' }],
    joinAudit: {
      rule: 'custom',
      ruleLabel: 'Sipariş Kod + Ürün Ad + Renk Kod',
      totals: { asasRows: 10, iasRows: 2, matched: 7, unmatched: 3 },
      conditions: [{ id: 'order', asasLabel: 'Sipariş Kod', iasLabel: 'Sipariş Kod' }],
      fields: { order: { shared: 7, asasOnly: ['450999'], iasOnly: [] } },
      samples: [{ anchor: '450999', mismatch: ['colour'] }],
    },
  });

  const modelStage = inspected.pipeline.find(stage => stage.id === 'model');
  assert.equal(inspected.metrics.modelRows, 7);
  assert.equal(inspected.metrics.rowLoss, 3);
  assert.equal(inspected.metrics.joinInputRows, 10);
  assert.equal(modelStage.status, 'warning');
  assert.match(modelStage.note, /7\/10/);
  assert.equal(modelStage.evidence.ruleLabel, 'Sipariş Kod + Ürün Ad + Renk Kod');
  assert.deepEqual(inspected.join.samples[0].mismatch, ['colour']);
});

test('AI diagnostic packages redact secrets recursively in JSON and text', () => {
  const payload = lab.buildDiagnosticPackage({
    environment: { mode: 'LOCAL_SIMULATION', validationRequired: true },
    inventory: [{ id: 'ias', status: 'warning', note: 'Bearer abc.def.ghi', password: 'top-secret' }],
    inspector: { url: 'https://example.test/path?token=hello&safe=yes', cookie: 'sid=secret' },
  });
  const serialized = JSON.stringify(payload.json);
  assert.doesNotMatch(serialized, /top-secret|abc\.def\.ghi|token=hello|sid=secret/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(payload.text, /top-secret|abc\.def\.ghi|token=hello|sid=secret/);
  assert.match(payload.text, /LOCAL_SIMULATION/);
});

test('Troy recipes are exposed only as dry-run diagnostics with bounded step evidence', () => {
  const result = lab.describeAutomations({
    recipes: [{
      id: 'r1', name: 'Troy Close Order', purpose: 'browser', url: 'https://troy.example/orders',
      steps: Array.from({ length: 80 }, (_, index) => ({ id: `s${index}`, action: index === 79 ? 'click' : 'assert_text', selector: '.secret', value: `v${index}` })),
    }],
    runs: [{ recipeId: 'r1', status: 'completed', dryRun: false }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].executionMode, 'dry-run-only');
  assert.equal(result[0].steps.length, 50);
  assert.equal(result[0].truncatedSteps, 30);
  assert.ok(!('runs' in result[0]));
});

test('lab snapshot reuses registry read-model evidence and includes web integration state', () => {
  const snapshot = lab.buildSnapshot({
    overview: overview(),
    support: { supported: true, platformLabel: 'Windows' },
    probes: [],
    sourceRows: { mc_asas: [{ ocode: '1' }], mc_ias: [{ 'Sipariş Kod': '2' }] },
    automations: { recipes: [{ id: 'troy', name: 'Troy', purpose: 'browser', url: 'https://troy.example', steps: [] }], runs: [] },
  });
  assert.equal(snapshot.environment.mode, 'LOCAL_SIMULATION');
  assert.deepEqual(snapshot.probes, []);
  assert.ok(snapshot.inventory.some(item => item.id === 'mc_ias' && item.kind === 'database'));
  assert.ok(snapshot.inventory.some(item => item.id === 'automation:troy' && item.kind === 'web'));
  assert.equal(snapshot.selectedInspector.sourceId, 'mc_ias');
  assert.equal(snapshot.safety.destructiveAutomation, 'dry-run-only');
});

test('snapshot exports persisted live probe details for AI diagnostics', () => {
  const snapshot = lab.buildSnapshot({
    overview: overview(),
    support: { supported: true, platformLabel: 'Windows' },
    probes: [{
      kind: 'live-connectivity', sourceId: 'mc_ias', sourceName: 'IAS',
      ok: true, simulated: false, at: '2026-09-27T09:00:00.000Z',
      provider: 'MSOLAP', queryOk: false, queryCode: 'MODEL_QUERY_FAILED',
      queryError: "Column 'Buyer Grup (TR)' cannot be found",
      queryRuns: [{ id: 'cp', ok: false, query: 'EVALUATE ...', error: 'bad query' }],
    }],
    sourceRows: { mc_asas: [], mc_ias: [] },
  });
  assert.equal(snapshot.environment.mode, 'CORPORATE_LIVE');
  assert.equal(snapshot.probes.length, 1);
  assert.equal(snapshot.probes[0].queryOk, false);
  assert.equal(snapshot.inspectors.find(item => item.sourceId === 'mc_ias').pipeline.find(stage => stage.id === 'query').status, 'fail');
  const pkg = lab.buildDiagnosticPackage(snapshot);
  assert.match(pkg.text, /LIVE PROBES/);
  assert.match(pkg.text, /query=fail/);
});

test('Corporate Integration Lab is wired lazily into the existing Data Management screen', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'public/data-management.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/data-management.css'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
  const perf = fs.readFileSync(path.join(ROOT, 'public/perf-runtime.js'), 'utf8');

  assert.match(ui, /Corporate Integration Lab/);
  assert.match(ui, /\['integrations',/);
  assert.match(ui, /\['inspector',/);
  assert.match(ui, /\['automation',/);
  assert.match(ui, /data-lab-tab=/);
  assert.match(ui, /data-lab-ai-export/);
  assert.match(ui, /if \(model\.canManage\) tabs\.push/);
  assert.match(ui, /ASAS–IAS eşleştirme kanıtı/);
  assert.match(ui, /\/api\/data-management\/integration-lab/);
  assert.match(ui, /\/api\/automations\/recipes\/\$\{encodeURIComponent\(recipeId\)\}\/preview/);
  assert.doesNotMatch(ui, /\/api\/automations\/recipes\/\$\{encodeURIComponent\(recipeId\)\}\/run/);
  assert.match(server, /app\.get\('\/api\/data-management\/integration-lab'/);
  assert.match(server, /app\.post\('\/api\/data-management\/integration-lab\/inspect'/);
  assert.match(server, /integrationLabProbeCache/);
  assert.match(server, /integrationLabProbeIntake/);
  assert.match(server, /buildConnectionQuery\(scoped/);
  assert.match(css, /\.dmLabPipeline/);
  assert.match(perf, /data-management\.js/);
});
