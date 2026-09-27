'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { inspectBackupArchive, extractBackupArchive } = require('./backup-archive');
const { safeId, USER_BACKUP_COMPONENTS, normalizeUserBackupSelection } = require('./backup-service');
const userPreferences = require('./user-preferences');
const collectionWorkspaces = require('./collection-workspaces');
const db = require('../db');
const { SERVER_DATA_ROOT, APP_DATA_ROOT } = require('../user-data');

const REQUIRED_JSON = Object.freeze([
  'user/preferences.json',
  'user/browser-storage.json',
  'user/collection-workspace.json',
  'user/views.json',
  'user/filters.json',
  'user/shipping.json',
  'user/refresh-history.json',
]);
const MAX_JSON_BYTES = 256 * 1024 * 1024;

function restoreError(code, message, statusCode = 400, details = null) {
  return Object.assign(new Error(message), { code, statusCode, details });
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function archivePaths(info) {
  return new Set((info && info.manifest && Array.isArray(info.manifest.contents) ? info.manifest.contents : []).map(item => String(item && item.path || '')));
}
function userSourceRoots(userId) {
  const id = safeId(userId);
  return {
    sourceData: path.join(SERVER_DATA_ROOT, 'user-source-data', id),
    localSourceData: path.join(APP_DATA_ROOT, 'user-source-data', id),
  };
}
async function copyTree(source, target) {
  if (!source || !fs.existsSync(source)) return;
  await fsp.mkdir(target, { recursive: true });
  const dir = await fsp.opendir(source);
  for await (const entry of dir) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(from, to); }
  }
}
async function replaceTree(source, target) {
  await fsp.rm(target, { recursive: true, force: true });
  if (source && fs.existsSync(source)) await copyTree(source, target);
}
async function readJsonFile(file, label) {
  let stat;
  try { stat = await fsp.stat(file); } catch (_) { throw restoreError('USER_RESTORE_MISSING_CONTENT', 'Backup içinde ' + label + ' bulunamadı.'); }
  if (stat.size > MAX_JSON_BYTES) throw restoreError('USER_RESTORE_JSON_TOO_LARGE', 'Backup içindeki ' + label + ' güvenli boyut sınırını aşıyor.', 413);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (_) { throw restoreError('USER_RESTORE_JSON_INVALID', 'Backup içindeki ' + label + ' okunamadı.'); }
}

