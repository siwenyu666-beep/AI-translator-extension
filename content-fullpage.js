// ========== DeepSeek 全文翻译 — Content Script ==========
// 由 background.js 通过 chrome.scripting.executeScript 按需注入
// 职责：DOM 文本扫描 → 视口优先 + 相邻块批量流式翻译 → ID 映射落盘 → 还原

(function () {
  'use strict';

  // 防止重复注入；若已激活（用户再次触发全文翻译）
  if (window.__dsFullPageTranslatorActive) {
    const progress = window.__dsFullPageTranslator?.progress;
    if (progress && progress.completed < progress.total) {
      const tb = document.getElementById('ds-translate-toolbar');
      const status = tb?.querySelector('.ds-tb-status');
      if (status) status.textContent = '⏳ 正在翻译中，请等待完成…';
    } else {
      window.__dsFullPageTranslator?.start?.().catch?.(console.error);
    }
    return;
  }
  window.__dsFullPageTranslatorActive = true;

  // ═══════════════════════════════════════════
  // 配置
  // ═══════════════════════════════════════════

  let targetLanguage = 'zh';
  const concurrency = 50;          // 按需求固定为 50 路批量请求
  const MAX_BATCH_BLOCKS = 8;      // 单批最多合并 8 个相邻块
  const MAX_BATCH_CHARS = 3500;    // 单批最多输入字符数，避免 Prompt 过大
  const rootMargin = '700px 0px';  // 视口前后预加载范围

  // ═══════════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════════

  const translatedElements = new Set();
  const originalHTML = new Map();       // element → 原始 innerHTML
  const translatedHTML = new Map();     // element → 当前译文 innerHTML，用于切换原文
  let toolbar = null;
  let observer = null;
  let mutationObserver = null;
  let activeStreamPorts = new Set();
  let totalBlocks = 0;
  let completedBlocks = 0;
  let failedBlocks = 0;
  let aborted = false;
  let showingOriginal = false;

  // 块任务：稳定 id → element，保证批量返回后按 id 落盘，不依赖模型输出顺序
  let taskSeq = 0;
  let taskById = new Map();
  let taskByEl = new WeakMap();

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
    if (el.offsetParent === null && el.tagName !== 'BODY') {
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
    const source = String(text || '');
    if (!source.trim()) return false;
    const len = source.length;
    const cjk = (source.match(/[\u4e00-\u9fff]/g) || []).length;
    const kana = (source.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (source.match(/[\uac00-\ud7af]/g) || []).length;

    if (target === 'zh') {
      if (cjk === 0) return false;
      if (kana / len > 0.1 || hangul / len > 0.1) return false;
      return cjk / len >= 0.5;
    }
    if (target === 'en') {
      const latin = (source.match(/[A-Za-z]/g) || []).length;
      if (latin / len < 0.4) return false;
      return (cjk + kana + hangul) / len < 0.05;
    }
    if (target === 'ja') {
      if (kana === 0 && cjk === 0) return false;
      return (kana + cjk) / len >= 0.3 && hangul / len < 0.05;
    }
    if (target === 'ko') {
      if (hangul === 0) return false;
      return hangul / len >= 0.3;
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
    'header', 'footer', 'nav', 'aside', 'main', 'caption'
  ].join(',');

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'TR',
    'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN', 'PRE', 'FORM', 'FIELDSET',
    'FIGCAPTION', 'DD', 'DT', 'LEGEND', 'SUMMARY', 'CAPTION'
  ]);

  function getDirectText(el) {
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

  // 落盘译文：保留原有结构，只替换文本节点
  function applyTranslation(el, buffer) {
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

    if (textNodes.length === 0) return;
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

  function toggleOriginal() {
    showingOriginal = !showingOriginal;
    const btn = document.getElementById('ds-tb-show-original');
    if (btn) btn.textContent = showingOriginal ? '显示译文' : '显示原文';

    for (const [el, html] of originalHTML) {
      if (showingOriginal) {
        translatedHTML.set(el, el.innerHTML);
        el.innerHTML = html;
      } else {
        const translation = translatedHTML.get(el);
        if (translation) el.innerHTML = translation;
      }
    }
  }

  function cancel() {
    aborted = true;

    for (const port of activeStreamPorts) {
      try { port.disconnect(); } catch {}
    }
    activeStreamPorts.clear();

    if (observer) observer.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
    if (queue) queue.reset();

    for (const [el, html] of originalHTML) {
      el.innerHTML = html;
      el.removeAttribute('data-ds-original');
      el.removeAttribute('data-ds-translated');
      el.removeAttribute('data-ds-translation');
      el.removeAttribute('data-ds-failed');
    }

    if (toolbar) toolbar.remove();

    translatedElements.clear();
    originalHTML.clear();
    translatedHTML.clear();
    taskById.clear();
    taskByEl = new WeakMap();
    taskSeq = 0;
    totalBlocks = 0;
    completedBlocks = 0;
    failedBlocks = 0;
    window.__dsFullPageTranslatorActive = false;
  }

  // ═══════════════════════════════════════════
  // 任务与队列
  // ═══════════════════════════════════════════

  function createTask(el, text) {
    if (!el) return null;
    if (taskByEl.has(el)) return taskByEl.get(el);

    const directText = text || getDirectText(el);
    if (!directText || directText.trim().length < 2) return null;

    const id = `b${taskSeq++}`;
    const task = {
      id,
      el,
      text: directText.trim(),
      index: taskSeq,             // DOM 顺序，用于相邻块批处理
      status: 'pending',
      indicator: null,
      viewportTop: 0
    };
    taskByEl.set(el, task);
    taskById.set(id, task);
    return task;
  }

  function prepareTask(task) {
    if (aborted) return false;
    const el = task.el;

    if (!el.isConnected) {
      task.status = 'done';
      taskById.delete(task.id);
      if (totalBlocks > 0) totalBlocks--;
      updateProgress();
      return false;
    }

    if (!originalHTML.has(el)) originalHTML.set(el, el.innerHTML);
    el.setAttribute('data-ds-original', 'true');
    el.insertAdjacentHTML('afterbegin',
      '<span class="ds-translating-indicator"><span class="ds-dot"></span>翻译中</span>');
    task.indicator = el.querySelector('.ds-translating-indicator');
    task.status = 'running';
    return true;
  }

  function cleanupBatchTask(task) {
    if (task.indicator) {
      task.indicator.remove();
      task.indicator = null;
    }
    if (task.status !== 'done') task.status = 'pending';
  }

  function finishBlock(el, translatedText, indicator) {
    indicator?.remove();
    if (!el.isConnected) {
      el.setAttribute('data-ds-translated', 'true');
      if (totalBlocks > 0) totalBlocks--;
      updateProgress();
      return;
    }

    if (translatedText !== undefined && translatedText.trim()) {
      applyTranslation(el, translatedText);
      el.removeAttribute('data-ds-failed');
    } else {
      failedBlocks++;
      el.setAttribute('data-ds-failed', 'true');
    }

    el.setAttribute('data-ds-translated', 'true');
    translatedElements.add(el);
    completedBlocks++;
    updateProgress();
  }

  class BatchQueue {
    constructor(maxConcurrency = 50, maxBlocks = 8, maxChars = 3500) {
      this.queue = [];
      this.active = 0;
      this.max = maxConcurrency;
      this.maxBlocks = maxBlocks;
      this.maxChars = maxChars;
    }

    reset() {
      this.queue.length = 0;
      this.active = 0;
    }

    add(task) {
      if (aborted || !task || task.status !== 'pending') return;
      task.status = 'queued';
      this.queue.push(task);
      this.process();
    }

    takeBatch() {
      this.queue.sort((a, b) => a.index - b.index);
      const first = this.queue.shift();
      if (!first) return [];

      const batch = [first];
      let chars = first.text.length;

      while (batch.length < this.maxBlocks) {
        const last = batch[batch.length - 1];
        const pos = this.queue.findIndex(task => task.index === last.index + 1);
        if (pos === -1) break;

        const next = this.queue[pos];
        if (chars + next.text.length > this.maxChars) break;

        batch.push(next);
        this.queue.splice(pos, 1);
        chars += next.text.length;
      }

      return batch;
    }

    process() {
      if (aborted) return;

      while (this.active < this.max && this.queue.length > 0) {
        const batch = this.takeBatch();
        if (batch.length === 0) break;

        this.active++;
        translateBatchTasks(batch)
          .catch(() => {})
          .finally(() => {
            this.active--;
            this.process();
          });
      }
    }
  }

  const queue = new BatchQueue(concurrency, MAX_BATCH_BLOCKS, MAX_BATCH_CHARS);

  // 批量请求失败时，逐块回退；每块仍然用 done 一次性落盘
  async function translateSingleTask(task) {
    if (aborted || task.status === 'done' || task.status === 'failed') return;
    if (!prepareTask(task)) return;

    let port;
    try {
      port = chrome.runtime.connect({
        name: `stream-fp-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
    } catch {
      finishBlock(task.el, undefined, task.indicator);
      task.status = 'failed';
      return;
    }

    activeStreamPorts.add(port);

    return new Promise((resolve) => {
      let buffer = '';
      let finished = false;

      const timeout = setTimeout(() => cleanup(false), 30000);
      const cleanup = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        activeStreamPorts.delete(port);
        try { port.disconnect(); } catch {}
        resolve();
      };

      port.onMessage.addListener((msg) => {
        if (aborted) { cleanup(false); return; }
        if (msg.type === 'token') {
          buffer += msg.token;
        } else if (msg.type === 'done') {
          finishBlock(task.el, msg.text || buffer, task.indicator);
          task.status = 'done';
          taskById.delete(task.id);
          cleanup(true);
        } else if (msg.type === 'error') {
          finishBlock(task.el, undefined, task.indicator);
          task.status = 'failed';
          taskById.delete(task.id);
          cleanup(false);
        }
      });

      port.onDisconnect.addListener(() => {
        if (finished) return;
        if (!aborted) {
          finishBlock(task.el, undefined, task.indicator);
          task.status = 'failed';
          taskById.delete(task.id);
        }
        cleanup(false);
      });

      port.postMessage({
        type: 'STREAM_BATCH',
        promptType: 'translate',
        text: task.text,
        context: { title: document.title, url: window.location.href },
        batchId: `fp-${task.id}-${Date.now()}`
      });
    });
  }

  async function translateBatchTasks(tasks) {
    if (aborted || tasks.length === 0) return;

    const prepared = [];
    for (const task of tasks) {
      if (!task || task.status === 'done' || task.status === 'failed') continue;
      if (prepareTask(task)) prepared.push(task);
    }
    if (prepared.length === 0) return;

    // 单块没必要走批量协议，直接走单块回退路径
    if (prepared.length === 1) {
      const task = prepared[0];
      cleanupBatchTask(task);
      await translateSingleTask(task);
      return;
    }

    let port;
    try {
      port = chrome.runtime.connect({
        name: `stream-fp-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
    } catch {
      for (const task of prepared) {
        cleanupBatchTask(task);
        translateSingleTask(task).catch(() => {});
      }
      return;
    }

    activeStreamPorts.add(port);

    return new Promise((resolve) => {
      let finished = false;

      const finish = (success, msg) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        activeStreamPorts.delete(port);

        if (success && msg && Array.isArray(msg.items)) {
          const resultMap = new Map(msg.items.map(item => [String(item.id), item.text]));
          for (const task of prepared) {
            const text = resultMap.get(task.id);
            if (text !== undefined) {
              finishBlock(task.el, text, task.indicator);
              task.status = 'done';
            } else {
              finishBlock(task.el, undefined, task.indicator);
              task.status = 'failed';
            }
            taskById.delete(task.id);
          }
        } else {
          // 批量结构错误/网络错误：降级为单块请求，位置不受影响
          for (const task of prepared) cleanupBatchTask(task);
          if (!aborted) {
            for (const task of prepared) {
              translateSingleTask(task).catch(() => {});
            }
          }
        }

        try { port.disconnect(); } catch {}
        resolve();
      };

      const timeout = setTimeout(() => finish(false), 60000);

      port.onMessage.addListener((msg) => {
        if (aborted) { finish(false); return; }
        if (msg.type === 'done') {
          finish(true, msg);
        } else if (msg.type === 'error') {
          finish(false);
        }
      });

      port.onDisconnect.addListener(() => {
        if (finished) return;
        finish(false);
      });

      port.postMessage({
        type: 'STREAM_TRANSLATE_BATCH',
        items: prepared.map(task => ({ id: task.id, text: task.text })),
        context: { title: document.title, url: window.location.href },
        batchId: `fp-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      });
    });
  }

  // ═══════════════════════════════════════════
  // 视口感知（IntersectionObserver）
  // ═══════════════════════════════════════════

  function setupViewportObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (aborted) return;

        const ready = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const el = entry.target;
          observer.unobserve(el);

          const task = taskByEl.get(el);
          if (!task || task.status !== 'pending') continue;

          task.viewportTop = entry.boundingClientRect?.top ?? 0;
          ready.push(task);
        }

        // 先翻用户当前看得到的，再按 DOM 顺序组成相邻块 batch
        ready.sort((a, b) => a.viewportTop - b.viewportTop || a.index - b.index);
        for (const task of ready) queue.add(task);
      },
      { rootMargin, threshold: 0 }
    );
  }

  // ═══════════════════════════════════════════
  // 启动入口
  // ═══════════════════════════════════════════

  async function start() {
    aborted = true;
    for (const port of activeStreamPorts) {
      try { port.disconnect(); } catch {}
    }
    activeStreamPorts.clear();
    if (observer) observer.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 重置上一会话
    if (queue) queue.reset();
    taskById.clear();
    taskByEl = new WeakMap();
    taskSeq = 0;
    translatedElements.clear();
    originalHTML.clear();
    translatedHTML.clear();
    totalBlocks = 0;
    completedBlocks = 0;
    failedBlocks = 0;
    showingOriginal = false;
    aborted = false;

    try {
      const config = await chrome.storage.local.get({ targetLanguage: 'zh' });
      targetLanguage = config.targetLanguage || 'zh';
    } catch {}

    injectToolbar();
    const showOriginalBtn = document.getElementById('ds-tb-show-original');
    if (showOriginalBtn) showOriginalBtn.textContent = '显示原文';

    // 设置观察器
    setupViewportObserver();

    // 先在内存中建立任务，不立刻全量 getBoundingClientRect，避免大页面强制布局
    const blocks = collectTranslatableBlocks().filter(
      el => !isAlreadyTargetLang(getDirectText(el), targetLanguage)
    );
    const tasks = blocks.map(el => createTask(el)).filter(Boolean);
    totalBlocks = tasks.length;
    updateProgress();

    // 所有块交给视口观察器，进入 rootMargin 范围才加入翻译队列
    for (const task of tasks) observer.observe(task.el);

    // SPA 动态内容
    mutationObserver = new MutationObserver((mutations) => {
      if (aborted || !observer) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          const newBlocks = [];
          if (node.matches && node.matches(BLOCK_SELECTOR)) newBlocks.push(node);
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(BLOCK_SELECTOR)) newBlocks.push(el);
          }

          for (const el of newBlocks) {
            if (isSkippable(el) || translatedElements.has(el) || taskByEl.has(el)) continue;
            const text = getDirectText(el);
            if (!text || text.trim().length < 2) continue;
            if (isAlreadyTargetLang(text, targetLanguage)) continue;

            const task = createTask(el, text);
            if (!task) continue;
            observer.observe(el);
            totalBlocks++;
            updateProgress();
          }
        }

        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;

          const removed = [];
          if (node.matches && node.matches(BLOCK_SELECTOR)) removed.push(node);
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(BLOCK_SELECTOR)) removed.push(el);
          }

          for (const el of removed) {
            observer.unobserve(el);
            const task = taskByEl.get(el);
            if (!task) continue;

            if (task.status === 'pending' || task.status === 'queued') {
              queue.queue = queue.queue.filter(item => item !== task);
              taskById.delete(task.id);
              taskByEl.delete(el);
              if (totalBlocks > 0) totalBlocks--;
              updateProgress();
            } else if (task.status === 'done') {
              taskById.delete(task.id);
              taskByEl.delete(el);
              translatedElements.delete(el);
              originalHTML.delete(el);
              translatedHTML.delete(el);
              if (totalBlocks > 0) totalBlocks--;
              if (completedBlocks > 0) completedBlocks--;
              updateProgress();
            } else if (task.status === 'running') {
              // 由 finishBlock 的 isConnected 分支补计数，避免删除/移动时重复减
              task.removed = true;
            }
          }
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    if (totalBlocks === 0) {
      const status = toolbar?.querySelector('.ds-tb-status');
      const anyBlocks = document.body.querySelectorAll(BLOCK_SELECTOR).length > 0;
      if (status) {
        status.textContent = anyBlocks
          ? 'ℹ️ 页面内容已是目标语言，无需翻译'
          : '⏳ 等待内容加载…（出现后将自动翻译）';
      }
    }
  }

  // ═══════════════════════════════════════════
  // 页面卸载清理
  // ═══════════════════════════════════════════

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
