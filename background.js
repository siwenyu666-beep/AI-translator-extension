// ========== DeepSeek 智能解释 - Service Worker ==========
// 职责：右键菜单、下载解释到本地（API 调用已移至 content script 直接 fetch）

// ── 右键菜单：安装/更新时创建 ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'deepseek-explain',
    title: 'DeepSeek 智能解释',
    contexts: ['selection']
  });
});

// ── 右键菜单点击：转发选中文本给 content script ──
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'deepseek-explain' && info.selectionText && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRIGGER_EXPLAIN',
      text: info.selectionText.trim()
    }).catch(() => {
      // content script 可能未注入（如 chrome:// 页面），静默忽略
    });
  }
});
