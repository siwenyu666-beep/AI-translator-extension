// ========== DeepSeek 智能解释 & 翻译 — Service Worker ==========
// 职责：配置管理、流式 API 代理、动态右键菜单、缓存、下载

const CACHE = new Map();
const CACHE_MAX = 100;

// 官方已将 deepseek-v4-flash 迁移为 deepseek-flash（DeepSeek-V4.1-Flash）。
// 旧的调用名仍被官方接受，但对应模型已退役；这里统一归一化，避免旧配置继续发旧模型名。
const LEGACY_MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
};

// ═══════════════════════════════════════════
// 右键菜单：安装/更新时创建（精简为两项）
// ═══════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  // 先清除旧菜单再重建，避免扩展更新/浏览器升级时重复 create 同 id 报错
  chrome.contextMenus.removeAll(() => {
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
  // 模型可用性检测：调用各供应商的 /models 接口，避免无效模型被保存到列表
  if (message.type === 'VALIDATE_MODEL') {
    validateModel(message.model)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message || '模型检测失败' }));
    return true; // 异步响应
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
    // 全文翻译批量流式请求（旧协议，保留兼容）
    if (msg.type === 'STREAM_BATCH') {
      handleStreamRequest(port, {
        promptType: msg.promptType || 'translate',
        text: msg.text,
        context: msg.context,
        batchId: msg.batchId
      });
    }
    // 全文翻译真正批量请求：单次请求多个相邻块，按 id 返回
    if (msg.type === 'STREAM_TRANSLATE_BATCH') {
      handleTranslateBatchRequest(port, msg);
    }
  });
});

// ═══════════════════════════════════════════
// 统一流式处理器
// ═══════════════════════════════════════════

