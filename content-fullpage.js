// ========== DeepSeek 全文翻译 — Content Script ==========
// 由 background.js 通过 chrome.scripting.executeScript 按需注入
// 职责：DOM 文本扫描 → 段落级流式翻译 → 覆盖原文 → 视口感知 → 还原

(function () {
  'use strict';

  // 防止重复注入
  if (window.__dsFullPageTranslatorActive) return;
  window.__dsFullPageTranslatorActive = true;

  // ═══════════════════════════════════════════
  // 配置（从 storage 读取）
  // ═══════════════════════════════════════════

  let targetLanguage = 'zh';
  let concurrency = 100;
  let rootMargin = '500px 0px';

  // ═══════════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════════

  const translatedElements = new Set();
  const originalHTML = new Map();       // element → innerHTML 备份
  const originalTexts = new Map();      // element → 纯文本备份
  let toolbar = null;
  let observer = null;
  let activeStreamPorts = new Set();
  let totalBlocks = 0;
  let completedBlocks = 0;
  let aborted = false;

  // ═══════════════════════════════════════════
  // 阻止翻译的元素选择器
  // ═══════════════════════════════════════════

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD',
    'TEXTAREA', 'INPUT', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
    'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR'
  ]);

  const SKIP_CLASSES = ['ds-translating', 'ds-translated-placeholder'];

  function isSkippable(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute('data-ds-translated')) return true;
    if (el.hasAttribute('data-ds-skip')) return true;
    if (el.closest('#ds-translate-toolbar')) return true;
    if (el.closest('#deepseek-explain-tooltip')) return true;
    // 跳过无可见文本的元素
    if (el.offsetParent === null && el.tagName !== 'BODY') {
      // 但允许 position:fixed/sticky 的元素
      const style = window.getComputedStyle(el);
      if (style.position === 'static') return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════
  // 收集可翻译的块级元素
  // ═══════════════════════════════════════════

  const BLOCK_SELECTOR = [
    'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figcaption', 'dd', 'dt', 'legend', 'summary', 'blockquote',
    'div', 'section', 'article',
    'header', 'footer', 'nav', 'aside', 'main', 'caption',
    'option', 'optgroup', 'title'
  ].join(',');

  function collectTranslatableBlocks(root = document.body) {
    const candidates = root.querySelectorAll(BLOCK_SELECTOR);
    const blocks = [];

    for (const el of candidates) {
      if (isSkippable(el)) continue;
      if (translatedElements.has(el)) continue;

      const directText = getDirectText(el);
      if (!directText || directText.trim().length < 2) continue;

      blocks.push(el);
    }

    return blocks;
  }

  function getDirectText(el) {
    // 收集直接子文本节点 + 内联元素内的文本，跳过块级后代
    let text = '';
    const blockTags = new Set([
      'P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'TR',
      'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'PRE', 'FORM', 'FIELDSET'
    ]);

    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        text += child.textContent;
      } else if (child.nodeType === 1) {
        if (blockTags.has(child.tagName)) continue;
        text += child.textContent || '';
      }
    }

    return text.trim();
  }

  // ═══════════════════════════════════════════
  // 工具栏
  // ═══════════════════════════════════════════

  function injectToolbar() {
    if (document.getElementById('ds-translate-toolbar')) return;

    toolbar = document.createElement('div');
    toolbar.id = 'ds-translate-toolbar';
    toolbar.innerHTML = `
      <span class="ds-tb-status">🌐 翻译中…</span>
      <span class="ds-tb-progress" id="ds-tb-progress">0 / 0</span>
      <button class="ds-tb-btn" id="ds-tb-show-original">显示原文</button>
      <button class="ds-tb-btn ds-tb-danger" id="ds-tb-cancel">取消翻译</button>
    `;
    document.body.prepend(toolbar);

    document.getElementById('ds-tb-show-original').addEventListener('click', toggleOriginal);
    document.getElementById('ds-tb-cancel').addEventListener('click', cancel);
  }

  function updateProgress() {
    const el = document.getElementById('ds-tb-progress');
    if (el) el.textContent = `${completedBlocks} / ${totalBlocks}`;
    const status = toolbar?.querySelector('.ds-tb-status');
    if (status) {
      status.textContent = completedBlocks >= totalBlocks && totalBlocks > 0
        ? '✅ 翻译完成'
        : '🌐 翻译中…';
    }
  }

  // ═══════════════════════════════════════════
  // 还原 & 取消
  // ═══════════════════════════════════════════

  let showingOriginal = false;

  function toggleOriginal() {
    showingOriginal = !showingOriginal;
    const btn = document.getElementById('ds-tb-show-original');
    if (btn) btn.textContent = showingOriginal ? '显示译文' : '显示原文';

    for (const [el, html] of originalHTML) {
      if (showingOriginal) {
        el.setAttribute('data-ds-translation', el.innerHTML);
        el.innerHTML = html;
      } else {
        const translation = el.getAttribute('data-ds-translation');
        if (translation) el.innerHTML = translation;
      }
    }
  }

  function cancel() {
    aborted = true;

    // 中止所有进行中的流
    for (const port of activeStreamPorts) {
      try { port.disconnect(); } catch {}
    }
    activeStreamPorts.clear();

    // 断开观察器
    if (observer) observer.disconnect();

    // 还原所有原文
    for (const [el, html] of originalHTML) {
      el.innerHTML = html;
      el.removeAttribute('data-ds-original');
      el.removeAttribute('data-ds-translated');
      el.removeAttribute('data-ds-translation');
    }

    // 移除工具栏
    if (toolbar) toolbar.remove();

    // 清理
    translatedElements.clear();
    originalHTML.clear();
    originalTexts.clear();
    window.__dsFullPageTranslatorActive = false;
  }

  // ═══════════════════════════════════════════
  // 流式翻译单个块元素
  // ═══════════════════════════════════════════

  // 检测元素是否包含不可丢失的子元素（图片、链接等）
  function hasFragileChildren(el) {
    const fragile = el.querySelectorAll('img, iframe, video, audio, canvas, svg, input, button, select, textarea, picture, source, object, embed');
    return fragile.length > 0;
  }

  async function translateBlockElement(el) {
    if (aborted) return;
    if (translatedElements.has(el)) return;
    translatedElements.add(el);

    const directText = getDirectText(el);
    if (!directText || directText.trim().length < 2) return;

    // 包含图片/链接等 → 保留原文，只标记为已处理
    if (hasFragileChildren(el)) {
      el.setAttribute('data-ds-translated', 'true');
      completedBlocks++;
      updateProgress();
      return;
    }

    originalHTML.set(el, el.innerHTML);
    originalTexts.set(el, directText);
    el.setAttribute('data-ds-original', 'true');

    // 段首插入低调指示器，原文保持可见（减少页面跳动）
    el.insertAdjacentHTML('afterbegin',
      '<span class="ds-translating-indicator"><span class="ds-dot"></span>翻译中</span>');
    const indicator = el.querySelector('.ds-translating-indicator');

    let port;
    try {
      port = chrome.runtime.connect({ name: `stream-fp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    } catch {
      // connect 失败（扩展重载等），还原
      indicator?.remove();
      el.setAttribute('data-ds-translated', 'true');
      completedBlocks++;
      updateProgress();
      return;
    }
    activeStreamPorts.add(port);

    // 30 秒超时
    const timeout = setTimeout(() => {
      if (!el.hasAttribute('data-ds-translated')) {
        indicator?.remove();
        el.setAttribute('data-ds-translated', 'true');
        completedBlocks++;
        updateProgress();
      }
      try { port.disconnect(); } catch {}
    }, 30000);

    return new Promise((resolve) => {
      let buffer = '';

      port.onMessage.addListener((msg) => {
        if (aborted) { cleanup(); resolve(); return; }

        if (msg.type === 'token') {
          buffer += msg.token;
          // 流式期间不更新 DOM，保留原文+指示器，避免跳动
        } else if (msg.type === 'done') {
          clearTimeout(timeout);
          indicator?.remove();
          el.textContent = buffer;
          el.setAttribute('data-ds-translated', 'true');
          activeStreamPorts.delete(port);
          port.disconnect();
          completedBlocks++;
          updateProgress();
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          indicator?.remove();
          el.setAttribute('data-ds-translated', 'true');
          activeStreamPorts.delete(port);
          port.disconnect();
          completedBlocks++;
          updateProgress();
          resolve();
        }
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        activeStreamPorts.delete(port);
        if (!el.hasAttribute('data-ds-translated')) {
          indicator?.remove();
          el.setAttribute('data-ds-translated', 'true');
          completedBlocks++;
          updateProgress();
        }
        resolve();
      });

      port.postMessage({
        type: 'STREAM_BATCH',
        promptType: 'translate',
        text: directText,
        context: { title: document.title, url: window.location.href },
        batchId: `fp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
      });
    });
  }

  // ═══════════════════════════════════════════
  // 翻译队列（并发控制）
  // ═══════════════════════════════════════════

  class TranslateQueue {
    constructor(maxConcurrency = 3) {
      this.queue = [];
      this.active = 0;
      this.max = maxConcurrency;
    }

    add(el) {
      if (aborted) return;
      this.queue.push(el);
      this.processNext();
    }

    async processNext() {
      if (aborted) return;
      if (this.active >= this.max || this.queue.length === 0) return;

      this.active++;
      const el = this.queue.shift();
      try {
        await translateBlockElement(el);
      } catch {
        // 静默失败，避免阻塞队列
      } finally {
        this.active--;
        this.processNext();
      }
    }
  }

  const queue = new TranslateQueue(concurrency);

  // ═══════════════════════════════════════════
  // 视口感知（IntersectionObserver）
  // ═══════════════════════════════════════════

  function setupViewportObserver() {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !aborted) {
            const el = entry.target;
            if (!translatedElements.has(el)) {
              queue.add(el);
            }
            observer.unobserve(el);
          }
        }
      },
      { rootMargin, threshold: 0 }
    );
  }

  // ═══════════════════════════════════════════
  // 启动入口
  // ═══════════════════════════════════════════

  async function start() {
    // 重置状态（支持重复翻译）
    aborted = false;
    showingOriginal = false;
    try {
      const config = await chrome.storage.local.get({
        targetLanguage: 'zh'
      });
      targetLanguage = config.targetLanguage || 'zh';
    } catch {}

    // 注入工具栏
    injectToolbar();

    // 收集所有可翻译块
    const blocks = collectTranslatableBlocks();
    totalBlocks = blocks.length;
    completedBlocks = 0;
    updateProgress();

    if (totalBlocks === 0) {
      const status = toolbar?.querySelector('.ds-tb-status');
      if (status) status.textContent = '⚠️ 未找到可翻译文本';
      return;
    }

    // 设置视口观察器
    setupViewportObserver();

    // 先翻译已在视口内的
    const viewportBlocks = blocks.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight + 500 && rect.bottom > -500;
    });

    // 其余注册到观察器
    for (const el of blocks) {
      if (!viewportBlocks.includes(el)) {
        observer.observe(el);
      }
    }

    // 视口内按从上到下排序后加入队列
    viewportBlocks.sort((a, b) => {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });

    for (const el of viewportBlocks) {
      queue.add(el);
    }
  }

  // ═══════════════════════════════════════════
  // 页面卸载清理
  // ═══════════════════════════════════════════

  window.addEventListener('beforeunload', () => {
    aborted = true;
    for (const port of activeStreamPorts) {
      try { port.disconnect(); } catch {}
    }
    if (observer) observer.disconnect();
  });

  // 暴露 API 到全局
  window.__dsFullPageTranslator = {
    start,
    cancel,
    toggleOriginal,
    get progress() { return { completed: completedBlocks, total: totalBlocks }; }
  };

  // 自动启动
  start().catch(console.error);

})();
