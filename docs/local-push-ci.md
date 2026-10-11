# 每小时推送 GitHub

本机任务 `Citadels-GitHubPushCI` 每小时将 `citadels` 本地 `main` 分支已经提交的内容推送到 GitHub `main`。即使当前切换到其他分支，也只推送 `main`。运行时固定提交 SHA，因此执行过程中新增的提交留到下一次推送。

不执行 add、commit、checkout、merge 或强制推送，不上传未提交的修改或未跟踪文件。远端出现分叉、网络中断或凭据失效时停止并记录错误。这个任务只负责发布提交；Gitee 合并 CI 另行负责三小时一次的合并与回归验证。

安装器 `tools/install_local_push_ci.ps1 -Config <绝对配置路径>` 使用 JSON 中的 `state`、`repository`、`target`、`git`、`python` 绝对路径注册任务，并复制固定版本的 runner 到状态目录。脚本更新后需要重新运行安装器。密码由 Windows Git Credential Manager 保存；配置不包含密码或 Token。

退出 Codex 不影响计划任务。重启后登录当前 Windows 账号即可继续运行，锁屏可以运行；关机、睡眠或注销期间无法运行，恢复后会补跑错过的任务。Python/Git 的配置路径必须一直有效。

`last-run.json` 记录最新运行状态，`last-success.json` 记录最近成功，`logs/` 保留最近 180 次日志。`pushed` 表示推送了新提交，`up_to_date` 表示无需更新，`failed` 时查看 `error` 和日志。

```powershell
Start-ScheduledTask -TaskName 'Citadels-GitHubPushCI'
Get-ScheduledTaskInfo -TaskName 'Citadels-GitHubPushCI'
Disable-ScheduledTask -TaskName 'Citadels-GitHubPushCI' # 暂停
Enable-ScheduledTask -TaskName 'Citadels-GitHubPushCI'  # 恢复
```
