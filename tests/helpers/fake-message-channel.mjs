/**
 * Minimal MessageChannel + window.postMessage shim for jsdom.
 *
 * jsdom has no MessageChannel/MessagePort and its postMessage drops the
 * transfer list. These fakes let the tests exercise the private bridge path
 * that production Chrome uses.
 */
export class FakePort {
  constructor() {
    this._onmessage = null;
    this._peer = null;
    this._closed = false;
    this.sent = [];
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(handler) {
    this._onmessage = handler;
  }

  start() {}

  close() {
    this._closed = true;
  }

  postMessage(data, transfer) {
    if (this._closed) return;
    const peer = this._peer;
    this.sent.push({ data, transfer: transfer || [] });
    if (!peer || peer._closed) return;
    setTimeout(() => {
      if (this._closed || peer._closed) return;
      if (typeof peer.onmessage === 'function') peer.onmessage({ data, ports: transfer || [] });
    }, 0);
  }
}

export class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
    FakeMessageChannel.instances.push(this);
  }
}

// Every channel created inside the jsdom window, in creation order, so tests
// can inspect both ends' traffic.
FakeMessageChannel.instances = [];

export function installWindowPostMessage(window) {
  const calls = [];
  window.MessageChannel = FakeMessageChannel;
  window.MessagePort = FakePort;
  window.postMessage = (message, targetOrigin, transfer) => {
    const ports = transfer || [];
    calls.push({ message, targetOrigin, ports });
    const event = new window.MessageEvent('message', {
      data: message,
      origin: window.location.origin,
      source: window,
      ports,
    });
    setTimeout(() => window.dispatchEvent(event), 0);
  };
  return calls;
}
