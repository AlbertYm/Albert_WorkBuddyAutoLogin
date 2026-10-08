# 合并依据

2026-10-08 合并两套用户仓库的运行流程。每日任务统一使用 GitHub 托管运行器 `ubuntu-latest`。

| 来源 | 保留或整合的内容 | 审阅提交 |
|---|---|---|
| `AlbertYm/workbuddy-auto` | 已在 GitHub 实测的 `copilot.tencent.com` 业务网关、`www.workbuddy.cn` 刷新域、AT / RT Secrets 名称、每日与旅行轮询入口 | `e68d061734946c0abf70cc59a320aeed158df4ad` |
| `AlbertYm/Albert_WorkBuddyAutoLogin` | 签到和旅行终态确认、固定错误类别、非幂等写入超时后的对账、已完成任务领奖、离线测试、本机 IPC 备用入口 | `c262bd1d1e3485a2bf2dc0afb9fb3100847c5e51` |
| `tslshuli/workbuddy-checkin-public` | 签到与插件刷新接口依据 | 审阅快照 `c05a581d0170` |
| `L0NE-6/WorkBuddy-Daily` | 成长任务查询 / 领取、旅行状态别名 | `4823609a5957c569021e7c532958bda73bf00b0f` |
| 用户原本机 `buddy_daily.js` | 本机 IPC 协议和已实测的旅行接口 | 原文件 SHA-256 `27182282D04F639CBB6D1FF9DBFFDDC940B7A817EC12C51CEB5F9B8D56A5E6AE`，未修改 |
| `88lin/workbuddy-auto-signin` | 首次初始化用的加密登录态适配函数，未调用其自动任务函数 | `cb2bf1f02db8900922dc0f06090cdb7334d45ff5`，MIT 许可证随附 |

新增的核心机制：以现有原始 RT Secret 派生仓库绑定的状态加密密钥，最新 AT / RT 保存在加密 GitHub Artifact，每次运行先恢复、需要时续期，再完成持久化，然后执行业务。无需额外 PAT、自己的云服务器或日常本机导出。

私有部署使用已有 Secrets；公开仓库仅保存通用代码。两个仓库合并前均保存原提交备份。没有复制实际 Secret 值、用户本机路径、登录文件或原始账户日志到源码。

原 `workbuddy-auto` 的局限：缺少 `REPO_PAT` 时无法保存新 RT；两项 Secret 分开写入；保存发生在业务之后且失败不导致任务失败；HTTP 成功与业务成功检查不完整；部分失败可能仍退出 0。本合并版使用无 PAT 的加密状态机制并保留失败退出及终态验证。

GitHub 官方 Artifact Actions 固定提交：

- upload-artifact v4：`ea165f8d65b6e75b540449e92b4886f43607fa02`
- download-artifact v4：`d3f86a106a0bac45b974a628896c90dbdf5c8093`
- setup-node v4：`49933ea5288caeca8642d1e84afbd3f7d6820020`

实现会检查刷新后令牌是否变化、实际到期时间是否延长。服务端是否支持滑动续期必须以真实运行结果判定，不能只从源码宣称无限有效。
