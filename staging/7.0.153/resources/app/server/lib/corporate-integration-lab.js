'use strict';

/* Corporate Integration Lab is a read-only diagnostic projection. It consumes
   the existing Data Management read model and runtime caches; it never owns a
   second connection, mapping, refresh or automation configuration. */

const MAX_SAMPLE_ROWS = 12;
const MAX_AUTOMATION_STEPS = 50;
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|authorization|cookie|session|api[-_]?key|client[-_]?secret)/i;
const SENSITIVE_QUERY = /([?&](?:access_token|token|api_key|apikey|key|secret|password|session)=)[^&#\s]*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function clean(value) { return String(value == null ? '' : value).trim(); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }

function redactString(value) {
  return String(value)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(JWT, '[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]');
}

function redact(value, keyHint = '', seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(clean(keyHint))) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, '', seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redact(item, key, seen);
  return out;
}

function deriveEnvironment({ supported = false, probes = [] } = {}) {
  const live = (Array.isArray(probes) ? probes : []).find(probe =>
    probe && probe.kind === 'live-connectivity' && probe.ok === true && probe.simulated !== true);
  if (supported === true && live) {
    return {
      mode: 'CORPORATE_LIVE',
      label: 'Corporate Live',
      validationRequired: false,
      evidence: { kind: live.kind, at: clean(live.at), sourceId: clean(live.sourceId) },
    };
  }
  return {
    mode: 'LOCAL_SIMULATION',
    label: 'Local Simulation',
    validationRequired: true,
    validationLabel: 'CORPORATE VALIDATION REQUIRED',
    evidence: supported === true ? { kind: 'no-live-probe' } : { kind: 'platform-unsupported' },
  };
}

function valueFor(row, names) {
  if (!row || typeof row !== 'object') return '';
  for (const name of names) {
    if (row[name] != null && clean(row[name])) return clean(row[name]);
  }
  const folded = new Map(Object.keys(row).map(key => [clean(key).toLocaleLowerCase('tr-TR'), key]));
  for (const name of names) {
    const key = folded.get(clean(name).toLocaleLowerCase('tr-TR'));
    if (key && row[key] != null) return clean(row[key]);
  }
  return '';
}

const ORDER_FIELDS = ['Sipariş Kod', 'Sipariş Kodu', 'Order Code', 'ocode', 'orderCode', 'order'];
const MODEL_FIELDS = ['Ürün Ad', 'Ürün Adı', 'Model Adı', 'Model', 'model'];
const COLOUR_FIELDS = ['Renk Kod', 'Renk Kodu', 'Colour Code', 'Color Code', 'ccode', 'colourCode'];

function logicalKey(row) {
  const order = valueFor(row, ORDER_FIELDS);
  const model = valueFor(row, MODEL_FIELDS);
  const colour = valueFor(row, COLOUR_FIELDS);
  return order || model || colour ? `${order}\u001f${model}\u001f${colour}` : '';
}

function rowMetrics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  let duplicates = 0;
  let missingOrderKeys = 0;
  for (const row of list) {
    if (!valueFor(row, ORDER_FIELDS)) missingOrderKeys += 1;
    const key = logicalKey(row);
    if (!key) continue;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return { rows: list.length, duplicateRows: duplicates, missingOrderKeys };
}

function stage(id, label, status, count, note, evidence = {}) {
  return { id, label, status, count: Number.isFinite(Number(count)) ? Number(count) : null, note: clean(note), evidence: redact(evidence) };
}

function matchesTrace(row, wanted) {
  if (!wanted) return false;
  return Object.values(row || {}).some(value => clean(value).toLocaleLowerCase('tr-TR') === wanted);
}

function traceRows(rows, traceValue) {
  const wanted = clean(traceValue).toLocaleLowerCase('tr-TR');
  const list = Array.isArray(rows) ? rows : [];
  const matched = wanted ? list.filter(row => matchesTrace(row, wanted)) : [];
  return { matches: matched.length, sample: redact(matched.slice(0, 3)) };
}

