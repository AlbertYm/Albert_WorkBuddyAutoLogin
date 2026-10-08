# WorkBuddy GitHub 自动化 — 合并版

**GitHub 托管运行器执行，电脑可以关机，不需要自己的云服务器，不需要每 30 天手动导出登录态，也不需要额外 PAT。**

日常部署在私有仓库 [AlbertYm/workbuddy-auto](https://github.com/AlbertYm/workbuddy-auto)。公开仓库 [AlbertYm/Albert_WorkBuddyAutoLogin](https://github.com/AlbertYm/Albert_WorkBuddyAutoLogin) 保存同一套通用源码；其每日任务默认不运行，避免同一账户有两套定时任务。

## 每次自动做什么

1. 找到本仓库最新一份、未过期的加密凭据 Artifact，恢复最新 AT / RT。
2. 检查两种凭据的实际 `exp`：AT 剩余不超过 5 天，或 RT 剩余不超过 7 天时，调用 WorkBuddy 插件刷新接口取得新的一对凭据。
3. 只读验证登录。AT 尚未到期但被接口判为 401 时，允许一次自动刷新，并重新验证。
4. 将当前凭据加密成新的快照，上传 GitHub Artifact。**保存成功之后才执行签到、领奖、派猫。**
5. 今日已签到就跳过；猫咪在旅行中就等待；到家先领奖，再查询次数限制；只在可派出时派一次。
6. 成长任务仅领取服务端已经标为 `completed` 的奖励，不接取、不伪造进度、不调用模型、不消费补签卡、不抽奖。

业务写请求超时后查询实际状态，不直接重发写请求；明确 404 才换候选路径。未知积分数记为 `null`，不编造 +100。任一启用任务失败会让工作流失败，不把部分失败报告成成功。

## 30 天后为什么还能运行

仓库中现有的 `WB_ACCESS_TOKEN` 和 `WB_REFRESH_TOKEN` Secrets 用于第一次初始化。其中原始 `WB_REFRESH_TOKEN` 同时作为 HKDF-SHA256 的秘密输入，派生 AES-256-GCM 状态加密密钥；派生过程绑定仓库名称。

刷新后取得的 **新 AT / 新 RT** 保存到加密 Artifact。下一次从 Artifact 恢复最新凭据，原始 RT 不再用于请求 WorkBuddy，只用于解密。**原始 RT 的服务端有效期届满不会让加密密钥失效。** 因而不需要把新凭据写回 GitHub Secrets，不需要 `REPO_PAT`，不需要把桌面 GitHub 登录授权复制到云端。

每次运行都会上传一个当前快照，保留 90 天，即使本次业务操作失败也保留已更新的凭据。状态选择依据最新 Artifact，而不是只选择绿色成功的运行，避免业务失败后退回已经轮转掉的旧 RT。

Artifact 只含 `schema/repo/keyId/iv/tag/ciphertext`，没有明文 AT / RT。加密采用随机 12 字节 IV 和完整认证标签，篡改、错仓库、错种子均会失败。密钥和 token 不打印、不作为命令行参数、不保存到 Git 或明文文件。GitHub 自动提供的 `GITHUB_TOKEN` 只需要 `contents: read` 和 `actions: read`；上传使用 GitHub 官方 Artifact Action 的运行时授权。

这是对正常凭据到期的自动续期。WorkBuddy 主动撤销会话、修改登录协议或 GitHub 服务中断不是固定的 30 天重置周期；这类外部事件可能需要人工恢复，不能承诺服务商永远不撤销会话。续期后 AT/RT 是否确实延长，通过报告中的 `renewal.*ExpiryExtended` 布尔值验证，不只凭 HTTP 200 宣称长期续期成功。

## 定时与停止

时区 **Asia/Shanghai**：每天 **09:30**，以及 **00:17 / 04:17 / 08:17 / 12:17 / 16:17 / 20:17** 轮询。签到接口会先检查状态，重复轮询不会重复签到；旅行和奖励由服务端状态决定。GitHub 定时可能延迟，不能承诺准点。

主要入口：`Actions → buddy-daily → Run workflow`。

- `action=execute`：正常执行。
- `action=check`：只读业务检查；仍会维护登录凭据和加密快照。
- `force_refresh=true`：强制一次真实续期，用于初次验收或检查续期链。日常设为 false。

停止：在 GitHub Actions 禁用 `buddy-daily`。撤销会话时还应在 WorkBuddy 的账户安全功能中退出或撤销登录授权。公开源码副本只有显式设置 `WB_ENABLED=true` 才会运行每日任务；同一账户请使用一个部署。

## 现有仓库无需重新初始化

`workbuddy-auto` 已有两项 Secret，合并流程直接使用现有授权，不读取 Windows 登录文件，不要求用户再提交 token。初始化成功后，日常无需打开 WorkBuddy 客户端，也无需运行 `renew_export.py`。

如果复制到一个全新仓库，首次仍需用户主动授权一次。用户在本机完成 GitHub CLI 登录后：

```powershell
python renew_export.py --repo YOUR_OWNER/YOUR_REPO
```

这条只有预览，不读取登录态。明确允许本机登录文件解析和上传到该仓库后，用户自行添加 `--write`；公开仓库还需 `--allow-public`。不要在聊天中发送登录文件或凭据。初始化工具复用固定版本、带许可证和文件哈希校验的原生适配器，不自动下载最新版。

自动化不会修改种子 Secrets。正常运行时不要定期用本机导出覆盖它们；如因撤销会话而重新初始化，新的种子会自动切换到另一组 Artifact 名称，不需要删除旧历史。

## 本机备用入口

`check-local.cmd` / `run-local.cmd` 保留 `wbipc` 方式，使用相同的业务状态机。它们只用于手动检查或备用，不是 GitHub 每日执行的依赖。原本的 WorkBuddy 本机脚本未修改。

## 代码验证和回滚

运行环境：GitHub `ubuntu-latest`、Node.js 20。代码与测试无第三方 Node 依赖，不使用外部模型 API。Windows 本机验证使用 Node.js 24；首次初始化工具另需 Python 3.10+、GitHub CLI 和已登录的 WorkBuddy 客户端。

```powershell
node --test
```

模拟测试覆盖正常状态、401、业务拒绝、超时后的终态确认、每日次数上限、已完成任务过滤、密文篡改、旧种子第 40 天仍可恢复新状态、跨次轮转、保存失败停止和 TLS 校验。模拟测试不替代真实 WorkBuddy 与 Artifact 跨次运行验收。

合并前两个仓库的提交均保存在 `backup/before-unified-renewal-20261008` 分支。回滚时可以恢复源代码；已轮转过的凭据应继续使用最新加密状态，**不要直接重新运行只会读取旧 RT 的旧脚本**。需要停止时先禁用每日工作流，不删除种子 Secrets 或最新 Artifact 来“重置”。

Artifact 的正常保留期为 90 天，持续运行会持续生成新快照；如果整套任务停用超过保留期、状态全部丢失且原始凭据也过期，需要重新初始化。恢复工具是异常恢复入口，不是按月操作要求。

整合来源与审阅说明见 [SOURCE-REVIEW.md](SOURCE-REVIEW.md)。
