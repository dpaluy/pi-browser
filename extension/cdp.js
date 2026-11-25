import { coversHost, webHost } from './allowed.js';
import { checkPower, offError } from './power.js';

const tabs = new Map();
const blockedKey = 'debuggerCanceled';
let blocked = chrome.storage.session.get(blockedKey).then(data => Boolean(data[blockedKey]));
const canceledMessage = 'The debugger was canceled by the user. Turn Pi Browser off and on again with its toolbar icon to resume.';
const commandTimeout = 10_000;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function command(tabId, method, params = {}, timeout = commandTimeout, sessionId) {
  const target = { tabId, ...(sessionId ? { sessionId } : {}) };
  return withTimeout(chrome.debugger.sendCommand(target, method, params), timeout, `${method} timed out.`);
}

export async function checkDebugger() {
  const canceled = await blocked;
  checkPower();
  if (canceled) throw new Error(canceledMessage);
}

export function resumeDebugger() {
  blocked = Promise.resolve(false);
  return chrome.storage.session.remove(blockedKey);
}

function failTab(state, error) {
  state.failure = error;
  for (const abort of state.aborts) abort(state.failure);
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (reason === 'canceled_by_user') {
    blocked = Promise.resolve(true);
    void chrome.storage.session.set({ [blockedKey]: true }).catch(console.warn);
  }
  const state = tabs.get(tabId);
  if (!state) return;
  if (!state.detaching) {
    failTab(state, new Error(reason === 'canceled_by_user' ? canceledMessage : `Debugger detached from tab ${tabId}: ${reason}.`));
    tabs.delete(tabId);
  }
});

export async function detach(tabId, error = new Error(`Tab ${tabId} is not in your group.`)) {
  const state = tabs.get(tabId);
  if (!state) return;
  if (state.detaching) return state.detaching;
  failTab(state, error);
  state.detaching = (async () => {
    try {
      await state.attached;
      await withTimeout(chrome.debugger.detach({ tabId }), commandTimeout, 'Debugger detach timed out.');
    } catch {
      // Chrome already detached, or attach failed.
    } finally {
      if (tabs.get(tabId) === state) tabs.delete(tabId);
    }
  })();
  return state.detaching;
}

export function detachAll() {
  return Promise.all([...tabs.keys()].map(id => detach(id, offError())));
}

export function detachSession(session) {
  return Promise.all([...tabs].filter(([, state]) => state.session === session).map(([id]) => detach(id)));
}

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  const state = tabs.get(tabId);
  if (state && changes.groupId != null && changes.groupId !== state.groupId) void detach(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => { void detach(tabId); });

function append(items, item) {
  if (items.length === 200) items.shift();
  items.push(item);
}

function consoleLine(state, text) {
  append(state.console, text.slice(0, 1000));
}

function pageChanged(state) {
  state.generation++;
  state.refs.clear();
  state.screenshot = undefined;
  state.console.length = 0;
}

function frameOrigin(frame, parentOrigin) {
  const origin = frame.securityOrigin;
  if (origin && origin !== '://' && origin !== 'null') return origin;
  if (frame.url === 'about:blank' || frame.url === 'about:srcdoc') return parentOrigin;
  try { return new URL(frame.url).origin; } catch { return undefined; }
}

function rememberTree(state, tree, parentOrigin) {
  if (!tree) return;
  const origin = frameOrigin(tree.frame, parentOrigin);
  state.origins.set(tree.frame.id, origin);
  for (const child of tree.childFrames ?? []) rememberTree(state, child, origin);
}

function dialogError(state) {
  const dialog = state.dialog;
  const host = webHost(dialog.url);
  if (host && !coversHost(state.allowed, host)) {
    return Object.assign(new Error(`Approval is required to use ${host}.`), {
      code: 'needs-approval', host, acted: true,
    });
  }
  return new Error(`The page opened a ${dialog.type} dialog ("${dialog.message}"); answer it in the browser, then try again.`);
}

