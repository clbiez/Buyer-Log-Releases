'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const OAB = fs.readFileSync(path.join(ROOT, 'public', 'oab.js'), 'utf8');
const USER_ACCESS = fs.readFileSync(path.join(ROOT, 'public', 'user-access-ui.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const {
  createOabAuthLifecycle,
  authorizationHeaderFromRequest,
  isReportApiRequest,
  isOabApiRequest,
} = require('../electron/oab-auth-lifecycle');

function webRequest(url, authorization = '') {
  const requestHeaders = { Accept: 'application/json' };
  if (authorization) requestHeaders.Authorization = authorization;
  return { url, method: 'POST', requestHeaders };
}

test('user menu reuses the same persistent OAB session through the desktop auth bridge', () => {
  assert.match(USER_ACCESS, /data-oab-user-login/);
  assert.match(USER_ACCESS, /OAB Kullanıcı Girişi/);
  assert.match(USER_ACCESS, /ensureOabAuth\(\{ interactive:true \}\)/);
  assert.doesNotMatch(USER_ACCESS, /ensureOabAuth\(\{ interactive:true, manual:true \}\)/);
});

test('OAB desktop auth captures only the dedicated Electron session through webRequest, never debugger/CDP', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /oabAuthSession\(\)\.webRequest/);
  assert.match(body, /onBeforeSendHeaders\(OAB_AUTH_CAPTURE_FILTER/);
  assert.match(body, /createOabAuthLifecycle/);
  assert.match(body, /networkReady = Promise\.resolve\(true\)/);
  assert.doesNotMatch(body, /webContents\.debugger|Network\.requestWillBeSent|Network\.enable|targetDebugger|remote-debugging|9223/);
  assert.ok(body.indexOf('onBeforeSendHeaders(OAB_AUTH_CAPTURE_FILTER') < body.indexOf('loadLoginTarget(targetViewerUrl(), true)'));
});

test('OAB owns a persistent dedicated session and normal shutdown preserves it', () => {
  assert.match(MAIN, /const OAB_AUTH_PARTITION = 'persist:oab'/);
  const shutdownStart = MAIN.indexOf('async function shutdown()');
  const shutdownEnd = MAIN.indexOf('/* ------------------------------------------------------------------- IPC */', shutdownStart);
  const shutdownBody = MAIN.slice(shutdownStart, shutdownEnd);
  assert.match(shutdownBody, /clearOabBackendAuthorization\(\)/);
  assert.doesNotMatch(shutdownBody, /clearOabAuthSession\(\)/);

  const clearStart = MAIN.indexOf('async function clearOabAuthSession()');
  const clearEnd = MAIN.indexOf('/* ------------------------------------------------------------- pencereler */', clearStart);
  const clearBody = MAIN.slice(clearStart, clearEnd);
  assert.match(clearBody, /clearOabBackendAuthorization\(\)/);
  assert.match(clearBody, /clearStorageData/);
  assert.match(clearBody, /clearCache\(\)/);
});

test('persistent OAB probe stays hidden briefly, then escalates instead of waiting invisibly for the full auth timeout', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /show: false/);
  assert.match(body, /phase === 'login-required'[\s\S]*?showInteractiveWindow\(\)/);
  assert.match(MAIN, /const OAB_SILENT_PROBE_MS = 8000/);
  assert.match(body, /armSilentProbe\(\)/);
  assert.match(body, /recoverStaleSilentProbe/);
  assert.match(body, /resetForFreshViewer/);
  const recoveryStart = body.indexOf('const recoverStaleSilentProbe');
  const recoveryEnd = body.indexOf('const armSilentProbe', recoveryStart);
  const recoveryBody = body.slice(recoveryStart, recoveryEnd);
  assert.match(recoveryBody, /clearOabBackendAuthorization\(\)/);
  assert.match(recoveryBody, /showInteractiveWindow\(\)/);
  assert.doesNotMatch(recoveryBody, /resetOabBrowserAuthState|clearStorageData|clearCache/);
  assert.match(body, /resetOabBrowserAuthState[\s\S]*?clearStorageData[\s\S]*?clearCache/);
  assert.doesNotMatch(body, /once\('ready-to-show', showInteractiveWindow\)/);
  assert.match(body, /did-fail-load[\s\S]*?OAB_AUTH_NAVIGATION_FAILED/);
  assert.match(body, /render-process-gone[\s\S]*?OAB_AUTH_RENDERER_FAILED/);
});

