# 开发版、稳定版与线上部署

`main` 用于持续开发。`VERSION` 记录计划发布的版本，初始为 `0.1.0`，并不表示已经发布稳定版。
版本号采用 `主版本.次版本.修订版本`：不兼容变更增加主版本，功能增加次版本，修复增加修订版本。

开发目录显示 `0.1.0-dev+g<提交号>`，已跟踪文件有未提交修改时追加 `.dirty`。
即使 `main` 当前提交已经打过标签，在 `main` 中运行仍然属于开发版。
只有**以 detached HEAD 检出、已跟踪文件无修改、对应附注标签为 `vX.Y.Z`，且标签与 VERSION 一致**的目录，才属于稳定版。
Git 信息缺失、轻量标签、标签不匹配或本地修改，都不能通过稳定版启动检查。

## 发布一个稳定版

1. 在 `main` 上完成开发、验证，将 `VERSION` 改为准备发布的版本并提交。
   初次可用 `0.1.0`；以后发布必须使用更高版本。不要覆盖、移动或删除已发布标签。
2. 获取远端标签，避免与其他发布冲突，然后显式创建附注标签：

   ```bash
   git fetch origin --tags
   python tools/release.py tag 0.1.0
   ```

   命令会检查 VERSION 已提交、已跟踪文件干净、版本不重复且高于旧版。
   它不代替规则测试、真实对局或模型验证，发布前仍需完成本次变更所需的检查。
   未跟踪的本地文件不会进入发布提交。

3. 确认要发布后，分别推送代码和标签：

   ```bash
   git push origin main
   git push origin v0.1.0
   ```

   推送 `main` 不再触发 GitHub Pages 更新。推送稳定版标签才部署静态站点；工作流会再次校验发布身份。
   GitHub Actions 手动部署必须输入已有稳定版标签，也可用它回滚静态站点。
   后端服务器需独立切换版本，GitHub Pages 工作流不会重启它。

4. 继续在 `main` 开发。下一轮开发开始时将 VERSION 改为下一计划版本，例如 `0.2.0`。
   无论是否已经改号，后续 `main` 提交都不会改变 `v0.1.0` 指向的代码、配置和仓库默认模型权重。

## 后端服务器按版本部署

保留一个用于获取代码的源仓库，例如 `/srv/citadels-source`。
每个稳定版放入独立目录，服务器不在 `main` 工作目录中运行，也不通过 `git pull main` 更新。
例如在 Linux 上准备 `v0.1.0`：

```bash
python /srv/citadels-source/tools/release.py checkout v0.1.0 /srv/citadels-releases/v0.1.0 --fetch
```

该命令从 `origin` 获取标签，验证标签对应提交，然后创建 detached Git worktree；目标目录必须不存在。
省略 `--fetch` 可部署本地已存在的标签，不依赖网络。
Windows 也支持同一命令，目录参数可以改为 `C:\citadels-releases\v0.1.0`。
worktree 共享源仓库的 Git 数据；保留源仓库，不要移动或删除源仓库及发布目录。

发布目录不包含原目录里被 Git 忽略的 Python、Torch、编译器及已编译 worker。
使用已安装依赖的**共享 Python 环境的绝对路径**启动；C++ worker 会按该版本源码独立构建。
先在备用端口启动新版本，检查版本、真实对局和模型，再切换正式服务。
首次构建可能需要时间，不能把“成功检出”等同于“上线验证通过”。

把运行数据放在代码目录之外，服务启动配置例如：

```bash
export CITADELS_TRAINING_DATA_DIR=/srv/citadels-data/training-data
export CITADELS_ADMIN_FILE=/srv/citadels-data/server-admin.json
export CITADELS_REQUIRE_STABLE=1
/opt/citadels-python/bin/python /srv/citadels-releases/v0.1.0/python_backend/run.py 8787 --host 0.0.0.0 --require-stable
```

`CITADELS_TRAINING_DATA_DIR` 同时用于网页训练和独立训练。未设置时沿用各代码目录内的 `training-data/`。
首次迁移需停止训练并将原有存档复制到共享数据目录；检出工具不会自动移动存档或重启服务。
管理员凭据可使用上述共享文件，或沿用已有环境变量/用户配置目录。
默认策略权重随发布提交固定；若配置 `CITADELS_NEURAL_CHECKPOINT`，应使用经过验证的外部权重绝对路径，并独立管理其版本。

systemd、容器或现有进程管理器的启动命令应固定指向目标版本目录，并保留 `--require-stable`。
也可以让服务指向 `/srv/citadels-current/python_backend/run.py`，将 `citadels-current` 符号链接切换到已验证的发布目录后再重启。
命令行标志或环境变量都能启用稳定版检查，检查在 worker 构建、监听端口之前执行。

## 回滚与查询

回滚到已保留的旧目录时，只需切换服务启动路径并重启。
若旧目录不存在，可重新检出旧标签到新的目录：

```bash
python /srv/citadels-source/tools/release.py checkout v0.1.0 /srv/citadels-releases/rollback-v0.1.0 --fetch
```

回滚不会覆盖开发代码或删除训练存档。旧代码能否读取新格式的训练存档，需要按该版本兼容性确认。
重启会中断当前内存中的房间，建议在无对局、训练已停止时切换。

查询方式：

```bash
python tools/release.py status
python python_backend/run.py --version
curl http://127.0.0.1:8787/api/version
```

返回版本、开发/稳定通道、完整提交号、标签和修改状态。服务器启动日志、首页“启动信息”和管理员状态接口也显示发布身份。
HTTP 返回的是该服务器启动时的身份；运行过程中不要编辑发布目录。
GitHub Pages 的 `/version.json` 则记录静态站点发布版本，可能与独立后端版本不同。

首个稳定版为 `v0.1.0`，游戏与训练基准为 `945d1b3`，补入发布支持后发布。
具体范围见 [v0.1.0 发布说明](release-0.1.0.md)。发布本身不切换线上后端服务器。
