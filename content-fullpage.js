// ========== DeepSeek 全文翻译 — Content Script ==========
// 由 background.js 通过 chrome.scripting.executeScript 按需注入
// 职责：DOM 文本扫描 → 段落级流式翻译 → 覆盖原文 → 视口感知 → 还原

(function () {
  'use strict';

  // 防止重复注入；若已激活（用户再次触发全文翻译）
  if (window.__dsFullPageTranslatorActive) {
    // 翻译进行中：提示等待，不推倒重来
    const progress = window.__dsFullPageTranslator?.progress;
    if (progress && progress.completed < progress.total) {
      const tb = document.getElementById('ds-translate-toolbar');
      const status = tb?.querySelector('.ds-tb-status');
      if (status) status.textContent = '⏳ 正在翻译中，请等待完成…';
    } else {
      // 已完成/已取消：重新翻译
      window.__dsFullPageTranslator?.start?.().catch?.(console.error);
    }
    return;
  }
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
  let toolbar = null;
  let observer = null;
  let mutationObserver = null;
  let activeStreamPorts = new Set();
  let totalBlocks = 0;
  let completedBlocks = 0;
  let failedBlocks = 0;
  let aborted = false;

  // ═══════════════════════════════════════════
  // 阻止翻译的元素选择器
  // ═══════════════════════════════════════════

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD',
    'TEXTAREA', 'INPUT', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
    'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR',
    'BUTTON', 'SELECT', 'OPTION'
  ]);

  function isSkippable(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute('data-ds-translated')) return true;
    if (el.hasAttribute('data-ds-skip')) return true;
    if (el.closest('#ds-translate-toolbar')) return true;
    if (el.closest('#deepseek-explain-tooltip')) return true;
    // 跳过无可见文本的元素（用 checkVisibility 替代昂贵的 getComputedStyle）
    if (el.offsetParent === null && el.tagName !== 'BODY') {
      // 但允许 position:fixed/sticky 等可见悬浮元素
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility()) return true;
      } else {
        const style = window.getComputedStyle(el);
        if (style.position === 'static') return true;
      }
    }
    return false;
  }

  // 目标语言检测：已是目标语言的块直接跳过，不消耗 API token
  function isAlreadyTargetLang(text, target) {
    if (target !== 'zh') return false; // 仅对中文目标做保守检测
    const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (han === 0) return false;
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    // 日文/韩文含大量汉字，按假名/谚文比例排除，避免误判
    if (kana / text.length > 0.1 || hangul / text.length > 0.1) return false;
    return han / text.length >= 0.5;
  }

  // ═══════════════════════════════════════════
  // 收集可翻译的块级元素
  // ═══════════════════════════════════════════

  const BLOCK_SELECTOR = [
    'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figcaption', 'dd', 'dt', 'legend', 'summary', 'blockquote',
    'div', 'section', 'article',
    'header', 'footer', 'nav', 'aside', 'main', 'caption'
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

  // 块级标签：翻译粒度按块划分，嵌套块级元素由各自块处理
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'TR',
    'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'PRE', 'FORM', 'FIELDSET',
    'FIGCAPTION', 'DD', 'DT', 'LEGEND', 'SUMMARY', 'CAPTION' // 与 BLOCK_SELECTOR 保持一致
  ]);

  function getDirectText(el) {
    // 收集文本（递归 walk：跳过块级后代与不可见元素），与 applyTranslation 的落盘遍历规则一致
    let text = '';
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.textContent;
        } else if (child.nodeType === 1) {
          if (BLOCK_TAGS.has(child.tagName) || SKIP_TAGS.has(child.tagName)) continue;
          walk(child);
        }
      }
    })(el);
    return text.trim();
  }

  // 落盘译文：保留原有结构（img/a/script 等元素不删除），只替换文本节点，避免脚本源码/图片被破坏
  function applyTranslation(el, buffer) {
    // 按 DOM 顺序收集可替换的文本节点（跳过块级后代与不可见元素内部）
    const textNodes = [];
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          textNodes.push(child);
        } else if (child.nodeType === 1) {
          if (BLOCK_TAGS.has(child.tagName) || SKIP_TAGS.has(child.tagName)) continue;
          walk(child);
        }
      }
    })(el);
    if (textNodes.length === 0) {
      // 没有可替换文本节点（如纯媒体/控件块）：保持原文，不落盘
      return;
    }
    textNodes[0].textContent = buffer;
    for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = '';
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
        ? (failedBlocks > 0 ? `✅ 翻译完成（${failedBlocks} 块失败）` : '✅ 翻译完成')
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
    if (mutationObserver) mutationObserver.disconnect();

    // 还原所有原文
    for (const [el, html] of originalHTML) {
      el.innerHTML = html;
      el.removeAttribute('data-ds-original');
      el.removeAttribute('data-ds-translated');
      el.removeAttribute('data-ds-translation');
      el.removeAttribute('data-ds-failed');
    }

    // 移除工具栏
    if (toolbar) toolbar.remove();

    // 清理
    translatedElements.clear();
    originalHTML.clear();
    window.__dsFullPageTranslatorActive = false;
  }

  // ═══════════════════════════════════════════
  // 流式翻译单个块元素
  // ═══════════════════════════════════════════

  // 统一收尾：落盘译文并计数（已脱离 DOM 的块不计数，计数由 removedNodes 修正）
  function finishBlock(el, translatedText, indicator) {
    indicator?.remove();
    if (!el.isConnected) {
      // 块已被 SPA 移除：removedNodes 对“翻译中”的块不递减，由这里补计数
      el.setAttribute('data-ds-translated', 'true'); // 幂等标记，防止 onDisconnect 二次收尾
      if (totalBlocks > 0) totalBlocks--;
      updateProgress();
      return;
    }
    if (translatedText !== undefined && translatedText.trim()) {
      applyTranslation(el, translatedText);
      el.removeAttribute('data-ds-failed');
    } else {
      failedBlocks++; // 空译文/失败：保留原文，计入失败数
      el.setAttribute('data-ds-failed', 'true');
    }
    el.setAttribute('data-ds-translated', 'true');
    completedBlocks++;
    updateProgress();
  }

  async function translateBlockElement(el) {
    if (aborted) return;
    if (!el.isConnected) return; // 已脱离 DOM（SPA 移除/移动）的块不翻译，计数由 removedNodes 修正
    if (translatedElements.has(el)) return;
    translatedElements.add(el);

    const directText = getDirectText(el);
    if (!directText || directText.trim().length < 2) return;

    originalHTML.set(el, el.innerHTML);
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
      finishBlock(el, undefined, indicator);
      return;
    }
    activeStreamPorts.add(port);

    // 30 秒超时
    const timeout = setTimeout(() => {
      if (!el.hasAttribute('data-ds-translated')) {
        finishBlock(el, undefined, indicator);
      }
      try { port.disconnect(); } catch {}
    }, 30000);

    return new Promise((resolve) => {
      let buffer = '';

      port.onMessage.addListener((msg) => {
        if (aborted) { resolve(); return; }

        if (msg.type === 'token') {
          buffer += msg.token;
          // 流式期间不更新 DOM，保留原文+指示器，避免跳动
        } else if (msg.type === 'done') {
          clearTimeout(timeout);
          try {
            finishBlock(el, buffer, indicator);
          } catch {
            // 防御：落盘异常时补计数并标记完成，避免进度卡死
            try { finishBlock(el, undefined, indicator); } catch {}
          }
          activeStreamPorts.delete(port);
          port.disconnect();
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          finishBlock(el, undefined, indicator);
          activeStreamPorts.delete(port);
          port.disconnect();
          resolve();
        }
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        activeStreamPorts.delete(port);
        // aborted 时由 cancel() 统一还原，不重复计数
        if (!aborted && !el.hasAttribute('data-ds-translated')) {
          finishBlock(el, undefined, indicator);
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
    if (observer) observer.disconnect(); // 二次启动时避免旧观察器泄漏
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
    // 中止上一会话遗留的流与观察器：await 前旧 onDisconnect 回调已派发
    // （此时 aborted 仍为 true，旧回调不会计数，避免污染新会话）
    aborted = true;
    for (const port of activeStreamPorts) {
      try { port.disconnect(); } catch {}
    }
    activeStreamPorts.clear();
    if (observer) observer.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0)); // 再让一个宏任务，尽量等旧 onDisconnect 回调落地

    // 还原上一会话的原文，随后全新翻译（重复触发 = 重新翻译整页）
    queue.queue.length = 0; // 清空旧会话队列残留
    for (const [el, html] of originalHTML) {
      el.innerHTML = html;
      el.removeAttribute('data-ds-original');
      el.removeAttribute('data-ds-translated');
      el.removeAttribute('data-ds-translation');
      el.removeAttribute('data-ds-failed');
    }
    translatedElements.clear();
    originalHTML.clear();
    totalBlocks = 0;
    completedBlocks = 0;
    failedBlocks = 0;

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
    // 重置“显示原文”按钮文案（可能残留上次翻译的状态）
    const showOriginalBtn = document.getElementById('ds-tb-show-original');
    if (showOriginalBtn) showOriginalBtn.textContent = '显示原文';

    // 监听动态插入的内容（SPA），新块交给视口观察器懒加载翻译
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver((mutations) => {
      if (aborted || !observer) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const newBlocks = node.matches && node.matches(BLOCK_SELECTOR) ? [node] : [];
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(BLOCK_SELECTOR)) newBlocks.push(el);
          }
          for (const el of newBlocks) {
            if (isSkippable(el) || translatedElements.has(el)) continue;
            const directText = getDirectText(el);
            if (!directText || directText.trim().length < 2) continue;
            if (isAlreadyTargetLang(directText, targetLanguage)) continue;
            observer.observe(el);
            totalBlocks++;
            updateProgress();
          }
        }
        // SPA 卸载节点：注销观察并修正计数，避免进度卡在“翻译中…”
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          const removed = node.matches && node.matches(BLOCK_SELECTOR) ? [node] : [];
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(BLOCK_SELECTOR)) removed.push(el);
          }
          for (const el of removed) {
            observer.unobserve(el);
            const wasTranslated = el.hasAttribute('data-ds-translated');
            // 翻译中的块：保留 set 与计数，由 finishBlock 依据 isConnected 收尾
            // （移动场景避免 addedNodes 重排队导致双翻译；删除场景由 finishBlock 补递减）
            if (translatedElements.has(el) && !wasTranslated) continue;
            translatedElements.delete(el);
            originalHTML.delete(el); // 同步清理原文备份，避免 SPA 场景内存泄漏
            if (el.hasAttribute('data-ds-failed') && failedBlocks > 0) failedBlocks--;
            if (totalBlocks > 0) totalBlocks--;
            // 仅已完成块同步递减
            if (wasTranslated && completedBlocks > 0) completedBlocks--;
            updateProgress();
          }
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    // 设置视口观察器（必须先于空块判断：SPA 页面首屏无内容时，动态内容靠它翻译）
    setupViewportObserver();

    // 收集所有可翻译块（跳过已是目标语言的块，省 token）
    const blocks = collectTranslatableBlocks().filter(el => !isAlreadyTargetLang(getDirectText(el), targetLanguage));
    totalBlocks = blocks.length;
    completedBlocks = 0;
    updateProgress();

    if (totalBlocks === 0) {
      const status = toolbar?.querySelector('.ds-tb-status');
      const anyBlocks = document.body.querySelectorAll(BLOCK_SELECTOR).length > 0;
      if (status) {
        status.textContent = anyBlocks
          ? 'ℹ️ 页面内容已是目标语言，无需翻译'
          : '⏳ 等待内容加载…（出现后将自动翻译）';
      }
      return;
    }

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

  // 只注册一次，避免重复注入导致监听器累积
  if (!window.__dsBeforeUnloadRegistered) {
    window.__dsBeforeUnloadRegistered = true;
    window.addEventListener('beforeunload', () => {
      aborted = true;
      for (const port of activeStreamPorts) {
        try { port.disconnect(); } catch {}
      }
      if (observer) observer.disconnect();
      if (mutationObserver) mutationObserver.disconnect();
    });
  }

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