test('Microsoft SSO popup is kept inside the dedicated partition and allowlist', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /setWindowOpenHandler/);
  assert.match(body, /overrideBrowserWindowOptions/);
  assert.match(body, /partition: OAB_AUTH_PARTITION/);
  assert.match(body, /did-create-window/);
  assert.match(body, /isAllowedOabLoginUrl/);
  assert.match(body, /will-navigate/);
});

test('interactive OAB reveals the SSO child itself without exposing the blank PASS parent', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /authWindow\.once\('ready-to-show',[\s\S]*?if \(loginRequiredKnown\) showInteractiveWindow\(\)/);
  assert.doesNotMatch(body, /if \(forceFresh \|\| loginRequiredKnown\) showInteractiveWindow\(\)/);
  assert.match(body, /popup\.once\('ready-to-show',[\s\S]*?flowState\.interactive[\s\S]*?showWindow\(popup\)/);
  assert.match(body, /popup\.webContents\.on\('did-finish-load',[\s\S]*?flowState\.interactive[\s\S]*?showWindow\(popup\)/);

  const openHandlerStart = body.indexOf('authWindow.webContents.setWindowOpenHandler');
  const childHandlerStart = body.indexOf("authWindow.webContents.on('did-create-window'", openHandlerStart);
  const openHandler = body.slice(openHandlerStart, childHandlerStart);
  assert.doesNotMatch(openHandler, /showInteractiveWindow\(\)/);
});

test('only explicit force-fresh OAB auth clears the dedicated persistent browser state', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /const forceFresh = options\.forceFresh === true/);
  assert.match(body, /if \(forceFresh\) await resetOabBrowserAuthState\('force-fresh-login'\)/);
  assert.match(body, /resetOabBrowserAuthState[\s\S]*?oabAuthSession\(\)[\s\S]*?clearStorageData[\s\S]*?clearCache/);
  assert.doesNotMatch(body, /options\.manual|manual-login|stale-silent-probe/);
});


test('interactive Get OAB upgrades an existing hidden auth flow instead of joining it invisibly', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /if \(oabAuthInFlight\)/);
  assert.match(body, /if \(requestedInteractive\)/);
  assert.match(body, /oabAuthFlowState\.interactive = true/);
  assert.match(body, /promoteInteractive\?\.\(\{ immediate:true, reason:'interactive-join' \}\)/);
  assert.match(body, /target\.show\(\);[\s\S]*?target\.focus\(\)/);
});

test('main-frame and popup sign-in redirects immediately reveal a usable auth window', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /did-start-navigation/);
  assert.match(body, /will-redirect/);
  assert.match(body, /markLoginRequired\(url, authWindow\)/);
  assert.match(body, /markLoginRequired\(url, popup\)/);
  assert.match(body, /isLikelyOabSignInUrl\(url\)/);
  assert.match(body, /showWindow\(target\)/);
});

test('Keycloak is detected by generic identity-host semantics without hard-coding a login URL or OAuth query', () => {
  assert.doesNotMatch(MAIN, /https:\/\/keycloak\.lcwaikiki\.com/i);
  assert.doesNotMatch(MAIN, /code_challenge=|nonce=|state=/i);
  assert.match(MAIN, /keycloak\|login\|signin\|auth\|sso\|identity\|idp\|adfs/);
});

test('Electron webRequest capture accepts only the real PASS report API Authorization', () => {
  const token = 'Bearer ' + 'a'.repeat(48);
  const valid = webRequest('https://pass.prod.lcwaikiki.com/pass/common/report/api/v2.0/Report/GetReportData', token);
  assert.equal(isReportApiRequest(valid, 'pass.prod.lcwaikiki.com'), true);
  assert.equal(authorizationHeaderFromRequest(valid), token);

  assert.equal(isReportApiRequest(webRequest('https://pass.lcwaikiki.com/v3/report/viewer', token), 'pass.prod.lcwaikiki.com'), false);
  assert.equal(isReportApiRequest(webRequest('https://pass.prod.lcwaikiki.com/other/api', token), 'pass.prod.lcwaikiki.com'), false);
  assert.equal(authorizationHeaderFromRequest(webRequest('https://pass.prod.lcwaikiki.com/pass/common/report/api/v2.0/x')), '');
});

