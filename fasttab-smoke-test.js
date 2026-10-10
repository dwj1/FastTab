/**
 * FastTab background.js 冒烟测试（Node vm + mock chrome API）
 * 覆盖 v3 键位体系（Alt+Q 右移 / Alt+E 左移 / Alt+W 横跳）核心场景。
 * 运行：node fasttab-smoke-test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

// ---------- Mock 环境 ----------
const state = {
  windows: { 1: { id: 1, focused: true, activeTab: null }, 2: { id: 2, focused: false, activeTab: null } },
  tabs: new Map(),        // id -> { id, windowId, index }
  session: {},
  local: {},
  commandCbs: [],
  activatedCbs: [],
  removedCbs: [],
  changedCbs: [],
};

const windowIndexCounters = {};
function addTab(id, windowId) {
  if (!windowIndexCounters[windowId]) windowIndexCounters[windowId] = 0;
  state.tabs.set(id, { id, windowId, index: windowIndexCounters[windowId]++ });
}
function closeTab(id) {
  state.tabs.delete(id);
  for (const w of Object.values(state.windows)) if (w.activeTab === id) w.activeTab = null;
  for (const cb of state.removedCbs) cb(id, { isWindowClosing: false });
}
function setActive(windowId, tabId) {
  state.windows[windowId].activeTab = tabId;
  for (const cb of state.activatedCbs) cb({ tabId, windowId });
}
function focus(windowId) {
  for (const w of Object.values(state.windows)) w.focused = (w.id === windowId);
}

const chrome = {
  storage: {
    session: {
      async get(k) { const r = {}; if (k in state.session) r[k] = state.session[k]; return r; },
      async set(o) { Object.assign(state.session, o); },
    },
    local: {
      async get(k) { const r = {}; if (k in state.local) r[k] = state.local[k]; return r; },
      async set(o) { Object.assign(state.local, o); },
    },
    onChanged: { addListener(cb) { state.changedCbs.push(cb); } },
  },
  tabs: {
    async get(id) {
      const t = state.tabs.get(id);
      if (!t) throw new Error('no tab ' + id);
      return t;
    },
    async update(id, props) {
      const t = state.tabs.get(id);
      if (!t) throw new Error('no tab ' + id);
      if (props.active) {
        state.windows[t.windowId].activeTab = id;
        for (const cb of state.activatedCbs) cb({ tabId: id, windowId: t.windowId });
      }
      return t;
    },
    async query({ active, windowId }) {
      if (active) {
        const w = state.windows[windowId];
        return w && w.activeTab != null ? [state.tabs.get(w.activeTab)] : [];
      }
      const list = [];
      for (const t of state.tabs.values()) {
        if (t.windowId === windowId) list.push(t);
      }
      list.sort((a, b) => a.index - b.index);
      return list;
    },
    onActivated: { addListener(cb) { state.activatedCbs.push(cb); } },
    onRemoved: { addListener(cb) { state.removedCbs.push(cb); } },
  },
  windows: {
    async getLastFocused() {
      return Object.values(state.windows).find((w) => w.focused) || null;
    },
  },
  commands: {
    onCommand: { addListener(cb) { state.commandCbs.push(cb); } },
  },
};

function loadExtension() {
  const context = { chrome, console, setTimeout, clearTimeout, Promise };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('D:/DWJ/fasttab/background.js', 'utf8'), context, { filename: 'background.js' });
}
loadExtension();

// ---------- 辅助 ----------
async function press(cmd) { for (const cb of state.commandCbs) await cb(cmd); }
const flush = () => new Promise((r) => setTimeout(r, 30));
let passCount = 0, failCount = 0;
function check(name, cond) {
  if (cond) { passCount++; console.log('  PASS | ' + name); }
  else { failCount++; console.log('  FAIL | ' + name); }
}

(async () => {
  // ========== 场景 1：Alt+Q 右移逐格 ==========
  console.log('\n[场景1] Q 右移（A→B→C→D 逐格）');
  addTab(101, 1); addTab(102, 1); addTab(103, 1); addTab(104, 1);
  setActive(1, 101); await flush();
  await press('toggle-right');
  check('Q → 102', state.windows[1].activeTab === 102);
  await press('toggle-right');
  check('Q → 103', state.windows[1].activeTab === 103);

  // ========== 场景 2：Q 环形回初始 ==========
  console.log('\n[场景2] Q 环形（104 后回 101 初始标签）');
  await press('toggle-right');
  check('Q → 104', state.windows[1].activeTab === 104);
  await press('toggle-right');
  check('Q 环形 → 101（回到初始）', state.windows[1].activeTab === 101);

  // ========== 场景 3：Alt+E 左移 + 环形 ==========
  console.log('\n[场景3] E 左移（A→D→C→B 及环形）');
  await press('toggle-left');
  check('E → 104', state.windows[1].activeTab === 104);
  await press('toggle-left');
  check('E → 103', state.windows[1].activeTab === 103);
  await press('toggle-left');
  await press('toggle-left');
  check('E ×2 → 101', state.windows[1].activeTab === 101);
  await press('toggle-left');
  check('E 环形 → 104', state.windows[1].activeTab === 104);

  // ========== 场景 4：Alt+W MRU 横跳交替 ==========
  console.log('\n[场景4] W 横跳（最近两标签交替）');
  setActive(1, 101); await flush();
  setActive(1, 102); await flush();
  setActive(1, 103); await flush();   // MRU=[103,102,101]
  await press('toggle-mru');
  check('W → 102', state.windows[1].activeTab === 102);
  await press('toggle-mru');
  check('W → 103（交替）', state.windows[1].activeTab === 103);

  // ========== 场景 5：Q 切换后 W 仍正确 ==========
  console.log('\n[场景5] Q 后 W（MRU 更新正确）');
  await press('toggle-right');         // 103 → 104，MRU=[104,103,102,101]
  check('Q → 104', state.windows[1].activeTab === 104);
  await press('toggle-mru');
  check('W → 103（真实上一个）', state.windows[1].activeTab === 103);

  // ========== 场景 6：关闭标签后 W 跳过失效 ==========
  console.log('\n[场景6] 关闭后 W 跳过');
  setActive(1, 104); await flush();
  setActive(1, 103); await flush();    // MRU=[103,104,102,101]
  closeTab(104); await flush();        // MRU=[103,102,101]
  await press('toggle-mru');
  check('W → 102（跳过已关闭 104）', state.windows[1].activeTab === 102);

  // ========== 场景 7：关闭标签后 Q 不切到已关闭 ==========
  console.log('\n[场景7] 关闭后 Q 位置正常');
  await press('toggle-right');         // 102 → 103
  check('Q → 103', state.windows[1].activeTab === 103);
  await press('toggle-right');         // 103 → 环形 101（104 已关，跳过）
  check('Q 环形 → 101（跳过已关闭 104）', state.windows[1].activeTab === 101);

  // ========== 场景 8：多窗口隔离 ==========
  console.log('\n[场景8] 多窗口互不串扰');
  addTab(201, 2); addTab(202, 2);
  focus(2);
  setActive(2, 201); await flush();
  setActive(2, 202); await flush();    // W2 当前 202
  await press('toggle-right');
  check('W2 Q → 201', state.windows[2].activeTab === 201);
  focus(1);
  setActive(1, 101); await flush();    // W1 操作不影响 W2
  focus(2);
  await press('toggle-right');
  check('W2 Q → 202（会话隔离）', state.windows[2].activeTab === 202);

  // ========== 场景 9：功能互换（Q↔E 对调，W 不变） ==========
  console.log('\n[场景9] 功能互换');
  await chrome.storage.local.set({ fasttabSettings: { swapFunctions: true } });
  for (const cb of state.changedCbs) cb({ fasttabSettings: { newValue: { swapFunctions: true } } }, 'local');
  focus(1);
  setActive(1, 101); await flush();
  setActive(1, 102); await flush();
  setActive(1, 103); await flush();    // W1 当前 103
  await press('toggle-right');         // 互换后 = 左移 → 102
  check('互换后 Q(=E) → 102', state.windows[1].activeTab === 102);
  await press('toggle-right');         // 互换后 = 左移 → 101
  check('互换后 Q(=E) → 101', state.windows[1].activeTab === 101);
  await press('toggle-mru');           // W 不受影响：两次左移后 MRU=[101,102,103]
  check('互换后 W 仍横跳 → 102', state.windows[1].activeTab === 102);

  // ========== 场景 10：SW 冷启动恢复 ==========
  console.log('\n[场景10] SW 冷启动恢复');
  await chrome.storage.local.set({ fasttabSettings: { swapFunctions: false } });
  focus(1);
  setActive(1, 102); await flush();
  setActive(1, 101); await flush();    // MRU=[101,102,103]
  await new Promise((r) => setTimeout(r, 400)); // 等待持久化回写 session
  state.commandCbs = []; state.activatedCbs = []; state.removedCbs = []; state.changedCbs = [];
  loadExtension();                     // 模拟 SW 被杀后重启
  await press('toggle-mru');           // 当前 101 → 目标 102
  check('冷启动恢复后 W → 102（真实上一个）', state.windows[1].activeTab === 102);

  // ========== 场景 11：单标签静默 ==========
  console.log('\n[场景11] 单标签静默');
  state.windows[3] = { id: 3, focused: false, activeTab: null };
  addTab(301, 3);
  focus(3);
  setActive(3, 301); await flush();
  await press('toggle-right');
  check('单标签 Q 无操作', state.windows[3].activeTab === 301);
  await press('toggle-mru');
  check('单标签 W 无操作', state.windows[3].activeTab === 301);

  console.log('\n========== 结果: ' + passCount + ' PASS / ' + failCount + ' FAIL ==========');
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
