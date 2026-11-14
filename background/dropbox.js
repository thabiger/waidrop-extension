/**
 * WAiDrop - Dropbox client (App folder, OAuth PKCE)
 *
 * The extension holds a Dropbox refresh token (chrome.storage.local) and talks
 * only to api.dropboxapi.com / content.dropboxapi.com. The CLI tool uses
 * its own app-scoped token; no folder sharing is required.
 */

const API_URL = 'https://api.dropboxapi.com/2';
const CONTENT_URL = 'https://content.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const AUTH_STORAGE_KEY = 'dropboxAuth';
const EXPIRY_SKEW_MS = 60000;

const OPERATIONAL_SCOPES = ['files.metadata.read', 'files.content.write', 'files.content.read'];
const REQUESTED_SCOPES = ['account_info.read', ...OPERATIONAL_SCOPES];

function grantedScopes(document) {
  return String((document && document.scope) || '')
    .split(/\s+/)
    .filter(Boolean);
}

function missingScopes(scopes, required = REQUESTED_SCOPES) {
  return required.filter((scope) => !scopes.includes(scope));
}

function scopeError(missing) {
  return (
    `Dropbox authorized, but the app is missing required permissions: ${missing.join(', ')}. ` +
    'Enable them in the Dropbox App Console (Permissions), then Disconnect and Connect Dropbox again.'
  );
}

const folderCache = new Set();

function base64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readAuth() {
  const result = await chrome.storage.local.get([AUTH_STORAGE_KEY]);
  return result[AUTH_STORAGE_KEY] || null;
}

export async function getAuth() {
  return readAuth();
}

async function writeAuth(auth) {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: auth });
}

export async function disconnect() {
  await chrome.storage.local.remove([AUTH_STORAGE_KEY]);
  folderCache.clear();
}

export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

async function errorDetail(response) {
  try {
    const text = await response.text();
    try {
      const document = JSON.parse(text);
      const summary = document && document.error_summary;
      if (summary && String(summary).includes('missing_scope')) {
        const required = document.error && document.error.required_scope;
        const scopes = Array.isArray(required) ? required.join(', ') : required;
        return (
          `Dropbox token is missing required scope ${scopes || 'unknown'}; ` +
          'enable it in the Dropbox App Console and re-authorize'
        );
      }
      if (summary) return String(summary).slice(0, 200);
    } catch (e) {
      /* not JSON */
    }
    return String(text || '').slice(0, 200);
  } catch (e) {
    return '';
  }
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`Dropbox token exchange failed: HTTP ${response.status} ${await errorDetail(response)}`);
  }
  return response.json();
}

async function getAccountWithToken(accessToken) {
  const response = await fetch(`${API_URL}/users/get_current_account`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(`Dropbox account lookup failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  return response.json();
}

export async function connect(appKey) {
  if (!appKey) throw new Error('Dropbox app key is required');

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = base64Url(challengeBytes);
  const redirectUri = getRedirectUri();

  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', appKey);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('token_access_type', 'offline');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirectResponse) throw new Error('Dropbox authorization was cancelled');
  const code = new URL(redirectResponse).searchParams.get('code');
  if (!code) throw new Error('Dropbox authorization returned no code');

  const params = {
    code,
    grant_type: 'authorization_code',
    client_id: appKey,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  const token = await tokenRequest(params);
  if (!token.refresh_token) {
    throw new Error('Dropbox did not return a refresh token (re-check token_access_type=offline)');
  }

  const scopes = grantedScopes(token);
  const missing = missingScopes(scopes);
  const auth = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (Number(token.expires_in) || 0) * 1000 - EXPIRY_SKEW_MS,
    accountId: token.account_id || null,
    accountName: null,
    email: null,
    scopes,
  };
  // Persist tokens immediately: the popup may be gone by the time enrichment runs.
  await writeAuth(auth);

  try {
    const account = await getAccountWithToken(token.access_token);
    auth.accountName = (account.name && (account.name.display_name || account.name.given_name)) || null;
    auth.email = account.email || null;
    await writeAuth(auth);
  } catch (e) {
    /* account details are optional */
  }

  if (missing.length) throw new Error(scopeError(missing));
  return auth;
}

async function refreshAuth(auth, appKey) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: appKey,
  };
  const token = await tokenRequest(params);
  const next = {
    ...auth,
    accessToken: token.access_token,
    expiresAt: Date.now() + (Number(token.expires_in) || 0) * 1000 - EXPIRY_SKEW_MS,
  };
  if (token.refresh_token) next.refreshToken = token.refresh_token;
  if (token.scope) next.scopes = grantedScopes(token);
  await writeAuth(next);
  // Only operational scopes gate refresh: pre-existing connections without
  // account_info.read must keep uploading until the user reconnects.
  if (token.scope) {
    const missing = missingScopes(next.scopes, OPERATIONAL_SCOPES);
    if (missing.length) throw new Error(scopeError(missing));
  }
  return next;
}

export async function ensureAccessToken(settings) {
  const auth = await readAuth();
  if (!auth || !auth.refreshToken) {
    throw new Error('Dropbox is not connected — click "Connect Dropbox" and finish the authorization');
  }
  if (auth.accessToken && auth.expiresAt && Date.now() < auth.expiresAt) return auth.accessToken;
  const refreshed = await refreshAuth(auth, settings.dropboxAppKey);
  return refreshed.accessToken;
}

async function apiFetch(settings, url, init = {}) {
  let token = await ensureAccessToken(settings);
  const withAuth = (accessToken) => ({
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${accessToken}` },
  });

  let response = await fetch(url, withAuth(token));
  if (response.status === 401) {
    const auth = await readAuth();
    if (auth && auth.refreshToken) {
      const refreshed = await refreshAuth(auth, settings.dropboxAppKey);
      response = await fetch(url, withAuth(refreshed.accessToken));
    }
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    throw new Error(`Dropbox rate limit (retry after ${retryAfter}s)`);
  }
  return response;
}