test('Electron auth capture accepts Bearer traffic from the trusted PASS /pass namespace before report filters are applied', () => {
  const token = 'Bearer ' + 'b'.repeat(48);
  const bootstrap = webRequest('https://pass.prod.lcwaikiki.com/pass/common/security/api/v1.0/User/Profile', token);

  assert.equal(isOabApiRequest(bootstrap, 'pass.prod.lcwaikiki.com'), true);
  assert.equal(isReportApiRequest(bootstrap, 'pass.prod.lcwaikiki.com'), false);
  assert.equal(authorizationHeaderFromRequest(bootstrap), token);

  assert.equal(isOabApiRequest(webRequest('https://pass.prod.lcwaikiki.com/other/api', token), 'pass.prod.lcwaikiki.com'), false);
  assert.equal(isOabApiRequest(webRequest('https://evil.example/pass/common/security/api', token), 'pass.prod.lcwaikiki.com'), false);
});

test('trusted PASS bootstrap request can finish auth without waiting for Report/GetReportData', async () => {
  const token = 'Bearer ' + 'c'.repeat(48);
  const validated = [];
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    onAuthorization: async authorization => {
      validated.push(authorization);
      return authorization === token;
    },
  });

  const bootstrap = webRequest('https://pass.prod.lcwaikiki.com/pass/common/security/api/v1.0/User/Profile', token);
  assert.equal(await lifecycle.onNetworkRequest(bootstrap), true);
  assert.deepEqual(validated, [token]);
  assert.equal(lifecycle.snapshot().phase, 'backend-validated');
  assert.equal(lifecycle.snapshot().stopped, true);
});

test('interactive lifecycle waits for login, retries viewer in a bounded way, then resolves only after backend validation', async () => {
  let clock = 1000;
  const phases = [];
  const kicks = [];
  const validated = [];
  const validToken = 'Bearer ' + 'v'.repeat(48);
  const staleToken = 'Bearer ' + 's'.repeat(48);

  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    viewerKickIntervalMs: 1000,
    viewerSettleMs: 1000,
    maxViewerKicks: 3,
    now: () => clock,
    onPhase: phase => phases.push(phase),
    onViewerKick: async detail => { kicks.push(detail); },
    onAuthorization: async authorization => {
      validated.push(authorization);
      return authorization === validToken;
    },
  });

  await lifecycle.observe({ url: 'https://login.microsoftonline.com/common/oauth2/authorize', signIn: true });
  assert.equal(lifecycle.snapshot().phase, 'login-required');
  assert.equal(kicks.length, 0);

  // Login completes and PASS viewer appears. The first viewer observation is
  // attempt zero; success is still false because no report Authorization exists.
  await lifecycle.observe({ url: 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report', signIn: false });
  assert.equal(lifecycle.snapshot().phase, 'waiting-report-request');
  assert.equal(lifecycle.snapshot().stopped, false);
  assert.equal(kicks.length, 0);

  // PASS SPA may render the viewer shell without issuing the report request.
  // Retry is bounded and paced, not tied to one did-finish-load event.
  for (let index = 0; index < 5; index += 1) {
    clock += 1100;
    await lifecycle.observe({ url: 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report', signIn: false });
  }
  assert.equal(kicks.length, 3);
  assert.equal(lifecycle.snapshot().viewerKicks, 3);

  // A non-report request cannot complete authentication.
  assert.equal(await lifecycle.onNetworkRequest(webRequest('https://pass.prod.lcwaikiki.com/health', validToken)), false);
  assert.equal(validated.length, 0);

  // A captured but rejected/expired candidate is not success.
  const reportUrl = 'https://pass.prod.lcwaikiki.com/pass/common/report/api/v2.0/Report/GetReportVariablesWithData';
  assert.equal(await lifecycle.onNetworkRequest(webRequest(reportUrl, staleToken)), false);
  assert.equal(lifecycle.snapshot().stopped, false);

  // Only backend-accepted Authorization completes the lifecycle.
  assert.equal(await lifecycle.onNetworkRequest(webRequest(reportUrl, validToken)), true);
  assert.equal(lifecycle.snapshot().stopped, true);
  assert.equal(lifecycle.snapshot().phase, 'backend-validated');
  assert.deepEqual(validated, [staleToken, validToken]);

  // Duplicate requests after success cannot trigger duplicate validation/fetch.
  assert.equal(await lifecycle.onNetworkRequest(webRequest(reportUrl, validToken)), false);
  assert.equal(validated.length, 2);
  assert.ok(phases.includes('authorization-captured'));
  assert.ok(phases.includes('backend-validated'));
});

test('stale lifecycle state can be reset before reopening the real PASS viewer', async () => {
  let clock = 1000;
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    viewerKickIntervalMs: 1000,
    viewerSettleMs: 1000,
    now: () => clock,
  });
  await lifecycle.observe({ url: 'https://login.microsoftonline.com/common/oauth2/authorize', signIn: true });
  assert.equal(lifecycle.snapshot().sawLogin, true);
  assert.equal(lifecycle.snapshot().phase, 'login-required');
  assert.equal(lifecycle.resetForFreshViewer(), true);
  assert.equal(lifecycle.snapshot().sawLogin, false);
  assert.equal(lifecycle.snapshot().viewerKicks, 0);
  assert.equal(lifecycle.snapshot().phase, 'opening');
});

