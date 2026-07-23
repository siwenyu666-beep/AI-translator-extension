// ========== DeepSeek 智能解释 - Content Script ==========
// 职责：监听文本选择 → 请求解释 → 显示浮动卡片

let tooltip = null;
let currentText = null;
let currentExplanation = null;
let isLoading = false;
let hideTimer = null;
let pendingRequest = 0;

// ── 创建弹窗 DOM（只创建一次） ──
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
        <button class="ds-btn ds-btn-copy" title="复制解释内容">
          <span class="ds-btn-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </span>
          <span class="ds-btn-label">复制</span>
        </button>
        <button class="ds-btn ds-btn-download" title="下载解释内容">
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

// ── 获取选中文本在文档中的坐标 ──
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

// ── 显示/更新弹窗位置（使用文档坐标）──
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
  tooltip.classList.add('ds-hidden');
  tooltip.classList.remove('ds-visible');
  currentText = null;
  currentExplanation = null;
  isLoading = false;
  pendingRequest++;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideTooltip();
  }, 200);
}

// ── 设置加载状态 ──
function setLoading(text) {
  isLoading = true;
  currentExplanation = null;
  const el = getTooltip();
  el.querySelector('.ds-quote').textContent = truncate(text, 80);
  el.querySelector('.ds-body').innerHTML = '<div class="ds-loading"><span class="ds-spinner"></span>DeepSeek 思考中…</div>';
  el.querySelector('.ds-model-tag').textContent = '';
  el.querySelector('.ds-actions').style.display = 'none';
}

// ── 清理 Markdown 标记 ──
function cleanMarkdown(text) {
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

// ── 设置解释内容 ──
function setExplanation(text, explanation, model, cached) {
  isLoading = false;
  const cleaned = cleanMarkdown(explanation);
  currentExplanation = cleaned;
  const el = getTooltip();
  el.querySelector('.ds-quote').textContent = truncate(text, 80);
  el.querySelector('.ds-body').textContent = cleaned;
  const tag = model ? model.replace('deepseek-', '') : '';
  el.querySelector('.ds-model-tag').textContent = cached ? (tag + ' · 缓存') : tag;
  el.querySelector('.ds-actions').style.display = 'flex';
}

// ── 设置错误 ──
function setError(text, errMsg) {
  isLoading = false;
  currentExplanation = null;
  const el = getTooltip();
  el.querySelector('.ds-quote').textContent = truncate(text, 80);
  el.querySelector('.ds-body').innerHTML = `<span class="ds-error">${escapeHtml(errMsg)}</span>`;
  el.querySelector('.ds-model-tag').textContent = '';
  el.querySelector('.ds-actions').style.display = 'none';
}

// ── 复制解释 ──
async function handleCopy(e) {
  e.stopPropagation();
  if (!currentExplanation) return;

  try {
    await navigator.clipboard.writeText(currentExplanation);
    const btn = tooltip.querySelector('.ds-btn-copy .ds-btn-label');
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.style.color = '#16a34a';
    setTimeout(() => {
      btn.textContent = original;
      btn.style.color = '';
    }, 1500);
  } catch {
    // fallback
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

// ── 下载解释 ──
function handleDownload(e) {
  e.stopPropagation();
  if (!currentText || !currentExplanation) return;

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD',
    text: currentText,
    explanation: currentExplanation
  });

  const btn = tooltip.querySelector('.ds-btn-download .ds-btn-label');
  const original = btn.textContent;
  btn.textContent = '已下载';
  btn.style.color = '#16a34a';
  setTimeout(() => {
    btn.textContent = original;
    btn.style.color = '';
  }, 1500);
}

// ── 提取网页上下文 ──
function getPageContext() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  // 向上查找最近的块级父元素
  const blockTags = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT', 'ASIDE', 'MAIN', 'SUMMARY']);
  let container = range.commonAncestorContainer;
  while (container && container !== document.body) {
    if (container.nodeType === 1 && blockTags.has(container.tagName)) break;
    container = container.parentElement;
  }
  if (!container || container === document.body) {
    // fallback: 取 body 文本（限制长度）
    const bodyText = document.body.innerText || '';
    return {
      title: document.title,
      before: bodyText.substring(0, 800),
      after: ''
    };
  }

  const fullText = container.innerText || container.textContent || '';
  const selIndex = fullText.indexOf(selectedText);
  if (selIndex === -1) {
    // 选中文本可能跨元素，用 startContainer 的文本估位置
    let beforeText = '';
    if (range.startContainer.nodeType === 3) {
      const offset = range.startOffset;
      beforeText = range.startContainer.textContent.substring(0, offset);
    }
    return {
      title: document.title,
      before: beforeText.slice(-300),
      after: ''
    };
  }

  const before = fullText.substring(Math.max(0, selIndex - 300), selIndex);
  const afterStart = selIndex + selectedText.length;
  const after = fullText.substring(afterStart, afterStart + 300);

  return {
    title: document.title,
    before: before,
    after: after
  };
}