function onPageEvent(state, method, p, target) {
  if (method === 'Page.frameNavigated' && target && p.frame.id === target.frameId) {
    target.tree = { frame: p.frame };
    rememberTree(state, target.tree, state.origins.get(target.parentFrameId));
  } else if (method === 'Page.frameNavigated' && !p.frame.parentId) {
    state.main = p.frame;
    rememberTree(state, { frame: p.frame });
    pageChanged(state);
    state.commits++;
  } else if (!target && method === 'Page.frameNavigated') {
    rememberTree(state, { frame: p.frame }, state.origins.get(p.frame.parentId));
  } else if (method === 'Page.navigatedWithinDocument' && p.frameId === state.main?.id) {
    state.main = { ...state.main, url: p.url, urlFragment: undefined };
    pageChanged(state);
    state.commits++;
    state.sameDocumentCommit = state.commits;
  } else if (method === 'Page.frameStartedLoading' && p.frameId === state.main?.id) {
    state.starts++;
  } else if (method === 'Page.lifecycleEvent' && p.frameId === state.main?.id && p.name === 'load') {
    state.loaded = p.loaderId;
  } else if (method === 'Page.javascriptDialogOpening') {
    state.dialog = p;
    const error = dialogError(state);
    for (const abort of state.aborts) abort(error);
  } else if (method === 'Page.javascriptDialogClosed') {
    state.dialog = undefined;
  }
}

function onNetworkEvent(state, method, p, target) {
  if (method === 'Network.requestWillBeSent') {
    const previous = state.inFlight.get(p.requestId);
    if (previous && p.redirectResponse) previous.status = p.redirectResponse.status;
    let origin;
    try { origin = new URL(p.documentURL).origin; } catch {}
    if (!origin) origin = p.frameId ? state.origins.get(p.frameId) : target?.tree ? frameOrigin(target.tree.frame) : undefined;
    const request = { method: p.request.method, url: p.request.url, type: p.type ?? 'Other', status: 'pending', origin };
    state.inFlight.set(p.requestId, request);
    append(state.network, request);
  } else if (method === 'Network.responseReceived') {
    const request = state.inFlight.get(p.requestId);
    if (request) Object.assign(request, { status: p.response.status, type: p.type });
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const request = state.inFlight.get(p.requestId);
    if (request && method === 'Network.loadingFailed') request.status = 'failed';
    state.inFlight.delete(p.requestId);
  } else {
    return;
  }
  state.networkChanged = Date.now();
}

const autoAttach = {
  autoAttach: true, flatten: true, waitForDebuggerOnStart: true,
  filter: [{ type: 'iframe' }],
};

function attachFrame(id, state, sessionId, info) {
  const target = {
    frameId: info.targetId, parentFrameId: info.parentFrameId, sessionId,
    tree: { frame: { id: info.targetId, url: info.url, securityOrigin: '' } },
  };
  state.targets.set(sessionId, target);
  target.ready = (async () => {
    const send = (method, params) => command(id, method, params, commandTimeout, sessionId);
    await send('Page.enable');
    await send('Network.enable');
    await send('Target.setAutoAttach', autoAttach);
    target.tree = (await send('Page.getFrameTree')).frameTree;
    rememberTree(state, target.tree, state.origins.get(target.parentFrameId));
    await send('Runtime.runIfWaitingForDebugger');
  })().catch(error => { failTab(state, `Could not attach to frame ${target.frameId}: ${error.message}`); });
}

chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, p) => {
  const state = tabs.get(tabId);
  if (!state || state.failure) return;
  if (method === 'Target.attachedToTarget' && p.targetInfo.type === 'iframe') {
    attachFrame(tabId, state, p.sessionId, p.targetInfo);
  } else if (method === 'Target.detachedFromTarget') {
    state.targets.delete(p.sessionId);
  }
  const target = sessionId ? state.targets.get(sessionId) : undefined;
  if (method.startsWith('Page.')) onPageEvent(state, method, p, target);
  if (method.startsWith('Network.')) onNetworkEvent(state, method, p, target);
  if (!sessionId && method === 'Runtime.consoleAPICalled') {
    consoleLine(state, `${p.type}: ${p.args.map(arg => typeof arg.value === 'string' ? arg.value : arg.description ?? JSON.stringify(arg.value) ?? arg.type).join(' ')}`);
  } else if (!sessionId && method === 'Runtime.exceptionThrown') {
    consoleLine(state, p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  } else if (!sessionId && method === 'Log.entryAdded') {
    consoleLine(state, `${p.entry.level}: ${p.entry.text}`);
  }
  for (const listener of state.listeners) listener(method, p);
});

