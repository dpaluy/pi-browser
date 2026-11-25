import * as groups from './groups.js';
import { checkDebugger, evaluatePage, frameTree, runtimeValue, sleep, withTab } from './cdp.js';
import { browser, version } from './transport.js';
import { frameURL, snapshot } from './snapshot.js';
import * as input from './input.js';
import { allowedHosts, coversHost, webHost } from './allowed.js';
import { checkPower } from './power.js';

function requireWebHost(value) {
  const host = webHost(value);
  if (!host) throw new Error('Only http: and https: pages are supported.');
  return host;
}

function authorize(host, allowed, acted) {
  if (!coversHost(allowed, host)) throw Object.assign(new Error(`Approval is required to use ${host}.`), {
    code: 'needs-approval', host, acted,
  });
}

function configure(ctx, allowed, method) {
  ctx.acted = false;
  ctx.refresh = async () => {
    const tab = await chrome.tabs.get(ctx.id);
    if (tab.groupId !== ctx.state.groupId) throw new Error(`Tab ${ctx.id} is not in your group.`);
    ctx.tree = await frameTree(ctx);
    const url = ctx.tree.frame.url;
    if (!(method === 'navigate' && url === 'about:blank' && !ctx.state.commits)) {
      authorize(requireWebHost(url), allowed, ctx.acted);
    }
  };
  ctx.allowed = allowed;
  ctx.state.allowed = allowed;
  ctx.approveFrame = (frame, parent) => {
    if (!frame) throw new Error('Cannot determine the frame for this action.');
    if (frame.url === 'about:blank' || frame.url === 'about:srcdoc') {
      if (parent) return ctx.approveFrame(parent);
      return;
    }
    const origin = frame.securityOrigin;
    if (!origin || origin === 'null' || origin === '://') throw new Error('Cannot determine the frame origin for this action.');
    authorize(requireWebHost(origin), allowed, ctx.acted);
  };
  ctx.method = method;
}

async function header(ctx, pendingURL) {
  const { title = '' } = await chrome.tabs.get(ctx.id);
  await ctx.refresh();
  const url = frameURL(ctx.tree.frame);
  return url === 'about:blank' && pendingURL ? `Tab ${ctx.id}:  <${pendingURL}>` : `Tab ${ctx.id}: ${title} <${url}>`;
}

function marker(state) {
  return { starts: state.starts, commits: state.commits };
}

