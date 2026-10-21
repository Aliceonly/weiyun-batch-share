# 测试与交付状态

版本：0.1.1（测试版）
测试时间：2026-10-21T09:12:02.803Z

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

当前工作目录不是 Git repository，未创建 commit。