function componentDefinition(id) {
  return USER_BACKUP_COMPONENTS.find(item => item.id === id) || null;
}
function componentsFromInfo(info) {
  const manifest = info && info.manifest || {};
  if (Array.isArray(manifest.scope_components) && manifest.scope_components.length) {
    return [...new Set(manifest.scope_components.map(value => String(value || '').trim()).filter(id => componentDefinition(id)))];
  }
  // v7.57-v7.116 kişisel yedekleri scope manifest'i taşımıyordu ve "source-data"
  // klasörü tamamen boş olduğunda ZIP'te bu klasöre ait entry bulunmuyordu.
  // Zorunlu eski JSON seti tam ise eski davranışı birebir koru: tüm kişisel
  // bileşenler backup'ın parçası sayılır ve boş source-data restore'da temizlenir.
  const paths = archivePaths(info);
  if (REQUIRED_JSON.every(name => paths.has(name))) {
    return USER_BACKUP_COMPONENTS.filter(component => !component.shared).map(component => component.id);
  }
  // Daha eski/alışılmadık arşivlerde mevcut içerikten güvenli biçimde çıkar.
  const found = [];
  for (const component of USER_BACKUP_COMPONENTS) {
    const exact = Array.isArray(component.paths) ? component.paths : [];
    const prefixes = Array.isArray(component.prefixes) ? component.prefixes : [];
    const exactPresent = exact.length ? exact.every(name => paths.has(name)) : false;
    const prefixPresent = prefixes.length ? [...paths].some(name => prefixes.some(prefix => name.startsWith(prefix))) : false;
    if (exactPresent || prefixPresent) found.push(component.id);
  }
  return found;
}
function componentPublicList(info, currentUser = null) {
  const available = new Set(componentsFromInfo(info));
  const moderator = Boolean(currentUser && currentUser.systemRole === 'moderator');
  return USER_BACKUP_COMPONENTS.filter(component => available.has(component.id)).map(component => ({
    id: component.id,
    labelTr: component.labelTr,
    labelEn: component.labelEn,
    shared: Boolean(component.shared),
    moderatorOnly: Boolean(component.moderatorOnly),
    canRestore: !(component.moderatorOnly || component.shared) || moderator,
  }));
}
function validateDeclaredComponentFiles(info, ids) {
  const paths = archivePaths(info);
  const missing = [];
  for (const id of ids) {
    const component = componentDefinition(id);
    if (!component) continue;
    for (const name of Array.isArray(component.paths) ? component.paths : []) if (!paths.has(name)) missing.push(name);
    // source-data klasörleri boş olabilir; manifest'te seçili olduğu halde ZIP'te
    // dosya olmaması geçerli bir "boş kaynak verisi" snapshot'ıdır.
  }
  if (missing.length) throw restoreError('USER_RESTORE_MISSING_CONTENT', 'Kişisel backup eksik: ' + missing.join(', '), 400, { missing });
}
function isKnownPath(name) {
  if (name === 'user/profile.json' || name === 'user/fx.json') return true;
  return USER_BACKUP_COMPONENTS.some(component =>
    (Array.isArray(component.paths) && component.paths.includes(name))
    || (Array.isArray(component.prefixes) && component.prefixes.some(prefix => name.startsWith(prefix))));
}

function publicInspect(info, currentUser = null) {
  const manifest = info.manifest || {}, owner = manifest.user || {}, paths = archivePaths(info);
  const warnings = [];
  if (paths.has('user/fx.json')) warnings.push('Eski kişisel backup içindeki FX kaydı ortak veri olduğu için restore edilmeyecek.');
  warnings.push('Koleksiyon satırlarındaki Royalty/Hologram değerleri Collection ile geri gelir; merkezi Royalty kuralları ve E-posta Grupları kişisel backup kapsamı dışındadır ve Shared Hub / Tam Sistem Yedeği üzerinden geri yüklenmelidir.');
  const unknown = [...paths].filter(name => !isKnownPath(name));
  if (unknown.length) warnings.push('Bu sürümün kişisel restore kapsamı dışında ' + unknown.length + ' kayıt var; uygulanmayacak.');
  const components = componentPublicList(info, currentUser);
  if (components.some(item => item.shared && !item.canRestore)) warnings.push('Paylaşılan CP Ex-Factory revizyonlarını geri yüklemek için moderatör yetkisi gerekir.');
  return {
    backupType: String(manifest.backup_type || ''),
    appVersion: String(manifest.app_version || ''),
    createdAt: manifest.created_at || null,
    user: { id: String(owner.id || ''), username: String(owner.username || ''), displayName: String(owner.displayName || '') },
    fileCount: Number(info.fileCount) || 0,
    totalBytes: Number(info.totalBytes) || 0,
    scopeSchema: Number(manifest.scope_schema) || 0,
    components,
    warnings,
  };
}

