// ========== DeepSeek 智能解释 & 翻译 — Service Worker ==========
// 职责：配置管理、流式 API 代理、动态右键菜单、缓存、下载

const CACHE = new Map();
const CACHE_MAX = 100;

// ═══════════════════════════════════════════
// 右键菜单：安装/更新时创建（精简为两项）
// ═══════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'deepseek-explain',
    title: '📖 智能解释',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'deepseek-fullpage',
    title: '🌐 全文翻译',
    contexts: ['page']
  });
});

// ═══════════════════════════════════════════
// 右键菜单点击分发
// ═══════════════════════════════════════════

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'deepseek-explain' && info.selectionText && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRIGGER_EXPLAIN',
      text: info.selectionText.trim()
    }).catch(() => {});
  }
  if (info.menuItemId === 'deepseek-fullpage' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRIGGER_FULLPAGE_TRANSLATE'
    }).catch(() => {});
  }
});

// ═══════════════════════════════════════════
// 消息路由
// ═══════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD') {
    handleDownload(message.text, message.explanation);
    return false;
  }
  // 全文翻译注入
  if (message.type === 'INJECT_FULLPAGE_TRANSLATE') {
    injectFullPageTranslator(sender);
    return false;
  }
});

// ═══════════════════════════════════════════
// 全文翻译脚本注入
// ═══════════════════════════════════════════

async function injectFullPageTranslator(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-fullpage.js']
    });
  } catch (err) {
    console.error('[DeepSeek] 全文翻译注入失败:', err);
  }
}

// ═══════════════════════════════════════════
// 流式连接入口：explain 和 translate 共用
// ═══════════════════════════════════════════

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('stream-')) return;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'STREAM_REQUEST') {
      handleStreamRequest(port, msg);
    }
    // 全文翻译批量流式请求
    if (msg.type === 'STREAM_BATCH') {
      handleStreamRequest(port, {
        promptType: msg.promptType || 'translate',
        text: msg.text,
        context: msg.context,
        batchId: msg.batchId
      });
    }
  });
});

// ═══════════════════════════════════════════
// 统一流式处理器
// ═══════════════════════════════════════════

