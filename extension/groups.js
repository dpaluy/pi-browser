import { checkPower } from './power.js';

const key = 'sessions';
let registry = chrome.storage.session.get(key).then(data => data[key] ?? {});

let actionDepth = 0;
let actionReady = Promise.resolve();
const activeTabs = new Map();
const previousTabs = new Map();
const openedTabs = new Map();
const tabTasks = new Set();

function restoreTab(tabId) {
  const opened = openedTabs.get(tabId);
  if (!opened || !actionDepth) return;
  activeTabs.set(opened.windowId, opened.previous);
  void chrome.tabs.update(opened.previous, { active: true }).catch(console.warn);
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (openedTabs.has(tabId) && actionDepth) restoreTab(tabId);
  else {
    previousTabs.set(windowId, activeTabs.get(windowId));
    activeTabs.set(windowId, tabId);
  }
});

chrome.tabs.onCreated.addListener(tab => {
  if (!actionDepth || tab.openerTabId == null) return;
  const task = (async () => {
    await actionReady;
    const opener = await chrome.tabs.get(tab.openerTabId);
    const sessions = Object.values(await registry);
    const ownsOpenerGroup = sessions.some(record => record.group === opener.groupId);
    const ownsTabGroup = sessions.some(record => record.group === tab.groupId);
    if (!ownsOpenerGroup && !ownsTabGroup) return;
    const groupId = ownsOpenerGroup ? opener.groupId : tab.groupId;
    const current = activeTabs.get(tab.windowId);
    const previous = current === tab.id ? previousTabs.get(tab.windowId) : current;
    if (previous != null && previous !== tab.id) {
      openedTabs.set(tab.id, { previous, windowId: tab.windowId });
    }
    if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tab.id], groupId });
    if ((await chrome.tabs.get(tab.id)).active) restoreTab(tab.id);
  })().catch(console.warn);
  tabTasks.add(task);
  void task.finally(() => tabTasks.delete(task));
});

export async function action(id, fn) {
  if (actionDepth++ === 0) {
    activeTabs.clear();
    previousTabs.clear();
    actionReady = chrome.tabs.query({ active: true }).then(tabs => {
      for (const tab of tabs) activeTabs.set(tab.windowId, tab.id);
    });
  }
  try {
    await actionReady;
    return await fn();
  } finally {
    if (actionDepth === 1) await Promise.all([...tabTasks]);
    if (--actionDepth === 0) openedTabs.clear();
  }
}

function transaction(fn) {
  const result = registry.then(async sessions => {
    const value = await fn(sessions);
    await chrome.storage.session.set({ [key]: sessions });
    return value;
  });
  registry = result.then(() => chrome.storage.session.get(key).then(data => data[key] ?? {}),
    () => chrome.storage.session.get(key).then(data => data[key] ?? {}));
  return result;
}

function entry(sessions, id) {
  return Object.hasOwn(sessions, id) ? sessions[id] : undefined;
}

async function members(record) {
  return record ? chrome.tabs.query({ groupId: record.group }) : [];
}

function current(record, tabs) {
  return record?.recent.find(id => tabs.some(tab => tab.id === id)) ?? tabs[0]?.id;
}

export function list(id) {
  return transaction(async sessions => {
    const record = entry(sessions, id);
    const all = await chrome.tabs.query({});
    const tabs = all.filter(tab => tab.groupId === record?.group);
    const selected = current(record, tabs);
    return {
      text: '', others: all.length - tabs.length,
      tabs: tabs.map(tab => ({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '', current: tab.id === selected })),
    };
  });
}

export function tabFor(id, tabId) {
  return transaction(async sessions => {
    const record = entry(sessions, id);
    const tabs = await members(record);
    if (tabId == null) tabId = current(record, tabs);
    if (tabId == null) throw new Error('No tab in your group. Navigate first.');
    const tab = tabs.find(tab => tab.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} is not in your group.`);
    return tab;
  });
}

export function touch(id, tabId) {
  return transaction(async sessions => {
    const record = entry(sessions, id);
    if (record && (await members(record)).some(tab => tab.id === tabId)) {
      record.recent = [tabId, ...record.recent.filter(tab => tab !== tabId)];
    }
  });
}

async function retitle(record, ended = false) {
  const [tab] = await members(record);
  if (tab) await chrome.tabGroups.update(record.group, { title: `π · ${record.name}${ended ? ' (ended)' : ''}` });
}

export function rename(id, name) {
  return transaction(async sessions => {
    const record = entry(sessions, id);
    if (!record) return;
    if (record.name !== name || record.ended) {
      record.name = name;
      record.ended = false;
      await retitle(record);
    }
  });
}

export function end(id) {
  return transaction(async sessions => {
    const record = entry(sessions, id);
    if (!record) return;
    record.ended = true;
    await retitle(record, true);
  });
}

export function createTab(id, name) {
  return transaction(async sessions => {
    let record = entry(sessions, id);
    const [existing] = await members(record);
    const windowId = existing?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
    checkPower();
    const tab = await chrome.tabs.create({ windowId, active: false, url: 'about:blank' });
    try {
      const group = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: record.group } : {}) });
      if (!existing) {
        record = { group, name, recent: [], ended: false };
        Object.defineProperty(sessions, id, { value: record, enumerable: true, configurable: true, writable: true });
        await retitle(record);
      }
      record.recent.unshift(tab.id);
      return { ...tab, groupId: group };
    } catch (error) {
      await chrome.tabs.remove(tab.id);
      throw error;
    }
  });
}

chrome.tabs.onRemoved.addListener(tabId => {
  void transaction(sessions => {
    for (const record of Object.values(sessions)) record.recent = record.recent.filter(id => id !== tabId);
  }).catch(console.warn);
});
chrome.tabGroups.onRemoved.addListener(({ id }) => {
  void transaction(sessions => {
    for (const [key, record] of Object.entries(sessions)) if (record.group === id) delete sessions[key];
  }).catch(console.warn);
});
