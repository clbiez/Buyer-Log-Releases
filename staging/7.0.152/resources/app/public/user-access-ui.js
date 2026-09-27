/* Buyer Log v7.01 — oturum açan kullanıcının erişim katmanı.
 * Eski ekran adı yükseltme tanılaması için korunuyor: Kullanıcılar ve Hiyerarşi.
 *
 * Bu dosya YALNIZ şunlardan sorumludur:
 *   · oturum açan kullanıcının rolüne göre sekme/düğme görünürlüğü,
 *   · sağ üstteki kullanıcı menüsü ve kullanıcı değiştirme.
 *
 * Kullanıcı & Yetki Yönetimi arayüzü v7.00'da yazıldı ve v7.01'de kişisel
 * workspace desteğiyle genişletildi; ayrı bir
 * dosyaya taşındı: public/user-management.js (window.BLUserManagement).
 * Eski yönetim arayüzü (kullanıcı listesi, sihirbaz, rol matrisi, hiyerarşi ve
 * yetki panelleri) buradan tamamen kaldırıldı.
 */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const esc = value => typeof escapeHtml === 'function' ? escapeHtml(String(value == null ? '' : value)) : String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const tr = (a, b) => (typeof appLang !== 'undefined' && appLang === 'en') ? b : a;
  const current = () => { try { if (typeof state !== 'undefined' && state.currentUser) return state.currentUser; } catch (_) {} return window.BL_USER_CONTEXT || null; };
  const initials = name => String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(value => value[0]).join('').toLocaleUpperCase('tr-TR') || '?';
  const roleLabels = { buyer: 'Buyer', manager: 'Manager', senior_manager: 'Senior Manager', moderator: tr('Moderatör', 'Moderator') };
  const scopeLabels = { SELF: tr('Kendi Kayıtları', 'Own Records'), TEAM: tr('Ekibi', 'Their Team'), MMYG: 'MMYG', MAG: 'MAG', ALL: tr('Tüm Veriler', 'All Data'), CUSTOM: tr('Özel', 'Custom') };
  const areaLabels = { overview: 'Overview', cp: 'CP', quotations:'Quotations', pricinghistory:tr('Fiyat Geçmişi','Pricing History'), orders: tr('Siparişler', 'Orders'), koleksiyon: tr('Koleksiyon', 'Collections'), priceanalysis: tr('Fiyat & Üretici Analizi', 'Price & Supplier Analysis'), lfl: tr('Analizler', 'Analysis'), opencosting: tr('Ön Maliyet', 'Open Costing'), backlog: 'Backlog', shipping: tr('Nakliye', 'Shipping'), agents: 'Agent Studio', automations: tr('Otomasyonlar', 'Automations'), source: tr('Kaynak Veri', 'Source Data') };
  const permissionControls={manageBusinessRules:['transitRulesBtn','nonDtrManufacturersBtn','cpSuppFobRulesBtn','cpLicenseRoyaltyBtn','ordersLicenseRoyaltyBtn','kolLicenseRoyaltyBtn','ocFxBtn','btnSourceFx'],manageModelConnections:['modelConnectionBtn','endeksmatikUploadBtn']};
  const canManageUsers = () => Boolean(current() && current().canManageUsers);
  const hasPermission = key => Boolean(current() && current().permissions && current().permissions[key]);
  const hasCapability = key => Boolean(current() && Array.isArray(current().capabilities) && current().capabilities.includes(key));
  const areaAllowed = (areas, key) => { const mapped=(key==='quotations'||key==='pricinghistory')?'koleksiyon':key; return Boolean(mapped === 'orders' ? (areas && (areas.orders ?? areas.cp)) : areas && areas[mapped]); };
  const hasArea = key => areaAllowed(current() && current().accessAreas || {}, key);

  function applyAccessAreaVisibility(profile) {
    const areas = profile.accessAreas || {};
    document.querySelectorAll('nav.tabs button[data-tab]').forEach(button => { const allowed = areaAllowed(areas, button.dataset.tab); button.hidden = !allowed; button.style.display = allowed ? '' : 'none'; button.setAttribute('aria-hidden', allowed ? 'false' : 'true'); });
    ['railSourceBtn', 'topRefreshBtn'].forEach(id => { const button = byId(id); if (button) { button.hidden = !areas.source; button.style.display = areas.source ? '' : 'none'; } });
    const active = document.body && document.body.dataset.activeTab || document.querySelector('nav.tabs button.active') && document.querySelector('nav.tabs button.active').dataset.tab || 'overview';
    if (!areaAllowed(areas, active)) {
      const fallback = Object.keys(areaLabels).find(key => key !== 'source' && areas[key] && document.querySelector(`nav.tabs button[data-tab="${key}"]`));
      if (fallback && typeof window.switchTab === 'function') window.switchTab(fallback);
    }
  }
  function applyUserAccessUI() {
    const profile = current(); if (!profile) return;
    window.BL_USER_CONTEXT = { ...(window.BL_USER_CONTEXT || {}), ...profile, initials: initials(profile.displayName) };
    const avatar = byId('currentUserInitials'); if (avatar) avatar.textContent = initials(profile.displayName);
    const badge = byId('accessModeBadge'); if (badge) { badge.textContent = roleLabels[profile.systemRole] || profile.systemRoleLabel || profile.roleLabel; badge.classList.toggle('isModerator', profile.systemRole === 'moderator'); badge.classList.toggle('isBuyer', profile.systemRole === 'buyer'); }
    applyAccessAreaVisibility(profile);
    Object.entries(permissionControls).forEach(([permission, ids]) => ids.forEach(id => { const el = byId(id); if (el) el.style.display = hasPermission(permission) ? '' : 'none'; }));
    window.dispatchEvent(new CustomEvent('bl:user-access-applied', { detail: profile }));
  }
  window.applyUserAccessUI = applyUserAccessUI;
  window.BLIsModerator = () => current() && current().systemRole === 'moderator';
  window.BLHasPermission = hasPermission;
  window.BLHasCapability = hasCapability;
  window.BLHasArea = hasArea;
  window.BLCanAccessArea = hasArea;
  // Check only the local validated session. Central polling belongs to the
  // server, so an unavailable share never blocks page guards or normal APIs.
  let iamSessionCheck = false;
  async function checkIamSession() {
    if (iamSessionCheck || !current()?.centralIamEnabled) return;
    iamSessionCheck = true;
    try {
      const response = await fetch('/api/current-user', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (!result.selected) { location.assign('/select-user.html'); return; }
      window.BL_USER_CONTEXT = result.user;
      if (typeof state !== 'undefined') state.currentUser = result.user;
      applyUserAccessUI();
    } catch (_) {} finally { iamSessionCheck = false; }
  }
  setInterval(checkIamSession, 5000);
  window.addEventListener('focus', checkIamSession);
  window.addEventListener('bl:iam-revision-available', checkIamSession);

  let menu;
  function closeMenu() { if (menu) menu.remove(); menu = null; }
  function switchUser() { location.assign('/select-user.html?switch=1'); }
  function currentWorkspaceModule() {
    const active = document.body && document.body.dataset.activeTab || document.querySelector('nav.tabs button.active') && document.querySelector('nav.tabs button.active').dataset.tab || 'overview';
    return ({ koleksiyon: 'collections', quotations:'quotations', pricinghistory:'quotations', source: 'default' })[active] || active;
  }
  async function resetMyView() {
    const module = currentWorkspaceModule();
    if (!confirm(tr('Bu modüldeki kişisel Horizon, filtre, kolon ve görünüm ayarlarınız sıfırlansın mı?', 'Reset your personal Horizon, filters, columns and view settings for this module?'))) return;
    try {
      const response = await fetch(`/api/user-workspace/${encodeURIComponent(module)}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: ['horizon','filters','columns','views','dashboard','favorites'] }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || tr('Görünüm sıfırlanamadı.', 'The view could not be reset.'));
      (result.removedKeys || []).forEach(key => { try { if (window.BLStorage && window.BLStorage.removeItem) window.BLStorage.removeItem(key); } catch (_) {} });
      location.reload();
    } catch (error) { if (typeof showToast === 'function') showToast(error.message); else alert(error.message); }
  }
  function openUserManagement() {
    if (window.BLUserManagement && typeof window.BLUserManagement.open === 'function') { window.BLUserManagement.open(); return; }
    if (typeof showToast === 'function') showToast(tr('Kullanıcı yönetimi arayüzü yüklenemedi.', 'The user management screen could not be loaded.'));
  }
  async function openOabUserLogin() {
    const bridge = window.buyerLogDesktop;
    if (!bridge || typeof bridge.ensureOabAuth !== 'function') {
      const message = tr('OAB kullanıcı girişi Buyer Log masaüstü uygulamasında kullanılabilir.', 'OAB user sign-in is available in the Buyer Log desktop app.');
      if (typeof showToast === 'function') showToast(message); else alert(message);
      return;
    }
    try {
      if (typeof showToast === 'function') showToast(tr('OAB giriş ekranı açılıyor…', 'Opening OAB sign-in…'));
      const result = await bridge.ensureOabAuth({ interactive:true });
      if (result && result.ok && result.authenticated) {
        if (typeof showToast === 'function') showToast(tr('OAB oturumu açıldı.', 'OAB session is ready.'));
        return;
      }
      const message = result && result.code === 'OAB_AUTH_CANCELLED'
        ? tr('OAB kullanıcı girişi iptal edildi.', 'OAB sign-in was cancelled.')
        : (result && result.error) || tr('OAB kullanıcı girişi tamamlanmadı.', 'OAB sign-in was not completed.');
      if (typeof showToast === 'function') showToast(message); else alert(message);
    } catch (error) {
      const message = error && error.message || tr('OAB kullanıcı girişi açılamadı.', 'OAB sign-in could not be opened.');
      if (typeof showToast === 'function') showToast(message); else alert(message);
    }
  }

  function openMenu(anchor) {
    if (menu) return closeMenu();
    const profile = current(); if (!profile) return;
    menu = document.createElement('div'); menu.className = 'userMenu';
    menu.innerHTML = `<div class="userMenuHead"><span class="userMenuAvatar">${esc(initials(profile.displayName))}</span><div><div class="userMenuName">${esc(profile.displayName || profile.username)}</div><div class="userMenuRole">${esc(roleLabels[profile.systemRole] || profile.systemRoleLabel || profile.roleLabel)}</div></div></div><div class="userMenuScope">${esc([profile.title, profile.dataScope && scopeLabels[profile.dataScope.mode]].filter(Boolean).join(' · '))}</div>${canManageUsers() ? `<button type="button" data-user-admin><svg class="ic" aria-hidden="true"><use href="#i-users-group"/></svg>${esc(tr('Kullanıcı & Yetki Yönetimi', 'User & Authorization Management'))}</button>` : ''}${hasCapability('OUTLOOK.SEARCH') ? `<button type="button" data-outlook-settings-menu><svg class="ic" aria-hidden="true"><use href="#i-mail-send"/></svg>${esc(tr('Microsoft 365 · Outlook', 'Microsoft 365 · Outlook'))}</button>` : ''}<button type="button" data-plm-user-login><svg class="ic" aria-hidden="true"><use href="#i-globe"/></svg>${esc(tr('PLM Kullanıcı Girişi', 'PLM User Sign-In'))}</button><button type="button" data-oab-user-login><svg class="ic" aria-hidden="true"><use href="#i-globe"/></svg>${esc(tr('OAB Kullanıcı Girişi', 'OAB User Sign-In'))}</button>${profile.systemRole === 'moderator' ? `<button type="button" data-update-test><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg>${esc(tr('Güncelleme Testi', 'Update Test'))}</button>` : ''}<button type="button" data-backup-settings><svg class="ic" aria-hidden="true"><use href="#i-database-import"/></svg>${esc(tr('Backup', 'Backup'))}</button><button type="button" data-reset-my-view><svg class="ic" aria-hidden="true"><use href="#i-reload"/></svg>${esc(tr('Görünümümü Sıfırla', 'Reset My View'))}</button><button type="button" data-switch-user><svg class="ic" aria-hidden="true"><use href="#i-user"/></svg>${esc(tr('Kullanıcı Değiştir', 'Switch User'))}</button>`;
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect(), width = Math.min(380, window.innerWidth - 24); menu.style.width = `${width}px`; menu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`; menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 12)}px`;
    menu.querySelector('[data-switch-user]').addEventListener('click', switchUser);
    menu.querySelector('[data-reset-my-view]').addEventListener('click', () => { closeMenu(); resetMyView(); });
    menu.querySelector('[data-user-admin]')?.addEventListener('click', () => { closeMenu(); openUserManagement(); });
    menu.querySelector('[data-outlook-settings-menu]')?.addEventListener('click', () => { closeMenu(); if (window.BLOutlook) window.BLOutlook.openSettings(); });
    menu.querySelector('[data-plm-user-login]')?.addEventListener('click', () => { closeMenu(); window.openCoreNectumApiSettings?.({ required:false, manual:true }); });
    menu.querySelector('[data-oab-user-login]')?.addEventListener('click', () => { closeMenu(); void openOabUserLogin(); });
    menu.querySelector('[data-update-test]')?.addEventListener('click', () => { closeMenu(); window.openBuyerLogUpdateTest?.(); });
    menu.querySelector('[data-backup-settings]')?.addEventListener('click', () => { closeMenu(); window.buyerLogBackupModal?.(); });
  }

  window.openUserAccessAdmin = openUserManagement;
  document.addEventListener('click', event => { const button = event.target.closest('#currentUserBtn'); if (button) { event.preventDefault(); event.stopPropagation(); openMenu(button); return; } if (menu && !menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyUserAccessUI); else applyUserAccessUI();
})();
