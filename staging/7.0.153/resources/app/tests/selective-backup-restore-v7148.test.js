'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BACKUP = read('server/lib/backup-service.js');
const RESTORE = read('server/lib/user-restore-service.js');
const DB = read('server/db.js');
const SERVER = read('server/server.js');
const UI = read('public/backup-manager.js');

const {
  DEFAULT_USER_BACKUP_COMPONENTS,
  normalizeUserBackupSelection,
} = require('../server/lib/backup-service');
const { componentsFromInfo } = require('../server/lib/user-restore-service');

test('selective backup defaults preserve the previous personal-backup scope', () => {
  assert.deepEqual(DEFAULT_USER_BACKUP_COMPONENTS, [
    'preferences',
    'collection',
    'views-filters',
    'shipping',
    'refresh-history',
    'source-data',
  ]);
  assert.deepEqual(normalizeUserBackupSelection(null), DEFAULT_USER_BACKUP_COMPONENTS);
  assert.throws(() => normalizeUserBackupSelection(['cp-exfactory']), error => error && error.code === 'BACKUP_SCOPE_FORBIDDEN');
  assert.deepEqual(normalizeUserBackupSelection(['collection', 'cp-exfactory'], { allowShared:true }), ['collection', 'cp-exfactory']);
  assert.throws(() => normalizeUserBackupSelection([]), error => error && error.code === 'BACKUP_SCOPE_EMPTY');
});

test('restore preflight reads explicit component manifest and supports legacy inference', () => {
  const explicit = {
    manifest: {
      scope_components:['collection', 'cp-exfactory'],
      contents:[
        { path:'user/profile.json' },
        { path:'user/collection-workspace.json' },
        { path:'user/cp-ex-factory-revisions.json' },
      ],
    },
  };
  assert.deepEqual(componentsFromInfo(explicit), ['collection', 'cp-exfactory']);

  const legacy = {
    manifest: {
      contents:[
        { path:'user/profile.json' },
        { path:'user/preferences.json' },
        { path:'user/browser-storage.json' },
        { path:'user/collection-workspace.json' },
        { path:'user/views.json' },
        { path:'user/filters.json' },
        { path:'user/shipping.json' },
        { path:'user/refresh-history.json' },
      ],
    },
  };
  assert.deepEqual(componentsFromInfo(legacy), DEFAULT_USER_BACKUP_COMPONENTS);
});

test('backup service writes selected scope to manifest and CP dates are moderator-only', () => {
  assert.match(BACKUP, /scope_schema:\s*1, scope_components:\s*selectedComponents/);
  assert.match(BACKUP, /selected\.has\('collection'\)/);
  assert.match(BACKUP, /selected\.has\('cp-exfactory'\)/);
  assert.match(BACKUP, /cpExFactoryRevisionSnapshot\(\)/);
  assert.match(BACKUP, /current\.systemRole === 'moderator'/);
});

test('CP Ex-Factory restore is field-scoped and preserves retail\/in-store date data', () => {
  assert.match(DB, /function cpExFactoryRevisionSnapshot\(\)/);
  assert.match(DB, /function restoreCpExFactoryRevisions\(/);
  assert.match(DB, /delete current\.ex/);
  assert.doesNotMatch(DB, /delete current\.retail/);
  assert.doesNotMatch(DB, /delete current\.mb/);
  assert.match(DB, /mirrorPatch\(key, \{ dates:/);
});

test('personal restore applies only selected components and rolls back the same scope', () => {
  assert.match(RESTORE, /selectedSet\.has\('collection'\)/);
  assert.match(RESTORE, /selectedSet\.has\('cp-exfactory'\)/);
  assert.match(RESTORE, /restoreCpExFactoryRevisions\(incoming\.cpExFactory/);
  assert.match(RESTORE, /restoreCpExFactoryRevisions\(before\.cpExFactory/);
  assert.match(RESTORE, /browserStorage: selectedSet\.has\('preferences'\)/);
  assert.match(SERVER, /components: mode === 'user'/);
  assert.match(SERVER, /components: req\.body && req\.body\.components/);
});

test('backup modal exposes separate backup and restore scope selectors', () => {
  assert.match(UI, /data-backup-scope-id/);
  assert.match(UI, /data-user-restore-scope-id/);
  assert.match(UI, /CP Tracker · Ex-Factory revizyonları/);
  assert.match(UI, /components, browserStorage/);
  assert.match(UI, /JSON\.stringify\(\{ uploadId: userUploadId, components \}\)/);
  assert.match(UI, /if \(result\.browserStorage && typeof result\.browserStorage === 'object'\)/);
});
