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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DOWNLOAD') {
    handleDownload(message.text, message.explanation);
  }
});

// ── 下载解释到本地 ──
function handleDownload(selectedText, explanation) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `笔记/DeepSeek解释_${timestamp}.txt`;

  const content = [
    `DeepSeek 智能解释`,
    `生成时间: ${now.toLocaleString('zh-CN')}`,
    ``,
    `── 选中原文 ──`,
    selectedText,
    ``,
    `── 解释内容 ──`,
    explanation,
    ``,
  ].join('\n');

  // Service Worker 没有 FileReader，用 TextEncoder + base64
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + btoa(binary);

  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  });
}
