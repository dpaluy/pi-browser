import { objectFor, onNode, release, runtimeValue, sleep, world } from './cdp.js';
import { flattenFrames, isFrame } from './snapshot.js';

export function staleRef(ref) {
  return new Error(`Ref [${ref}] is not on the page anymore; read again.`);
}

function nodeArg(backendNodeId) {
  return { backendNodeId };
}

function locateFrame(tree, id, parent) {
  if (tree.frame.id === id) return { frame: tree.frame, parent };
  for (const child of tree.childFrames ?? []) {
    const found = locateFrame(child, id, tree.frame);
    if (found) return found;
  }
}

export async function resolveRef(ctx, ref) {
  await ctx.refresh();
  const entry = ctx.state.refs.get(ref);
  if (!entry) throw staleRef(ref);
  const found = locateFrame(ctx.tree, entry.frameId);
  if (!found) throw staleRef(ref);
  const { frame, parent } = found;
  ctx.approveFrame(frame, parent);
  try {
    const connected = await onNode(ctx, ref, frame.id, function () { return this.isConnected; });
    if (!connected) throw staleRef(ref);
  } catch (error) {
    ctx.check();
    if (/timed out/.test(error.message)) throw error;
    throw staleRef(ref);
  }
  return frame.id;
}

export function screenshotPoint(ctx, point) {
  const shot = ctx.state.screenshot;
  if (!shot) throw new Error('Take a screenshot first; points are in its pixels.');
  const [x, y] = point;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw new Error('Point is outside the screenshot.');
  }
  return [x / shot.scale + shot.offsetX, y / shot.scale + shot.offsetY];
}

export async function hitTest(ctx, point) {
  await ctx.refresh();
  const { backendNodeId, frameId } = await ctx.send('DOM.getNodeForLocation', { x: Math.floor(point[0]), y: Math.floor(point[1]) });
  const frames = flattenFrames(ctx.tree);
  const frame = frames.find(frame => frame.id === frameId);
  if (!frame) throw new Error('Cannot determine the frame at that point.');
  ctx.approveFrame(frame, locateFrame(ctx.tree, frame.id)?.parent);
  const { node } = await ctx.send('DOM.describeNode', nodeArg(backendNodeId));
  if (isFrame(node)) {
    const child = frames.find(frame => frame.id === node.frameId);
    if (!child) throw new Error('Cannot determine the frame at that point.');
    ctx.approveFrame(child, frame);
  }
  return { backendNodeId, frameId, node };
}

async function nodeName(ctx, ref, node) {
  const { nodes } = await ctx.send('Accessibility.getPartialAXTree', { ...nodeArg(ref), fetchRelatives: false });
  const ax = nodes[0];
  const name = ax?.name?.value;
  if (name) return `${ax.role.value} ${JSON.stringify(name)}`;
  if (!node) ({ node } = await ctx.send('DOM.describeNode', nodeArg(ref)));
  return `<${node.localName || node.nodeName.toLowerCase()}>`;
}

export async function scrollRef(ctx, ref) {
  await resolveRef(ctx, ref);
  await ctx.send('DOM.scrollIntoViewIfNeeded', nodeArg(ref));
}

async function targetsRef(ctx, ref, frameId, hit) {
  if (hit.backendNodeId === ref) return true;
  if (hit.frameId !== frameId) return false;
  const objectId = await objectFor(ctx, ref, frameId);
  const hitId = await objectFor(ctx, hit.backendNodeId, frameId).catch(async error => { await release(ctx, objectId); throw error; });
  try {
    return runtimeValue(await ctx.send('Runtime.callFunctionOn', {
      objectId, arguments: [{ objectId: hitId }], returnByValue: true,
      functionDeclaration: function (hit) {
        for (let element = hit; element; element = element.parentNode ?? element.host) {
          if (element === this || (element.localName === 'label' && element.control === this)) return true;
        }
        return false;
      }.toString(),
    }));
  } finally {
    await Promise.all([release(ctx, hitId), release(ctx, objectId)]);
  }
}