async function loaded(ctx, before, deadline, loaderId) {
  const { state } = ctx;
  for (;;) {
    await ctx.refresh();
    const committed = state.commits > before.commits;
    if (committed && state.commits === state.sameDocumentCommit && !loaderId) return true;
    if ((loaderId || committed) && state.loaded === ctx.tree.frame.loaderId &&
        (committed || ctx.tree.frame.loaderId === loaderId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

async function navigate(ctx, { url }) {
  const before = marker(ctx.state);
  const deadline = Date.now() + 15_000;
  ctx.acted = true;
  let response;
  try {
    response = await ctx.send('Page.navigate', { url }, 15_000);
  } catch (error) {
    if (error.message !== 'Page.navigate timed out.') throw error;
    return `${await header(ctx, url)} (still loading)`;
  }
  const { loaderId, errorText, isDownload } = response;
  if (errorText) throw new Error(errorText);
  const complete = !loaderId || isDownload || await loaded(ctx, before, deadline, loaderId);
  return (await header(ctx, url)) + (complete ? '' : ' (still loading)');
}

async function history(ctx, direction) {
  const before = marker(ctx.state);
  const deadline = Date.now() + 15_000;
  if (direction === 'reload') {
    ctx.acted = true;
    await ctx.send('Page.reload');
  } else {
    const { currentIndex, entries } = await ctx.send('Page.getNavigationHistory');
    const index = currentIndex + (direction === 'back' ? -1 : 1);
    if (!entries[index] || (index === 0 && entries[index].url === 'about:blank')) throw new Error(`Tab ${ctx.id} has no page to go ${direction} to.`);
    requireWebHost(entries[index].url);
    ctx.acted = true;
    await ctx.send('Page.navigateToHistoryEntry', { entryId: entries[index].id });
  }
  const complete = await loaded(ctx, before, deadline);
  return (await header(ctx)) + (complete ? '' : ' (still loading)');
}

async function click(ctx, params) {
  const before = marker(ctx.state);
  const text = await input.click(ctx, params);
  // Renderer-initiated navigation can start just after the mouse command returns.
  await sleep(100);
  if (ctx.state.starts > before.starts || ctx.state.commits > before.commits) await loaded(ctx, before, Date.now() + 15_000);
  return text;
}

async function wait(ctx, { text, gone, timeout = 10_000 }) {
  const deadline = Date.now() + timeout;
  const needle = (typeof gone === 'string' ? gone : text)?.toLowerCase();
  for (;;) {
    await ctx.refresh();
    if (needle) {
      const body = await evaluatePage(ctx, () => document.body?.innerText ?? '');
      if (body.toLowerCase().includes(needle) !== Boolean(gone)) return 'Wait condition met.';
    } else {
      const ready = await evaluatePage(ctx, () => document.readyState);
      if (ready === 'complete' && !ctx.state.inFlight.size && Date.now() - ctx.state.networkChanged >= 500) {
        return 'Page is ready.';
      }
    }
    if (Date.now() >= deadline) throw new Error('Wait timed out.');
    await sleep(Math.min(200, deadline - Date.now()));
  }
}

function captureScale(width, height, maxScale) {
  return Math.min(maxScale, 1568 / Math.max(width, height), Math.sqrt(1_150_000 / (width * height)));
}

async function capture(ctx, viewport, clip, maxScale) {
  const generation = ctx.state.generation;
  const scale = captureScale(clip.width, clip.height, maxScale);
  const width = Math.max(1, Math.floor(clip.width * scale));
  const height = Math.max(1, Math.floor(clip.height * scale));
  const { data } = await ctx.send('Page.captureScreenshot', {
    format: 'jpeg', quality: 80, fromSurface: true, captureBeyondViewport: true, clip: { ...clip, scale },
  });
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], { type: 'image/jpeg' }));
  let jpeg = data;
  try {
    // Surface capture also includes the browser's device scale factor.
    if (bitmap.width !== width || bitmap.height !== height) {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      jpeg = btoa(binary);
    }
  } finally {
    bitmap.close();
  }
  await ctx.refresh();
  if (generation !== ctx.state.generation) throw new Error('The page navigated during capture; take another screenshot.');
  ctx.state.screenshot = {
    scale, viewport, scroll: { x: viewport.pageX, y: viewport.pageY }, width, height, clip,
    offsetX: clip.x - viewport.pageX, offsetY: clip.y - viewport.pageY,
  };
  return { text: `${ctx.method === 'zoom' ? 'Zoom' : 'Screenshot'} of tab ${ctx.id} (${width} × ${height}).`, image: { data: jpeg, mimeType: 'image/jpeg', width, height } };
}

async function screenshot(ctx) {
  const { cssVisualViewport: viewport } = await ctx.send('Page.getLayoutMetrics');
  return capture(ctx, viewport, { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight }, 1);
}

async function zoom(ctx, { region }) {
  const shot = ctx.state.screenshot;
  if (!shot) throw new Error('Take a screenshot first; regions are in its pixels.');
  const [x, y, width, height] = region;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > shot.width || y + height > shot.height) {
    throw new Error('Region is outside the screenshot.');
  }
  const { cssVisualViewport: viewport } = await ctx.send('Page.getLayoutMetrics');
  return capture(ctx, viewport, { x: shot.clip.x + x / shot.scale, y: shot.clip.y + y / shot.scale, width: width / shot.scale, height: height / shot.scale }, 4);
}

async function consoleMessages(ctx) {
  if (!ctx.state.consoleEnabled) {
    await ctx.send('Runtime.enable');
    await ctx.send('Log.enable');
    ctx.state.consoleEnabled = true;
  }
  return ctx.state.console.join('\n');
}

async function evalCode(ctx, { code }) {
  ctx.acted = true;
  const response = await ctx.send('Runtime.evaluate', {
    expression: code, replMode: true, awaitPromise: true, returnByValue: true, timeout: 10_000,
  });
  return JSON.stringify(runtimeValue(response)) ?? response.result.unserializableValue ?? 'undefined';
}

function dataURL(value) {
  const match = /^data:([^,]*),(.*)$/s.exec(value);
  if (!match) return value;
  const parts = match[1].split(';');
  const base64 = parts.at(-1) === 'base64';
  const mime = parts[0] || 'text/plain';
  let bytes;
  if (base64) bytes = atob(match[2]).length;
  else bytes = new TextEncoder().encode(decodeURIComponent(match[2])).length;
  return `data:${mime} (${bytes} bytes)`;
}

function network(ctx) {
  const lines = [];
  let hidden = 0;
  for (const { method, status, type, url, origin } of ctx.state.network) {
    const data = url.startsWith('data:');
    if (!coversHost(ctx.allowed, webHost(origin)) || (!data && !coversHost(ctx.allowed, webHost(url)))) hidden++;
    else lines.push(`${method} ${status} ${type} ${data ? dataURL(url) : url}`);
  }
  if (hidden) lines.push(`${hidden} requests to sites you haven't approved are hidden.`);
  return lines.join('\n');
}

