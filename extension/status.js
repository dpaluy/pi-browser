const sizes = [16, 32, 48, 128];
const minWorkingMs = 400;
let sessions;
let error;
let on = true;
const running = new Set();
let workingUntil = 0;
let idleTimer;
let requestedIcon;
let appliedIcon;
let iconUpdate = Promise.resolve();

Object.defineProperty(globalThis, 'piBrowserIconState', { get: () => appliedIcon });
void chrome.action.setBadgeBackgroundColor({ color: '#152338' }).catch(console.warn);

function renderIcon() {
  clearTimeout(idleTimer);
  const now = performance.now();
  let state = !on ? 'disabled' : !sessions || error ? 'off' : sessions.size ? 'active' : 'ready';
  if (state === 'active' && (running.size || now < workingUntil)) {
    if (!workingUntil) workingUntil = now + minWorkingMs;
    state = 'working';
    if (!running.size) idleTimer = setTimeout(renderIcon, workingUntil - now);
  } else {
    workingUntil = 0;
  }

  if (state === requestedIcon) return;
  requestedIcon = state;
  const path = Object.fromEntries(sizes.map(size => [size, `icons/${state}-${size}.png`]));
  // setIcon loads the PNGs asynchronously. Keep rapid updates in transition order.
  iconUpdate = iconUpdate.then(async () => {
    await chrome.action.setIcon({ path });
    appliedIcon = state;
  }).catch(console.warn);
}

export function setConnection(peers, message) {
  sessions = peers && new Set(peers);
  error = message;
  // Peers are unique to their connection; a late completion cannot end a new peer's action.
  for (const peer of running) if (!sessions?.has(peer)) running.delete(peer);
  renderToolbar();
}

export function setOn(value) {
  on = value;
  renderToolbar();
}

function renderToolbar() {
  const count = sessions?.size ?? 0;
  const summary = error ?? (count ? `${count} ${count === 1 ? 'session' : 'sessions'}` : sessions && 'connected');
  const prefix = summary ? `Pi Browser: ${summary}` : 'Pi Browser';
  const title = on ? `${prefix} — click to turn off` : 'Pi Browser: off — click to turn on';
  void chrome.action.setTitle({ title }).catch(console.warn);
  void chrome.action.setBadgeText({ text: on && count && !error ? String(count) : '' }).catch(console.warn);
  renderIcon();
}

export function beginAction(peer) {
  running.add(peer);
  renderIcon();
  return () => { if (running.delete(peer)) renderIcon(); };
}
