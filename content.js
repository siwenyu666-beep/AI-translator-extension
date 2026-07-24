// ========== DeepSeek 智能解释 - Content Script ==========
// 职责：监听文本选择 → 请求解释 → 显示浮动卡片

let tooltip = null;
let currentText = null;
let currentExplanation = null;
let isLoading = false;
let hideTimer = null;
let pendingRequest = 0;

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT', 'ASIDE', 'MAIN', 'SUMMARY']);

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
        <span class="ds-download-status"></span>
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
  const st = tooltip.querySelector('.ds-download-status');
  if (st) { st.className = 'ds-download-status'; st.textContent = ''; }
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
  const tag = model ? model.replace('deepseek-v4-', '') : '';
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
async function handleDownload(e) {
  e.stopPropagation();
  if (!currentText || !currentExplanation) return;

  const statusEl = getTooltip().querySelector('.ds-download-status');

  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `DeepSeek解释_${ts}.txt`;

    const text = [
      `DeepSeek 智能解释`,
      `生成时间: ${now.toLocaleString('zh-CN')}`,
      `来源页面: ${location.href}`,
      ``,
      `── 选中原文 ──`,
      currentText,
      ``,
      `── 解释内容 ──`,
      currentExplanation,
      ``,
    ].join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    statusEl.textContent = `已下载于 默认下载目录\\${filename}`;
    statusEl.className = 'ds-download-status ds-status-visible';
  } catch (err) {
    statusEl.textContent = `下载失败：${err.message}`;
    statusEl.className = 'ds-download-status ds-status-visible ds-status-error';
  }
}

// ── 提取网页上下文 ──
function getPageContext() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  // 向上查找最近的块级父元素
  let container = range.commonAncestorContainer;
  while (container && container !== document.body) {
    if (container.nodeType === 1 && BLOCK_TAGS.has(container.tagName)) break;
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

// ── 缓存 & 配置 ──
const CACHE = new Map();
const CACHE_MAX = 50;

async function getConfig() {
  const defaults = {
    apiKey: '',
    model: 'deepseek-v4-flash',
    enabled: true,
    language: 'auto',
    usePageContext: true,
    thinkingEnabled: false,
    reasoningEffort: 'high'
  };
  return await chrome.storage.local.get(defaults);
}

// ── 构建 Prompt ──
function buildPrompt(text, language, context) {
  const langHint = language === 'auto'
    ? '请自动检测文本语言：如果是英文，用英文解释；如果是中文，用中文解释；其他语言用中文解释。'
    : language === 'en'
      ? '请用英文解释以下内容。'
      : '请用中文解释以下内容。';

  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[网页标题]\n${context.title || '未知'}\n\n[选中文本的上下文]\n...${context.before || ''}[选中文本]${context.after || ''}...\n`;
  }

  return `你是一个知识渊博、擅于解释的助手。用户选中了一段文本，请结合上下文给出简洁清晰的分点解释。
${contextBlock}
[需要解释的文本]
"""
${text}
"""

规则：
- ${langHint}
- 用编号列表（1. 2. 3.）分点解释，每点一行
- 结合上文和下文的语境来理解选中文本的具体含义
- 如果选中文本在上下文中是专业术语或特定领域的用法，请给出该领域内的解释
- 不要使用任何 Markdown 格式：不要用 ** 加粗、不要用 * 斜体、不要用反引号、不要用标题符号
- 如果文本是单词或短语：分点给出释义、词性、用法、例句
- 如果文本是句子或段落：分点解释含义、背景、关键信息
- 如果是专业术语：分点给出定义、背景、相关知识
- 整体控制在 3~5 个要点，每个要点一句话，简洁有力
- 不要写"这段文字说的是"之类的开场白，直接分点解释`;
}

// ── 调用 DeepSeek API（直接 fetch，不经过 Service Worker）──
async function callDeepSeek(apiKey, model, prompt, thinkingEnabled, reasoningEffort) {
  const controller = new AbortController();
  const timeoutMs = thinkingEnabled ? 30000 : 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: model,
      messages: [
        { role: 'system', content: '你是一个知识渊博、擅于解释的助手。给出简洁清晰的解释，不要重复开场白，直接解释。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 400,
      stream: false
    };

    if (thinkingEnabled) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = reasoningEffort || 'high';
    }

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401) throw new Error('API Key 无效，请检查设置');
      if (res.status === 402) throw new Error('账户余额不足，请充值');
      if (res.status === 403) throw new Error('API Key 无权访问，请检查');
      if (res.status === 429) throw new Error('请求过于频繁，请稍后再试');
      if (res.status === 400) throw new Error('请求参数有误，请重试');
      throw new Error(`API 错误 (${res.status}): ${errBody.slice(0, 100)}`);
    }

    const data = await res.json();
    const text_result = data?.choices?.[0]?.message?.content;
    if (!text_result) throw new Error('DeepSeek 未返回有效解释，请重试');
    return text_result.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ── 请求解释 ──
async function requestExplanation(text) {
  const reqId = ++pendingRequest;

  try {
    const config = await getConfig();
    if (!config.apiKey) {
      if (isStale(reqId)) return;
      setError(text, '请先在扩展弹窗中设置 DeepSeek API Key');
      return;
    }
    if (config.enabled === false) {
      if (isStale(reqId)) return;
      setError(text, '扩展已禁用');
      return;
    }

    const useContext = config.usePageContext !== false;
    const context = useContext ? getPageContext() : null;
    const cacheKey = useContext ? `${config.model}:${location.origin}${location.pathname}:${text}` : `${config.model}:${text}`;

    if (CACHE.has(cacheKey)) {
      if (isStale(reqId)) return;
      setExplanation(text, CACHE.get(cacheKey), config.model, true);
      return;
    }

    const prompt = buildPrompt(text, config.language, context);
    const explanation = await callDeepSeek(config.apiKey, config.model, prompt, config.thinkingEnabled, config.reasoningEffort);

    if (isStale(reqId)) return;

    CACHE.set(cacheKey, explanation);
    if (CACHE.size > CACHE_MAX) {
      const first = CACHE.keys().next().value;
      CACHE.delete(first);
    }

    setExplanation(text, explanation, config.model, false);
  } catch (err) {
    if (isStale(reqId)) return;
    setError(text, err.message || '请求失败，请重试');
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

function isStale(reqId) { return reqId !== pendingRequest; }

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