function inspectSource({ source = {}, rawRows = [], normalizedRows = null, modelRows = null, referenceRows = null, traceValue = '', joinAudit = null, liveProbe = null } = {}) {
  const raw = Array.isArray(rawRows) ? rawRows : [];
  const normalized = Array.isArray(normalizedRows) ? normalizedRows : raw;
  const modeled = Array.isArray(modelRows) ? modelRows : normalized;
  const reference = Array.isArray(referenceRows) ? referenceRows : null;
  const rawInfo = rowMetrics(raw);
  const normalizedInfo = rowMetrics(normalized);
  const mapped = source.mapping || {};
  const mappingBlocked = finite(mapped.blocking) > 0;
  const configured = Boolean(source.connection && clean(source.connection.server) && clean(source.connection.catalog));
  const hasLiveProbe = Boolean(liveProbe && liveProbe.kind === 'live-connectivity');
  const liveConnectivityOk = hasLiveProbe && liveProbe.ok === true;
  const liveQueryKnown = hasLiveProbe && typeof liveProbe.queryOk === 'boolean';
  const liveQueryRows = hasLiveProbe ? finite(liveProbe.queryRowCount) : 0;
  const joinTotals = joinAudit && joinAudit.totals && typeof joinAudit.totals === 'object' ? joinAudit.totals : null;
  const hasJoinAudit = Boolean(joinTotals);
  const modelInputRows = hasJoinAudit ? finite(joinTotals.asasRows) : raw.length;
  const modelOutputRows = hasJoinAudit ? finite(joinTotals.matched) : modeled.length;
  const rowLoss = hasJoinAudit ? finite(joinTotals.unmatched) : Math.max(0, raw.length - modeled.length);
  const joinEvidence = hasJoinAudit ? {
    rule: clean(joinAudit.rule),
    ruleLabel: clean(joinAudit.ruleLabel),
    totals: joinTotals,
    conditions: Array.isArray(joinAudit.conditions) ? joinAudit.conditions : [],
    fields: joinAudit.fields || {},
    samples: Array.isArray(joinAudit.samples) ? joinAudit.samples.slice(0, MAX_SAMPLE_ROWS) : [],
  } : null;

  const pipeline = [
    stage('source', 'Source', configured ? 'pass' : 'fail', null,
      configured ? `${clean(source.connection.server)} / ${clean(source.connection.catalog)}` : 'Connection is not configured',
      { sourceId: source.id, profileId: source.profileId, engine: source.engine, shape: source.shape }),
    stage('connectivity', 'Live Connectivity',
      !hasLiveProbe ? 'optional' : (liveConnectivityOk ? 'pass' : 'fail'), null,
      !hasLiveProbe
        ? 'Live connection has not been tested in this diagnostic session'
        : (liveConnectivityOk
          ? `Live connection verified${liveProbe.provider ? ` via ${clean(liveProbe.provider)}` : ''}`
          : clean(liveProbe.error) || 'Live connection failed'),
      hasLiveProbe ? {
        at: liveProbe.at, provider: liveProbe.provider, method: liveProbe.method,
        tableCount: liveProbe.tableCount, elapsedMs: liveProbe.elapsedMs,
        error: liveProbe.error, code: liveProbe.code,
      } : {}),
    stage('query', 'Query',
      !configured ? 'blocked' : (liveQueryKnown ? (liveProbe.queryOk ? 'pass' : 'fail') : 'pass'), null,
      liveQueryKnown
        ? (liveProbe.queryOk
          ? `Live query executed successfully${liveQueryRows ? ` · ${liveQueryRows} rows sampled` : ''}`
          : clean(liveProbe.queryError) || 'Live query execution failed')
        : (source.queryMode === 'manual' ? 'Stored manual query; live execution not tested' : 'Generated from registered source metadata; live execution not tested'),
      liveQueryKnown ? {
        mode: source.queryMode || 'generated',
        queryOk: liveProbe.queryOk,
        queryRowCount: liveProbe.queryRowCount,
        queryCode: liveProbe.queryCode,
        queryError: liveProbe.queryError,
        queryRuns: liveProbe.queryRuns || [],
      } : { mode: source.queryMode || 'generated' }),
    stage('raw', 'Raw Data',
      raw.length ? 'pass' : (liveQueryRows ? 'warning' : (source.lastRun && source.lastRun.ok ? 'warning' : 'blocked')),
      raw.length || (liveQueryRows || 0),
      raw.length
        ? `${raw.length} cached rows available for inspection`
        : (liveQueryRows ? `${liveQueryRows} live rows returned; runtime cache is not populated` : 'No cached rows available'),
      { duplicateRows: rawInfo.duplicateRows, missingOrderKeys: rawInfo.missingOrderKeys, liveQueryRows }),
    stage('normalization', 'Normalization', rawInfo.duplicateRows || rawInfo.missingOrderKeys ? 'warning' : (normalized.length ? 'pass' : 'blocked'), normalized.length,
      `${rawInfo.duplicateRows} duplicate rows; ${rawInfo.missingOrderKeys} rows without order key`,
      { inputRows: raw.length, outputRows: normalized.length, duplicateRows: rawInfo.duplicateRows, missingOrderKeys: rawInfo.missingOrderKeys }),
    stage('mapping', 'Field Mapping', mappingBlocked ? 'fail' : (finite(mapped.needsAttention) ? 'warning' : 'pass'), finite(mapped.ok),
      mappingBlocked ? `${finite(mapped.blocking)} required fields are missing` : `${finite(mapped.needsAttention)} fields need review`,
      { ok: mapped.ok || 0, review: mapped.review || 0, blocking: mapped.blocking || 0, problems: mapped.problems || [] }),
    stage('model', 'Buyer Log Model', mappingBlocked ? 'blocked' : (rowLoss ? 'warning' : 'pass'), modelOutputRows,
      hasJoinAudit
        ? `${modelOutputRows}/${modelInputRows} ASAS rows matched; ${rowLoss} unmatched`
        : (rowLoss ? `${rowLoss} rows are not present after the pipeline` : 'No measured row loss'),
      hasJoinAudit
        ? { inputRows: modelInputRows, outputRows: modelOutputRows, rowLoss, ...joinEvidence }
        : { inputRows: raw.length, outputRows: modeled.length, rowLoss }),
    stage('reference', 'Reference Excel', reference ? (reference.length === modeled.length ? 'pass' : 'warning') : 'optional', reference ? reference.length : null,
      reference ? `${Math.abs(reference.length - modeled.length)} row count difference` : 'Optional comparison not supplied',
      reference ? { modelRows: modeled.length, referenceRows: reference.length } : {}),
  ];

  return {
    sourceId: clean(source.id),
    sourceName: clean(source.name),
    status: pipeline.some(item => item.status === 'fail') ? 'fail'
      : (pipeline.some(item => item.status === 'warning') ? 'warning' : 'pass'),
    metrics: {
      rawRows: raw.length,
      normalizedRows: normalized.length,
      modelRows: modelOutputRows,
      joinInputRows: hasJoinAudit ? modelInputRows : null,
      referenceRows: reference ? reference.length : null,
      rowLoss,
      duplicateRows: rawInfo.duplicateRows,
      missingOrderKeys: rawInfo.missingOrderKeys,
      normalizedDuplicateRows: normalizedInfo.duplicateRows,
      liveQueryRows,
    },
    pipeline,
    liveProbe: redact(liveProbe),
    samples: redact(raw.slice(0, MAX_SAMPLE_ROWS)),
    join: redact(joinEvidence),
    trace: {
      value: clean(traceValue),
      stages: {
        raw: traceRows(raw, traceValue),
        normalized: traceRows(normalized, traceValue),
        model: traceRows(modeled, traceValue),
        reference: traceRows(reference || [], traceValue),
      },
    },
  };
}

