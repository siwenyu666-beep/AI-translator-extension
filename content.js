// ========== DeepSeek 智能解释 & 翻译 — Content Script ==========
// 职责：划词检测 → 流式弹窗（解释/翻译共用）、动态菜单联动、全文翻译入口

let tooltip = null;
let currentText = null;
let currentExplanation = null;
let isLoading = false;
let hideTimer = null;
let currentStreamPort = null;
let scrollRaf = null;

// ── 触发模式 ──
let triggerMode = 'auto';
let usePageContext = true;
let selectionDebounce = null;
let lastContextMenuPos = { x: 0, y: 0 };

// ── 扩展上下文有效性检测（重载后旧页面的 runtime 会失效）──
function isRuntimeAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}
function safeSendMessage(msg) {
  if (!isRuntimeAlive()) return Promise.resolve();
  return chrome.runtime.sendMessage(msg).catch(() => {});
}
function safeConnect(name) {
  if (!isRuntimeAlive()) return null;
  try { return chrome.runtime.connect({ name }); } catch { return null; }
}

// ── 本地自动分类（微秒级，无网络开销）──
function classifyText(text) {
  const trimmed = text.trim();
  // 剥离数字与常见半角标点，避免“3.5 元”“2024-2025”等中文文本被误判为外语
  const cleaned = trimmed.replace(/[\d.,%+\-():;/'"$?!&@#=*_\[\]{}|\\^~<>]/g, '');
  // 检测非中文字符（拉丁字母、假名、韩文、阿拉伯文等）
  const hasForeign = /[^\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2013\u00b7\s，。、；：！？…—""''（）【】《》]/.test(cleaned);
  const isPurelyChinese = !hasForeign;

  if (isPurelyChinese) {
    if (trimmed.length <= 10) return 'C';  // 拓展解释
    return 'D';                             // 语境解读
  }

  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 10) return 'A';       // 翻译+解释
  return 'B';                                // 纯翻译
}

function modeLabel(mode) {
  return { A: '翻译+解释', B: '翻译', C: '拓展解释', D: '语境解读' }[mode] || '智能解释';
}

// ═══════════════════════════════════════════
// 弹窗 DOM（只创建一次）
// ═══════════════════════════════════════════

function getTooltip() {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'deepseek-explain-tooltip';
    tooltip.innerHTML = `
      <div class="ds-header">
        <span class="ds-brand">DeepSeek 解释</span>
        <button class="ds-close" title="关闭">×</button>
      </div>
      <div class="ds-quote"></div>
      <div class="ds-body"></div>
      <div class="ds-actions">
        <button class="ds-btn ds-btn-copy" title="复制内容">
          <span class="ds-btn-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </span>
          <span class="ds-btn-label">复制</span>
        </button>
        <button class="ds-btn ds-btn-download" title="下载内容">
          <span class="ds-btn-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </span>
          <span class="ds-btn-label">下载</span>
        </button>
      </div>
      <div class="ds-footer">
        <span class="ds-model-tag"></span>
        <span class="ds-powered">Powered by DeepSeek</span>
      </div>
    `;
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', () => scheduleHide());
    tooltip.querySelector('.ds-close').addEventListener('click', hideTooltip);
    tooltip.querySelector('.ds-btn-copy').addEventListener('click', handleCopy);
    tooltip.querySelector('.ds-btn-download').addEventListener('click', handleDownload);
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

// ═══════════════════════════════════════════
// 坐标计算
// ═══════════════════════════════════════════

function getSelectionDocCoords() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return {
    left: rect.left + window.scrollX,
    bottom: rect.bottom + window.scrollY,
    right: rect.right + window.scrollX,
    top: rect.top + window.scrollY,
    viewportLeft: rect.left,
    viewportBottom: rect.bottom
  };
}

function positionTooltip(docCoords) {
  const el = getTooltip();
  el.classList.remove('ds-hidden');
  el.classList.add('ds-visible');
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  el.style.display = 'block';

  const rect = el.getBoundingClientRect();
  const gap = 10;

  let left = docCoords.left;
  let top = docCoords.bottom + gap;

  if (left + rect.width > window.scrollX + window.innerWidth - 10) {
    left = docCoords.right - rect.width;
  }
  if (left < window.scrollX + 10) left = window.scrollX + 10;

  const viewportBottom = docCoords.viewportBottom + gap + rect.height;
  if (viewportBottom > window.innerHeight - 10) {
    top = docCoords.top - rect.height - gap;
  }
  if (top < window.scrollY + 10) top = window.scrollY + 10;

  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function hideTooltip() {
  if (!tooltip) return;
  abortStream();
  tooltip.classList.add('ds-hidden');
  tooltip.classList.remove('ds-visible');
  currentText = null;
  currentExplanation = null;
  isLoading = false;
}

function scheduleHide() {
  clearTimeout(hideTimer); // 先清残留定时器，再判断是否调度（isLoading 时也清，避免残余窗口）
  if (isLoading) return; // 流式生成中不因鼠标移出/选区折叠而隐藏，避免弹窗生成一半消失
  hideTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideTooltip();
  }, 200);
}

