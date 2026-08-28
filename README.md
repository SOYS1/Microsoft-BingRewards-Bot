## Microsoft Bing Rewards 自动搜索助手 | Microsoft BingRewards Bot

自动完成 Microsoft Rewards 在必应（Bing）上的每日搜索任务，支持自动点击奖励卡片、自定义搜索速度、进度监控与 UI 配置。模拟人工操作提高安全性，全自动完成电脑端90分任务。

## 功能特性

- **自动搜索**：自动执行每日搜索任务，支持主页面和侧边栏搜索词
- **进度追踪**：实时显示搜索进度和倒计时
- **自动点击**：自动点击奖励卡片（每日点击任务）
- **智能容错**：连续无进度时自动休息，避免无效操作
- **模拟人工**：搜索间隔随机化、滚动行为随机化，降低被检测风险
- **状态持久化**：刷新页面后自动恢复搜索状态
- **保底搜索**：搜索词用尽时自动切换保底词库

## 安装

### 环境要求

- 浏览器：Chrome、Edge、Firefox 或 Opera 等支持用户脚本的浏览器
- 用户脚本管理器：**Tampermonkey**（推荐）或 Greasemonkey

### 安装步骤

1. 安装 Tampermonkey 扩展（[Chrome 商店](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Edge 商店](https://microsoftedge.microsoft.com/addons/tampermonkey) / [Firefox 商店](https://addons.mozilla.org/firefox/addon/tampermonkey/)）
2. 点击扩展图标 → "添加新脚本"
3. 将 Microsoft-BingRewards-Bot.js 内容粘贴进去，覆盖默认模板
4. 按 `Ctrl+S` 保存，或在 Tampermonkey 菜单中选择「文件」→「保存」
5. 访问 `bing.com`，脚本将自动生效

或从 [Greasyfork](https://greasyfork.org/zh-CN/scripts/592417) 直接安装。

## 使用方法

1. 打开 [Bing](https://www.bing.com) 并登录 Microsoft 账户
2. 进入有 Rewards 积分显示的页面（如 Bing 首页）
3. 右下角会出现浮动面板，显示当前进度
4. 点击 **▶ 开始搜索** 启动自动任务
5. 脚本将自动完成全部搜索任务

> 💡 脚本会在检测到任务完成后自动停止

## 配置参数

- 点击标题栏的 **−** 按钮折叠面板（仅保留进度和状态）
- 点击 **+** 按钮展开完整面板

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 休息时间(分) | 5 | 连续无进度时的休息时间 |
| 滚动时间(秒) | 10 | 每次搜索后的页面滚动时长 |
| 等待时间(秒) | 10 | 检查进度后的等待时间 |
| 容错次数 | 3 | 连续多少次无进度才触发休息 |
| 自动点击奖励卡片 | 开启 | 是否自动点击每日点击任务 |

> 默认参数已经过优化，一般无需修改。修改后自动保存到本地存储。