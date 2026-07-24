// ========== DeepSeek 智能解释 - Popup ==========

const $apiKey = document.getElementById('api-key');
const $model = document.getElementById('model');
const $language = document.getElementById('language');
const $enabled = document.getElementById('enabled');
const $useContext = document.getElementById('use-context');
const $triggerMode = document.getElementById('trigger-mode');
const $saveBtn = document.getElementById('save-btn');
const $status = document.getElementById('status');

// ── 加载配置 ──
(async () => {
  const config = await chrome.storage.local.get({
    apiKey: '',
    model: 'deepseek-chat',
    enabled: true,
    language: 'auto',
    usePageContext: true,
    triggerMode: 'auto'
  });

  $apiKey.value = config.apiKey || '';
  $model.value = config.model;
  $language.value = config.language;
  $enabled.checked = config.enabled !== false;
  $useContext.checked = config.usePageContext !== false;
  $triggerMode.value = config.triggerMode || 'auto';
})();

// ── 保存配置 ──
$saveBtn.addEventListener('click', async () => {
  const apiKey = $apiKey.value.trim();

  if (!apiKey) {
    showStatus('请输入 DeepSeek API Key', 'error');
    return;
  }

  const config = {
    apiKey,
    model: $model.value,
    language: $language.value,
    enabled: $enabled.checked,
    usePageContext: $useContext.checked,
    triggerMode: $triggerMode.value
  };

  try {
    await chrome.storage.local.set(config);
    showStatus('✅ 设置已保存！现在去任意页面选中文字试试吧', 'success');
  } catch (err) {
    showStatus('保存失败: ' + err.message, 'error');
  }
});

// ── 实时切换 ──
$enabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: $enabled.checked });
});

$useContext.addEventListener('change', () => {
  chrome.storage.local.set({ usePageContext: $useContext.checked });
});

function showStatus(msg, type) {
  $status.textContent = msg;
  $status.className = 'status ' + (type || '');
  setTimeout(() => {
    $status.textContent = '';
    $status.className = 'status';
  }, 3000);
}
