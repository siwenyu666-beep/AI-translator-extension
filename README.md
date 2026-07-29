# DeepSeek 智能解释 & 翻译 - Edge 浏览器扩展

基于 [siwenyudecangku](https://github.com/zdjmrq/siwenyudecangku)，新增以**翻译**为核心的第二功能模块。

## 功能

- **智能解释**（升级）：选中文本自动/手动弹出解释，**流式输出**，逐 token 呈现
- **选中翻译**：右键菜单触发，结合上下文准确翻译选中内容，**流式弹窗**展示
- **全文翻译**：右键空白处触发，翻译结果直接覆盖原文（如 Edge 自带翻译），滚动时持续翻译
- **双标签独立配置**：解释和翻译各自拥有独立的模型、深度思考、思考强度设置

## 安装

- 下载本仓库全部文件到一个文件夹
- 打开 Edge 浏览器，地址栏输入 `edge://extensions`
- 开启左侧「开发人员模式」
- 点击「加载解压缩的扩展」，选择本文件夹
- 点击工具栏扩展图标，填入 DeepSeek API Key
- 去任意网页选中文字或右键空白处，即可使用

## 技术栈

- Manifest V3
- Service Worker（流式 API 代理 + SSE 解析）
- Content Script（划词检测 + 流式渲染 + 全文翻译 DOM 替换）
- DeepSeek Chat Completions API（stream: true）

## 许可证

MIT