function statusForSource(source) {
  if (!source) return 'unknown';
  if (source.status === 'ready') return 'healthy';
  if (source.status === 'disabled' || source.status === 'unconfigured') return 'unavailable';
  if (source.status === 'error' || (source.mapping && finite(source.mapping.blocking))) return 'failed';
  return 'warning';
}

function describeAutomations(state = {}) {
  return (Array.isArray(state.recipes) ? state.recipes : [])
    .filter(recipe => ['browser', 'mixed'].includes(clean(recipe && recipe.purpose).toLowerCase()) || /troy/i.test(`${recipe && recipe.name || ''} ${recipe && recipe.url || ''}`))
    .map(recipe => {
      const allSteps = Array.isArray(recipe.steps) ? recipe.steps : [];
      return {
        id: clean(recipe.id),
        name: clean(recipe.name) || 'Browser automation',
        purpose: clean(recipe.purpose),
        host: (() => { try { return new URL(clean(recipe.url)).host; } catch (_) { return ''; } })(),
        enabled: recipe.enabled !== false,
        executionMode: 'dry-run-only',
        steps: redact(allSteps.slice(0, MAX_AUTOMATION_STEPS).map((entry, index) => ({
          id: clean(entry && entry.id) || `step-${index + 1}`,
          index: index + 1,
          action: clean(entry && entry.action),
          description: clean(entry && entry.description),
          target: clean(entry && (entry.target || entry.selector)),
        }))),
        truncatedSteps: Math.max(0, allSteps.length - MAX_AUTOMATION_STEPS),
      };
    });
}