test('viewer gets a settle window after login instead of being reloaded every few seconds', async () => {
  let clock = 1000;
  let kicks = 0;
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    viewerKickIntervalMs: 1000,
    viewerSettleMs: 10000,
    now: () => clock,
    onViewerKick: async () => { kicks += 1; return true; },
  });

  const viewer = 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report';
  await lifecycle.observe({ url: viewer, signIn: false });
  clock += 5000;
  await lifecycle.observe({ url: viewer, signIn: false });
  assert.equal(kicks, 0, 'viewer henüz yüklenirken yeniden yönlendirilmemeli');

  clock += 6000;
  await lifecycle.observe({ url: viewer, signIn: false });
  assert.equal(kicks, 1, 'settle süresi dolduktan sonra tek bounded retry yapılabilir');
});

test('busy navigation does not consume the bounded viewer retry budget', async () => {
  let clock = 1000;
  let navigationBusy = true;
  let calls = 0;
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    viewerKickIntervalMs: 1000,
    viewerSettleMs: 1000,
    maxViewerKicks: 2,
    now: () => clock,
    onViewerKick: async () => {
      calls += 1;
      return navigationBusy ? false : true;
    },
  });

  await lifecycle.observe({ url: 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report', signIn: false });
  clock += 1100;
  await lifecycle.observe({ url: 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report', signIn: false });
  assert.equal(calls, 1);
  assert.equal(lifecycle.snapshot().viewerKicks, 0);

  navigationBusy = false;
  clock += 1100;
  await lifecycle.observe({ url: 'https://pass.lcwaikiki.com/v3/report/viewer?key=OrderBudget_List_Report', signIn: false });
  assert.equal(calls, 2);
  assert.equal(lifecycle.snapshot().viewerKicks, 1);
});

test('concurrent duplicate report requests validate only one Authorization candidate', async () => {
  let releaseValidation;
  const validationGate = new Promise(resolve => { releaseValidation = resolve; });
  let validationCalls = 0;
  const token = 'Bearer ' + 'd'.repeat(48);
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    onAuthorization: async () => {
      validationCalls += 1;
      await validationGate;
      return true;
    },
  });
  const request = webRequest('https://pass.prod.lcwaikiki.com/pass/common/report/api/v2.0/Report/GetReportData', token);
  const first = lifecycle.onNetworkRequest(request);
  const duplicate = await lifecycle.onNetworkRequest(request);
  assert.equal(duplicate, false);
  assert.equal(validationCalls, 1);
  releaseValidation();
  assert.equal(await first, true);
  assert.equal(lifecycle.snapshot().stopped, true);
});

test('distinct PASS Authorization arriving during validation is queued instead of being lost', async () => {
  let releaseFirstValidation;
  const firstGate = new Promise(resolve => { releaseFirstValidation = resolve; });
  const staleToken = 'Bearer ' + 's'.repeat(48);
  const validToken = 'Bearer ' + 'v'.repeat(48);
  const validated = [];
  const lifecycle = createOabAuthLifecycle({
    apiHost: 'pass.prod.lcwaikiki.com',
    uiHost: 'pass.lcwaikiki.com',
    onAuthorization: async authorization => {
      validated.push(authorization);
      if (authorization === staleToken) {
        await firstGate;
        return false;
      }
      return authorization === validToken;
    },
  });

  const securityUrl = 'https://pass.prod.lcwaikiki.com/pass/common/security/api/v1.0/User/Profile';
  const reportUrl = 'https://pass.prod.lcwaikiki.com/pass/common/report/api/v2.0/Report/GetReportData';
  const first = lifecycle.onNetworkRequest(webRequest(securityUrl, staleToken));
  assert.equal(await lifecycle.onNetworkRequest(webRequest(reportUrl, validToken)), false);
  assert.deepEqual(validated, [staleToken]);

  releaseFirstValidation();
  assert.equal(await first, true);
  assert.deepEqual(validated, [staleToken, validToken]);
  assert.equal(lifecycle.snapshot().phase, 'backend-validated');
  assert.equal(lifecycle.snapshot().stopped, true);
});

