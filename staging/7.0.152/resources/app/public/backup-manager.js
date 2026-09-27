'use strict';

// Buyer Log v7.57 — versioned, streamed user/full backup UI.
function buyerLogBackupTr(tr, en) { return typeof appLang !== 'undefined' && appLang === 'en' ? en : tr; }
function buyerLogRestoreBytes(value) {
  const bytes = Math.max(0, Number(value) || 0), units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes, unit = 0; while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}
function buyerLogBrowserStorageSnapshot() {
  const out = {}, profile = window.BL_USER_CONTEXT || {}, uid = String(profile.id || 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_');
  const prefix = `bl.user.${uid}.`, storage = window.BLStorage && window.BLStorage.native || window.localStorage;
  for (let index = 0; storage && index < storage.length; index++) {
    const key = storage.key(index); if (key && key.startsWith(prefix)) out[key] = storage.getItem(key);
  }
  return out;
}
function buyerLogApplyBrowserStorageSnapshot(snapshot) {
  const profile = window.BL_USER_CONTEXT || {}, uid = String(profile.id || 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_');
  const prefix = `bl.user.${uid}.`, storage = window.BLStorage && window.BLStorage.native || window.localStorage;
  if (!storage) return;
  const remove = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index); if (key && key.startsWith(prefix)) remove.push(key);
  }
  remove.forEach(key => { try { storage.removeItem(key); } catch (_) {} });
  for (const [key, value] of Object.entries(snapshot && typeof snapshot === 'object' ? snapshot : {})) {
    if (!String(key).startsWith(prefix)) continue;
    try { storage.setItem(String(key), String(value == null ? '' : value)); } catch (_) {}
  }
}