async function initialize(id, state) {
  const send = (method, params) => command(id, method, params);
  await state.attached;
  for (const domain of ['Page', 'Network', 'DOM', 'Accessibility']) await send(`${domain}.enable`);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const tree = (await send('Page.getFrameTree')).frameTree;
  state.main = tree.frame;
  rememberTree(state, tree);
  await send('Target.setAutoAttach', autoAttach);
  await send('Page.setLifecycleEventsEnabled', { enabled: true });
}

async function attach(tab, session) {
  await checkDebugger();
  const id = tab.id;
  let state = tabs.get(id);
  if (state && (state.detaching || state.session !== session || state.groupId !== tab.groupId)) {
    await detach(id);
    state = tabs.get(id);
  }
  checkPower();
  if (!state) {
    state = {
      session, groupId: tab.groupId, refs: new Map(), listeners: new Set(), aborts: new Set(),
      network: [], console: [], inFlight: new Map(), networkChanged: Date.now(),
      targets: new Map(), origins: new Map(), allowed: new Set(),
      generation: 0, starts: 0, commits: 0,
    };
    tabs.set(id, state);
    state.attached = withTimeout(chrome.debugger.attach({ tabId: id }, '1.3'), commandTimeout, 'Debugger attach timed out.');
    state.ready = initialize(id, state).catch(async error => {
      const failure = state.failure ?? error;
      await detach(id);
      throw failure;
    });
  }
  await state.ready;
  return state;
}

export async function withTab(tab, session, fn) {
  const state = await attach(tab, session);
  const id = tab.id;
  let failure;
  let reject;
  const stopped = new Promise((_, fail) => { reject = fail; });
  const abort = error => { failure = error; reject(error); };
  function check() {
    const error = failure ?? state.failure ?? (state.dialog ? dialogError(state) : undefined);
    if (error) throw error;
  }
  const send = async (method, params, timeout) => {
    check();
    const result = await command(id, method, params, timeout);
    check();
    return result;
  };
  state.aborts.add(abort);
  try {
    return await Promise.race([stopped, (async () => {
      check();
      return fn({ id, state, send, check, cleanup: (method, params) => command(id, method, params) });
    })()]);
  } finally {
    state.aborts.delete(abort);
  }
}

export async function frameTree(ctx) {
  const root = (await ctx.send('Page.getFrameTree')).frameTree;
  const targets = [...ctx.state.targets.values()];
  await Promise.all(targets.map(target => target.ready));
  ctx.check();
  function assemble(tree) {
    const remote = targets.filter(target => target.parentFrameId === tree.frame.id).map(target => target.tree);
    const childFrames = [...(tree.childFrames ?? []), ...remote].map(assemble);
    return { ...tree, ...(childFrames.length ? { childFrames } : {}) };
  }
  const tree = assemble(root);
  rememberTree(ctx.state, tree);
  return tree;
}

export async function world(ctx, frameId) {
  const { executionContextId } = await ctx.send('Page.createIsolatedWorld', { frameId, worldName: 'Pi Browser' });
  return executionContextId;
}

export function runtimeValue(response) {
  if (response.exceptionDetails) {
    const { exception, text } = response.exceptionDetails;
    throw new Error(exception?.description ?? text);
  }
  return response.result.value;
}

export async function evaluatePage(ctx, fn) {
  const contextId = await world(ctx, ctx.tree.frame.id);
  return runtimeValue(await ctx.send('Runtime.evaluate', {
    expression: `(${fn})()`, contextId, returnByValue: true,
  }));
}

export async function release(ctx, objectId) {
  await ctx.cleanup('Runtime.releaseObject', { objectId }).catch(() => {});
}

export async function objectFor(ctx, ref, frameId) {
  const executionContextId = await world(ctx, frameId);
  const { object } = await ctx.send('DOM.resolveNode', { backendNodeId: ref, executionContextId });
  return object.objectId;
}

export async function onNode(ctx, ref, frameId, fn, ...args) {
  const objectId = await objectFor(ctx, ref, frameId);
  try {
    return runtimeValue(await ctx.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true,
    }));
  } finally {
    await release(ctx, objectId);
  }
}
