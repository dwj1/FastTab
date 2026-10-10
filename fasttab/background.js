/**
 * FastTab 极速标签页切换器 — background service worker
 * Manifest V3 | 权限：仅 storage
 *
 * 数据模型（内存态为权威源，storage.session 异步节流回写兜底）：
 *   stacks        : { [windowId: string]: number[] }   每窗口 MRU 栈，上限 30
 *   traverse      : { active, windowId, anchor, cursor, target, candidates } | null
 *                   candidates = MRU 候选（栈中非 anchor 项）+ 未访问标签（按标签栏 index 升序）
 *   swapFunctions : boolean（storage.local 缓存，功能互换）
 *
 * PRD 补全约束（v0.2.0 / v0.3.0）：
 *   P1 会话绑定 windowId：跨窗口激活不终止会话；其他窗口按 Alt+E 先提交重建再新起会话
 *   P2 每次按键前指针归一化：失效顺延 / 跳过 anchor / 无可选目标静默退出
 *   P3 互换配置存 chrome.storage.local，SW 启动读入内存，按键路径零 storage 读取
 *   P4 当前窗口/标签统一取 lastFocusedWindow
 *   P5 遍历候选集 = MRU + 未访问补齐：批量打开的标签无需点击即可被遍历切换
 */
'use strict';

const STACK_MAX = 30;
const SESSION_KEY = 'fasttabState';
const SETTINGS_KEY = 'fasttabSettings';
const PERSIST_DEBOUNCE_MS = 300;

