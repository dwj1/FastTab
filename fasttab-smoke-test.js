/**
 * FastTab background.js 冒烟测试（Node vm + mock chrome API）
 * 覆盖 PRD 验收标准 1~8 的核心场景。
 * 运行：node fasttab-smoke-test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

// ---------- Mock 环境 ----------
const state = {
  windows: { 1: { id: 1, focused: true, activeTab: null }, 2: { id: 2, focused: false, activeTab: null } },
  tabs: new Map(),        // id -> { id, windowId }
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
      // 全量：返回该窗口所有标签，按标签栏 index 升序
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
const flush = () => new Promise((r) => setTimeout(r, 60));
let passCount = 0, failCount = 0;
function check(name, cond) {
  if (cond) { passCount++; console.log('  PASS | ' + name); }
  else { failCount++; console.log('  FAIL | ' + name); }
}

(async () => {
  // ========== 场景 1/验收1：横跳交替 ==========
  console.log('\n[场景1] 横跳（A→B→C，Alt+Q 应在 B/C 间交替）');
  addTab(101, 1); addTab(102, 1); addTab(103, 1);
  setActive(1, 101); await flush();
  setActive(1, 102); await flush();
  setActive(1, 103); await flush();   // MRU=[103,102,101]
  await press('toggle-mru');
  check('Alt+Q → 切到 B(102)', state.windows[1].activeTab === 102);
  await press('toggle-mru');
  check('Alt+Q → 切回 C(103)', state.windows[1].activeTab === 103);
  await press('toggle-mru');
  check('Alt+Q → 再切到 B(102)', state.windows[1].activeTab === 102);

  // ========== 场景 2/验收2：遍历逐级 ==========
  console.log('\n[场景2] 遍历（A→B→C→D 逐级前进）');
  addTab(104, 1);
  setActive(1, 104); await flush();
  setActive(1, 103); await flush();
  setActive(1, 102); await flush();
  setActive(1, 101); await flush();    // MRU=[101,102,103,104]（101 最近）
  await press('toggle-any');
  check('Alt+E 第1次 → B(102)', state.windows[1].activeTab === 102);
  await press('toggle-any');
  check('Alt+E 第2次 → C(103)', state.windows[1].activeTab === 103);
  await press('toggle-any');
  check('Alt+E 第3次 → D(104)', state.windows[1].activeTab === 104);

  // ========== 场景 3/验收3：遍历循环 ==========
  console.log('\n[场景3] 遍历循环（到底后回第1个候选）');
  await press('toggle-any');
  check('Alt+E 第4次 → 循环回 B(102)', state.windows[1].activeTab === 102);

  // ========== 场景 4/验收4：提交重建 ==========
  console.log('\n[场景4] 提交重建（遍历到 D 后 Alt+Q → 应横跳到 C）');
  setActive(1, 104); await flush();
  setActive(1, 103); await flush();
  setActive(1, 102); await flush();
  setActive(1, 101); await flush();    // MRU=[101,102,103,104]
  await press('toggle-any');           // → B
  await press('toggle-any');           // → C
  await press('toggle-any');           // → D
  await press('toggle-mru');           // 先提交重建，再横跳
  check('提交重建后 Alt+Q → C(103)（真实的上一个）', state.windows[1].activeTab === 103);

  // ========== 场景 5/验收5：会话终止 ==========
  console.log('\n[场景5] 会话终止（遍历中手动激活其他标签）');
  setActive(1, 101); await flush();
  setActive(1, 102); await flush();
  setActive(1, 103); await flush();    // MRU=[103,102,101]
  await press('toggle-any');           // → 102（会话中，anchor=103）
  setActive(1, 101); await flush();    // 手动激活 101（非遍历目标）：提交重建退出 + 101 置顶
  await press('toggle-any');           // 新会话 anchor=101 → 目标=栈[1]=102
  check('手动激活后会话终止，新会话目标 = 102', state.windows[1].activeTab === 102);

  // ========== 场景 6/验收6：失效清理 ==========
  console.log('\n[场景6] 失效清理（关闭标签后跳过）');
  setActive(1, 101); await flush();
  setActive(1, 103); await flush();
  setActive(1, 104); await flush();    // MRU=[104,103,101]
  closeTab(103); await flush();        // MRU=[104,101]
  await press('toggle-mru');           // 当前=104 → 目标=101（跳过已关闭的103）
  check('关闭 103 后 Alt+Q → 101（跳过失效）', state.windows[1].activeTab === 101);

  // ========== 场景 7/验收8a：多窗口隔离 ==========
  console.log('\n[场景7] 多窗口（窗口1会话中切到窗口2，会话不终止）');
  addTab(201, 2); addTab(202, 2);
  setActive(2, 201); await flush();
  setActive(2, 202); await flush();    // W2 MRU=[202,201]
  focus(2);
  await press('toggle-any');           // W2 会话 anchor=202 → 目标 201
  check('W2 Alt+E → 201', state.windows[2].activeTab === 201);
  focus(1);
  setActive(1, 104); await flush();    // 跨窗口激活 W1:104（不应终止 W2 会话）
  focus(2);
  await press('toggle-any');           // W2 会话仍在：cursor=2 → 循环回 201
  check('跨窗口激活后 W2 会话仍在（→201）', state.windows[2].activeTab === 201);

  // ========== 场景 8/验收8b：功能互换 ==========
  console.log('\n[场景8] 功能互换（开启后 Q↔E 对调）');
  await chrome.storage.local.set({ fasttabSettings: { swapFunctions: true } });
  for (const cb of state.changedCbs) cb({ fasttabSettings: { newValue: { swapFunctions: true } } }, 'local');
  addTab(105, 1);                      // 全新 tab，避免与前置场景状态耦合
  focus(1);
  setActive(1, 101); await flush();
  setActive(1, 104); await flush();
  setActive(1, 105); await flush();
  setActive(1, 101); await flush();    // W1 MRU=[101,105,104]
  await press('toggle-mru');           // 互换后=任意切换 → 新会话 anchor=101 → 目标 105
  check('互换后 Alt+Q 执行任意切换 → 105', state.windows[1].activeTab === 105);

  // ========== 场景 9/验收7：SW 冷启动恢复 ==========
  console.log('\n[场景9] SW 冷启动恢复（重新加载扩展，从 storage.session 恢复）');
  await chrome.storage.local.set({ fasttabSettings: { swapFunctions: false } }); // 还原配置
  focus(1);
  setActive(1, 104); await flush();
  setActive(1, 101); await flush();    // W1 MRU=[101,104,103]
  await new Promise((r) => setTimeout(r, 400)); // 等待持久化回写
  state.commandCbs = []; state.activatedCbs = []; state.removedCbs = []; state.changedCbs = [];
  loadExtension();                     // 模拟 SW 被杀后重启
  await press('toggle-mru');
  check('冷启动恢复后 Alt+Q → 104（真实上一个）', state.windows[1].activeTab === 104);

  // ========== 场景 10/P5：批量打开未点击也能遍历 ==========
  console.log('\n[场景10] 批量打开未点击的标签也能遍历（P5）');
  state.windows[3] = { id: 3, focused: false, activeTab: null };
  addTab(111, 3); addTab(112, 3); addTab(113, 3); addTab(114, 3); // 一次性打开4个，只点过 111、113
  setActive(3, 111); await flush();   // 点 A(111)
  setActive(3, 113); await flush();   // 点 C(113)，B(112)/D(114) 从未点击
  focus(3);
  await press('toggle-any');          // 第1次 → 111（最近使用的第2个）
  check('第1次 → 111（点过的优先）', state.windows[3].activeTab === 111);
  await press('toggle-any');          // 第2次 → 112（未点击，按标签栏位置补齐）
  check('第2次 → 112（未点击自动补齐）', state.windows[3].activeTab === 112);
  await press('toggle-any');          // 第3次 → 114（未点击）
  check('第3次 → 114（未点击自动补齐）', state.windows[3].activeTab === 114);
  await press('toggle-any');          // 第4次 → 循环回 111
  check('第4次 → 循环回 111', state.windows[3].activeTab === 111);

  console.log('\n========== 结果: ' + passCount + ' PASS / ' + failCount + ' FAIL ==========');
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