const handlers = {
  navigate, back: ctx => history(ctx, 'back'), forward: ctx => history(ctx, 'forward'), reload: ctx => history(ctx, 'reload'),
  read: async ctx => snapshot(ctx, await header(ctx), ctx.tree),
  click, hover: input.hover, drag: input.drag, type: input.type, keys: input.keys, scroll: input.scroll, fill: input.fill,
  select: async (ctx, { ref, values }) => { await input.choose(ctx, ref, values); return `Selected ${values.length} option${values.length === 1 ? '' : 's'}.`; },
  upload: input.upload, wait, screenshot, zoom, console: consoleMessages,
  network,
  eval: evalCode,
};

const isTuple = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const isRef = ref => Number.isSafeInteger(ref) && ref > 0;
const strings = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string');

function validate(method, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid action params.');
  if (p.tabId != null && !Number.isSafeInteger(p.tabId)) throw new Error('Invalid tabId.');
  if (p.ref != null && !isRef(p.ref)) throw new Error('Invalid ref.');
  if (['click', 'scroll'].includes(method) && p.ref == null || ['hover', 'drag'].includes(method)) {
    if (!isTuple(p.point, 2)) throw new Error('Expected point [x, y].');
  }
  if (method === 'drag' && !isTuple(p.to, 2)) throw new Error('Expected destination [x, y].');
  if (method === 'scroll' && p.ref == null && !isTuple(p.delta, 2)) throw new Error('Expected scroll delta [x, y].');
  if (method === 'zoom' && !isTuple(p.region, 4)) throw new Error('Expected region [x, y, width, height].');
  if (method === 'click') {
    if (p.button != null && !['left', 'middle', 'right', 'back', 'forward'].includes(p.button)) throw new Error('Invalid mouse button.');
    if (p.clickCount != null && (!Number.isSafeInteger(p.clickCount) || p.clickCount <= 0)) throw new Error('Invalid clickCount.');
  }
  if (['select', 'upload'].includes(method) && !isRef(p.ref)) throw new Error('A ref is required.');
  if (method === 'select' && !strings(p.values)) throw new Error('Expected option values.');
  if (method === 'upload' && !strings(p.paths)) throw new Error('Expected file paths.');
  if (method === 'fill' && (!Array.isArray(p.fields) || !p.fields.length || p.fields.some(f => !isRef(f?.ref) || typeof f.value !== 'string'))) throw new Error('Expected fields with a ref and string value.');
  if (method === 'type' && typeof p.text !== 'string') throw new Error('Expected text to type.');
  if (method === 'keys' && (typeof p.keys !== 'string' || !p.keys.trim())) throw new Error('Expected keys.');
  if (method === 'eval' && typeof p.code !== 'string') throw new Error('Expected code.');
  if (method === 'navigate' && (typeof p.url !== 'string' || p.newTab != null && typeof p.newTab !== 'boolean')) throw new Error('Expected a URL and optional newTab flag.');
  if (method === 'wait' && (p.timeout != null && (!Number.isFinite(p.timeout) || p.timeout < 0) || p.text != null && typeof p.text !== 'string' || p.gone != null && typeof p.gone !== 'boolean' && typeof p.gone !== 'string')) throw new Error('Invalid wait params.');
}

async function getTab(session, name, method, params) {
  if (method === 'navigate') {
    if (params.newTab && params.tabId != null) await groups.tabFor(session, params.tabId);
    if (params.newTab || (params.tabId == null && !(await groups.list(session)).tabs.length)) {
      return groups.createTab(session, name);
    }
  }
  return groups.tabFor(session, params.tabId);
}

export async function request({ session, name, method, params = {}, allowed, count = 0 }) {
  if (method === 'status') return { text: `Pi Browser ${version} · ${browser} · ${count} ${count === 1 ? 'session' : 'sessions'}` };
  if (method === 'tabs') return groups.list(session);
  if (method !== 'close' && !Object.hasOwn(handlers, method)) throw new Error(`Unknown browser method: ${method}.`);
  validate(method, params);
  await checkDebugger();
  const hosts = allowedHosts(allowed);
  if (method === 'navigate') authorize(requireWebHost(params.url), hosts, false);
  const tab = await getTab(session, name, method, params);
  const response = await groups.action(session, () => withTab(tab, session, async ctx => {
    configure(ctx, hosts, method);
    await ctx.refresh();
    if (method === 'close') return;
    try {
      const result = await handlers[method](ctx, params);
      await ctx.refresh();
      await groups.touch(session, tab.id);
      return typeof result === 'string' ? { text: result } : result;
    } catch (error) {
      if (ctx.acted) await groups.touch(session, tab.id);
      if (error.code !== 'needs-approval') await ctx.refresh();
      throw error;
    }
  }));
  if (method !== 'close') return response;
  await groups.tabFor(session, tab.id);
  checkPower();
  await chrome.tabs.remove(tab.id);
  return { text: `Closed tab ${tab.id}.` };
}
