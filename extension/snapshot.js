import { onNode } from './cdp.js';

const interactive = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  'InputDate', 'InputDateTime', 'InputTime', 'Date', 'DateTime', 'Time', 'ColorWell',
]);

export function flattenFrames(tree) {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(flattenFrames)];
}

function attribute(node, key) {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === key) return attrs[i + 1];
  return '';
}

export function isFrame(node) {
  return node.localName === 'iframe' || node.localName === 'frame';
}

export function frameURL(frame) {
  return `${frame.url}${frame.urlFragment ?? ''}`;
}

export function ownerURL(ctx, node, parent) {
  return onNode(ctx, node.backendNodeId, parent.id, function () {
    if (this.hasAttribute('srcdoc')) return 'about:srcdoc';
    return this.src || 'about:blank';
  });
}

function nodeStates(node) {
  const properties = Object.fromEntries((node.properties ?? []).map(({ name, value }) => [name, value.value]));
  const result = [];
  if (properties.checked !== undefined) {
    result.push(properties.checked === 'mixed' ? 'mixed' : String(properties.checked) === 'true' ? 'checked' : 'unchecked');
  }
  if (properties.pressed === 'mixed') result.push('mixed');
  else if (String(properties.pressed) === 'true') result.push('pressed');
  if (properties.expanded !== undefined) result.push(properties.expanded ? 'expanded' : 'collapsed');
  for (const name of ['selected', 'disabled', 'required']) if (properties[name]) result.push(name);
  return result.length ? ` (${result.join(', ')})` : '';
}

function quote(value) {
  return JSON.stringify(String(value));
}

function line(node, role, name, ref) {
  if (role === 'StaticText' || role === 'InlineTextBox') return name.replace(/\s+/g, ' ').trim();
  const value = node.value?.value;
  return `${ref ? `[${ref}] ` : ''}${role}${name ? ` ${quote(name)}` : ''}${value === undefined || value === '' ? '' : ` = ${quote(value)}`}${nodeStates(node)}`;
}

function origin(frame, parent) {
  const value = frame.securityOrigin;
  if (value && value !== '://' && value !== 'null') return value;
  return frame.url === 'about:blank' || frame.url === 'about:srcdoc' ? parent : new URL(frame.url).origin;
}

async function frameOwners(ctx, tree) {
  const pairs = await Promise.all((tree.childFrames ?? []).map(async child => {
    const { backendNodeId } = await ctx.send('DOM.getFrameOwner', { frameId: child.frame.id });
    return [backendNodeId, child];
  }));
  return new Map(pairs);
}

async function renderFrame(ctx, tree, mainOrigin, refs, lines, depth, parentName) {
  const frameId = tree.frame.id;
  const { nodes } = await ctx.send('Accessibility.getFullAXTree', { frameId });
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const owners = await frameOwners(ctx, tree);

  async function visit(node, depth, parentName) {
    const role = node.role?.value ?? 'none';
    const name = node.name?.value ?? '';
    const backendNodeId = node.backendDOMNodeId;
    const indent = '  '.repeat(depth);
    if (role === 'Iframe' || role === 'IframePresentational') {
      const child = owners.get(backendNodeId);
      const dom = child ? undefined : (await ctx.send('DOM.describeNode', { backendNodeId })).node;
      const url = child ? frameURL(child.frame) : await ownerURL(ctx, dom, tree.frame);
      const host = new URL(url).hostname || new URL(mainOrigin).hostname;
      const label = `Iframe ${quote(name || (dom ? attribute(dom, 'title') : ''))}`;
      if (!child || origin(child.frame, mainOrigin) !== mainOrigin) {
        lines.push(`${indent}${label} (cross-site ${host}, not read)`);
      } else {
        lines.push(indent + label);
        await renderFrame(ctx, child, mainOrigin, refs, lines, depth + 1, name);
      }
      return;
    }
    const wrapper = node.ignored || role === 'generic' || role === 'none';
    const duplicate = (role === 'StaticText' || role === 'InlineTextBox') && name === parentName;
    const ref = !wrapper && interactive.has(role) ? backendNodeId : undefined;
    if (ref) refs.set(ref, { frameId });
    if (!wrapper && !duplicate) {
      const text = line(node, role, name, ref);
      if (text) lines.push(indent + text);
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) await visit(child, depth + Number(!wrapper && !duplicate), wrapper || !name ? parentName : name);
    }
  }

  if (nodes.length) await visit(nodes[0], depth, parentName);
}

export async function snapshot(ctx, header, tree) {
  const lines = [header];
  const refs = new Map();
  const generation = ctx.state.generation;
  await renderFrame(ctx, tree, new URL(tree.frame.url).origin, refs, lines, 0, '');
  if (ctx.state.generation !== generation) throw new Error('The page navigated while reading; read again.');
  for (const [id, entry] of refs) ctx.state.refs.set(id, entry);
  return lines.join('\n');
}
