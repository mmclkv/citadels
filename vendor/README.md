# vendored 第三方包

## livekit-client.umd.min.js

- 版本：`2.22.3`（UMD 构建，全局名 `LivekitClient`）
- 来源：`https://registry.npmmirror.com/livekit-client/-/livekit-client-2.22.3.tgz` 的 UMD 产物
- 大小：591334 字节
- sha256：`8305b1ac570af8a77637055cea7bf13cf127d0a3c921c9698a89fa55804267a6`
- 许可：Apache-2.0（上游仓库 https://github.com/livekit/client-sdk-js）

包体里没有版本号以外的元信息可自证，升级时请重新核对上面的 sha256，
不要直接覆盖。本项目不引入 npm 依赖，这个文件就是全部的第三方前端代码；
它只在玩家第一次点「语音」时由 `app.js` 动态插入 `<script>` 加载，
单机模式的玩家不会下载它（详见 README「联机语音」一节）。
