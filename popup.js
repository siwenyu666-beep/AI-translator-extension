// ========== DeepSeek 智能解释 & 翻译 — Popup ==========
// 双标签布局：解释 / 翻译各自独立模型配置 + 通用设置

// ── DOM 引用 ──
// 标签
const $tabBtns = document.querySelectorAll('.tab-btn');
const $tabPanels = document.querySelectorAll('.tab-panel');

// 解释标签
const $explainModel = document.getElementById('explain-model');
const $explainThinking = document.getElementById('explain-thinking');
const $explainEffort = document.getElementById('explain-effort');
const $explainEffortSection = document.getElementById('explain-effort-section');
const $explainLanguage = document.getElementById('explain-language');

// 翻译标签
const $translateModel = document.getElementById('translate-model');
const $translateThinking = document.getElementById('translate-thinking');
const $translateEffort = document.getElementById('translate-effort');
const $translateEffortSection = document.getElementById('translate-effort-section');
const $targetLanguage = document.getElementById('target-language');

// 通用
const $apiKey = document.getElementById('api-key');
const $qwenApiKey = document.getElementById('qwen-api-key');
const $enabled = document.getElementById('enabled');
const $useContext = document.getElementById('use-context');
const $triggerMode = document.getElementById('trigger-mode');
const $saveBtn = document.getElementById('save-btn');
const $status = document.getElementById('status');

// ═══════════════════════════════════════════
// 标签切换
// ═══════════════════════════════════════════

$tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $tabPanels.forEach(p => {
      p.classList.toggle('active', p.id === `panel-${tab}`);
    });
  });
});

// ═══════════════════════════════════════════
// 深度思考开关 → 联动强度选择显隐
// ═══════════════════════════════════════════

$explainThinking.addEventListener('change', () => {
  $explainEffortSection.style.display = $explainThinking.checked && !$explainModel.value.startsWith('qwen') ? '' : 'none';
});
$translateThinking.addEventListener('change', () => {
  $translateEffortSection.style.display = $translateThinking.checked && !$translateModel.value.startsWith('qwen') ? '' : 'none';
});

// ── 模型切换 → 千问自动隐藏思考选项 ──
function onModelChange($model, $thinking, $effortSection) {
  const isQwen = $model.value.startsWith('qwen');
  if (isQwen) {
    $thinking.checked = false;
    $effortSection.style.display = 'none';
  }
}
$explainModel.addEventListener('change', () => {
  onModelChange($explainModel, $explainThinking, $explainEffortSection);
});
$translateModel.addEventListener('change', () => {
  onModelChange($translateModel, $translateThinking, $translateEffortSection);
});

// ═══════════════════════════════════════════
// 加载配置
// ═══════════════════════════════════════════

(async () => {
  const defaults = {
    apiKey: '',
    qwenApiKey: '',
    // 解释
    explainModel: 'deepseek-v4-flash',
    explainThinkingEnabled: false,
    explainReasoningEffort: 'high',
    language: 'auto',
    // 翻译
    translateModel: 'deepseek-v4-flash',
    translateThinkingEnabled: false,
    translateReasoningEffort: 'high',
    targetLanguage: 'zh',
    // 通用
    enabled: true,
    usePageContext: true,
    triggerMode: 'auto'
  };

  let config = await chrome.storage.local.get(defaults);

  // ── 旧版迁移 ──
  let migrated = false;

  if (config.model !== undefined) {
    config.explainModel = config.model;
    config.translateModel = config.model;
    delete config.model;
    migrated = true;
  }
  if (config.thinkingEnabled !== undefined) {
    config.explainThinkingEnabled = config.thinkingEnabled;
    config.translateThinkingEnabled = config.thinkingEnabled;
    delete config.thinkingEnabled;
    migrated = true;
  }
  if (config.reasoningEffort !== undefined) {
    config.explainReasoningEffort = config.reasoningEffort;
    config.translateReasoningEffort = config.reasoningEffort;
    delete config.reasoningEffort;
    migrated = true;
  }
  if (migrated) {
    await chrome.storage.local.set(config);
  }

  // ── 填充 UI ──
  $explainModel.value = config.explainModel;
  $explainThinking.checked = config.explainThinkingEnabled === true;
  $explainEffort.value = config.explainReasoningEffort || 'high';
  $explainEffortSection.style.display = config.explainThinkingEnabled && !config.explainModel.startsWith('qwen') ? '' : 'none';
  $explainLanguage.value = config.language || 'auto';

  $translateModel.value = config.translateModel;
  $translateThinking.checked = config.translateThinkingEnabled === true;
  $translateEffort.value = config.translateReasoningEffort || 'high';
  $translateEffortSection.style.display = config.translateThinkingEnabled && !config.translateModel.startsWith('qwen') ? '' : 'none';
  $targetLanguage.value = config.targetLanguage || 'zh';

  $apiKey.value = config.apiKey || '';
  $qwenApiKey.value = config.qwenApiKey || '';
  $enabled.checked = config.enabled !== false;
  $useContext.checked = config.usePageContext !== false;
  $triggerMode.value = config.triggerMode || 'auto';
})();

// ═══════════════════════════════════════════
// 保存配置
// ═══════════════════════════════════════════

$saveBtn.addEventListener('click', async () => {
  const apiKey = $apiKey.value.trim();
  const qwenApiKey = $qwenApiKey.value.trim();

  const stored = await chrome.storage.local.get({ apiKey: '', qwenApiKey: '' });
  if (!apiKey && !stored.apiKey && !qwenApiKey && !stored.qwenApiKey) {
    showStatus('请至少设置一个 API Key（DeepSeek 或 千问）', 'error');
    return;
  }

  const config = {
    apiKey: apiKey || stored.apiKey,
    qwenApiKey: qwenApiKey || stored.qwenApiKey,
    // 解释标签
    explainModel: $explainModel.value,
    explainThinkingEnabled: $explainThinking.checked,
    explainReasoningEffort: $explainEffort.value,
    language: $explainLanguage.value,
    // 翻译标签
    translateModel: $translateModel.value,
    translateThinkingEnabled: $translateThinking.checked,
    translateReasoningEffort: $translateEffort.value,
    targetLanguage: $targetLanguage.value,
    // 通用
    enabled: $enabled.checked,
    usePageContext: $useContext.checked,
    triggerMode: $triggerMode.value
  };

  try {
    await chrome.storage.local.set(config);
    showStatus('✅ 设置已保存！现在去任意页面试试吧', 'success');
  } catch (err) {
    showStatus('保存失败: ' + err.message, 'error');
  }
});

// ═══════════════════════════════════════════
// 实时保存（通用开关）
// ═══════════════════════════════════════════

$enabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: $enabled.checked });
});
$useContext.addEventListener('change', () => {
  chrome.storage.local.set({ usePageContext: $useContext.checked });
});
$triggerMode.addEventListener('change', () => {
  chrome.storage.local.set({ triggerMode: $triggerMode.value });
});

// ═══════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════

function showStatus(msg, type) {
  $status.textContent = msg;
  $status.className = 'status ' + (type || '');
  setTimeout(() => {
    $status.textContent = '';
    $status.className = 'status';
  }, 3000);
}