function integrationInventory(overview, automations, sourceRows) {
  const databases = (overview.sources || []).map(source => ({
    id: clean(source.id), name: clean(source.name), kind: 'database', profileId: clean(source.profileId),
    engine: clean(source.engine), shape: clean(source.shape), status: statusForSource(source),
    rowCount: Array.isArray(sourceRows[source.id]) ? sourceRows[source.id].length : finite(source.lastRun && source.lastRun.rowCount),
    lastCheckedAt: clean(source.lastRun && source.lastRun.at),
    note: source.mapping && finite(source.mapping.blocking)
      ? `${finite(source.mapping.blocking)} required mappings missing`
      : source.lastRun && source.lastRun.error || '',
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.slice() : [],
  }));
  const web = automations.map(recipe => ({
    id: `automation:${recipe.id}`, name: recipe.name, kind: 'web', profileId: 'browser-automation',
    engine: 'browser', shape: 'steps', status: recipe.enabled ? 'configured' : 'unavailable',
    rowCount: null, lastCheckedAt: '', note: `${recipe.steps.length} dry-run steps`, capabilities: ['dry-run', 'diagnostic-export'],
  }));
  return [...databases, ...web];
}

function buildSnapshot({ overview = {}, support = {}, probes = [], sourceRows = {}, normalizedRows = {}, modelRows = {}, sourceAudits = {}, automations = {} } = {}) {
  const environment = deriveEnvironment({ supported: support.supported === true, probes });
  const describedAutomations = describeAutomations(automations);
  const inventory = integrationInventory(overview, describedAutomations, sourceRows);
  const probeBySource = new Map((Array.isArray(probes) ? probes : []).filter(Boolean).map(probe => [clean(probe.sourceId), probe]));
  const ias = (overview.sources || []).find(source => source.profileId === 'ias-warehouse') || (overview.sources || [])[0] || {};
  const selectedInspector = inspectSource({
    source: ias,
    rawRows: sourceRows[ias.id] || [],
    normalizedRows: normalizedRows[ias.id],
    modelRows: modelRows[ias.id],
    joinAudit: sourceAudits[ias.id],
    liveProbe: probeBySource.get(clean(ias.id)) || null,
  });
  return redact({
    environment,
    generatedAt: new Date().toISOString(),
    summary: {
      integrationCount: inventory.length,
      databaseCount: inventory.filter(item => item.kind === 'database').length,
      webCount: inventory.filter(item => item.kind === 'web').length,
      healthyCount: inventory.filter(item => item.status === 'healthy').length,
      attentionCount: inventory.filter(item => ['warning', 'failed', 'unavailable'].includes(item.status)).length,
    },
    inventory,
    probes: redact(Array.isArray(probes) ? probes : []),
    inspectors: (overview.sources || []).map(source => inspectSource({
      source,
      rawRows: sourceRows[source.id] || [],
      normalizedRows: normalizedRows[source.id],
      modelRows: modelRows[source.id],
      joinAudit: sourceAudits[source.id],
      liveProbe: probeBySource.get(clean(source.id)) || null,
    })),
    selectedInspector,
    automations: describedAutomations,
    safety: {
      destructiveAutomation: 'dry-run-only',
      configurationSource: 'existing Buyer Log registries and stores',
      secrets: 'redacted',
    },
    corporateValidation: environment.validationRequired
      ? { required: true, label: 'CORPORATE VALIDATION REQUIRED', checks: ['live source connectivity', 'corporate VPN data counts', 'Troy selectors against live DOM'] }
      : { required: false, label: 'LIVE PROBE VERIFIED', checks: [] },
  });
}