test('main-process success still requires loopback backend validation and closes the login BrowserWindow', () => {
  const start = MAIN.indexOf('async function acquireOabAuthorization');
  const end = MAIN.indexOf('async function clearOabAuthSession', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /pushOabAuthorizationToBackend\(authorization\)/);
  assert.match(body, /settled = true;[\s\S]*?cleanup\(\);[\s\S]*?resolvePromise\(\{ ok:true, authenticated:true/);
  assert.match(body, /authWebRequest\.onBeforeSendHeaders\(null\)/);
  assert.match(body, /authWindow\.close\(\)/);
  assert.match(body, /clearInterval\(lifecycleTimer\)/);
});

test('explicit clear cancels any active OAB window before clearing the persistent session', () => {
  const start = MAIN.indexOf('async function clearOabAuthSession()');
  const end = MAIN.indexOf('/* ------------------------------------------------------------- pencereler */', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /const pending = oabAuthInFlight/);
  assert.match(body, /oabAuthWindow\.close\(\)/);
  assert.match(body, /clearOabBackendAuthorization\(\)/);
  assert.match(body, /clearStorageData/);
  assert.match(body, /clearCache\(\)/);
});

test('manual interactive window close remains OAB_AUTH_CANCELLED', () => {
  const start = MAIN.indexOf("authWindow.on('closed'");
  const end = MAIN.indexOf('lifecycleTimer = setInterval', start);
  const body = MAIN.slice(start, end);
  assert.match(body, /OAB_AUTH_CANCELLED/);
  assert.match(body, /cleanupCapture\(\)/);
});

test('Get OAB uses the dedicated Electron auth bridge and retries the original request after login', () => {
  const apiStart = OAB.indexOf('function oabIsAuthErrorCode');
  const apiEnd = OAB.indexOf('const OABApi', apiStart);
  const apiBody = OAB.slice(apiStart, apiEnd);
  assert.match(apiBody, /buyerLogDesktop/);
  assert.match(apiBody, /ensureOabAuth\(\{ interactive:true, \.\.\.oabLastAuthContext \}\)/);
  assert.match(apiBody, /OAB_AUTH_REQUIRED/);
  assert.match(apiBody, /OAB_AUTH_EXPIRED/);
  assert.match(apiBody, /return oabJson\(url, options, false\)/);

  const fetchStart = OAB.indexOf('async function oabFetchReport');
  const fetchBody = OAB.slice(fetchStart, OAB.indexOf('/* ================================================================', fetchStart));
  assert.match(fetchBody, /OABApi\.report\(/);
  assert.doesNotMatch(fetchBody, /Edge|remote debugging|9223|agentBrowserConnector/);
});

test('backend bridge stores Authorization only in RAM and validates through oabApiClient', () => {
  const start = SERVER.indexOf("app.post('/api/internal/desktop/oab-authorization'");
  const end = SERVER.indexOf("app.delete('/api/internal/desktop/oab-authorization'", start);
  const body = SERVER.slice(start, end);
  assert.match(body, /oabAuthState\.setAuthorization/);
  assert.match(body, /await oabApiClient\.validateAuthorization\(\)/);
  assert.match(body, /oabAuthState\.clear\(\)/);
  assert.doesNotMatch(body, /res[^\n]*authorization|json\([^)]*Bearer/i);
});

test('OAB desktop auth never reads credential values or logs Authorization values', () => {
  const signInStart = MAIN.indexOf('async function oabWindowLooksLikeSignIn');
  const signInEnd = MAIN.indexOf('/* Electron loadURL()', signInStart);
  const signInBody = MAIN.slice(signInStart, signInEnd);
  assert.match(signInBody, /querySelector/);
  assert.doesNotMatch(signInBody, /\.value\b|password\s*:/i);

  const authStart = MAIN.indexOf('async function acquireOabAuthorization');
  const authEnd = MAIN.indexOf('async function clearOabAuthSession', authStart);
  const authBody = MAIN.slice(authStart, authEnd);
  // It is safe to mention the word "Authorization" in a constant diagnostic;
  // the sensitive failure would be interpolating/concatenating the captured
  // authorization variable itself into a log call.
  assert.doesNotMatch(authBody, /log\([^\n]*(?:\+\s*authorization\b|\$\{authorization\}|,\s*authorization\b)/i);
  assert.doesNotMatch(authBody, /executeJavaScript\([^\n]*\.value/i);
});
