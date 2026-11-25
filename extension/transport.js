import { beginAction, setConnection, setOn } from './status.js';
import { checkPower, flipPower, isOn, offError, powerReady } from './power.js';

export const PROTOCOL = 1;
export const version = chrome.runtime.getManifest().version;
export const browser = navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] ?? navigator.userAgent;
const host = 'dev.majesticlabs.pi_browser';
const alarm = 'native-reconnect';

function mismatch(peer) {
  return `Pi Browser protocol mismatch: extension ${PROTOCOL}, peer ${peer}. Reload the extension in chrome://extensions and run /reload in Pi.`;
}

export function startTransport({ request, rename, end, resume, detach }) {
  let connection;
  let retry;
  let delay = 1000;
  const queues = new Map();

  function enqueue(session, fn) {
    const next = (queues.get(session) ?? Promise.resolve()).then(fn).catch(console.warn);
    queues.set(session, next);
    void next.then(() => { if (queues.get(session) === next) queues.delete(session); });
  }

  function disconnect(conn, message) {
    if (connection !== conn) return;
    connection = undefined;
    clearTimeout(conn.handshake);
    for (const session of conn.sessions.keys()) enqueue(session, () => end(session));
    conn.sessions.clear();
    setConnection(null, message);
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  }

  function deliver(conn, session, message, peer) {
    if (connection === conn && (!peer || conn.sessions.get(session) === peer)) conn.port.postMessage({ session, message });
  }

  function sessionMessage(conn, session, message) {
    const peer = conn.sessions.get(session);
    if (!peer || !message || typeof message !== 'object') return;
    if (message.hello) {
      if (message.hello.protocol !== PROTOCOL) {
        deliver(conn, session, { error: { message: mismatch(message.hello.protocol) } });
        return;
      }
      peer.ready = true;
      peer.name = typeof message.hello.name === 'string' ? message.hello.name : session;
      enqueue(session, () => rename(session, peer.name));
    } else if (message.error?.message && message.id == null) {
      setConnection(conn.sessions.values(), message.error.message);
    } else if (peer.ready && Number.isSafeInteger(message.id) && typeof message.method === 'string') {
      const name = typeof message.name === 'string' ? message.name : peer.name;
      const { id, method, params = {}, allowed } = message;
      const on = isOn();
      if (!on && method !== 'status') {
        const { code, message } = offError();
        deliver(conn, session, { id, error: { code, message } }, peer);
        return;
      }
      const respond = async () => {
        if (connection !== conn || conn.sessions.get(session) !== peer) return;
        const finish = beginAction(peer);
        try {
          if (method !== 'status') checkPower();
          if (isOn()) await rename(session, name);
          if (method !== 'status') checkPower();
          const result = await request({ session, name, method, params, allowed, count: conn.sessions.size });
          deliver(conn, session, { id, result }, peer);
        } catch (error) {
          const { code, host, acted } = error;
          deliver(conn, session, { id, error: { message: error.message, code, host, acted } }, peer);
        } finally {
          finish();
        }
      };
      if (!on) void respond();
      else enqueue(session, respond);
    }
  }

  function receive(conn, packet) {
    if (connection !== conn || !packet || typeof packet !== 'object') return;
    if (!conn.ready) {
      if (packet.hello?.protocol !== PROTOCOL) {
        const message = packet.error?.message ?? mismatch(packet.hello?.protocol);
        disconnect(conn, message);
        conn.port.disconnect();
        return;
      }
      clearTimeout(conn.handshake);
      conn.ready = true;
      delay = 1000;
      setConnection(conn.sessions.values());
      return;
    }
    const { session, open, message } = packet;
    if (typeof session !== 'string' || !session) return;
    if (open === true && !conn.sessions.has(session)) {
      conn.sessions.set(session, { ready: false });
      setConnection(conn.sessions.values());
      deliver(conn, session, { hello: { protocol: PROTOCOL, extension: version, browser, on: isOn() } });
    } else if (open === false && conn.sessions.delete(session)) {
      setConnection(conn.sessions.values());
      enqueue(session, () => end(session));
    } else {
      sessionMessage(conn, session, message);
    }
  }

  function connect() {
    if (connection) return;
    clearTimeout(retry);
    const port = chrome.runtime.connectNative(host);
    const conn = { port, ready: false, sessions: new Map() };
    connection = conn;
    port.onMessage.addListener(packet => receive(conn, packet));
    port.onDisconnect.addListener(() => disconnect(conn, chrome.runtime.lastError?.message ?? 'native host disconnected'));
    conn.handshake = setTimeout(() => {
      disconnect(conn, 'native host handshake timed out');
      port.disconnect();
    }, 10_000);
    port.postMessage({ hello: { protocol: PROTOCOL } });
  }

  const ready = powerReady.then(() => { setOn(isOn()); });
  const wake = () => { void ready.then(connect).catch(console.warn); };
  chrome.runtime.onStartup.addListener(wake);
  chrome.runtime.onInstalled.addListener(wake);
  chrome.alarms.onAlarm.addListener(({ name }) => { if (name === alarm) wake(); });
  void chrome.alarms.create(alarm, { periodInMinutes: 1 }).catch(console.warn);
  wake();

  let toggling = ready;
  return function handleToolbarClick() {
    toggling = toggling.then(async () => {
      const on = await flipPower();
      setOn(on);
      if (connection) {
        for (const session of connection.sessions.keys()) deliver(connection, session, { state: { on } });
      }
      if (on) {
        const resumed = resume();
        connect();
        await resumed;
      } else {
        await detach();
      }
    }).catch(console.warn);
    return toggling;
  };
}
