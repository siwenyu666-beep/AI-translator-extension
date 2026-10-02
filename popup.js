// ========== DeepSeek 智能解释 & 翻译 — Popup ==========
// 双标签布局：解释 / 翻译各自独立模型配置 + 通用设置

// ── 模型常量与旧名称兼容 ──
const BUILTIN_MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.7-flash'];
const DEFAULT_MODEL = 'deepseek-flash';
const LEGACY_MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
};

// ── DOM 引用 ──
// 标签
const $tabBtns = document.querySelectorAll('.tab-btn');
const $tabPanels = document.querySelectorAll('.tab-panel');

// 解释标签
const $explainModel = document.getElementById('explain-model');
const $explainCustomInput = document.getElementById('explain-custom-model');
const $explainCustomAdd = document.getElementById('explain-custom-add');
const $explainCustomDelete = document.getElementById('explain-custom-delete');
const $explainThinking = document.getElementById('explain-thinking');
const $explainEffort = document.getElementById('explain-effort');
const $explainEffortSection = document.getElementById('explain-effort-section');
const $explainLanguage = document.getElementById('explain-language');

// 翻译标签
const $translateModel = document.getElementById('translate-model');
const $translateCustomInput = document.getElementById('translate-custom-model');
const $translateCustomAdd = document.getElementById('translate-custom-add');
const $translateCustomDelete = document.getElementById('translate-custom-delete');
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

// 全局自定义模型列表（解释/翻译共用，避免重复维护）
let customModels = [];

// ═══════════════════════════════════════════
// 模型名称工具
// ═══════════════════════════════════════════

function normalizeModelName(model) {
  const name = String(model || '').trim();
  return LEGACY_MODEL_ALIASES[name] || name;
}

function normalizeCustomModels(models) {
  const out = [];
  (Array.isArray(models) ? models : []).forEach(item => {
    const name = normalizeModelName(item);
    if (!name || BUILTIN_MODELS.includes(name) || out.includes(name)) return;
    out.push(name);
  });
  return out;
}

function getModelKey($model) {
  return $model === $explainModel ? 'explainModel' : 'translateModel';
}

function updateCustomDeleteState($model, $deleteBtn) {
  $deleteBtn.disabled = !customModels.includes($model.value);
}

function renderCustomModelOptions($model) {
  const current = $model.value;

  $model.querySelectorAll('optgroup[data-custom-models]').forEach(el => el.remove());

  if (customModels.length > 0) {
    const group = document.createElement('optgroup');
    group.label = '自定义';
    group.dataset.customModels = 'true';
    customModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      group.appendChild(option);
    });
    $model.appendChild(group);
  }

  // 重建选项后恢复原选择
  if (current) $model.value = current;
}

function refreshCustomModelOptions() {
  renderCustomModelOptions($explainModel);
  renderCustomModelOptions($translateModel);
  updateCustomDeleteState($explainModel, $explainCustomDelete);
  updateCustomDeleteState($translateModel, $translateCustomDelete);
}

async function persistModelSelection($model, model) {
  await chrome.storage.local.set({ [getModelKey($model)]: model });
}

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

function syncThinkingSection($model, $thinking, $effortSection) {
  const isQwen = $model.value.startsWith('qwen');
  if (isQwen) {
    $thinking.checked = false;
    $effortSection.style.display = 'none';
    return;
  }
  $effortSection.style.display = $thinking.checked ? '' : 'none';
}

$explainThinking.addEventListener('change', () => {
  syncThinkingSection($explainModel, $explainThinking, $explainEffortSection);
});
$translateThinking.addEventListener('change', () => {
  syncThinkingSection($translateModel, $translateThinking, $translateEffortSection);
});

// ── 模型切换 → 千问自动隐藏思考选项；自定义模型同步删除按钮状态 ──
$explainModel.addEventListener('change', () => {
  syncThinkingSection($explainModel, $explainThinking, $explainEffortSection);
  updateCustomDeleteState($explainModel, $explainCustomDelete);
});
$translateModel.addEventListener('change', () => {
  syncThinkingSection($translateModel, $translateThinking, $translateEffortSection);
  updateCustomDeleteState($translateModel, $translateCustomDelete);
});

// ═══════════════════════════════════════════
// 自定义模型：保存 / 删除
// ═══════════════════════════════════════════

async function addCustomModel($input, $model, $deleteBtn) {
  const raw = $input.value.trim();
  if (!raw) {
    showStatus('⚠️ 请输入模型调用名', 'error');
    return;
  }

  const model = normalizeModelName(raw);
  if (/\s/.test(model)) {
    showStatus('⚠️ 模型调用名不能包含空格', 'error');
    return;
  }

  if (BUILTIN_MODELS.includes(model)) {
    $model.value = model;
    $input.value = '';
    await persistModelSelection($model, model);
    syncThinkingSection(
      $model,
      $model === $explainModel ? $explainThinking : $translateThinking,
      $model === $explainModel ? $explainEffortSection : $translateEffortSection
    );
    updateCustomDeleteState($model, $deleteBtn);
    showStatus(`✅ 已使用内置模型：${model}`, 'success');
    return;
  }

  if (!customModels.includes(model)) customModels.push(model);
  refreshCustomModelOptions();
  $model.value = model;
  $input.value = '';

  const updates = { customModels, [getModelKey($model)]: model };
  await chrome.storage.local.set(updates);

  // 手动触发 change，让思考强度显隐跟随自定义模型供应商前缀
  $model.dispatchEvent(new Event('change'));
  showStatus(`✅ 已保存并使用：${model}`, 'success');
}