async function handleStreamRequest(port, { promptType, text, context, batchId, mode }) {
  const config = await getConfig();
  if (!config.apiKey) {
    port.postMessage({ type: 'error', error: '请先设置 API Key', batchId });
    port.disconnect();
    return;
  }
  if (config.enabled === false) {
    port.postMessage({ type: 'error', error: '扩展已禁用', batchId });
    port.disconnect();
    return;
  }

  let prompt, systemPrompt, model, thinkingEnabled, reasoningEffort;

  // 🆕 四分类模式（来自智能解释的本地分类）
  if (mode) {
    if (mode === 'B') {
      // 纯翻译 → 使用翻译标签的模型
      model = config.translateModel || 'deepseek-v4-flash';
      thinkingEnabled = config.translateThinkingEnabled || false;
      reasoningEffort = config.translateReasoningEffort || 'high';
    } else {
      model = config.explainModel || 'deepseek-v4-flash';
      thinkingEnabled = config.explainThinkingEnabled || false;
      reasoningEffort = config.explainReasoningEffort || 'high';
    }
    systemPrompt = '你是一个知识渊博的助手。请严格按照指令输出。';

    if (mode === 'A') {
      prompt = buildTranslateExplainPrompt(text, context);
    } else if (mode === 'B') {
      prompt = buildPureTranslatePrompt(text, config.targetLanguage || 'zh', context);
    } else if (mode === 'C') {
      prompt = buildExplainPrompt(text, config.language, context);
    } else if (mode === 'D') {
      prompt = buildContextualInterpretPrompt(text, context);
    }
  } else if (promptType === 'explain') {
    // 兼容旧路径
    model = config.explainModel || 'deepseek-v4-flash';
    thinkingEnabled = config.explainThinkingEnabled || false;
    reasoningEffort = config.explainReasoningEffort || 'high';
    systemPrompt = '你是一个知识渊博、擅于解释的助手。给出简洁清晰的解释，不要重复开场白，直接解释。';
    prompt = buildExplainPrompt(text, config.language, context);
  } else {
    // translate (fullpage / pdf)
    model = config.translateModel || 'deepseek-v4-flash';
    thinkingEnabled = config.translateThinkingEnabled || false;
    reasoningEffort = config.translateReasoningEffort || 'high';
    systemPrompt = '你是一个专业的翻译引擎。只输出译文，不要任何解释、说明。';
    prompt = buildTranslatePrompt(text, config.targetLanguage || 'zh', context);
  }

  // 缓存检查
  const modeKey = mode || promptType;
  const langKey = (mode && (mode === 'A' || mode === 'B')) ? (config.targetLanguage || 'zh') : config.language;
  const ctxFingerprint = context ? hashString(context.title + (context.before || '') + (context.after || '')) : 'noctx';
  const cacheKey = `${modeKey}:${model}:${langKey}:${ctxFingerprint}:${text}`;
  if (CACHE.has(cacheKey)) {
    // 模拟流式：分 chunk 发送缓存结果
    const cached = CACHE.get(cacheKey);
    const chunks = splitIntoChunks(cached, 3);
    for (const chunk of chunks) {
      port.postMessage({ type: 'token', token: chunk, batchId });
      await sleep(30);
    }
    port.postMessage({ type: 'done', model: model.replace('deepseek-', ''), batchId });
    port.disconnect();
    return;
  }

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  try {
    const body = {
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: (mode === 'B' || promptType === 'translate') ? 0.1 : 0.3,
      max_tokens: getMaxTokens(mode, promptType),
      stream: true
    };

    if (thinkingEnabled && model === 'deepseek-v4-pro') {
      body.reasoning_effort = reasoningEffort;
    }

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errMsg = await parseApiError(res);
      port.postMessage({ type: 'error', error: errMsg, batchId });
      return;
    }

    // SSE 流式解析
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          // 缓存完整结果
          if (fullText.length > 10) {
            CACHE.set(cacheKey, fullText);
            if (CACHE.size > CACHE_MAX) {
              const first = CACHE.keys().next().value;
              CACHE.delete(first);
            }
          }
          port.postMessage({ type: 'done', model: model.replace('deepseek-', ''), batchId });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const token = parsed?.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            port.postMessage({ type: 'token', token, batchId });
          }
        } catch { /* skip malformed */ }
      }
    }

    // 流结束但没收到 [DONE]
    if (fullText.length > 10) {
      CACHE.set(cacheKey, fullText);
      if (CACHE.size > CACHE_MAX) {
        const first = CACHE.keys().next().value;
        CACHE.delete(first);
      }
    }
    port.postMessage({ type: 'done', model: model.replace('deepseek-', ''), batchId });
  } catch (err) {
    if (err.name !== 'AbortError') {
      port.postMessage({ type: 'error', error: err.message, batchId });
    }
  } finally {
    port.disconnect();
  }
}

// ═══════════════════════════════════════════
// Prompt 构建
// ═══════════════════════════════════════════

function buildExplainPrompt(text, language, context) {
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

function buildTranslatePrompt(text, targetLanguage, context) {
  const langNames = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية' };
  const targetName = langNames[targetLanguage] || targetLanguage;

  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[上下文]\n标题：${context.title || '未知'}\n上文：${context.before || ''}\n下文：${context.after || ''}\n`;
  }

  return `你是一个专业的翻译引擎。请将以下文本翻译为${targetName}。
${contextBlock}
[待翻译文本]
"""
${text}
"""

规则：
- 只输出翻译结果，不要任何解释、说明、开场白
- 翻译要准确、自然、符合目标语言习惯
- 结合上下文理解多义词和指代，确保翻译准确
- 保持原文的语气和风格（正式/非正式、技术/日常）
- 如果文本中包含专有名词、数字、代码等，保持原样
- 不要使用任何 Markdown 格式`;
}

// 🆕 模式 A：外语短词 → 先翻译成中文，再解释
function buildTranslateExplainPrompt(text, context) {
  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[上下文]\n标题：${context.title || '未知'}\n上文：${context.before || ''}\n下文：${context.after || ''}\n`;
  }
  return `请先翻译以下文本为中文，然后对翻译结果给出简洁解释（释义、词性、用法、例句）。

${contextBlock}
[待处理文本]
"""
${text}
"""

输出格式：
【译文】
（翻译结果）
【解释】
1. 释义：...
2. 用法：...
3. 例句：...

规则：
- 不要使用 Markdown 格式
- 解释控制在 2~4 个要点
- 不要写开场白`;
}