async function handleStreamRequest(port, { promptType, text, context, batchId, mode }) {
  const config = await getConfig();
  if (config.enabled === false) {
    port.postMessage({ type: 'error', error: '扩展已禁用', batchId });
    port.disconnect();
    return;
  }
  if (!config.apiKey && !config.qwenApiKey) {
    port.postMessage({ type: 'error', error: '请先设置 API Key', batchId });
    port.disconnect();
    return;
  }

  let prompt, systemPrompt, model, thinkingEnabled, reasoningEffort;

  // 🆕 四分类模式（来自智能解释的本地分类）
  if (mode) {
    if (mode === 'B') {
      // 纯翻译 → 使用翻译标签的模型
      model = config.translateModel || 'deepseek-flash';
      thinkingEnabled = config.translateThinkingEnabled || false;
      reasoningEffort = config.translateReasoningEffort || 'high';
    } else {
      model = config.explainModel || 'deepseek-flash';
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
    model = config.explainModel || 'deepseek-flash';
    thinkingEnabled = config.explainThinkingEnabled || false;
    reasoningEffort = config.explainReasoningEffort || 'high';
    systemPrompt = '你是一个知识渊博、擅于解释的助手。给出简洁清晰的解释，不要重复开场白，直接解释。';
    prompt = buildExplainPrompt(text, config.language, context);
  } else {
    // translate (fullpage / pdf)
    model = config.translateModel || 'deepseek-flash';
    thinkingEnabled = config.translateThinkingEnabled || false;
    reasoningEffort = config.translateReasoningEffort || 'high';
    systemPrompt = '你是一个专业的翻译引擎。只输出译文，不要任何解释、说明。';
    prompt = buildTranslatePrompt(text, config.targetLanguage || 'zh', context);
  }

  // ── 供应商判断 & Key 验证 ──
  const provider = getProvider(model);
  const apiKey = provider === 'qwen' ? config.qwenApiKey : config.apiKey;
  if (!apiKey) {
    const name = provider === 'qwen' ? '千问' : 'DeepSeek';
    port.postMessage({ type: 'error', error: `请先设置${name} API Key`, batchId });
    port.disconnect();
    return;
  }

  // 缓存检查（键包含思考开关，避免开关切换后命中旧缓存）
  const modeKey = mode || promptType;
  const langKey = ((mode && (mode === 'A' || mode === 'B')) || promptType === 'translate')
    ? (config.targetLanguage || 'zh')
    : config.language;
  const ctxFingerprint = context ? hashString(context.title + (context.before || '') + (context.after || '')) : 'noctx';
  const thinkingFlag = thinkingEnabled ? 't1' : 't0';
  const effortFlag = thinkingEnabled ? (reasoningEffort || 'default') : 'n';
  const cacheKey = `${modeKey}:${model}:${langKey}:${thinkingFlag}:${effortFlag}:${ctxFingerprint}:${text}`;
  if (CACHE.has(cacheKey)) {
    // 模拟流式：分 chunk 发送缓存结果
    const cached = CACHE.get(cacheKey);
    const chunks = splitIntoChunks(cached, 3);
    for (const chunk of chunks) {
      // 端口可能已被页面断开（用户关闭弹窗），发送失败即中止
      try {
        port.postMessage({ type: 'token', token: chunk, batchId });
        await sleep(30);
      } catch {
        port.disconnect();
        return;
      }
    }
    port.postMessage({ type: 'done', model: model.replace('deepseek-', ''), batchId });
    port.disconnect();
    return;
  }

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  try {
    let maxTokens = getMaxTokens(mode, promptType, text);
    if (thinkingEnabled && provider === 'deepseek') {
      // 思考模式的推理 token 计入输出上限；设置上限避免极端长文本成本失控
      maxTokens = Math.min(65536, maxTokens * 3);
    }
    const body = {
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: (mode === 'B' || promptType === 'translate') ? 0.1 : 0.3,
      max_tokens: maxTokens,
      stream: true
    };

    if (provider === 'deepseek') {
      // DeepSeek V4/V4.1 思考模式默认开启，必须显式控制开关，否则 UI 开关形同虚设
      body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
      if (thinkingEnabled) {
        body.reasoning_effort = reasoningEffort;
        // 思考模式下 temperature 是无效参数（官方文档），省略
        delete body.temperature;
      }
    }

    // 根据供应商选择端点
    const endpoint = provider === 'qwen'
      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
      : 'https://api.deepseek.com/chat/completions';

    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errMsg = await parseApiError(res);
      port.postMessage({ type: 'error', error: errMsg, batchId });
      return;
    }

    // SSE 流式解析：同一轮网络读取内的 token 合并发送，既不额外延迟，也减少 IPC
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let tokenChunk = '';
    let reasoningChunk = '';

    const flushChunks = () => {
      if (reasoningChunk) {
        port.postMessage({ type: 'reasoning-token', token: reasoningChunk, batchId });
        reasoningChunk = '';
      }
      if (tokenChunk) {
        port.postMessage({ type: 'token', token: tokenChunk, batchId });
        tokenChunk = '';
      }
    };

    const parseDataLine = (line) => {
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (!data) return false;
      if (data === '[DONE]') return 'done';
      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoningChunk += delta.reasoning_content;
        if (delta?.content) {
          tokenChunk += delta.content;
          fullText += delta.content;
        }
      } catch { /* skip malformed */ }
      return false;
    };

    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (parseDataLine(line) === 'done') {
          streamDone = true;
          break;
        }
      }
    }

    // 没收到 [DONE] 时也要处理解码器残余
    if (!streamDone) {
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) {
        if (parseDataLine(line) === 'done') break;
      }
    }

    flushChunks();

    // 缓存完整结果
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

// 按模式和输入长度动态计算 max_tokens，避免长段落被固定 2048 截断
function dynamicTranslateMaxTokens(text) {
  const len = String(text || '').length;
  return Math.min(32768, Math.max(2048, Math.ceil(len * 1.5)));
}

function getMaxTokens(mode, promptType, text) {
  if (mode === 'A') return Math.min(2048, Math.max(800, Math.ceil(String(text || '').length * 1.5)));
  if (mode === 'B') return dynamicTranslateMaxTokens(text);
  if (mode === 'C') return 400;
  if (mode === 'D') return 600;
  return promptType === 'translate' ? dynamicTranslateMaxTokens(text) : 400;
}

