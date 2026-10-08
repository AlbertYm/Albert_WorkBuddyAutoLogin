# Albert_WorkBuddyAutoLogin — WorkBuddy 统一自动化

这份版本整合了你的 `buddy_daily.js` 的本地请求通道和旅行逻辑、`tslshuli/workbuddy-checkin-public` 的签到与刷新接口、`L0NE-6/WorkBuddy-Daily` 的已完成任务领奖接口，以及公众号文章介绍的客户端加密登录态适配方法。

日常目标是：GitHub 保存代码、触发流程；你自己的云服务器执行任务；Windows 电脑可以关机。本机 `wbipc` 作为可选入口，共用相同任务逻辑。

**状态：整合源码和本机离线模拟验证已完成；真实登录、真实领奖、凭据上传、Runner 安装与每日定时均未执行。** 用户指定公开源码仓库 [AlbertYm/Albert_WorkBuddyAutoLogin](https://github.com/AlbertYm/Albert_WorkBuddyAutoLogin)。代码验证工作流只执行模拟测试，不使用账户凭据。原来的 WorkBuddy 自动化目录没有修改。

## 能自动做什么

- 每日签到：先查状态；已签到跳过；写入后再查状态确认。没有返回积分数时报告 `null`，不默认写成 +100。
- 猫猫旅行：旅行中等待；到家后领奖并重新查询；达到每日次数上限不再派出；选择第一个解锁地点；派出后确认状态。写入超时不会直接再派一次。
- 成长任务：仅领取服务端标为 `completed` 且在 `config.json` 的 `claimTaskCodes` 列表中的任务。不自动接取或制造完成记录。列表默认空，因此这项尚未启用。
- 登录续期：云端 JWT Access Token 剩余不足一天，或 Access Token 无法识别期限且存在 Refresh Token 时，尝试刷新；新的 AT 和 RT 一起写回同一个 GitHub Secret，然后才执行领取。
- 客户端升级：本机入口走 `wbipc`，不读取 Access Token；首次云端初始化由用户主动运行文章关联的原生模块适配器，支持其已实现的加密格式。未知协议、未知加密格式、未知业务状态会失败，不猜测兼容方式。

不会自动抽奖、开盲盒、兑换、使用补签卡、调用模型、模拟使用行为或升级上游脚本。

## 为什么云端不直接运行原来的文件

你的 `buddy_daily.js` 读取本机的 `.workbuddy/wbipc/endpoint.json`，连接 WorkBuddy 守护进程，由它附加登录态。这个本地 IPC 通道不能搬到普通 Linux 云端直接用。云端需要独立凭据，而不是复制 `endpoint.json`。

同时，GitHub 当前条款限制 GitHub-hosted runners 执行与仓库软件生产、测试、部署或发布无关的活动。因此本交付采用运行在你自己云服务器上的 self-hosted Runner。单纯把 `runs-on` 改成 `ubuntu-latest` 不解决条款与登录维护问题。

- [GitHub Actions 使用条款](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions)
- [Self-hosted runners 原理](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)

公开仓库的源码与 Actions 日志对外可见，Secrets 的值仍须保存在 GitHub Secrets 中，不能写入代码或日志。公开源码不等于已授权公开登录凭据。云端 Runner 应只运行本仓库经过审核的默认分支账户任务，不运行外部 PR；离线 PR 测试使用 GitHub 托管运行器且不传 Secrets。具有仓库写权限的人可以修改工作流，应限制写权限。60 天无活动的公开仓库定时可能被 GitHub 停用，不使用自动制造提交的方式保活。

## 文件入口

| 文件 | 用途 |
|---|---|
| `engine.js` | 共享签到、旅行、已完成任务领奖状态机 |
| `cloud.js` | 云端 HTTPS 请求、凭据刷新、Secret 持久化 |
| `ipc.js` | 从用户原脚本协议派生的本地请求代理 |
| `main.js` | 参数、运行锁、脱敏报告、失败退出码 |
| `config.json` | 开关和任务编号白名单 |
| `sync-auth.py` | 用户主动初始化云端凭据，不自动运行 |
| `vendor/signin.py` | 固定版本的客户端原生模块登录态适配器，仅使用其凭据解析函数 |
| `.github/workflows/daily.yml` | 云服务器 Runner 定时和手动入口 |
| `check-local.cmd` / `run-local.cmd` | Windows 一键只读检查 / 实际执行 |
| `tests/engine.test.js` | 不接触账户的离线模拟测试 |

运行需求：Node.js 20 或更新版本；云服务器 Linux、外网 HTTPS、GitHub CLI `gh` 和已注册且带 `workbuddy-cloud` 标签的 Runner。首次 Windows 凭据初始化还需要 Python 3.10+、已登录的 WorkBuddy 桌面端和 GitHub CLI。无需外部 AI、模型 API 或管理员权限执行脚本；安装系统服务可能需要系统管理员权限，本包不会自动安装服务。

## 第一步：离线验证

在此目录打开终端：

```powershell
node --test
node main.js --help
python sync-auth.py --repo AlbertYm/Albert_WorkBuddyAutoLogin
```

最后一条只有预览，**不读取登录文件、不解密、不上传、不调用账户接口**。如改用别的仓库，请使用真实的 owner/repo。

## 第二步：确定部署目标

1. 用户已选择公开源码仓库 `AlbertYm/Albert_WorkBuddyAutoLogin`，只上传这份代码目录。私有仓库同样可以运行 Actions。不要上传 WorkBuddy 原配置、登录文件、`endpoint.json` 或任何 token。
2. 选定一台长期在线的云服务器。运行脚本的目录应专门用于这个仓库，不覆盖已有服务或数据。
3. 在 GitHub 仓库 `Settings → Actions → Runners → New self-hosted runner` 中选择 Linux，按 GitHub 为该仓库生成的命令注册，添加自定义标签 `workbuddy-cloud`。注册授权由用户完成，不在聊天中发送注册 token。
4. 云服务器安装 Node.js 和 GitHub CLI，并确认 Runner 可以使用。不要把这台有账户凭据的 Runner 开放给不可信仓库、PR 或工作流。

已按用户授权创建公开仓库；本包不会自动注册 Runner、安装启动项或修改云服务器。已确认具体仓库、服务器、目录、服务名及回滚方式后再部署。

## 第三步：用户主动初始化凭据

这一步会读取本机 WorkBuddy 登录文件，必要时调用 WorkBuddy 原生运行时解密，将 AT、RT 和请求所需账户标识通过 `gh` 的标准输入上传到**明确指定的仓库**的 `WORKBUDDY_AUTH` Secret。明文不写文件、不打印、不作为命令行参数。这是持续运行授权：有效期由 WorkBuddy 实际会话规则决定，退出登录、撤销、风控、密码变更或协议变化均可能使其失效。

用户先在自己的终端完成 GitHub CLI 登录：

```powershell
gh auth login
python sync-auth.py --repo AlbertYm/Albert_WorkBuddyAutoLogin
```

核对预览中的目标仓库，并明确同意上述数据和接收方后，在本机自行执行。公开仓库需同时指定 `--allow-public`：

```powershell
python sync-auth.py --repo AlbertYm/Albert_WorkBuddyAutoLogin --allow-public --write
```

如果安装位置探测失败，可额外传入 `--exe "完整的 WorkBuddy.exe 路径"`；如登录文件路径不同，可使用 `--auth-file "登录文件完整路径"`。只传路径，不把文件内容交给聊天或加入仓库。客户端出现新加密格式时，脚本会停止，需要先审查并更新适配器；本包不会自行下载最新版。

接着，用户在 GitHub 创建只针对该仓库的 fine-grained personal access token，赋予仓库 **Secrets: Read and write**，选择合适的有限期限，在仓库 `Settings → Secrets and variables → Actions` 将它保存为 `WB_SECRET_WRITE_TOKEN`。不要发给助手。此凭据用于保存刷新后的 WorkBuddy 凭据；默认 `GITHUB_TOKEN` 的 `contents: read` 权限不能替代它。到期需由用户更换。

`WORKBUDDY_AUTH` 与 `WB_SECRET_WRITE_TOKEN` 应保存在仓库 Secrets，不是 Environment Secrets。本包的写回目标固定为仓库 Secret；改成 Environment 会使轮转写到另一处，不能直接混用。

## 第四步：真实验收与启用定时

1. 代码在默认分支，Runner 显示在线，Secrets 设置完成后，先设置仓库 Variable `WB_REPOSITORY_APPROVED=AlbertYm/Albert_WorkBuddyAutoLogin`，然后在 `Actions → WorkBuddy unified daily → Run workflow` 先选择 `check`。
2. `check` 会联网读取账户状态，但不会刷新 token、领取、派猫或写 Secrets。若 token 已过期，它会失败；再运行 `execute` 可尝试配置好的刷新链路。
3. 明确允许本账户的签到和猫猫旅行操作后，手动选择 `execute`。检查报告中的签到终态、旅行终态和实际积分。成长任务默认不领；需要时在 `config.json` 添加你希望领取的任务编号。
4. 验收通过后，在仓库 Variables 中设置 `WB_ENABLED=true`。定时为 **Asia/Shanghai 每天 09:17 与 21:43**：早上签到和派猫，晚上领取已到家的奖励；到达时间更晚时留待下一轮。GitHub 定时可能延迟或丢弃任务，不保证准点。
5. 下一次定时运行也成功，才算完成云端验收。模拟测试、Secret 保存成功或单次 HTTP 200 都不等于部署验收通过。

日常在 Actions 查看固定字段报告，运行失败会使该次任务失败。通知由你自己 GitHub 的 Actions 通知设置决定；本包未设置邮件、微信或其他外发通知。

## 保持登录和失效恢复

云端采用当前 AT / RT，不依赖 Windows 每天开机。RT 刷新成功且写回成功时可以延续运行，但不能承诺永久登录。文章中的 55 / 60 天是当时观察，本包使用实际 JWT `exp`，不将该天数硬编码。

同一账户不要同时在另外两个旧仓库中刷新同一条 RT 链。GitHub 的 concurrency 只覆盖本仓库；不同仓库、本机客户端、撤销操作仍可能竞争刷新或使会话失效。

如果刷新请求在服务端成功后网络断开，或者新 RT 已生成但 Secret 保存失败，远端登录服务与 GitHub Secrets 之间没有跨系统事务，存在无法自动恢复的窗口。脚本会停止，不继续用未保存的新凭据执行奖励。用户需要重新登录客户端、重新同步 `WORKBUDDY_AUTH`，再手动验收。不要反复用可能已失效的旧 RT 重试。

不需要每天重新同步；只有初始化、会话失效、更换账户或主动重建授权时再同步。同步后不需要重启脚本，下一次独立运行会读取新 Secret；如果某次任务已经启动，需等它完成后再运行一次，避免并发轮转。

## 本机备用入口

启动 WorkBuddy 并保持登录后，双击 `check-local.cmd` 先查询；明确要执行签到、领奖、派猫时双击 `run-local.cmd`。它们共用 `engine.js`，不会把 token 导出到云端。

这份本机入口没有修改你原来的自动化。不要同时启用原来的每日任务与这份本机任务来派同一只猫；读后写仍可能遇到跨进程竞态。默认仅使用云端日常入口。

## 停止和回滚

- 将 `WB_ENABLED` 改为 `false`，定时不执行；必要时在 Actions 禁用整个工作流，手动取消正在运行的任务。
- 撤销 `WB_SECRET_WRITE_TOKEN` 对应 PAT、删除两个仓库 Secrets 可撤销云端凭据引用；在 WorkBuddy 退出或撤销会话处理已经导出的账户授权。
- 注销 Runner、停止新建 Runner 服务，可撤销 GitHub 对该云服务器的执行入口。代码可回滚到此前审查过的提交；清空 `WB_REPOSITORY_APPROVED` 也会阻止手动和定时账户任务。
- 原来的本地 `buddy_daily.js` 和执行记忆没有修改，仍可恢复原路径运行。
- 若进程被强制终止留下 `workbuddy-unified.lock`，先确认该用户下没有脚本运行，再删除系统临时目录中的这一锁文件；不要在任务运行时删除锁。

## 证据与限制

当前机器验证环境为 Windows、Node.js v24.13.0、Python 3.12.10。测试仅使用模拟服务：401、空响应、业务拒绝、未知状态、未知积分、超时后对账、每日旅行上限、任务白名单、TLS 与跨域重定向、令牌轮转和持久化失败等。没有调用真实 WorkBuddy 账户、没有解密真实登录文件、没有上传 Secret、没有测试云服务器或注册 Runner。

原自动化 `memory.md` 记录了 2026-10-08 本机真实签到 +100、猫咪出发以及重复运行不再签到 / 派出；这是 WorkBuddy 记录的历史执行证据，不是本交付由 Codex 重跑的结果。

来源版本和修正点见 `SOURCE-REVIEW.md`。客户端原生模块属于内部接口，wbipc 和活动 API 也可能变化；未知变化需要复核源代码和实际响应，不能承诺客户端升级后永不失败。
