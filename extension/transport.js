export const PROTOCOL = 1;
export const version = chrome.runtime.getManifest().version;
export const browser = navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] ?? navigator.userAgent;
const host = 'dev.majesticlabs.pi_browser';
const alarm = 'native-reconnect';

function mismatch(peer) {
  return `Pi Browser protocol mismatch: extension ${PROTOCOL}, peer ${peer}. Reload the extension in chrome://extensions and run /reload in Pi.`;
}

export function startTransport({ request, rename, end, resume }) {
  let connection;
  let retry;
  let delay = 1000;
  const queues = new Map();

  function title(message) {
    void chrome.action.setTitle({ title: `Pi Browser: ${message}` }).catch(console.warn);
  }

  function readyTitle({ sessions }) {
    title(sessions.size ? `${sessions.size} sessions` : 'connected');
  }

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
    title(message);
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
      title(message.error.message);
    } else if (peer.ready && Number.isSafeInteger(message.id) && typeof message.method === 'string') {
      const name = typeof message.name === 'string' ? message.name : peer.name;
      const { id, method, params = {}, allowed } = message;
      enqueue(session, async () => {
        if (connection !== conn || conn.sessions.get(session) !== peer) return;
        try {
          await rename(session, name);
          const result = await request({ session, name, method, params, allowed, count: conn.sessions.size });
          deliver(conn, session, { id, result }, peer);
        } catch (error) {
          const { code, host, acted } = error;
          deliver(conn, session, { id, error: { message: error.message, code, host, acted } }, peer);
        }
      });
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
      readyTitle(conn);
      return;
    }
    const { session, open, message } = packet;
    if (typeof session !== 'string' || !session) return;
    if (open === true && !conn.sessions.has(session)) {
      conn.sessions.set(session, { ready: false });
      readyTitle(conn);
      deliver(conn, session, { hello: { protocol: PROTOCOL, extension: version, browser } });
    } else if (open === false && conn.sessions.delete(session)) {
      readyTitle(conn);
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

  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(connect);
  chrome.action.onClicked.addListener(() => { void resume().catch(console.warn); connect(); });
  chrome.alarms.onAlarm.addListener(({ name }) => { if (name === alarm) connect(); });
  void chrome.alarms.create(alarm, { periodInMinutes: 1 }).catch(console.warn);
  connect();
}
