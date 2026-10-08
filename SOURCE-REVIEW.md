# 整合依据与修正点

审阅日期：2026-10-08。公开仓库以已下载的固定提交为依据，原本机自动化仅作只读审阅。

| 来源 | 本次用途 | 版本依据 |
|---|---|---|
| [tslshuli/workbuddy-checkin-public](https://github.com/tslshuli/workbuddy-checkin-public) | 签到接口、插件 RT 刷新接口、Actions 报告思路 | 本地审阅快照提交前缀 `c05a581d0170` |
| [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily/tree/4823609a5957c569021e7c532958bda73bf00b0f) | 已完成成长任务查询 / 领取、旅行状态别名 | `4823609a5957c569021e7c532958bda73bf00b0f` |
| 用户的 `buddy_daily.js` 与同目录 `memory.md` | 本机 IPC 协议、实测的签到 / 旅行路径、`idle/traveling/completed` 状态 | 原 JS SHA-256：`27182282D04F639CBB6D1FF9DBFFDDC940B7A817EC12C51CEB5F9B8D56A5E6AE` |
| [公众号文章](https://mp.weixin.qq.com/s/VBaoD7a8HWjjbDeersVeUQ) | 加密字段改动、原生运行时兼容、失败可见、凭据维护 | 文章显示发布日期 2026-09-28 |
| [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin/tree/cb2bf1f02db8900922dc0f06090cdb7334d45ff5) | 仅复用本机凭据格式解析和原生助手；未调用其签到 / 成长任务函数 | `cb2bf1f02db8900922dc0f06090cdb7334d45ff5`；MIT 许可证随附 |

用户原自动化包含 `buddy_daily.js` 和同目录 `memory.md`。本交付没有覆盖原脚本、改写执行记忆或变更原任务安排；原机目录不随公开源码发布。

## 本次确实修正的风险

1. 用户脚本 `unwrap` 未检查 HTTP 状态；本版要求 HTTP 成功、业务 code 成功及有效 data，401 不再误判成功。
2. 用户脚本领取失败写在 REPORT 后仍可能退出 0；本版任一启用任务失败使进程退出 1。
3. 用户脚本缺少积分数据时默认 +100；本版只有实际数字才记录积分，没有数据用 null。
4. 用户脚本派出虽称不重试，但请求超时后仍可能换另一路径再次写入；本版仅明确 404 才允许换路径，写入超时后查询终态。
5. 用户脚本 completed 领奖成功分支可能绕过 daily_limit；本版领取后重新查状态和次数上限。
6. 公共签到脚本取得新 RT 后未自动持久化；本版将 AT / RT 同步保存到单个 Secret，保存失败停止执行。跨系统中断窗口仍无法消除。
7. WorkBuddy-Daily 的环境旧 RT 可能覆盖已保存的新 RT，且其工作流把 token 文件提交到 Git；本版不将登录信息写进 Git。
8. WorkBuddy-Daily 使用 `verify=False`；本版保留 TLS 校验，不跟随重定向，不允许任意目标域。
9. WorkBuddy-Daily 的接取 / 领奖部分不完全受任务过滤约束；本版的成长任务仅在明确白名单中领取已完成项。
10. 用户原脚本 DEBUG 和原始业务报错可能包含非预期字段；本版不输出原始响应、鉴权帧、token 前缀或后端字符串消息，仅固定错误类别和数字状态。

## 本版未声称实现的能力

- 永久登录、保证每日准点、保证每次拿到固定积分、适配任何未来客户端版本。
- 自动完成需要真实操作或模型调用的活动任务。
- 云端调用 Windows 的 wbipc。
- 已解密 / 同步用户凭据、已部署到 GitHub、已创建云服务器进程。

成长任务平台头等细节在真实云端验证前仍有兼容性不确定性；本版不会遇到 400 就自动伪装不同客户端再写一次。首次验收需要以实际服务端状态为准。
