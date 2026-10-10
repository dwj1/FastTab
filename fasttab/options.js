/**
 * FastTab 设置页逻辑
 * 功能互换开关 → chrome.storage.local（P3：持久化，重启不丢）
 * 快捷键设置入口 → chrome.tabs.create 打开 chrome://extensions/shortcuts
 */
'use strict';

const SETTINGS_KEY = 'fasttabSettings';
const swapEl = document.getElementById('swapFunctions');

async function init() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  swapEl.checked = !!(data[SETTINGS_KEY] && data[SETTINGS_KEY].swapFunctions);
}

swapEl.addEventListener('change', async () => {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { swapFunctions: swapEl.checked },
  });
});

document.getElementById('openShortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

init();