function textReport(value) {
  const snapshot = redact(value || {});
  const lines = [
    'BUYER LOG — CORPORATE INTEGRATION LAB DIAGNOSTIC',
    `Generated: ${clean(snapshot.generatedAt) || new Date().toISOString()}`,
    `Environment: ${clean(snapshot.environment && snapshot.environment.mode) || 'UNKNOWN'}`,
    `Corporate validation: ${snapshot.environment && snapshot.environment.validationRequired ? 'REQUIRED' : 'NOT REQUIRED'}`,
    '', 'INTEGRATIONS',
  ];
  for (const item of snapshot.inventory || []) {
    lines.push(`- ${clean(item.name)} [${clean(item.kind)}] ${clean(item.status)} rows=${item.rowCount == null ? 'n/a' : item.rowCount}${item.note ? ` — ${clean(item.note)}` : ''}`);
  }
  if ((snapshot.probes || []).length) {
    lines.push('', 'LIVE PROBES');
    for (const probe of snapshot.probes || []) {
      lines.push(`- ${clean(probe.sourceName || probe.sourceId)}: connectivity=${probe.ok === true ? 'pass' : 'fail'} query=${typeof probe.queryOk === 'boolean' ? (probe.queryOk ? 'pass' : 'fail') : 'not-run'}${probe.queryError ? ` — ${clean(probe.queryError)}` : ''}`);
    }
  }
  const inspector = snapshot.selectedInspector || snapshot.inspector;
  if (inspector) {
    lines.push('', `INSPECTOR — ${clean(inspector.sourceName || inspector.sourceId)}`);
    for (const item of inspector.pipeline || []) lines.push(`- ${item.label}: ${item.status}${item.count == null ? '' : ` (${item.count})`} — ${clean(item.note)}`);
  }
  lines.push('', 'SAFETY', '- Destructive automation: dry-run-only', '- Secrets: redacted');
  return lines.join('\n');
}

function buildDiagnosticPackage(snapshot) {
  const json = redact(snapshot || {});
  return { json, text: textReport(json) };
}

module.exports = {
  MAX_SAMPLE_ROWS,
  redact,
  deriveEnvironment,
  logicalKey,
  rowMetrics,
  inspectSource,
  describeAutomations,
  buildSnapshot,
  buildDiagnosticPackage,
};