// ---------- 内存态（权威源） ----------
let stacks = {};
let traverse = null;
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
    if (session[SESSION_KEY]) {
      if (session[SESSION_KEY].stacks) stacks = session[SESSION_KEY].stacks;
      if (session[SESSION_KEY].traverse) traverse = session[SESSION_KEY].traverse;
    }
    swapFunctions = !!(local[SETTINGS_KEY] && local[SETTINGS_KEY].swapFunctions);
  } catch (e) {
    // 读取失败从零开始，不影响后续按键
    stacks = {};
    traverse = null;
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
      .set({ [SESSION_KEY]: { stacks, traverse } })
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

// ---------- 遍历会话：提交重建 ----------
// 新栈 = [遍历路径逆序（最后目标在前）..., anchor, 栈其余项]，保证横跳语义正确
function commitTraverse() {
  if (!traverse) return;
  const key = String(traverse.windowId);
  const stack = stacks[key] || [];
  const cands = traverse.candidates || [];
  const cursor = Math.min(traverse.cursor, cands.length - 1);
  // 遍历路径：本次会话已走过的候选（cands[0..cursor]），逆序 = 最后切换目标在前
  const head = cands
    .slice(0, cursor + 1)
    .filter((id) => id != null && id !== traverse.anchor)
    .reverse()
    .filter((id) => stack.includes(id));
  // 其余：栈中不在 head 内的项（含 anchor 与未走到的候选），保持相对顺序
  const rest = stack.filter((id) => !head.includes(id));
  stacks[key] = head.concat(rest).slice(0, STACK_MAX);
  traverse = null;
  schedulePersist();
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

// ---------- 当前窗口/标签（P4 约定：lastFocusedWindow） ----------
async function getFocusedContext() {
  const win = await chrome.windows.getLastFocused();
  if (!win || win.id == null) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return { windowId: win.id, tab: tab || null };
}

// ---------- 命令：Alt+Q 横跳（模块 A） ----------
async function handleMruJump() {
  const ctx = await getFocusedContext();
  if (!ctx || !ctx.tab) return;
  const key = String(ctx.windowId);
  const stack = stacks[key];
  if (!stack || stack.length <= 1) return; // 无可跳对象，静默

  // 存在遍历会话：先提交重建（PRD 模块 A 交互规则）
  if (traverse) commitTraverse();

  // 目标 = 栈中第一个 ≠ 当前激活 tab 的 id；失效则移除并顺延
  const currentId = ctx.tab.id;
  for (const candidate of [...(stacks[key] || [])]) {
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

// ---------- 命令：Alt+E 遍历（模块 B） ----------
async function handleAnyTraverse() {
  const ctx = await getFocusedContext();
  if (!ctx || !ctx.tab) return;

  const hasActiveSession =
    traverse && traverse.windowId === ctx.windowId && traverse.candidates && traverse.candidates.length > 0;

  if (!hasActiveSession) {
    // 会话不存在 / 属于其他窗口（P1）/ 候选集耗尽：先提交重建，再新起会话
    if (traverse) commitTraverse();
    pushStack(ctx.windowId, ctx.tab.id);
    traverse = await initTraverse(ctx);
    if (!traverse) return; // 窗口内无其他标签：静默
  } else {
    // 会话继续：每次按键前进一格
    traverse.cursor++;
  }

  const targetId = await resolveTraverseTarget();
  if (targetId == null) return; // 已静默退出
  traverse.target = targetId;
  try {
    await activateTab(targetId);
  } catch (e) {
    removeTabFromStacks(targetId);
    if (traverse && traverse.candidates) {
      const i = traverse.candidates.indexOf(targetId);
      if (i !== -1) traverse.candidates.splice(i, 1);
    }
    schedulePersist();
  }
}

// 初始化遍历会话：候选集 = MRU 候选（栈中非 anchor）+ 未访问标签（按标签栏 index 升序，P5）
async function initTraverse(ctx) {
  const allTabs = await chrome.tabs.query({ windowId: ctx.windowId });
  if (allTabs.length <= 1) return null; // 没有可切换对象
  const stack = stacks[String(ctx.windowId)] || [];
  const stackSet = new Set(stack);
  const mruCandidates = stack.filter((id) => id !== ctx.tab.id);
  const unvisited = allTabs
    .filter((t) => t.id !== ctx.tab.id && !stackSet.has(t.id))
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);
  const candidates = mruCandidates.concat(unvisited);
  if (candidates.length === 0) return null;
  return {
    active: true,
    windowId: ctx.windowId,
    anchor: ctx.tab.id,
    cursor: 0,
    target: null,
    candidates,
  };
}

async function resolveTraverseTarget() {
  const cands = traverse.candidates;
  if (!cands || cands.length === 0) { commitTraverse(); return null; }
  const len = cands.length;
  let cursor = traverse.cursor;
  if (cursor < 0 || cursor >= len) cursor = 0;
  let attempts = 0;
  while (attempts < len) {
    if (cursor >= len) cursor = 0; // 循环回第 1 个候选，跳过 anchor（anchor 不在候选集中）
    const id = cands[cursor];
    if (id != null && id !== traverse.anchor) {
      if (await isTabValid(id, traverse.windowId)) {
        traverse.cursor = cursor;
        return id;
      }
      // 失效：从候选集与栈中移除并顺延（splice 后原位置由后续元素补位，cursor 保持不变）
      cands.splice(cursor, 1);
      removeTabFromStacks(id);
      if (cands.length === 0) { commitTraverse(); return null; }
      continue;
    }
    cursor++;
    attempts++;
  }
  commitTraverse();
  return null;
}

// ---------- 事件监听 ----------
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (traverse && traverse.windowId === windowId) {
    if (traverse.target != null && tabId === traverse.target) {
      // 遍历目标激活：
      const key = String(windowId);
      const stack = stacks[key] || [];
      if (stack.includes(tabId)) {
        // 已在 MRU 栈中：抑制更新，保持遍历顺序稳定
        return;
      }
      // 未入栈（P5：首次被遍历激活的未访问标签）：正常置顶入栈，下次排序自然提前
    } else {
      // 手动激活非目标：提交重建退出，随后正常置顶（fallthrough）
      commitTraverse();
    }
  }
  // 无会话 / 跨窗口激活 / 未访问标签首次激活：正常置顶
  pushStack(windowId, tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabFromStacks(tabId);
  if (traverse && traverse.candidates) {
    const idx = traverse.candidates.indexOf(tabId);
    if (idx !== -1) {
      traverse.candidates.splice(idx, 1);
      schedulePersist();
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  await ensureRestored();
  // 功能互换（模块 C）：Q ↔ E 对调
  const cmd = swapFunctions
    ? (command === 'toggle-mru' ? 'toggle-any' : 'toggle-mru')
    : command;
  if (cmd === 'toggle-mru') {
    await handleMruJump();
  } else if (cmd === 'toggle-any') {
    await handleAnyTraverse();
  }
});
