/**
 * Authenticated content-side peer for hook-only jsdom tests.
 *
 * Production Chrome always uses the private MessageChannel bridge. Tests that
 * exercise the MAIN-world hook without loading content/content.js use this
 * helper to perform the same nonce + MAC handshake and to collect the signed
 * frames the hook posts. The helper also installs the MessageChannel/crypto
 * shims those hooks need under jsdom.
 */
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { FakeMessageChannel, installWindowPostMessage } from './fake-message-channel.mjs';
import { TEST_BRIDGE_KEY } from './main-hook-loader.mjs';

export function bridgeMac(label, key, ...parts) {
  const input = ['wd-bridge/v1', label, key, ...parts].join('|');
  return createHash('sha256').update(Buffer.from(input, 'latin1')).digest('hex');
}

export function installHookPeer(window, key = TEST_BRIDGE_KEY) {
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  installWindowPostMessage(window);

  const channel = new FakeMessageChannel();
  const frames = [];
  let outSeq = 0;
  let connected = false;

  channel.port1.onmessage = (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.ok === 1) {
      connected = true;
      return;
    }
    if (typeof data.c === 'string' && data.n === undefined) {
      const nonce = randomBytes(16).toString('hex');
      channel.port1.postMessage({ c: data.c, n: nonce, m1: bridgeMac('reply', key, data.c, nonce) });
      return;
    }
    if (typeof data.kind === 'string') frames.push(data);
  };
  channel.port1.start();

  window.postMessage({}, window.location.origin, [channel.port2]);

  return {
    frames,
    channel,
    isConnected: () => connected,
    sendConfig(config) {
      const seq = ++outSeq;
      const tag = JSON.stringify({ media: config.media, catchUp: config.catchUp });
      channel.port1.postMessage({
        type: 'config',
        media: config.media,
        catchUp: config.catchUp,
        seq,
        mac: bridgeMac('c2h', key, String(seq), 'config', tag),
      });
    },
  };
}