let buyerLogSharedPersonalBackupBusy = false;
let buyerLogSharedPersonalBackupLastAttempt = 0;
async function buyerLogSharedPersonalBackupNow(force = false) {
  const profile = window.BL_USER_CONTEXT || {};
  if (!profile.id || buyerLogSharedPersonalBackupBusy) return { skipped: true, reason: !profile.id ? 'no-user' : 'busy' };
  const now = Date.now();
  if (!force && now - buyerLogSharedPersonalBackupLastAttempt < 14 * 60 * 1000) return { skipped: true, reason: 'throttled' };
  buyerLogSharedPersonalBackupLastAttempt = now;
  buyerLogSharedPersonalBackupBusy = true;
  try {
    const response = await fetch('/api/backups/shared-personal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserStorage: buyerLogBrowserStorageSnapshot() }),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    window.dispatchEvent(new CustomEvent('buyerlog:shared-personal-backup', { detail: data }));
    return data;
  } catch (error) {
    console.warn('[BuyerLog] Shared personal backup:', error && error.message || error);
    return { ok: false, error: error && error.message || String(error) };
  } finally {
    buyerLogSharedPersonalBackupBusy = false;
  }
}
window.buyerLogSharedPersonalBackupNow = buyerLogSharedPersonalBackupNow;

function buyerLogBackupScopeDefinitions(moderator) {
  const items = [
    { id:'preferences', tr:'Arayüz ve kullanıcı tercihleri', en:'Interface & user preferences', checked:true },
    { id:'collection', tr:'Collection', en:'Collection', checked:true },
    { id:'views-filters', tr:'Görünümler ve filtreler', en:'Views & filters', checked:true },
    { id:'shipping', tr:'Shipping Comparison', en:'Shipping Comparison', checked:true },
    { id:'refresh-history', tr:'Yenileme geçmişi', en:'Refresh history', checked:true },
    { id:'source-data', tr:'Kişisel kaynak dosyaları', en:'Personal source data', checked:true },
  ];
  if (moderator) items.push({ id:'cp-exfactory', tr:'CP Tracker · Ex-Factory revizyonları', en:'CP Tracker · Ex-Factory revisions', shared:true, checked:false });
  return items;
}
function buyerLogBackupScopeHtml(items, attributeName) {
  return items.map(item => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0"><input type="checkbox" ${attributeName}="${item.id}" ${item.checked !== false ? 'checked' : ''}/><span>${buyerLogBackupTr(item.tr || item.labelTr || item.id, item.en || item.labelEn || item.id)}${item.shared ? ` <small>· ${buyerLogBackupTr('paylaşılan veri','shared data')}</small>` : ''}</span></label>`).join('');
}
function buyerLogBackupModal() {
  document.getElementById('_buyerLogBackupModal')?.remove();
  const moderator = Boolean(window.BLIsModerator && window.BLIsModerator());
  const stages = ['Hazırlanıyor', 'Veriler', 'Ayarlar', 'Doğrulanıyor', 'Tamamlandı'];
  const labels = typeof appLang !== 'undefined' && appLang === 'en' ? ['Preparing', 'Data', 'Settings', 'Validating', 'Completed'] : stages;
  const modal = document.createElement('div'); modal.id = '_buyerLogBackupModal'; modal.className = 'warnOverlay';
  modal.innerHTML = `<div class="modalCard backupCard" role="dialog" aria-modal="true" aria-labelledby="_backupTitle">
    <div class="backupHead"><div><div class="modalTitle" id="_backupTitle">Backup</div><div class="backupIntro">${buyerLogBackupTr('Kişisel verilerinizi ve ayarlarınızı güvenli, sürümlü tek bir ZIP dosyasında indirin.','Download your personal data and settings as one secure, versioned ZIP file.')}</div></div><button class="pricingRuleIconBtn _backupClose" aria-label="${buyerLogBackupTr('Kapat','Close')}"><svg class="ic"><use href="#i-x"/></svg></button></div>
    <div class="backupBody"><div class="backupActions"><button class="navActionBtn" data-backup-mode="user"><svg class="ic"><use href="#i-download"/></svg><span>${buyerLogBackupTr('Verilerimi Yedekle','Back Up My Data')}</span></button><button class="navActionBtn" data-user-restore><svg class="ic"><use href="#i-upload"/></svg><span>${buyerLogBackupTr('Verilerimi Geri Yükle','Restore My Data')}</span></button>${moderator ? `<button class="tbtn" data-backup-mode="full"><svg class="ic"><use href="#i-database-import"/></svg><span>${buyerLogBackupTr('Tam Sistem Yedeği','Full System Backup')}</span></button><button class="tbtn" data-backup-restore><svg class="ic"><use href="#i-upload"/></svg><span>${buyerLogBackupTr('Full System Restore','Full System Restore')}</span></button>` : ''}</div>
    <div class="backupRestorePanel" data-user-backup-scope><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><b>${buyerLogBackupTr('Yedeklenecek veriler','Data to back up')}</b><div class="backupRestoreActions"><button class="tbtn" type="button" data-backup-scope-all>${buyerLogBackupTr('Tümünü seç','Select all')}</button><button class="tbtn" type="button" data-backup-scope-personal>${buyerLogBackupTr('Kişisel varsayılan','Personal default')}</button></div></div><div data-backup-scope-options>${buyerLogBackupScopeHtml(buyerLogBackupScopeDefinitions(moderator), 'data-backup-scope-id')}</div><div class="backupRestoreStatus">${buyerLogBackupTr('CP Ex-Factory revizyonları paylaşılan veridir ve varsayılan olarak seçili değildir.','CP Ex-Factory revisions are shared data and are not selected by default.')}</div></div>
    <div class="backupSharedPanel"><div><b>${buyerLogBackupTr('Ortak kişisel yedek','Shared personal backup')}</b><div data-shared-personal-status>${buyerLogBackupTr('Kontrol ediliyor…','Checking…')}</div></div><div class="backupRestoreActions"><button class="tbtn" data-shared-personal-now>${buyerLogBackupTr('Şimdi güncelle','Back up now')}</button><button class="tbtn" data-shared-personal-download hidden>${buyerLogBackupTr('Ortak yedeği indir','Download shared backup')}</button></div></div>
    <div class="backupRestorePanel" data-user-restore-panel hidden><label class="backupFilePicker">${buyerLogBackupTr('Kişisel Backup ZIP seçin','Choose a Personal Backup ZIP')}<input type="file" data-user-restore-file accept=".zip,application/zip"/></label><div data-user-restore-scope hidden style="margin:10px 0"><b>${buyerLogBackupTr('Geri yüklenecek veriler','Data to restore')}</b><div data-user-restore-scope-options></div></div><div class="backupRestoreActions"><button class="tbtn" data-user-restore-inspect>${buyerLogBackupTr('Ön kontrol yap','Run preflight')}</button><button class="tbtn" data-user-restore-confirm disabled>${buyerLogBackupTr('Seçilenleri geri yükle','Restore selected')}</button></div><div class="backupRestoreStatus" data-user-restore-status aria-live="polite">${buyerLogBackupTr('Bir kişisel backup seçin.','Choose a personal backup.')}</div></div>
    ${moderator ? `<div class="backupRestorePanel" data-restore-panel hidden><label class="backupFilePicker">${buyerLogBackupTr('Full System Backup ZIP seçin','Choose a Full System Backup ZIP')}<input type="file" data-restore-file accept=".zip,application/zip"/></label><div class="backupRestoreActions"><button class="tbtn" data-restore-inspect>${buyerLogBackupTr('Ön kontrol yap','Run preflight')}</button><label><input type="checkbox" data-restore-safety-backup checked/> createSafetyBackup</label><button class="tbtn" data-restore-confirm disabled>${buyerLogBackupTr('Restore’u uygula','Apply restore')}</button><button class="tbtn" data-restore-cancel hidden>${buyerLogBackupTr('İptal','Cancel')}</button></div><div class="backupRestoreStatus" data-restore-status aria-live="polite">${buyerLogBackupTr('Bir backup seçin.','Choose a backup.')}</div></div>` : ''}
    <div class="backupStages">${labels.map((label, index) => `<div class="backupStage" data-stage="${stages[index]}"><span>${index + 1}</span><b>${label}</b></div>`).join('')}</div>
    <div class="backupProgress" id="_backupStatus" aria-live="polite">${buyerLogBackupTr('Yedekleme başlatılmadı.','Backup has not started.')}</div></div></div>`;
  document.body.appendChild(modal);
  const status = modal.querySelector('#_backupStatus'), buttons = [...modal.querySelectorAll('[data-backup-mode]')];
  const backupScopeOptions = modal.querySelector('[data-backup-scope-options]');
  const selectedBackupComponents = () => [...backupScopeOptions.querySelectorAll('[data-backup-scope-id]:checked')].map(input => input.getAttribute('data-backup-scope-id')).filter(Boolean);
  modal.querySelector('[data-backup-scope-all]')?.addEventListener('click', () => backupScopeOptions.querySelectorAll('[data-backup-scope-id]').forEach(input => { input.checked = true; }));
  modal.querySelector('[data-backup-scope-personal]')?.addEventListener('click', () => backupScopeOptions.querySelectorAll('[data-backup-scope-id]').forEach(input => { input.checked = input.getAttribute('data-backup-scope-id') !== 'cp-exfactory'; }));
  const restorePanel = modal.querySelector('[data-restore-panel]'), restoreFile = modal.querySelector('[data-restore-file]');
  const userRestorePanel = modal.querySelector('[data-user-restore-panel]'), userRestoreFile = modal.querySelector('[data-user-restore-file]');
  const close = () => modal.remove();
  modal.querySelector('._backupClose').addEventListener('click', close); modal.addEventListener('click', event => { if (event.target === modal) close(); });
  const sharedStatus = modal.querySelector('[data-shared-personal-status]');
  const sharedNow = modal.querySelector('[data-shared-personal-now]');
  const sharedDownload = modal.querySelector('[data-shared-personal-download]');
  const formatSharedBackup = data => {
    const latest = data && data.latest;
    if (!data || data.configured === false) return buyerLogBackupTr('Shared Hub henüz bağlı değil. Yerel kişisel veriler korunmaya devam ediyor.','Shared Hub is not connected yet. Personal data remains stored locally.');
    if (!data.available && !latest) return buyerLogBackupTr('Shared Hub bağlı; henüz kişisel ortak yedek yok.','Shared Hub is connected; no shared personal backup exists yet.');
    const stamp = latest && latest.createdAt ? new Date(latest.createdAt).toLocaleString() : '—';
    return `${buyerLogBackupTr('Son ortak yedek','Latest shared backup')}: ${stamp}${latest && latest.bytes ? ` • ${buyerLogRestoreBytes(latest.bytes)}` : ''}`;
  };
  async function refreshSharedStatus() {
    try {
      const response = await fetch('/api/backups/shared-personal/status', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || response.statusText);
      sharedStatus.textContent = formatSharedBackup(data);
      sharedDownload.hidden = !(data.available && data.latest);
    } catch (error) {
      sharedStatus.textContent = `${buyerLogBackupTr('Ortak yedek durumu okunamadı','Shared backup status unavailable')}: ${error.message}`;
      sharedDownload.hidden = true;
    }
  }
  sharedNow?.addEventListener('click', async () => {
    sharedNow.disabled = true; sharedStatus.textContent = buyerLogBackupTr('Kişisel veriler Shared Hub’a yedekleniyor…','Backing up personal data to Shared Hub…');
    const data = await buyerLogSharedPersonalBackupNow(true);
    sharedNow.disabled = false;
    if (data && data.ok === false) sharedStatus.textContent = `${buyerLogBackupTr('Ortak yedek başarısız','Shared backup failed')}: ${data.error || '—'}`;
    else await refreshSharedStatus();
  });
  sharedDownload?.addEventListener('click', () => {
    const link = document.createElement('a'); link.href = '/api/backups/shared-personal/latest'; link.download = ''; document.body.appendChild(link); link.click(); link.remove();
  });
  void refreshSharedStatus();
  function render(job) {
    const activeIndex = Math.max(0, stages.indexOf(job.phase));
    modal.querySelectorAll('.backupStage').forEach((node, index) => { node.classList.toggle('done', index < activeIndex || job.ready); node.classList.toggle('active', index === activeIndex && !job.error); node.classList.toggle('error', Boolean(job.error) && index === activeIndex); });
    if (job.error) status.textContent = `${buyerLogBackupTr('Hata','Error')}: ${job.error}`;
    else status.textContent = `${labels[activeIndex] || job.phase} • ${Number(job.current || 0).toLocaleString()}/${Number(job.total || 0).toLocaleString()}${job.item ? ` • ${job.item}` : ''}`;
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function run(mode) {
    const components = mode === 'user' ? selectedBackupComponents() : null;
    if (mode === 'user' && !components.length) {
      render({ phase: 'Hazırlanıyor', current: 0, total: 0, error: buyerLogBackupTr('Yedeklenecek en az bir veri alanı seçin.','Select at least one data area to back up.') });
      return;
    }
    buttons.forEach(button => { button.disabled = true; }); render({ phase: 'Hazırlanıyor', current: 0, total: 0 });
    try {
      const response = await fetch('/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, components, browserStorage: mode === 'user' ? buyerLogBrowserStorageSnapshot() : {} }) });
      const initial = await response.json().catch(() => ({})); if (!response.ok) throw new Error(initial.error || response.statusText);
      let job = initial;
      while (!job.ready && !job.error) { await wait(300); const poll = await fetch(`/api/backups/${encodeURIComponent(job.id)}/status`, { cache: 'no-store' }); job = await poll.json().catch(() => ({})); if (!poll.ok) throw new Error(job.error || poll.statusText); render(job); }
      render(job); if (job.error) throw new Error(job.error);
      const link = document.createElement('a'); link.href = `/api/backups/${encodeURIComponent(job.id)}/download`; link.download = job.filename || 'BuyerLog_Backup.zip'; document.body.appendChild(link); link.click(); link.remove();
    } catch (error) { render({ phase: 'Hazırlanıyor', current: 0, total: 0, error: error.message }); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  buttons.forEach(button => button.addEventListener('click', () => run(button.dataset.backupMode)));
  if (userRestorePanel) {
    let userUploadId = '', userRestoreJobId = '', userRestorePlan = null;
    const userRestoreStatus = userRestorePanel.querySelector('[data-user-restore-status]');
    const userInspectButton = userRestorePanel.querySelector('[data-user-restore-inspect]');
    const userConfirmButton = userRestorePanel.querySelector('[data-user-restore-confirm]');
    const userRestoreScope = userRestorePanel.querySelector('[data-user-restore-scope]');
    const userRestoreScopeOptions = userRestorePanel.querySelector('[data-user-restore-scope-options]');
    const selectedRestoreComponents = () => [...userRestoreScopeOptions.querySelectorAll('[data-user-restore-scope-id]:checked:not(:disabled)')].map(input => input.getAttribute('data-user-restore-scope-id')).filter(Boolean);
    const syncRestoreConfirmState = () => { userConfirmButton.disabled = !userUploadId || selectedRestoreComponents().length === 0; };
    const setUserRestoreStatus = message => { userRestoreStatus.textContent = message; };
    modal.querySelector('[data-user-restore]').addEventListener('click', () => {
      userRestorePanel.hidden = !userRestorePanel.hidden;
      if (!userRestorePanel.hidden && restorePanel) restorePanel.hidden = true;
    });
    userInspectButton.addEventListener('click', async () => {
      const file = userRestoreFile.files && userRestoreFile.files[0];
      if (!file) return setUserRestoreStatus(buyerLogBackupTr('Önce bir kişisel backup ZIP seçin.','Choose a personal backup ZIP first.'));
      userInspectButton.disabled = true; userConfirmButton.disabled = true; userUploadId = ''; userRestorePlan = null; userRestoreScope.hidden = true; userRestoreScopeOptions.innerHTML = '';
      try {
        const response = await fetch('/api/backups/user-restore/inspect', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
        const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || response.statusText);
        userUploadId = data.uploadId;
        const plan = data.preflight || {}, backupUser = plan.user || {};
        userRestorePlan = plan;
        const components = Array.isArray(plan.components) ? plan.components : [];
        userRestoreScopeOptions.innerHTML = components.map(item => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0"><input type="checkbox" data-user-restore-scope-id="${item.id}" ${item.canRestore === false ? 'disabled' : 'checked'}/><span>${buyerLogBackupTr(item.labelTr || item.id, item.labelEn || item.id)}${item.shared ? ` <small>· ${buyerLogBackupTr('paylaşılan veri','shared data')}</small>` : ''}${item.canRestore === false ? ` <small>· ${buyerLogBackupTr('yetki gerekli','permission required')}</small>` : ''}</span></label>`).join('');
        userRestoreScope.hidden = components.length === 0;
        userRestoreScopeOptions.querySelectorAll('[data-user-restore-scope-id]').forEach(input => input.addEventListener('change', syncRestoreConfirmState));
        setUserRestoreStatus(`${buyerLogBackupTr('Ön kontrol tamamlandı','Preflight complete')}: ${Number(plan.fileCount || 0).toLocaleString()} ${buyerLogBackupTr('dosya','files')} • ${buyerLogRestoreBytes(plan.totalBytes)} • ${backupUser.displayName || backupUser.username || backupUser.id || '—'} • v${plan.appVersion || '—'}${(plan.warnings || []).length ? ` • ${plan.warnings.join(' ')}` : ''}`);
        syncRestoreConfirmState();
      } catch (error) { setUserRestoreStatus(`${buyerLogBackupTr('Hata','Error')}: ${error.message}`); }
      finally { userInspectButton.disabled = false; }
    });
    userConfirmButton.addEventListener('click', async () => {
      if (!userUploadId) return;
      const components = selectedRestoreComponents();
      if (!components.length) return setUserRestoreStatus(buyerLogBackupTr('Geri yüklenecek en az bir veri alanı seçin.','Select at least one data area to restore.'));
      if (!confirm(buyerLogBackupTr('Yalnız seçtiğiniz veri alanları backup içeriğiyle değiştirilecek. Devam edilsin mi?','Only the selected data areas will be replaced with the backup contents. Continue?'))) return;
      userConfirmButton.disabled = true; userInspectButton.disabled = true;
      try {
        const response = await fetch('/api/backups/user-restore/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: userUploadId, components }) });
        let job = await response.json().catch(() => ({})); if (!response.ok) throw new Error(job.error || response.statusText);
        userRestoreJobId = job.id;
        while (!job.done && !job.error) {
          await wait(350);
          const poll = await fetch(`/api/backups/user-restore/${encodeURIComponent(userRestoreJobId)}/status`, { cache: 'no-store' });
          job = await poll.json().catch(() => ({})); if (!poll.ok) throw new Error(job.error || poll.statusText);
          setUserRestoreStatus(`${job.phase || ''} • ${Number(job.current || 0).toLocaleString()}/${Number(job.total || 0).toLocaleString()}${job.bytesTotal ? ` • ${buyerLogRestoreBytes(job.bytesDone)}/${buyerLogRestoreBytes(job.bytesTotal)}` : ''}${job.item ? ` • ${job.item}` : ''}`);
        }
        if (job.error) throw new Error(job.error);
        const result = job.result || {};
        if (result.browserStorage && typeof result.browserStorage === 'object') buyerLogApplyBrowserStorageSnapshot(result.browserStorage);
        setUserRestoreStatus(`${buyerLogBackupTr('Kişisel restore tamamlandı. Arayüz yenileniyor…','Personal restore completed. Reloading the interface…')}${(result.warnings || []).length ? ` • ${result.warnings.join(' ')}` : ''}`);
        await wait(700); location.reload();
      } catch (error) {
        setUserRestoreStatus(`${buyerLogBackupTr('Hata','Error')}: ${error.message}`);
        userConfirmButton.disabled = false; userInspectButton.disabled = false;
      }
    });
  }
  if (restorePanel) {
    let uploadId = '', restoreJobId = '', commitStarted = false;
    const restoreStatus = restorePanel.querySelector('[data-restore-status]'), inspectButton = restorePanel.querySelector('[data-restore-inspect]'), confirmButton = restorePanel.querySelector('[data-restore-confirm]'), cancelButton = restorePanel.querySelector('[data-restore-cancel]'), safetyCheckbox = restorePanel.querySelector('[data-restore-safety-backup]');
    const setRestoreStatus = message => { restoreStatus.textContent = message; };
    modal.querySelector('[data-backup-restore]').addEventListener('click', () => { restorePanel.hidden = !restorePanel.hidden; if (!restorePanel.hidden && userRestorePanel) userRestorePanel.hidden = true; });
    inspectButton.addEventListener('click', async () => {
      const file = restoreFile.files && restoreFile.files[0]; if (!file) return setRestoreStatus(buyerLogBackupTr('Önce bir ZIP seçin.','Choose a ZIP first.'));
      inspectButton.disabled = true; confirmButton.disabled = true; uploadId = '';
      try {
        const response = await fetch(`/api/backups/restore/inspect?createSafetyBackup=${safetyCheckbox.checked ? '1' : '0'}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
        const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || response.statusText);
        uploadId = data.uploadId; const plan = data.preflight || {};
        const inventory = plan.inventory || {}, connections = inventory.connections || {};
        setRestoreStatus(`${buyerLogBackupTr('Ön kontrol tamamlandı','Preflight complete')}: ${Number(plan.fileCount || 0).toLocaleString()} ${buyerLogBackupTr('dosya','files')} • ${buyerLogRestoreBytes(plan.totalBytes)} • Users: ${Number(inventory.users || 0).toLocaleString()} • Roles: ${Number(inventory.roles || 0).toLocaleString()} • Local DB: ${inventory.localDb ? 'Found' : 'Missing'} • ASAS: ${connections.asas ? 'Found' : 'Missing'} • IAS: ${connections.ias ? 'Found' : 'Missing'} • INTAKE: ${connections.intake ? 'Found' : 'Missing'}${(plan.warnings || []).length ? ` • ${plan.warnings.join(' ')}` : ''}`);
        confirmButton.disabled = false;
      } catch (error) { setRestoreStatus(`${buyerLogBackupTr('Hata','Error')}: ${error.message}`); }
      finally { inspectButton.disabled = false; }
    });
    confirmButton.addEventListener('click', async () => {
      if (!uploadId) return;
      confirmButton.disabled = true; cancelButton.hidden = false; commitStarted = false;
      try {
        const response = await fetch('/api/backups/restore/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId, createSafetyBackup: safetyCheckbox.checked }) });
        let job = await response.json().catch(() => ({})); if (!response.ok) throw new Error(job.error || response.statusText);
        restoreJobId = job.id;
        while (!job.done && !job.error) {
          await wait(400); const poll = await fetch(`/api/backups/restore/${encodeURIComponent(restoreJobId)}/status`, { cache: 'no-store' }); job = await poll.json().catch(() => ({})); if (!poll.ok) throw new Error(job.error || poll.statusText);
          commitStarted = Boolean(job.commitStarted); cancelButton.hidden = commitStarted; setRestoreStatus(`${job.phase || ''} • ${Number(job.current || 0).toLocaleString()}/${Number(job.total || 0).toLocaleString()}${job.bytesTotal ? ` • ${buyerLogRestoreBytes(job.bytesDone)}/${buyerLogRestoreBytes(job.bytesTotal)}` : ''}${job.item ? ` • ${job.item}` : ''}`);
        }
        if (job.error) throw new Error(job.error);
        setRestoreStatus(buyerLogBackupTr('Restore tamamlandı. Sunucuyu yeniden başlatın.','Restore completed. Restart the server.'));
      } catch (error) { setRestoreStatus(`${buyerLogBackupTr('Hata','Error')}: ${error.message}`); }
      finally { cancelButton.hidden = true; confirmButton.disabled = false; }
    });
    cancelButton.addEventListener('click', async () => {
      if (!restoreJobId || commitStarted) return;
      await fetch(`/api/backups/restore/${encodeURIComponent(restoreJobId)}/cancel`, { method: 'POST' }).catch(() => {});
      setRestoreStatus(buyerLogBackupTr('İptal istendi.','Cancellation requested.'));
    });
  }
}
window.buyerLogBackupModal = buyerLogBackupModal;
document.getElementById('backupRestoreBtn')?.addEventListener('click', buyerLogBackupModal);
document.getElementById('backupSettingsBtn')?.addEventListener('click', buyerLogBackupModal);

(function startSharedPersonalBackupSchedule(){
  const run = () => { void buyerLogSharedPersonalBackupNow(false); };
  setTimeout(run, 45 * 1000);
  const timer = setInterval(run, 15 * 60 * 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  window.addEventListener('online', run);
  window.addEventListener('focus', () => {
    if (Date.now() - buyerLogSharedPersonalBackupLastAttempt >= 14 * 60 * 1000) run();
  });
})();