// ═══════════════════════════════════════════
// 配置读取
// ═══════════════════════════════════════════

// 会话级配置缓存：避免全文翻译高并发时每个请求都读 storage
let configCache = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') configCache = null;
});

async function getConfig() {
  if (configCache) return configCache;

  const defaults = {
    apiKey: '',
    qwenApiKey: '',
    // 解释标签
    explainModel: 'deepseek-flash',
    explainThinkingEnabled: false,
    explainReasoningEffort: 'high',
    language: 'auto',
    // 翻译标签
    translateModel: 'deepseek-flash',
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
  // 归一化旧模型调用名（deepseek-v4-flash -> deepseek-flash）
  ['explainModel', 'translateModel'].forEach(key => {
    if (!stored[key]) return;
    const normalized = normalizeModelName(stored[key]);
    if (normalized !== stored[key]) {
      stored[key] = normalized;
      migrated = true;
    }
  });

  if (migrated) {
    await chrome.storage.local.set(stored);
    // 删除旧版遗留键，避免每次缓存失效都重跑迁移
    await chrome.storage.local.remove(['model', 'thinkingEnabled', 'reasoningEffort']);
  }

  configCache = stored;
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

// 429/5xx/网络错误统一退避重试；AbortError 直接抛出，不重试
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers?.get?.('Retry-After') || 0);
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('请求失败');
}

// ═══════════════════════════════════════════
// 模型可用性检测
// ═══════════════════════════════════════════

async function validateModel(inputModel) {
  const model = normalizeModelName(inputModel);
  if (!model) {
    return { ok: false, error: '模型调用名不能为空' };
  }

  const config = await getConfig();
  const provider = getProvider(model);
  const apiKey = provider === 'qwen' ? config.qwenApiKey : config.apiKey;
  if (!apiKey) {
    const providerName = provider === 'qwen' ? '千问' : 'DeepSeek';
    return { ok: false, error: `请先设置${providerName} API Key` };
  }

  const endpoint = provider === 'qwen'
    ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'
    : 'https://api.deepseek.com/models';

  try {
    const res = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!res.ok) {
      return { ok: false, error: await parseApiError(res) };
    }

    const data = await res.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    const found = models.find(item => {
      const id = item?.id || item?.model;
      return id && String(id) === model;
    });

    if (!found) {
      return { ok: false, error: `未找到可调用的模型：${model}` };
    }

    return {
      ok: true,
      provider: provider,
      model: {
        id: found.id || model,
        name: found.name || found.id || model
      }
    };
  } catch (err) {
    return { ok: false, error: `模型检测失败：${err.message}` };
  }
}

// ═══════════════════════════════════════════
// 全文翻译批量请求：用 id 标记保证结果不会因模型输出顺序/合并而错位
// ═══════════════════════════════════════════

function sanitizeBatchId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_]/g, '_') || 'item';
}

function buildBatchTranslatePrompt(items, targetLanguage, context) {
  const langNames = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية' };
  const targetName = langNames[targetLanguage] || targetLanguage;
  const blocks = items.map(item => {
    const id = sanitizeBatchId(item.id);
    return `<<<DS_ITEM_${id}>>>\n${item.text}\n<<<DS_END_${id}>>>`;
  }).join('\n\n');
  const contextBlock = context?.title ? `网页标题：${context.title}\n\n` : '';

  return `你是一个专业的翻译引擎，请将下面每个标记块中的文本翻译为${targetName}。
${contextBlock}${blocks}

输出要求：
- 只输出翻译后的标记块，保持 <<<DS_ITEM_xxx>>> 和 <<<DS_END_xxx>>> 标记原样
- 标记中的 xxx 是 id，必须与输入完全一致
- 不要合并、遗漏、新增任何标记块
- 不要输出解释、说明、Markdown 代码块
- 保留原文段落结构和换行`;
}