// 🆕 模式 B：外语长段 → 纯翻译
function buildPureTranslatePrompt(text, targetLanguage, context) {
  const langNames = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية' };
  const targetName = langNames[targetLanguage] || targetLanguage;
  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[上下文]\n${context.before || ''}\n${context.after || ''}\n`;
  }
  return `将以下文本翻译为${targetName}。只输出译文，不要解释。
${contextBlock}
"""
${text}
"""`;
}

// 🆕 模式 D：中文长段 → 语境解读
function buildContextualInterpretPrompt(text, context) {
  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[上文]\n${context.before || ''}\n\n[下文]\n${context.after || ''}\n`;
  }
  return `请结合上下文解读这段话的核心含义和深层意图。

${contextBlock}
[待解读文本]
"""
${text}
"""

规则：
- 用编号列表（1. 2. 3.）输出
- 每点一行：先概括核心意思，再点出背景/意图/隐含信息
- 控制在 3~5 点
- 直接输出，不要开场白"这段话说的是…"
- 不要使用 Markdown 格式`;
}

// 🆕 按模式返回 max_tokens
function getMaxTokens(mode, promptType) {
  if (mode === 'A') return 800;   // 翻译+解释
  if (mode === 'B') return 2048;  // 纯翻译
  if (mode === 'C') return 400;   // 拓展解释
  if (mode === 'D') return 600;   // 语境解读
  return promptType === 'translate' ? 2048 : 400;
}

// ═══════════════════════════════════════════
// 配置读取
// ═══════════════════════════════════════════

async function getConfig() {
  const defaults = {
    apiKey: '',
    // 解释标签
    explainModel: 'deepseek-v4-flash',
    explainThinkingEnabled: false,
    explainReasoningEffort: 'high',
    language: 'auto',
    // 翻译标签
    translateModel: 'deepseek-v4-flash',
    translateThinkingEnabled: false,
    translateReasoningEffort: 'high',
    targetLanguage: 'zh',
    // 通用
    enabled: true,
    usePageContext: true,
    triggerMode: 'auto'
  };

  let stored = await chrome.storage.local.get(defaults);

  // ── 旧版迁移 ──
  let migrated = false;
  if (stored.model !== undefined) {
    stored.explainModel = stored.model;
    stored.translateModel = stored.model;
    delete stored.model;
    migrated = true;
  }
  if (stored.thinkingEnabled !== undefined) {
    stored.explainThinkingEnabled = stored.thinkingEnabled;
    stored.translateThinkingEnabled = stored.thinkingEnabled;
    delete stored.thinkingEnabled;
    migrated = true;
  }
  if (stored.reasoningEffort !== undefined) {
    stored.explainReasoningEffort = stored.reasoningEffort;
    stored.translateReasoningEffort = stored.reasoningEffort;
    delete stored.reasoningEffort;
    migrated = true;
  }
  if (migrated) {
    await chrome.storage.local.set(stored);
  }

  return stored;
}

// ═══════════════════════════════════════════
// API 错误解析
// ═══════════════════════════════════════════

async function parseApiError(res) {
  try {
    const body = await res.text();
    if (res.status === 401) return 'API Key 无效，请检查设置';
    if (res.status === 402) return '账户余额不足，请充值';
    if (res.status === 403) return 'API Key 无权访问，请检查';
    if (res.status === 429) return '请求过于频繁，请稍后再试';
    if (res.status === 400) return '请求参数有误，请重试';
    return `API 错误 (${res.status}): ${body.slice(0, 100)}`;
  } catch {
    return `API 错误 (${res.status})`;
  }
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function splitIntoChunks(text, count) {
  if (!text || count <= 1) return [text || ''];
  const len = text.length;
  const size = Math.ceil(len / count);
  const chunks = [];
  for (let i = 0; i < len; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length ? chunks : [''];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // 32-bit int
  }
  return hash.toString(36);
}

// ═══════════════════════════════════════════
// 下载
// ═══════════════════════════════════════════

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