/** Create a Dropbox folder (and parents) if missing. Safe to call repeatedly. */
export async function ensureFolder(settings, folderPath) {
  const segments = String(folderPath || '').split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    if (folderCache.has(current)) continue;
    const response = await apiFetch(settings, `${API_URL}/files/create_folder_v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: current, autorename: false }),
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      if (!(response.status === 409 && /conflict/i.test(detail))) {
        throw new Error(`Dropbox folder create failed (${current}): HTTP ${response.status} ${detail}`);
      }
    }
    folderCache.add(current);
  }
}

const UPLOAD_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'text/plain; charset=dropbox-cors-hack',
]);

export async function uploadFile(settings, path, bytes, contentType = 'application/octet-stream') {
  const arg = JSON.stringify({ path, mode: 'overwrite', autorename: false, mute: true });
  // files/upload only accepts these content types; anything else is rejected with HTTP 400.
  const type = UPLOAD_CONTENT_TYPES.has(contentType) ? contentType : 'application/octet-stream';
  const response = await apiFetch(settings, `${CONTENT_URL}/files/upload`, {
    method: 'POST',
    headers: { 'content-type': type, 'dropbox-api-arg': arg },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Dropbox upload failed (${path}): HTTP ${response.status} ${await errorDetail(response)}`);
  }
  return response.json();
}

export async function getMetadata(settings, path) {
  const response = await apiFetch(settings, `${API_URL}/files/get_metadata`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(`Dropbox metadata failed (${path}): HTTP ${response.status} ${await errorDetail(response)}`);
  }
  return response.json();
}

export async function downloadFile(settings, path) {
  const response = await apiFetch(settings, `${CONTENT_URL}/files/download`, {
    method: 'POST',
    headers: { 'dropbox-api-arg': JSON.stringify({ path }) },
  });
  if (!response.ok) {
    throw new Error(`Dropbox download failed (${path}): HTTP ${response.status} ${await errorDetail(response)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function testConnection(settings) {
  const auth = await readAuth();
  if (auth && Array.isArray(auth.scopes) && !auth.scopes.includes('account_info.read')) {
    throw new Error(
      'Dropbox is connected without the account_info.read permission — Disconnect, then Connect Dropbox again to grant it.'
    );
  }
  const token = await ensureAccessToken(settings);
  const account = await getAccountWithToken(token);
  const response = await apiFetch(settings, `${API_URL}/files/list_folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '', limit: 1 }),
  });
  if (!response.ok) {
    throw new Error(`Dropbox folder access failed: HTTP ${response.status} ${await errorDetail(response)}`);
  }
  return {
    ok: true,
    accountName: (account.name && (account.name.display_name || account.name.given_name)) || null,
    email: account.email || null,
  };
}

/** Test helper: allow folder-create caching to be reset between runs. */
export function resetFolderCache() {
  folderCache.clear();
}
