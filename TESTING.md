# 测试与交付状态

## 0.1.2 本次修复验证

验证日期：2026-10-21。

- 使用当前交付的 `background.js`、`content.js`、`panel.js` 建立 Node VM 测试，不修改被测脚本，不访问真实微云。
- 修复前已复现：自动重开读不到密码，补充保护后人工采用，仍回到同一项 `needs_review`，错误为 `PASSWORD_NOT_PERSISTED`。
- `node --test tests/reconcile.test.cjs`：28 项 regression tests 通过，包括人工采用后不再重开当前项、保存并关闭后继续下一项、先处理当前核对弹窗再恢复其他中断项、自动验证保持、导出区分确认方式、旧链接保留，以及账号、密码、URL、revision、扫描消息不能注入人工授权、存储失败/延迟和关闭失败保护。
- `node --check background.js`、`node --check content.js`、`node --check panel.js` 通过；`git diff --check` 通过。
- 人工采用只证明使用者已确认当前弹窗的链接与密码；记录为 `manual_review`，不伪装成 `reopened_dialog`。本次未验证真实网站为什么重开读不到密码，后续独立异常仍会暂停。
- 当前目录不含完整 TypeScript 源码或旧版测试，因此本次未重新运行 TypeScript strict typecheck、原 28 项核心测试或浏览器 integration tests。
- 更新后需同时重新加载扩展和刷新微云网页；不要卸载扩展或清除已保存进度。

## 0.1.1 历史交付记录

历史测试时间：2026-10-21T09:12:02.803Z。以下为原交付记录，不代表本次重新执行。

## 已通过

- TypeScript strict typecheck。
- 28 项核心 regression tests 全部通过。
- 3 项基于真实 DOM 结构的 adapter regression tests 全部通过。
- 已在真实登录微云页面只读确认 list-group-item / .tit 名称结构及 50 → 60 项 lazy loading；名称连续为 1–60、无重复。
- MV3 extension 在隔离的 Chromium 系 profile 中运行，本次使用 Edge 155；测试网页的所有请求由本地 fixture 拦截，不向真实微云创建分享。
- 60 项真实 content script + runtime messages + storage + download；初始 50 项 lazy loading；重载保留进度；320/420px 无横向溢出。
- 重开产生新链接：补充保护、显示两个链接、停止后续项目、不误报成功。
- 真实暂停、panel 重载、继续剩余项，已完成项目不重复创建。
- 目录仅加载 50/60 项时停止且零分享；诊断移除动态 class、attribute name 及所有 attribute values。
- 按真实微云采集的 list-group-item / .tit / menu-list 结构：初始 50 项、完整 60 项、无稳定 ID，逐项加密验证通过。
- 真实 service worker、isolated content script、runtime messages、storage 和 downloads API 集成。
- 独立 Spec / Standards code review 发现的恢复顺序、候选结果丢失、额外链接持久化、账号昵称误识别及诊断字段泄露问题已修复；关键行为有 regression tests。
- 最终发布 manifest 不包含 host_permissions；临时 fixture 扩展为 headless 测试添加的权限没有进入发布目录。

## 尚未验证

- 未在真实微云运行新插件的批量分享端到端验收；真实页面仅展开右键菜单检查结构，没有点击分享或修改密码。
- script 派发事件、既有分享复用语义、服务端密码保存与网站限流，以及其他布局/账号下的 DOM 差异。
- Chrome 中的手动安装、真实工具栏 action 点击与 Side Panel 展示链路仍需用户现场验证。
- 不提供真实微云 60 项固定完成时间承诺；fixture 不代表服务端性能。

## 使用前

先在专用的 3–5 项测试目录中试用，确认链接及密码可以正常访问，再运行正式任务。
当前 2026-10-18 目录已有历史分享，请先按 README 导入旧进度并核对第 32 项，不要直接全新重跑。
本轮开发没有继续执行该真实目录的批量分享；旧进度文件仅复制到 outputs 供手动迁移，不包含在通用源码包。

## 更新旧插件

覆盖原来加载的同一个插件目录，在 chrome://extensions 中重新加载后，还必须刷新微云 tab，再点击插件图标。不要卸载插件或清空本地进度。
因 0/60 扫描失败而没有快照的任务可以继续重扫；已有分享的目录必须继续原进度或导入历史记录，不要盲目重新建立任务。

本次修改未创建 commit。