async function pointForRef(ctx, ref) {
  const frameId = await resolveRef(ctx, ref);
  await ctx.send('DOM.scrollIntoViewIfNeeded', nodeArg(ref));
  const { quads } = await ctx.send('DOM.getContentQuads', nodeArg(ref));
  if (!quads.length) throw new Error(`Ref [${ref}] is not visible.`);
  const q = quads[0];
  const point = [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
  const hit = await hitTest(ctx, point);
  if (!await targetsRef(ctx, ref, frameId, hit)) {
    throw new Error(`Ref [${ref}] is covered by ${await nodeName(ctx, hit.backendNodeId, hit.node)}.`);
  }
  return { point, frameId, name: await nodeName(ctx, ref) };
}

const mouse = (ctx, type, [x, y], options) => ctx.send('Input.dispatchMouseEvent', { type, x, y, ...options });
const buttons = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

export async function click(ctx, { ref, point, button = 'left', clickCount = 1 }) {
  let name, frameId;
  if (ref != null) ({ point, frameId, name } = await pointForRef(ctx, ref));
  else {
    point = screenshotPoint(ctx, point);
    const hit = await hitTest(ctx, point);
    name = await nodeName(ctx, hit.backendNodeId, hit.node);
  }
  await mouse(ctx, 'mouseMoved', point);
  for (let count = 1; count <= clickCount; count++) {
    const hit = await hitTest(ctx, point);
    if (ref != null && !await targetsRef(ctx, ref, frameId, hit)) {
      throw new Error(`Ref [${ref}] is covered by ${await nodeName(ctx, hit.backendNodeId, hit.node)}.`);
    }
    ctx.acted = true;
    await mouse(ctx, 'mousePressed', point, { button, buttons: buttons[button], clickCount: count });
    await mouse(ctx, 'mouseReleased', point, { button, clickCount: count });
  }
  return `Clicked ${name}.`;
}

export async function hover(ctx, { point }) {
  point = screenshotPoint(ctx, point);
  const hit = await hitTest(ctx, point);
  const name = await nodeName(ctx, hit.backendNodeId, hit.node);
  ctx.acted = true;
  await mouse(ctx, 'mouseMoved', point);
  return `Hovered over ${name}.`;
}

export async function scroll(ctx, { ref, point, delta }) {
  if (ref != null) {
    await scrollRef(ctx, ref);
    return `Scrolled to [${ref}].`;
  }
  point = screenshotPoint(ctx, point);
  await hitTest(ctx, point);
  ctx.acted = true;
  const [deltaX, deltaY] = delta;
  await mouse(ctx, 'mouseWheel', point, { deltaX, deltaY });
  return 'Scrolled.';
}

export async function drag(ctx, { point, to }) {
  const start = screenshotPoint(ctx, point);
  const end = screenshotPoint(ctx, to);
  const steps = Array.from({ length: 5 }, (_, i) => start.map((n, axis) => n + (end[axis] - n) * (i + 1) / 5));
  for (const p of [start, ...steps]) await hitTest(ctx, p);
  let data;
  let entered = false;
  const listen = (method, event) => { if (method === 'Input.dragIntercepted') data = event.data; };
  const sendDrag = (type, [x, y]) => ctx.send('Input.dispatchDragEvent', { type, x, y, data });
  ctx.state.listeners.add(listen);
  try {
    await ctx.send('Input.setInterceptDrags', { enabled: true });
    await mouse(ctx, 'mouseMoved', start);
    await hitTest(ctx, start);
    ctx.acted = true;
    await mouse(ctx, 'mousePressed', start, { button: 'left', buttons: 1, clickCount: 1 });
    for (const step of steps) {
      await hitTest(ctx, step);
      if (data) {
        if (!entered) await sendDrag('dragEnter', step);
        entered = true;
        await sendDrag('dragOver', step);
      } else {
        await mouse(ctx, 'mouseMoved', step, { button: 'left', buttons: 1 });
      }
    }
    if (data) {
      if (!entered) await sendDrag('dragEnter', end);
      if (!entered) await sendDrag('dragOver', end);
      await sendDrag('drop', end);
    }
    await mouse(ctx, 'mouseReleased', end, { button: 'left', clickCount: 1 });
    return 'Dragged.';
  } finally {
    ctx.state.listeners.delete(listen);
    await ctx.cleanup('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

async function focusedFrame(ctx) {
  await ctx.refresh();
  const contextId = await world(ctx, ctx.tree.frame.id);
  const find = function () {
    let doc = document;
    for (;;) {
      let node = doc.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      if (!node || node === doc.body || node === doc.documentElement) return null;
      if (node.localName !== 'iframe' && node.localName !== 'frame') return doc.URL;
      if (!node.contentDocument) return node;
      doc = node.contentDocument;
    }
  };
  const response = await ctx.send('Runtime.evaluate', { expression: `(${find})()`, contextId });
  const objectId = response.result.objectId;
  if (!objectId) {
    const url = runtimeValue(response);
    if (url) {
      const found = flattenFrames(ctx.tree).map(frame => locateFrame(ctx.tree, frame.id)).find(entry => entry.frame.url === url);
      if (!found) throw new Error('Cannot determine the focused frame.');
      ctx.approveFrame(found.frame, found.parent);
    }
    return Boolean(url);
  }
  try {
    const { node } = await ctx.send('DOM.describeNode', { objectId });
    const found = locateFrame(ctx.tree, node.frameId);
    if (!found) throw new Error('Cannot determine the focused frame.');
    ctx.approveFrame(found.frame, found.parent);
    return true;
  } finally {
    await release(ctx, objectId);
  }
}

async function focus(ctx, ref) {
  const frameId = await resolveRef(ctx, ref);
  await ctx.send('DOM.focus', nodeArg(ref));
  return frameId;
}

export async function type(ctx, { ref, text }) {
  if (ref != null) await focus(ctx, ref);
  if (!await focusedFrame(ctx)) throw new Error('No element is focused.');
  ctx.acted = true;
  await ctx.send('Input.insertText', { text });
  return 'Typed text.';
}

const modifiers = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Shift: 8 };
const namedKeys = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, Space: 32, Alt: 18, Control: 17, Meta: 91, Shift: 16,
};
const editCommands = { a: 'SelectAll', c: 'Copy', v: 'Paste', x: 'Cut', z: 'Undo' };
const symbols = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
];

function keyEvent(combo) {
  const parts = combo.split('+');
  const base = parts.pop();
  const mods = parts.reduce((mask, part) => {
    if (!Object.hasOwn(modifiers, part)) throw new Error(`Unknown key modifier: ${part}.`);
    return mask | modifiers[part];
  }, 0);
  let key = base === 'Space' ? ' ' : base;
  let code = base;
  let vk = namedKeys[base];
  if (/^[a-z]$/i.test(base)) {
    const upper = base.toUpperCase();
    key = mods & 8 ? upper : base;
    code = `Key${upper}`;
    vk = upper.charCodeAt(0);
  } else if (/^\d$/.test(base) || ')!@#$%^&*('.includes(base) && base) {
    const digit = /^\d$/.test(base) ? Number(base) : ')!@#$%^&*('.indexOf(base);
    if (mods & 8) key = ')!@#$%^&*('[digit];
    code = `Digit${digit}`;
    vk = 48 + digit;
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(base)) {
    vk = 111 + Number(base.slice(1));
  } else {
    const symbol = symbols.find(([plain, shifted]) => plain === base || shifted === base);
    if (symbol) {
      code = symbol[2];
      vk = symbol[3];
      if (mods & 8) key = symbol[1];
    }
  }
  if (!vk) throw new Error(`Unknown key: ${base}.`);
  const editing = !(/Mac/i.test(navigator.platform) && (mods & 4)) ? undefined : editCommands[key.toLowerCase()];
  const commands = editing === 'Undo' && (mods & 8) ? ['Redo'] : editing ? [editing] : undefined;
  const text = mods & 7 ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
  return { event: { key, code, windowsVirtualKeyCode: vk, modifiers: mods }, commands, text };
}

export async function keys(ctx, { ref, keys }) {
  const inputs = keys.trim().split(/\s+/).map(keyEvent);
  if (ref != null) await focus(ctx, ref);
  for (const { event, commands, text } of inputs) {
    await focusedFrame(ctx);
    ctx.acted = true;
    await ctx.send('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', text, commands });
    await ctx.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  }
  return 'Sent keys.';
}

