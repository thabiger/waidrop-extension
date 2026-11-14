/**
 * Dropbox OAuth-connect tests: the flow runs in the service worker (the popup
 * cannot survive the authorization window). Stubbed identity + fetch.
 *
 *   node tests/dropbox-connect.test.mjs
 */
import 'fake-indexeddb/auto';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';

const storage = { settings: null, waidropConsent: { version: 1, acceptedAt: Date.now() } };
const listeners = [];
let launchedUrl = null;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) {
        Object.assign(storage, values);
      },
      async remove(keys) {
        for (const key of keys) delete storage[key];
      },
    },
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
  },
  identity: {
    getRedirectURL() {
      return 'https://testextension.chromiumapp.org/';
    },
    async launchWebAuthFlow({ url }) {
      launchedUrl = url;
      return 'https://testextension.chromiumapp.org/?code=test-code';
    },
  },
};

let tokenFailure = false;
let accountFailure = false;
let accountMissingScope = false;
const FULL_SCOPE = 'account_info.read files.metadata.read files.content.write files.content.read';
let scopeValue = FULL_SCOPE;

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/oauth2/token')) {
    if (tokenFailure) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => '{"error":"invalid_grant"}', json: async () => ({}) };
    }
    return jsonResponse({
      access_token: 'access-token-1',
      refresh_token: 'refresh-token-1',
      expires_in: 14400,
      account_id: 'dbid-1',
      scope: scopeValue,
    });
  }
  if (target.includes('/users/get_current_account')) {
    if (accountMissingScope) {
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error_summary: 'missing_scope/required', error: { '.tag': 'missing_scope', required_scope: 'account_info.read' } }),
        json: async () => ({}),
      };
    }
    if (accountFailure) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) };
    }
    return jsonResponse({ name: { display_name: 'Test User' }, email: 'test@example.com' });
  }
  return jsonResponse({});
};

await import('../background/background.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

function connectMessage() {
  return new Promise((resolve) => {
    const listener = listeners[0];
    listener({ type: 'DROPBOX_CONNECT' }, {}, (response) => resolve(response));
  });
}

function testConnectionMessage() {
  return new Promise((resolve) => {
    const listener = listeners[0];
    listener({ type: 'TEST_CONNECTION' }, {}, (response) => resolve(response));
  });
}

function configure(appKey = 'app-key') {
  storage.settings = {
    uploadEnabled: true,
    accountAlias: 'primary',
    dropboxAppKey: appKey,
    encryptionKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  };
}

check('background listener registered', listeners.length === 1);

// --- success -------------------------------------------------------------------
configure();
delete storage.dropboxAuth;
let response = await connectMessage();
check('connect: succeeds', response && response.ok === true, JSON.stringify(response));
const requestedScopes = launchedUrl
  ? String(new URL(launchedUrl).searchParams.get('scope') || '').split(/\s+/)
  : [];
check(
  'connect: requests all Dropbox scopes',
  ['account_info.read', 'files.metadata.read', 'files.content.write', 'files.content.read'].every((scope) =>
    requestedScopes.includes(scope)
  ),
  JSON.stringify(requestedScopes)
);
check('connect: account name returned', response && response.accountName === 'Test User', response && response.accountName);
check('connect: refresh token stored', storage.dropboxAuth && storage.dropboxAuth.refreshToken === 'refresh-token-1');
check('connect: account enriched', storage.dropboxAuth && storage.dropboxAuth.accountName === 'Test User');

// --- token exchange failure ------------------------------------------------------
configure();
delete storage.dropboxAuth;
tokenFailure = true;
response = await connectMessage();
tokenFailure = false;
check('token failure: reported', response && response.ok === false && /400/.test(String(response.error)), JSON.stringify(response));
check('token failure: no auth stored', !storage.dropboxAuth);

// --- missing scopes are reported at connect time ---------------------------------
configure();
delete storage.dropboxAuth;
scopeValue = 'account_info.read files.content.read';
response = await connectMessage();
scopeValue = FULL_SCOPE;
check(
  'missing scopes: connect fails with guidance',
  response && response.ok === false && /missing required permissions/.test(String(response.error)),
  JSON.stringify(response)
);
check(
  'missing scopes: message names the scope',
  response && /files\.metadata\.read/.test(String(response.error)) && /files\.content\.write/.test(String(response.error)),
  String(response && response.error)
);
check(
  'missing scopes: token still stored with granted scopes',
  storage.dropboxAuth && Array.isArray(storage.dropboxAuth.scopes) && !storage.dropboxAuth.scopes.includes('files.metadata.read'),
  JSON.stringify(storage.dropboxAuth && storage.dropboxAuth.scopes)
);

// --- enrichment failure must not lose tokens ------------------------------------
configure();
delete storage.dropboxAuth;
accountFailure = true;
response = await connectMessage();
accountFailure = false;
check('enrichment failure: connect still succeeds', response && response.ok === true, JSON.stringify(response));
check(
  'enrichment failure: tokens still stored',
  storage.dropboxAuth && storage.dropboxAuth.refreshToken === 'refresh-token-1',
  JSON.stringify(storage.dropboxAuth && Object.keys(storage.dropboxAuth))
);

// --- stored custom app key is ignored ----------------------------------------------
configure('custom-key');
delete storage.dropboxAuth;
launchedUrl = null;
response = await connectMessage();
check(
  'stored custom key: connect succeeds with the built-in key',
  response && response.ok === true,
  JSON.stringify(response)
);
check(
  'stored custom key: built-in key sent as client_id',
  launchedUrl && new URL(launchedUrl).searchParams.get('client_id') === DEFAULT_DROPBOX_APP_KEY,
  launchedUrl
);

// --- missing account_info.read at connect time -------------------------------------
configure();
delete storage.dropboxAuth;
scopeValue = 'files.metadata.read files.content.write';
response = await connectMessage();
scopeValue = FULL_SCOPE;
check(
  'missing account scope: connect fails naming account_info.read',
  response && response.ok === false && /account_info\.read/.test(String(response.error)),
  JSON.stringify(response)
);

// --- test connection -----------------------------------------------------------------
configure();
storage.dropboxAuth = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  expiresAt: Date.now() + 3600_000,
  accountId: 'dbid-1',
  accountName: 'Test User',
  email: 'test@example.com',
  scopes: FULL_SCOPE.split(' '),
};
response = await testConnectionMessage();
check('test connection: succeeds', response && response.ok === true, JSON.stringify(response));
check('test connection: account name returned', response && response.accountName === 'Test User', JSON.stringify(response));

// Old token without account_info.read -> clear reconnect guidance, no API call.
storage.dropboxAuth.scopes = ['files.metadata.read', 'files.content.write'];
response = await testConnectionMessage();
check(
  'test connection: old token prompts reconnect',
  response && response.ok === false && /account_info\.read/.test(String(response.error)) && /Disconnect/.test(String(response.error)),
  JSON.stringify(response)
);

// Token carries the scope but the API still rejects it -> detailed error.
storage.dropboxAuth.scopes = FULL_SCOPE.split(' ');
accountMissingScope = true;
response = await testConnectionMessage();
accountMissingScope = false;
check(
  'test connection: missing_scope surfaces required scope',
  response && response.ok === false && /account_info\.read/.test(String(response.error)),
  JSON.stringify(response)
);

console.log(failures === 0 ? '\nALL DROPBOX CONNECT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
