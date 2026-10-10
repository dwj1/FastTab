/**
 * FastTab 极速标签页切换器 — background service worker
 * Manifest V3 | 权限：仅 storage
 *
 * v0.3.0 键位体系（v3）：
 *   Alt+Q (toggle-right) : 标签栏从左往右切换（index+1，环形，包含初始标签）
 *   Alt+E (toggle-left)  : 标签栏从右往左切换（index-1，环形）
 *   Alt+W (toggle-mru)   : 最近使用的两个标签之间横跳（MRU 栈驱动）
 *   swapFunctions        : Alt+Q / Alt+E 左右互换（Alt+W 不参与）
 *
 * 数据模型（内存态为权威源，storage.session 异步节流回写兜底）：
 *   stacks        : { [windowId: string]: number[] }   每窗口 MRU 栈，上限 30
 *   swapFunctions : boolean（storage.local 缓存，功能互换）
 *
 * v3 简化：删除 v0.2 的遍历会话（traverse / commitTraverse / candidates）——
 *   位置切换按当前激活标签的 index±1 定位，天然无需锁 MRU 与锚点游标；
 *   未访问标签也自动覆盖（位置遍历天然包含窗口内全部标签）。
 */
'use strict';

const STACK_MAX = 30;
const SESSION_KEY = 'fasttabState';
const SETTINGS_KEY = 'fasttabSettings';
const PERSIST_DEBOUNCE_MS = 300;

// ---------- 内存态（权威源） ----------
let stacks = {};
let swapFunctions = false;

// ---------- 启动恢复（SW 冷启动后首次按键前调用） ----------
let restorePromise = null;
function ensureRestored() {
  if (!restorePromise) {
    restorePromise = restoreState();
  }
  return restorePromise;
}

async function restoreState() {
  try {
    const session = await chrome.storage.session.get(SESSION_KEY);
    const local = await chrome.storage.local.get(SETTINGS_KEY);
    if (session[SESSION_KEY] && session[SESSION_KEY].stacks) {
      stacks = session[SESSION_KEY].stacks;
    }
    swapFunctions = !!(local[SETTINGS_KEY] && local[SETTINGS_KEY].swapFunctions);
  } catch (e) {
    // 读取失败从零开始，不影响后续按键
    stacks = {};
    swapFunctions = false;
  }
}

// ---------- 持久化（节流回写 storage.session） ----------
let persistTimer = null;
function schedulePersist() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session
      .set({ [SESSION_KEY]: { stacks } })
      .catch(() => { /* 写失败忽略，下次变更会再次回写 */ });
  }, PERSIST_DEBOUNCE_MS);
}

// ---------- 配置监听（options 页改动即时生效，无需 SW 重启） ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    swapFunctions = !!(changes[SETTINGS_KEY].newValue && changes[SETTINGS_KEY].newValue.swapFunctions);
  }
});

// ---------- MRU 栈操作 ----------
function pushStack(windowId, tabId) {
  const key = String(windowId);
  if (!stacks[key]) stacks[key] = [];
  const stack = stacks[key];
  const idx = stack.indexOf(tabId);
  if (idx !== -1) stack.splice(idx, 1);
  stack.unshift(tabId);
  if (stack.length > STACK_MAX) stack.length = STACK_MAX;
  schedulePersist();
}

function removeTabFromStacks(tabId) {
  let changed = false;
  for (const key of Object.keys(stacks)) {
    const idx = stacks[key].indexOf(tabId);
    if (idx !== -1) {
      stacks[key].splice(idx, 1);
      changed = true;
    }
    if (stacks[key].length === 0) delete stacks[key];
  }
  if (changed) schedulePersist();
}

// ---------- 目标校验与激活 ----------
async function isTabValid(tabId, windowId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab && tab.windowId === windowId;
  } catch (e) {
    return false;
  }
}

async function activateTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}

// ---------- 当前窗口/标签（约定：lastFocusedWindow） ----------
async function getFocusedContext() {
  const win = await chrome.windows.getLastFocused();
  if (!win || win.id == null) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return { windowId: win.id, tab: tab || null };
}

// ---------- 命令：Alt+Q / Alt+E 位置切换（模块 A） ----------
// direction: +1 右移（index+1）、-1 左移（index-1）
// 环形遍历包含初始标签：遍历一圈最后回到初始标签，自然进入下一圈
async function shiftTab(direction) {
  const ctx = await getFocusedContext();
  if (!ctx || !ctx.tab) return;
  const allTabs = await chrome.tabs.query({ windowId: ctx.windowId });
  if (allTabs.length <= 1) return; // 无可切换对象，静默
  allTabs.sort((a, b) => a.index - b.index);
  const curIdx = allTabs.findIndex((t) => t.id === ctx.tab.id);
  if (curIdx === -1) return; // 当前标签不在列表中（异常态），静默
  const next = allTabs[(curIdx + direction + allTabs.length) % allTabs.length];
  try {
    await activateTab(next.id);
  } catch (e) {
    // 目标失效：从 MRU 栈清理，保持静默
    removeTabFromStacks(next.id);
  }
}

// ---------- 命令：Alt+W MRU 横跳（模块 B） ----------
async function handleMruJump() {
  const ctx = await getFocusedContext();
  if (!ctx || !ctx.tab) return;
  const key = String(ctx.windowId);
  const stack = stacks[key];
  if (!stack || stack.length <= 1) return; // 无可跳对象，静默

  const currentId = ctx.tab.id;
  for (const candidate of [...stack]) {
    if (candidate === currentId) continue;
    if (await isTabValid(candidate, ctx.windowId)) {
      try {
        await activateTab(candidate);
      } catch (e) {
        removeTabFromStacks(candidate);
        continue;
      }
      return;
    }
    removeTabFromStacks(candidate);
  }
  // 全部无效：静默
}

// ---------- 事件监听 ----------
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  pushStack(windowId, tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabFromStacks(tabId);
});

chrome.commands.onCommand.addListener(async (command) => {
  await ensureRestored();
  // 功能互换（模块 C）：Alt+Q ↔ Alt+E 对调，Alt+W 不参与
  let cmd = command;
  if (swapFunctions) {
    if (command === 'toggle-right') cmd = 'toggle-left';
    else if (command === 'toggle-left') cmd = 'toggle-right';
  }
  if (cmd === 'toggle-right') {
    await shiftTab(1);
  } else if (cmd === 'toggle-left') {
    await shiftTab(-1);
  } else if (cmd === 'toggle-mru') {
    await handleMruJump();
  }
});