async function removeCustomModel($model, $deleteBtn) {
  const model = $model.value;
  if (!customModels.includes(model)) {
    showStatus('⚠️ 当前选择的是内置模型，不能删除', 'error');
    return;
  }

  customModels = customModels.filter(item => item !== model);

  const updates = { customModels };
  [$explainModel, $translateModel].forEach($select => {
    if ($select.value === model) {
      $select.value = DEFAULT_MODEL;
      updates[getModelKey($select)] = DEFAULT_MODEL;
    }
  });

  refreshCustomModelOptions();
  if ($model === $explainModel) {
    syncThinkingSection($explainModel, $explainThinking, $explainEffortSection);
  } else {
    syncThinkingSection($translateModel, $translateThinking, $translateEffortSection);
  }

  await chrome.storage.local.set(updates);
  showStatus(`✅ 已删除自定义模型：${model}`, 'success');
}

$explainCustomAdd.addEventListener('click', () => {
  addCustomModel($explainCustomInput, $explainModel, $explainCustomDelete);
});
$translateCustomAdd.addEventListener('click', () => {
  addCustomModel($translateCustomInput, $translateModel, $translateCustomDelete);
});
$explainCustomDelete.addEventListener('click', () => {
  removeCustomModel($explainModel, $explainCustomDelete);
});
$translateCustomDelete.addEventListener('click', () => {
  removeCustomModel($translateModel, $translateCustomDelete);
});

[$explainCustomInput, $translateCustomInput].forEach($input => {
  $input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      ($input === $explainCustomInput ? $explainCustomAdd : $translateCustomAdd).click();
    }
  });
});

// 点击删除按钮后兜底刷新状态（保持禁用状态与当前选择一致）
$explainCustomDelete.addEventListener('mouseup', () => {
  setTimeout(() => updateCustomDeleteState($explainModel, $explainCustomDelete), 0);
});
$translateCustomDelete.addEventListener('mouseup', () => {
  setTimeout(() => updateCustomDeleteState($translateModel, $translateCustomDelete), 0);
});

// ═══════════════════════════════════════════
// 加载配置
// ═══════════════════════════════════════════

(async () => {
  const defaults = {
    apiKey: '',
    qwenApiKey: '',
    // 解释
    explainModel: DEFAULT_MODEL,
    explainThinkingEnabled: false,
    explainReasoningEffort: 'high',
    language: 'auto',
    // 翻译
    translateModel: DEFAULT_MODEL,
    translateThinkingEnabled: false,
    translateReasoningEffort: 'high',
    targetLanguage: 'zh',
    // 通用
    enabled: true,
    usePageContext: true,
    triggerMode: 'auto',
    // 自定义模型列表
    customModels: []
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

  // 旧模型名兼容：deepseek-v4-flash → deepseek-flash
  const normalizedExplain = normalizeModelName(config.explainModel);
  const normalizedTranslate = normalizeModelName(config.translateModel);
  if (normalizedExplain !== config.explainModel) {
    config.explainModel = normalizedExplain;
    migrated = true;
  }
  if (normalizedTranslate !== config.translateModel) {
    config.translateModel = normalizedTranslate;
    migrated = true;
  }

  const normalizedCustoms = normalizeCustomModels(config.customModels);
  if (JSON.stringify(normalizedCustoms) !== JSON.stringify(config.customModels || [])) {
    migrated = true;
  }
  customModels = normalizedCustoms;

  // 旧版本可能只保存了自定义模型名，没有自定义列表；自动补录，避免下拉框丢失选择
  [config.explainModel, config.translateModel].forEach(model => {
    if (model && !BUILTIN_MODELS.includes(model) && !customModels.includes(model)) {
      customModels.push(model);
      migrated = true;
    }
  });

  if (migrated) {
    await chrome.storage.local.set({ ...config, customModels });
    await chrome.storage.local.remove(['model', 'thinkingEnabled', 'reasoningEffort']);
  }

  // ── 填充 UI ──
  refreshCustomModelOptions();
  $explainModel.value = config.explainModel || DEFAULT_MODEL;
  $explainThinking.checked = config.explainThinkingEnabled === true;
  $explainEffort.value = config.explainReasoningEffort || 'high';
  syncThinkingSection($explainModel, $explainThinking, $explainEffortSection);
  $explainLanguage.value = config.language || 'auto';
  updateCustomDeleteState($explainModel, $explainCustomDelete);

  $translateModel.value = config.translateModel || DEFAULT_MODEL;
  $translateThinking.checked = config.translateThinkingEnabled === true;
  $translateEffort.value = config.translateReasoningEffort || 'high';
  syncThinkingSection($translateModel, $translateThinking, $translateEffortSection);
  $targetLanguage.value = config.targetLanguage || 'zh';
  updateCustomDeleteState($translateModel, $translateCustomDelete);

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

  const config = {
    apiKey: apiKey,
    qwenApiKey: qwenApiKey,
    // 解释标签
    explainModel: normalizeModelName($explainModel.value),
    explainThinkingEnabled: $explainThinking.checked,
    explainReasoningEffort: $explainEffort.value,
    language: $explainLanguage.value,
    // 翻译标签
    translateModel: normalizeModelName($translateModel.value),
    translateThinkingEnabled: $translateThinking.checked,
    translateReasoningEffort: $translateEffort.value,
    targetLanguage: $targetLanguage.value,
    // 通用
    enabled: $enabled.checked,
    usePageContext: $useContext.checked,
    triggerMode: $triggerMode.value,
    // 自定义模型列表
    customModels: customModels
  };

  try {
    await chrome.storage.local.set(config);
    if (!apiKey && !qwenApiKey) {
      showStatus('⚠️ 已保存，但未设置任何 API Key，扩展将无法使用', 'error');
    } else {
      showStatus('✅ 设置已保存！现在去任意页面试试吧', 'success');
    }
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