function createUserRestoreService({ restoreCollectionWorkspace = null } = {}) {
  async function inspect(file, user) {
    const current = user || {};
    const info = await inspectBackupArchive(file, { requireType: 'user', validateData: true });
    const owner = info.manifest && info.manifest.user || {};
    if (!current.id || String(owner.id || '') !== String(current.id)) {
      throw restoreError(
        'USER_RESTORE_OWNER_MISMATCH',
        'Bu kişisel backup başka bir Buyer Log kullanıcısına ait.',
        403,
        { backupUserId: String(owner.id || ''), currentUserId: String(current.id || '') },
      );
    }
    const declared = componentsFromInfo(info);
    if (Array.isArray(info.manifest && info.manifest.scope_components)) validateDeclaredComponentFiles(info, declared);
    else {
      // Eski backup'lar tam kişisel snapshot sözleşmesiyle üretildi.
      const paths = archivePaths(info), missing = REQUIRED_JSON.filter(name => !paths.has(name));
      if (missing.length) throw restoreError('USER_RESTORE_MISSING_CONTENT', 'Kişisel backup eksik: ' + missing.join(', '), 400, { missing });
    }
    return { info, components: declared, public: publicInspect(info, current) };
  }

  async function restore(file, { user, preflight = null, components = null, onProgress = null } = {}) {
    const currentUser = user || {};
    const checked = preflight && preflight.info ? preflight : await inspect(file, currentUser);
    const info = checked.info;
    const owner = info.manifest && info.manifest.user || {};
    if (!currentUser.id || String(owner.id || '') !== String(currentUser.id)) throw restoreError('USER_RESTORE_OWNER_MISMATCH', 'Bu kişisel backup başka bir kullanıcıya ait.', 403);

    const available = Array.isArray(checked.components) ? checked.components : componentsFromInfo(info);
    const requested = Array.isArray(components) ? components : available;
    const selected = normalizeUserBackupSelection(requested, { allowShared: currentUser.systemRole === 'moderator' });
    const unavailable = selected.filter(id => !available.includes(id));
    if (unavailable.length) throw restoreError('USER_RESTORE_SCOPE_UNAVAILABLE', 'Seçilen veri alanı bu backup içinde yok: ' + unavailable.join(', '), 400, { unavailable });

    const selectedSet = new Set(selected);
    const txRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'buyerlog-user-restore-'));
    const stageRoot = path.join(txRoot, 'stage'), rollbackRoot = path.join(txRoot, 'rollback');
    const roots = userSourceRoots(currentUser.id);
    const report = value => { if (typeof onProgress === 'function') onProgress(value); };
    const customCollectionRestore = typeof restoreCollectionWorkspace === 'function';

    const before = {
      preferences: selectedSet.has('preferences') ? clone(userPreferences.load(currentUser.id)) : null,
      collection: selectedSet.has('collection') && !customCollectionRestore ? clone(collectionWorkspaces.loadWorkspace(currentUser.id)) : null,
      stores: {},
      cpExFactory: selectedSet.has('cp-exfactory') ? clone(db.cpExFactoryRevisionSnapshot()) : null,
    };
    if (selectedSet.has('views-filters')) {
      before.stores.views = clone(db.loadViews(currentUser.id));
      before.stores.filters = clone(db.loadFilterProfiles(currentUser.id));
    }
    if (selectedSet.has('shipping')) before.stores.shipping = clone(db.loadShipping(currentUser.id));
    if (selectedSet.has('refresh-history')) before.stores.refreshHistory = clone(db.loadRefreshHistory(currentUser.id));

    try {
      await fsp.mkdir(rollbackRoot, { recursive: true });
      if (selectedSet.has('source-data')) {
        await copyTree(roots.sourceData, path.join(rollbackRoot, 'source-data'));
        await copyTree(roots.localSourceData, path.join(rollbackRoot, 'local-source-data'));
      }

      await extractBackupArchive(file, stageRoot, {
        preflight: info,
        requireType: 'user',
        onProgress: progress => report({ ...progress, phase: 'Açılıyor' }),
      });

      const read = name => readJsonFile(path.join(stageRoot, ...name.split('/')), name);
      const incoming = {};
      if (selectedSet.has('preferences')) {
        incoming.preferences = await read('user/preferences.json');
        incoming.browserStorage = await read('user/browser-storage.json');
      }
      if (selectedSet.has('collection')) incoming.collection = await read('user/collection-workspace.json');
      if (selectedSet.has('views-filters')) {
        incoming.views = await read('user/views.json');
        incoming.filters = await read('user/filters.json');
      }
      if (selectedSet.has('shipping')) incoming.shipping = await read('user/shipping.json');
      if (selectedSet.has('refresh-history')) incoming.refreshHistory = await read('user/refresh-history.json');
      if (selectedSet.has('cp-exfactory')) incoming.cpExFactory = await read('user/cp-ex-factory-revisions.json');

      let currentStep = 0;
      const totalSteps = selected.length;
      const step = item => report({ phase: 'Uygulanıyor', current: currentStep++, total: totalSteps, item });

      if (selectedSet.has('preferences')) {
        step('preferences');
        userPreferences.restoreSnapshot(currentUser.id, incoming.preferences);
      }
      if (selectedSet.has('views-filters')) {
        step('views-filters');
        db.restoreUserBackupStores(currentUser.id, { views: incoming.views, filters: incoming.filters });
      }
      if (selectedSet.has('shipping')) {
        step('shipping');
        db.restoreUserBackupStores(currentUser.id, { shipping: incoming.shipping });
      }
      if (selectedSet.has('refresh-history')) {
        step('refresh-history');
        db.restoreUserBackupStores(currentUser.id, { refreshHistory: incoming.refreshHistory });
      }
      if (selectedSet.has('source-data')) {
        step('source-data');
        await replaceTree(path.join(stageRoot, 'user', 'source-data'), roots.sourceData);
        await replaceTree(path.join(stageRoot, 'user', 'local-source-data'), roots.localSourceData);
      }
      if (selectedSet.has('cp-exfactory')) {
        step('cp-exfactory');
        await db.restoreCpExFactoryRevisions(incoming.cpExFactory, { actor: currentUser });
      }

      let collectionRestore = null;
      if (selectedSet.has('collection')) {
        step('collection-workspace');
        if (customCollectionRestore) {
          collectionRestore = await restoreCollectionWorkspace(currentUser, incoming.collection);
        } else {
          const currentWorkspace = collectionWorkspaces.loadWorkspace(currentUser.id);
          const workspace = collectionWorkspaces.saveWorkspace(currentUser.id, incoming.collection, currentWorkspace._revision);
          collectionRestore = { shared:false, ownerId:currentUser.id, incomingRows:Array.isArray(incoming.collection && incoming.collection.rows) ? incoming.collection.rows.length : 0, totalRows:workspace.rows.length };
        }
      }

      report({ phase: 'Tamamlandı', current: totalSteps, total: totalSteps, item: '' });
      return {
        ok: true,
        components: selected,
        browserStorage: selectedSet.has('preferences') && incoming.browserStorage && typeof incoming.browserStorage === 'object' ? incoming.browserStorage : null,
        sourceAppVersion: String(info.manifest && info.manifest.app_version || ''),
        createdAt: info.manifest && info.manifest.created_at || null,
        collectionRestore,
        warnings: publicInspect(info, currentUser).warnings,
      };
    } catch (error) {
      try {
        if (selectedSet.has('preferences')) userPreferences.restoreSnapshot(currentUser.id, before.preferences);
        if (selectedSet.has('collection') && !customCollectionRestore) {
          const workspace = collectionWorkspaces.loadWorkspace(currentUser.id);
          collectionWorkspaces.saveWorkspace(currentUser.id, before.collection, workspace._revision);
        }
        if (Object.keys(before.stores).length) db.restoreUserBackupStores(currentUser.id, before.stores);
        if (selectedSet.has('cp-exfactory')) await db.restoreCpExFactoryRevisions(before.cpExFactory, { actor: currentUser });
        if (selectedSet.has('source-data')) {
          await replaceTree(path.join(rollbackRoot, 'source-data'), roots.sourceData);
          await replaceTree(path.join(rollbackRoot, 'local-source-data'), roots.localSourceData);
        }
      } catch (rollbackError) {
        error.rollbackError = rollbackError && rollbackError.message || String(rollbackError);
      }
      throw error;
    } finally {
      await fsp.rm(txRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { inspect, restore };
}

module.exports = { createUserRestoreService, REQUIRED_JSON, publicInspect, userSourceRoots, componentsFromInfo };