// ═══════════════════════════════════════════
// 流式中止
// ═══════════════════════════════════════════

function abortStream() {
  if (currentStreamPort) {
    try { currentStreamPort.disconnect(); } catch {}
    currentStreamPort = null;
  }
}

// ═══════════════════════════════════════════
// 统一流式弹窗触发（解释 & 翻译共用）
// ═══════════════════════════════════════════

async function triggerWithStream({ text, mode, popupTitle }) {
  if (!text || text.length < 2) return;
  if (text === currentText && tooltip?.classList.contains('ds-visible') && !tooltip.querySelector('.ds-error')) return;

  // 中止上一个流
  abortStream();
  currentText = text;
  isLoading = true;
  currentExplanation = null;

  const coords = getSelectionDocCoords() || {
    left: lastContextMenuPos.x,
    bottom: lastContextMenuPos.y,
    right: lastContextMenuPos.x,
    top: lastContextMenuPos.y,
    viewportLeft: lastContextMenuPos.x - window.scrollX,
    viewportBottom: lastContextMenuPos.y - window.scrollY
  };

  const el = getTooltip();
  el.querySelector('.ds-brand').textContent = popupTitle;
  el.querySelector('.ds-quote').textContent = truncate(text, 80);
  el.querySelector('.ds-body').textContent = '';
  el.querySelector('.ds-body').classList.add('ds-streaming');
  el.querySelector('.ds-actions').style.display = 'none';
  el.querySelector('.ds-model-tag').textContent = '';

  positionTooltip(coords);

  // 建立流式连接
  const port = safeConnect(`stream-${Date.now()}`);
  if (!port) {
    isLoading = false;
    el.querySelector('.ds-body').classList.remove('ds-streaming');
    el.querySelector('.ds-body').innerHTML = '<span class="ds-error">扩展已重载，请刷新页面后重试</span>';
    return;
  }
  currentStreamPort = port;
  let buffer = '';

  port.onMessage.addListener((msg) => {
    if (msg.type === 'token') {
      buffer += msg.token;
      // 流式期间直接显示原文 token（避免逐 token 全量 cleanMarkdown 的 O(n²) 开销），done 时统一清理
      el.querySelector('.ds-body').textContent = buffer;
    } else if (msg.type === 'done') {
      isLoading = false;
      const isExplainLike = mode === 'A' || mode === 'C' || mode === 'D';
      const display = isExplainLike ? cleanMarkdown(buffer) : buffer;
      currentExplanation = display;
      el.querySelector('.ds-body').textContent = display;
      el.querySelector('.ds-body').classList.remove('ds-streaming');
      el.querySelector('.ds-actions').style.display = 'flex';
      el.querySelector('.ds-model-tag').textContent = msg.model || '';
      // 🆕 模式 B：翻译完成后显示"解释此句"按钮
      updateExtraActions(mode);
      port.disconnect();
      currentStreamPort = null;
      // 流结束后若鼠标已不在弹窗上，恢复移出自动隐藏
      if (!el.matches(':hover')) scheduleHide();
    } else if (msg.type === 'error') {
      isLoading = false;
      currentExplanation = null;
      el.querySelector('.ds-body').classList.remove('ds-streaming');
      el.querySelector('.ds-body').innerHTML = `<span class="ds-error">${escapeHtml(msg.error)}</span>`;
      el.querySelector('.ds-actions').style.display = 'none';
      port.disconnect();
      currentStreamPort = null;
      // 与 done 分支对称：鼠标已不在弹窗上时恢复自动隐藏
      if (!el.matches(':hover')) scheduleHide();
    }
  });

  port.onDisconnect.addListener(() => {
    // 旧流被新流顶替时（abortStream），其回调不得干扰新流状态
    if (currentStreamPort !== port) return;
    currentStreamPort = null;
    if (isLoading) {
      isLoading = false;
      if (!currentExplanation) {
        el.querySelector('.ds-body').classList.remove('ds-streaming');
        el.querySelector('.ds-body').textContent = '⚠️ 连接中断，请重试';
      }
      if (!el.matches(':hover')) scheduleHide();
    }
  });

  // 发送请求（根据开关决定是否携带上下文）
  const context = usePageContext ? getPageContext() : null;
  port.postMessage({
    type: 'STREAM_REQUEST',
    mode,
    text,
    context
  });
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function cleanMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .trim();
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isInTooltip(node) {
  return tooltip && tooltip.contains(node);
}

// ═══════════════════════════════════════════
// 网页上下文提取
// ═══════════════════════════════════════════

function getPageContext() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  const blockTags = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT', 'ASIDE', 'MAIN', 'SUMMARY']);
  let container = range.commonAncestorContainer;
  while (container && container !== document.body) {
    if (container.nodeType === 1 && blockTags.has(container.tagName)) break;
    container = container.parentElement;
  }
  if (!container || container === document.body) {
    const bodyText = document.body.innerText || '';
    return { title: document.title, before: bodyText.substring(0, 800), after: '' };
  }

  const fullText = container.innerText || container.textContent || '';
  const selIndex = fullText.indexOf(selectedText);
  if (selIndex === -1) {
    let beforeText = '';
    if (range.startContainer.nodeType === 3) {
      beforeText = range.startContainer.textContent.substring(0, range.startOffset);
    }
    return { title: document.title, before: beforeText.slice(-300), after: '' };
  }

  const before = fullText.substring(Math.max(0, selIndex - 300), selIndex);
  const afterStart = selIndex + selectedText.length;
  const after = fullText.substring(afterStart, afterStart + 300);

  return { title: document.title, before, after };
}