function parseBatchTranslation(raw, expectedIds) {
  const text = String(raw || '');
  const map = new Map();
  const re = /<<<DS_ITEM_([A-Za-z0-9_]+)>>>([\s\S]*?)<<<DS_END_\1>>>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    map.set(match[1], match[2].trim());
  }

  const items = expectedIds.map(id => ({
    id: String(id),
    text: map.get(sanitizeBatchId(id)) || ''
  }));

  if (items.some(item => !item.text)) return null;
  return items;
}

async function handleTranslateBatchRequest(port, { items, context, batchId }) {
  const list = Array.isArray(items)
    ? items.filter(item => item && item.id && String(item.text || '').trim())
    : [];

  if (list.length === 0) {
    port.postMessage({ type: 'error', error: '没有可翻译的内容', batchId });
    port.disconnect();
    return;
  }

  const config = await getConfig();
  if (config.enabled === false) {
    port.postMessage({ type: 'error', error: '扩展已禁用', batchId });
    port.disconnect();
    return;
  }

  const model = config.translateModel || 'deepseek-flash';
  const provider = getProvider(model);
  const apiKey = provider === 'qwen' ? config.qwenApiKey : config.apiKey;
  if (!apiKey) {
    const name = provider === 'qwen' ? '千问' : 'DeepSeek';
    port.postMessage({ type: 'error', error: `请先设置${name} API Key`, batchId });
    port.disconnect();
    return;
  }

  const targetLanguage = config.targetLanguage || 'zh';
  const thinkingEnabled = config.translateThinkingEnabled || false;
  const reasoningEffort = config.translateReasoningEffort || 'high';
  const systemPrompt = '你是一个专业的翻译引擎。只输出规定格式的译文，不要任何解释、说明。';
  const prompt = buildBatchTranslatePrompt(list, targetLanguage, context);

  const inputChars = list.reduce((sum, item) => sum + String(item.text).length, 0) + list.length * 40;
  let maxTokens = Math.min(32768, Math.max(2048, Math.ceil(inputChars * 1.5)));
  if (thinkingEnabled && provider === 'deepseek') {
    maxTokens = Math.min(65536, maxTokens * 3);
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    stream: true
  };

  if (provider === 'deepseek') {
    body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
    if (thinkingEnabled) {
      body.reasoning_effort = reasoningEffort;
      delete body.temperature;
    }
  }

  const endpoint = provider === 'qwen'
    ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    : 'https://api.deepseek.com/chat/completions';

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  try {
    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const error = await parseApiError(res);
      port.postMessage({
        type: 'error',
        error,
        batchId,
        retryable: res.status === 429 || res.status >= 500,
        fallback: true
      });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';

    const consumeLine = (line) => {
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (!data) return false;
      if (data === '[DONE]') return true;
      try {
        const parsed = JSON.parse(data);
        const token = parsed?.choices?.[0]?.delta?.content;
        if (token) output += token;
      } catch { /* skip malformed */ }
      return false;
    };

    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (consumeLine(line)) {
          streamDone = true;
          break;
        }
      }
    }

    if (!streamDone) {
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) {
        if (consumeLine(line)) break;
      }
    }

    const parsedItems = parseBatchTranslation(output, list.map(item => item.id));
    if (!parsedItems) {
      port.postMessage({
        type: 'error',
        error: '批量译文解析失败，将回退为逐块翻译',
        batchId,
        retryable: true,
        fallback: true
      });
      return;
    }

    port.postMessage({
      type: 'done',
      model: model.replace('deepseek-', ''),
      batchId,
      items: parsedItems
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      port.postMessage({
        type: 'error',
        error: err.message || '批量翻译失败',
        batchId,
        retryable: true,
        fallback: true
      });
    }
  } finally {
    port.disconnect();
  }
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function normalizeModelName(model) {
  const name = String(model || '').trim();
  return LEGACY_MODEL_ALIASES[name] || name;
}

function getProvider(model) {
  return model && model.startsWith('qwen') ? 'qwen' : 'deepseek';
}

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
  }).catch(() => {});
}