export async function choose(ctx, ref, values) {
  const frameId = await resolveRef(ctx, ref);
  await onNode(ctx, ref, frameId, function (values) {
    if (this.localName !== 'select') throw new Error('This ref is not a native select.');
    if (this.matches(':disabled')) throw new Error('The select is disabled.');
    if (values.length > 1 && !this.multiple) throw new Error('This select does not accept multiple options.');
    const options = [...this.options];
    const selected = values.map(value => {
      const option = options.find(o => o.value === value) ?? options.find(o => o.label.toLowerCase() === value.toLowerCase());
      if (!option) throw new Error(`No option ${JSON.stringify(value)}. Options: ${options.map(o => `${o.label} (${o.value})`).join(', ')}.`);
      if (option.matches(':disabled')) throw new Error(`Option ${JSON.stringify(option.label)} is disabled.`);
      return option;
    });
    if (this.multiple) for (const option of options) option.selected = selected.includes(option);
    else this.selectedIndex = options.indexOf(selected[0]);
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }, values);
  ctx.acted = true;
}

async function fillField(ctx, { ref, value }) {
  const frameId = await resolveRef(ctx, ref);
  const kind = await onNode(ctx, ref, frameId, function () {
    return this.localName === 'select' ? 'select' : 'other';
  });
  if (kind === 'select') return choose(ctx, ref, [value]);
  await onNode(ctx, ref, frameId, function (value) {
    if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true') throw new Error('The field is disabled.');
    if (this.readOnly || this.getAttribute('aria-readonly') === 'true') throw new Error('The field is read-only.');
    const role = this.getAttribute('role');
    if (['checkbox', 'radio'].includes(this.type) || ['checkbox', 'radio', 'switch'].includes(role)) {
      if (value !== 'true' && value !== 'false') throw new Error('Expected "true" or "false".');
      const checked = value === 'true';
      if (this.matches('input[type=checkbox], input[type=radio]')) {
        this.checked = checked;
        this.indeterminate = false;
      } else {
        if (this.getAttribute('aria-checked') !== value) this.click();
        if (this.getAttribute('aria-checked') !== value) throw new Error(`The field did not become ${value}.`);
      }
    } else if (this.isContentEditable) {
      this.textContent = value;
    } else if (this.matches('textarea, input:not([type=file])')) {
      if (this.type === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Expected a color like #aabbcc.');
      const probe = this.cloneNode(false);
      probe.value = value;
      if (probe.value !== (this.type === 'color' ? value.toLowerCase() : value) &&
          !(this.type === 'datetime-local' && Date.parse(probe.value) === Date.parse(value))) {
        throw new Error(`Invalid value for ${this.type}.`);
      }
      this.value = probe.value;
      if (this.value !== probe.value) throw new Error(`The field did not accept ${JSON.stringify(value)}.`);
    } else {
      throw new Error('This ref is not a fillable field.');
    }
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  ctx.acted = true;
}

export async function fill(ctx, { fields }) {
  let count = 0;
  for (const field of fields) {
    try {
      await fillField(ctx, field);
      count++;
    } catch (error) {
      error.message = `Filled ${count} of ${fields.length} fields; [${field.ref}]: ${error.message}`;
      throw error;
    }
  }
  return `Filled ${count} fields.`;
}

export async function upload(ctx, { ref, paths }) {
  const frameId = await resolveRef(ctx, ref);
  const direct = await onNode(ctx, ref, frameId, function () { return this.matches('input[type=file]'); });
  let backendNodeId = ref;
  if (!direct) {
    let chooser;
    const listen = (method, event) => { if (method === 'Page.fileChooserOpened') chooser = event; };
    ctx.state.listeners.add(listen);
    try {
      await ctx.send('Page.setInterceptFileChooserDialog', { enabled: true });
      await click(ctx, { ref });
      const deadline = Date.now() + 2000;
      while (!chooser && Date.now() < deadline) { ctx.check(); await sleep(25); }
      if (!chooser?.backendNodeId) throw new Error('The element did not open a file chooser.');
      await ctx.refresh();
      const found = locateFrame(ctx.tree, chooser.frameId);
      if (!found) throw new Error('Cannot determine the file chooser frame.');
      ctx.approveFrame(found.frame, found.parent);
      backendNodeId = chooser.backendNodeId;
    } finally {
      ctx.state.listeners.delete(listen);
      await ctx.cleanup('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    }
  }
  ctx.acted = true;
  await ctx.send('DOM.setFileInputFiles', { backendNodeId, files: paths });
  return `Attached ${paths.length} file${paths.length === 1 ? '' : 's'}.`;
}