// ═══════════════════════════════════════════
// 复制 & 下载
// ═══════════════════════════════════════════

async function handleCopy(e) {
  e.stopPropagation();
  if (!currentExplanation) return;
  try {
    await navigator.clipboard.writeText(currentExplanation);
    const btn = tooltip.querySelector('.ds-btn-copy .ds-btn-label');
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.style.color = '#16a34a';
    setTimeout(() => { btn.textContent = original; btn.style.color = ''; }, 1500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = currentExplanation;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function handleDownload(e) {
  e.stopPropagation();
  if (!currentText || !currentExplanation) return;
  safeSendMessage({
    type: 'DOWNLOAD',
    text: currentText,
    explanation: currentExplanation
  });
  const btn = tooltip.querySelector('.ds-btn-download .ds-btn-label');
  const original = btn.textContent;
  btn.textContent = '已下载';
  btn.style.color = '#16a34a';
  setTimeout(() => { btn.textContent = original; btn.style.color = ''; }, 1500);
}

// 🆕 显示/隐藏 B 类"解释此句"额外按钮
function updateExtraActions(mode) {
  // 移除旧额外按钮
  const oldBtn = tooltip.querySelector('.ds-btn-explain-this');
  if (oldBtn) oldBtn.remove();

  if (mode !== 'B') return;

  const btn = document.createElement('button');
  btn.className = 'ds-btn ds-btn-explain-this';
  btn.title = '结合上下文解释这句话的含义';
  btn.innerHTML = `
    <span class="ds-btn-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="15" x2="15.01" y2="15"></line></svg>
    </span>
    <span class="ds-btn-label">解释此句</span>`;
  btn.addEventListener('click', handleExplainThis);
  btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  tooltip.querySelector('.ds-actions').appendChild(btn);
}

async function handleExplainThis(e) {
  e.stopPropagation();
  e.preventDefault();

  const btn = e.currentTarget;
  // 备份当前文本（防止 currentText 在异步期间被清空）
  const textToExplain = currentText;
  if (!textToExplain) {
    btn.querySelector('.ds-btn-label').textContent = '无文本';
    return;
  }

  btn.disabled = true;
  btn.querySelector('.ds-btn-label').textContent = '解释中…';

  // 三道防线防止卡片关闭
  clearTimeout(hideTimer);
  abortStream();
  isLoading = true;

  // 确保 tooltip 可见
  const el = getTooltip();
  el.classList.add('ds-visible');
  el.classList.remove('ds-hidden');
  el.style.display = 'block';

  const port = safeConnect(`stream-${Date.now()}`);
  if (!port) {
    isLoading = false;
    btn.disabled = false;
    btn.querySelector('.ds-btn-label').textContent = '重试（需刷新页面）';
    return;
  }
  currentStreamPort = port;

  el.querySelector('.ds-body').textContent = '';
  el.querySelector('.ds-body').classList.add('ds-streaming');
  let buffer = '';

  const cleanup = () => {
    isLoading = false;
    el.querySelector('.ds-body').classList.remove('ds-streaming');
    btn.remove();
    currentStreamPort = null;
    try { port.disconnect(); } catch {}
  };

  port.onMessage.addListener((msg) => {
    if (msg.type === 'token') {
      buffer += msg.token;
      // 流式期间直接显示，done 时统一 cleanMarkdown（避免逐 token 全量清理）
      el.querySelector('.ds-body').textContent = buffer;
    } else if (msg.type === 'done') {
      currentExplanation = cleanMarkdown(buffer);
      el.querySelector('.ds-body').textContent = currentExplanation;
      cleanup();
      // 流结束后若鼠标已不在弹窗上，恢复移出自动隐藏
      if (!el.matches(':hover')) scheduleHide();
    } else if (msg.type === 'error') {
      el.querySelector('.ds-body').innerHTML = `<span class="ds-error">${escapeHtml(msg.error)}</span>`;
      cleanup();
    }
  });

  port.onDisconnect.addListener(() => {
    // 旧流被新流顶替时，其回调不得干扰新流状态
    if (currentStreamPort !== port) return;
    if (isLoading) {
      if (!el.querySelector('.ds-body').textContent) {
        el.querySelector('.ds-body').textContent = '⚠️ 连接中断';
      }
      cleanup();
    }
  });

  port.postMessage({
    type: 'STREAM_REQUEST',
    mode: 'D',
    text: textToExplain,
    context: usePageContext ? getPageContext() : null
  });
}

// ═══════════════════════════════════════════
// 事件监听：触发模式
// ═══════════════════════════════════════════

(async function initTriggerMode() {
  try {
    const stored = await chrome.storage.local.get({ triggerMode: 'auto', usePageContext: true });
    triggerMode = stored.triggerMode || 'auto';
    usePageContext = stored.usePageContext !== false;
  } catch {}
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.triggerMode) {
    triggerMode = changes.triggerMode.newValue || 'auto';
  }
  if (changes.usePageContext) {
    usePageContext = changes.usePageContext.newValue !== false;
  }
});

// ── 右键点击位置记录 ──
document.addEventListener('contextmenu', (e) => {
  lastContextMenuPos.x = e.clientX + window.scrollX;
  lastContextMenuPos.y = e.clientY + window.scrollY;
});

// ── 检测是否在输入框/搜索框/编辑器内（用户正在编辑，不触发）──
function isEditingElement() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute('role');
  if (role === 'searchbox' || role === 'textbox') return true;
  return false;
}

// ── mouseup 自动触发（auto 模式：分类 → 智能解释）──
document.addEventListener('mouseup', (e) => {
  if (isInTooltip(e.target)) return;
  if (triggerMode !== 'auto') return;
  if (e.button !== 0) return; // 仅左键拖动选区触发，避免右键点击误触发

  clearTimeout(selectionDebounce);
  selectionDebounce = setTimeout(() => {
    if (isEditingElement()) return;
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text || text.length < 2) {
      if (!isLoading) hideTooltip();
      return;
    }
    if (text === currentText && tooltip?.classList.contains('ds-visible') && !tooltip.querySelector('.ds-error')) return;

    const mode = classifyText(text);
    triggerWithStream({ text, mode, popupTitle: `DeepSeek ${modeLabel(mode)}` });
  }, 150);
});

