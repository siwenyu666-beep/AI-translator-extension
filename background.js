// ========== DeepSeek 智能解释 - Service Worker ==========
// 职责：管理 API Key、代理 DeepSeek API 调用、缓存最近结果、右键菜单

const CACHE = new Map();
const CACHE_MAX = 50;

// ── 右键菜单：安装/更新时创建 ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'deepseek-explain',
    title: '智能解释',
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXPLAIN') {
    handleExplain(message.text, message.context, sender.url).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_CONFIG') {
    getConfig().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'DOWNLOAD') {
    handleDownload(message.text, message.explanation);
  }
});

async function handleExplain(text, context, pageUrl) {
  const config = await getConfig();
  if (!config.apiKey) return { error: '请先在扩展弹窗中设置 DeepSeek API Key' };
  if (config.enabled === false) return { error: '扩展已禁用' };

  const useContext = config.usePageContext !== false && context;
  // 上下文模式下缓存 key 包含页面 URL，确保不同页面的相同文字各自缓存
  const cacheKey = useContext ? `${config.model}:${pageUrl}:${text}` : `${config.model}:${text}`;
  if (CACHE.has(cacheKey)) return { explanation: CACHE.get(cacheKey), cached: true };

  const prompt = buildPrompt(text, config.language, useContext ? context : null);
  const explanation = await callDeepSeek(config.apiKey, config.model, prompt);

  CACHE.set(cacheKey, explanation);
  if (CACHE.size > CACHE_MAX) {
    const first = CACHE.keys().next().value;
    CACHE.delete(first);
  }

  return { explanation, model: config.model };
}

async function getConfig() {
  const defaults = {
    apiKey: '',
    model: 'deepseek-chat',
    enabled: true,
    language: 'auto',
    usePageContext: true,
    triggerMode: 'auto'
  };
  const stored = await chrome.storage.local.get(defaults);
  return stored;
}

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

async function callDeepSeek(apiKey, model, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const url = 'https://api.deepseek.com/chat/completions';

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

    const res = await fetch(url, {
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
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('DeepSeek 未返回有效解释，请重试');

    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

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