// ── 请求解释 ──
async function requestExplanation(text) {
  const reqId = ++pendingRequest;

  try {
    const context = getPageContext();
    const res = await chrome.runtime.sendMessage({
      type: 'EXPLAIN',
      text,
      context
    });
    if (reqId !== pendingRequest) return;

    if (res.error) {
      setError(text, res.error);
    } else {
      setExplanation(text, res.explanation, res.model, res.cached);
    }
  } catch (err) {
    if (reqId !== pendingRequest) return;
    setError(text, '无法连接到扩展，请刷新页面后重试');
  }
}

// ── 工具函数 ──
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

// ── 事件监听 ──
// ── 触发模式与鼠标事件 ──
let triggerMode = 'auto';
let debounceTimer = null;

// ── 异步加载触发模式配置 ──
(async function initTriggerMode() {
  try {
    const stored = await chrome.storage.local.get({ triggerMode: 'auto' });
    triggerMode = stored.triggerMode || 'auto';
  } catch { /* storage 不可用时保持默认值 */ }
})();

// ── 监听配置变更，实时切换触发模式 ──
chrome.storage.onChanged.addListener((changes) => {
  if (changes.triggerMode) {
    triggerMode = changes.triggerMode.newValue || 'auto';
  }
});

// ── 记录右键点击位置（作为弹窗定位 fallback）──
let lastContextMenuPos = { x: 0, y: 0 };

document.addEventListener('contextmenu', (e) => {
  lastContextMenuPos.x = e.clientX + window.scrollX;
  lastContextMenuPos.y = e.clientY + window.scrollY;
});

// ── mouseup 自动触发（仅在 auto 模式下生效）──
document.addEventListener('mouseup', (e) => {
  if (isInTooltip(e.target)) return;
  if (triggerMode !== 'auto') return;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text || text.length < 2) {
      if (!isLoading) hideTooltip();
      return;
    }
    if (text === currentText && tooltip && tooltip.classList.contains('ds-visible')) return;
    triggerExplanation(text);
  }, 150);
});

// ── 接收来自右键菜单的触发消息 ──
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TRIGGER_EXPLAIN' && message.text) {
    triggerExplanation(message.text);
  }
});

// ── 由右键菜单触发的解释流程 ──
function triggerExplanation(text) {
  if (!text || text.length < 2) return;

  if (text === currentText && tooltip && tooltip.classList.contains('ds-visible')) return;

  currentText = text;

  // 优先用当前 selection 坐标，获取不到则用右键点击位置
  let coords = getSelectionDocCoords();
  if (!coords) {
    coords = {
      left: lastContextMenuPos.x,
      bottom: lastContextMenuPos.y,
      right: lastContextMenuPos.x,
      top: lastContextMenuPos.y,
      viewportLeft: lastContextMenuPos.x - window.scrollX,
      viewportBottom: lastContextMenuPos.y - window.scrollY
    };
  }

  setLoading(text);
  positionTooltip(coords);
  requestExplanation(text);
}

document.addEventListener('mousedown', (e) => {
  if (tooltip && tooltip.classList.contains('ds-visible') && !isInTooltip(e.target)) {
    hideTooltip();
  }
});

document.addEventListener('selectionchange', () => {
  if (!tooltip || !tooltip.classList.contains('ds-visible')) return;

  const sel = window.getSelection();
  if (sel.isCollapsed && !isLoading) {
    scheduleHide();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tooltip && tooltip.classList.contains('ds-visible')) {
    hideTooltip();
  }
});

window.addEventListener('scroll', () => {
  if (!tooltip || !tooltip.classList.contains('ds-visible')) return;
  if (isLoading) return;

  const sel = window.getSelection();
  if (sel.isCollapsed) {
    hideTooltip();
    return;
  }

  const coords = getSelectionDocCoords();
  if (coords) {
    positionTooltip(coords);
  } else {
    hideTooltip();
  }
}, { passive: true });