// ── 接收来自 background（右键菜单）的消息 ──
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TRIGGER_EXPLAIN' && message.text) {
    const mode = classifyText(message.text);
    triggerWithStream({ text: message.text, mode, popupTitle: `DeepSeek ${modeLabel(mode)}` });
  }
  if (message.type === 'TRIGGER_FULLPAGE_TRANSLATE') {
    safeSendMessage({ type: 'INJECT_FULLPAGE_TRANSLATE' });
  }
});

// ── 点击弹窗外部关闭 ──
document.addEventListener('mousedown', (e) => {
  if (tooltip?.classList.contains('ds-visible') && !isInTooltip(e.target)) {
    hideTooltip();
  }
});

document.addEventListener('selectionchange', () => {
  if (!tooltip?.classList.contains('ds-visible')) return;
  const sel = window.getSelection();
  if (sel.isCollapsed && !isLoading) scheduleHide();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tooltip?.classList.contains('ds-visible')) {
    hideTooltip();
  }
});

window.addEventListener('scroll', () => {
  if (!tooltip?.classList.contains('ds-visible')) return;
  if (isLoading) return;
  // rAF 节流：滚动事件高频触发，避免每帧强制布局
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideTooltip(); return; }
    const coords = getSelectionDocCoords();
    if (coords) positionTooltip(coords);
    else hideTooltip();
  });
}, { passive: true });
