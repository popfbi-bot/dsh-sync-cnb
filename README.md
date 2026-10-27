# dsh-sync-cnb

一套引擎，接 CNB 和 GitHub（以及 Gitee / GitLab / GitCode / 自建）。把 DeepSeek Harness 的 `~/.dsh` 在多台机器之间保持一致，而不把密钥传出去。

针对的场景是**多台机器长期并行使用**，且** Windows 与 macOS 混用**。

---

## 为什么自己写

现有同步插件的托管方白名单里没有 CNB：`weibaohui/dsh-sync` 只认 GitCode / GitHub / GitLab / Gitee，`dpskk2/dsh-chatsync` 的安装流程绑在 GitHub CLI 上。CNB 是标准 HTTPS Git 协议，理论上能填自定义仓库硬跑，但没人替你验证过。

所以这个插件把"平台差异"压到最小：一个 provider 只回答五件事——URL 怎么拼、git 用户名是什么、仓库私有性怎么校验、PR 怎么开、PR 怎么合。剩下的提交、推送、抓取、三方合并、冲突副本，全部是平台无关的。加一个托管方只需要加一个约 80 行的声明文件。

## 安装

```bash
dsh plugin --profile web add github:<你的账号>/dsh-sync-cnb#v0.1.0
# 或本地目录
dsh plugin --profile web add /绝对路径/dsh-sync-cnb
```

重启 DSH 生效。设置页出现「同步」，会话里可以直接让 Agent 调用 `sync_status` / `sync_preview` / `sync_now` / `sync_snapshot`。

本插件是**纯 ESM、零构建**：`lib/` 不需要预先编译，git 安装时不跑构建脚本，也就不需要 pnpm 的 `allowBuilds` 授权。

### 配置

最小配置（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-sync-cnb
      name: dsh-sync-cnb
      config:
        provider: cnb
        repoUrl: '你的组织/dsh-sync'   # 也接受完整 URL
        branch: main
        machineId: ''                  # 留空则用 主机名-平台
```

CNB 侧：在 https://cnb.cool/profile/token 建访问令牌，**必须额外勾选私有仓库权限**——默认令牌对私有仓库是零权限。然后：

```bash
export DSH_SYNC_TOKEN=你的令牌
```

GitHub 侧：`provider: github`，令牌需要 Contents: read+write（开 PR 模式还要 Pull requests: read+write）。

首次使用建议先跑一次校验，公共仓库会被直接拒绝保存：

```
POST /api/dsh-sync-cnb/verify
```

自建或未知托管方无法校验私有性，接口会返回 `unverified: true`，需要你手动确认后再放行。

---

## 仓库布局

```
shared/<slice>/<rootTag>/<rel>                  并集切片（技能）
instances/<machineId>/<slice>/<rootTag>/<rel>   各机独立切片（会话、设置、插件清单）
.dsh-sync/state.json                            同步台账（不含密钥）
```

**为什么是"一个分支 + 按机器分目录"，而不是"一机一分支"**：几台机器在任意时刻推送，一机一分支会把每次同步变成 rebase 战争，共享部分照样要合并。按机器 ID 分目录之后，git 层面**永远不需要解决任何冲突**——每台机器只写自己那个目录。真正的合并在提交之前完成，由我们自己控制的三方合并来做。

**关键性质**：边车仓库（`~/.dsh/dsh-sync-cnb/repo`）的工作树是一个**生成物**。每轮同步都可以放心地从远端重置它，再重新铺一遍本地内容。这就是为什么这套引擎不需要 `git merge`，也不会产生合并提交。

流程：`fetch → 强制重置到 origin/main → 铺本地内容（共享部分先三方合并）→ commit → push`。如果推送时发现有人抢先推了，会自动重置后重试一次。

## 四类切片与四种策略

| 切片 | 内容 | 默认策略 | 作用域 |
|---|---|---|---|
| skills | `skills/`、` .agents/skills/`、`agents/skills/` | `union` 并集 | 共享 |
| sessions | 会话日志与附件 | `backup` 备份 | 按机器 |
| settings | `settings.yaml` | `backup` 备份 | 按机器 |
| plugins | 各 profile 的 `package.json`（只记清单） | `backup` 备份 | 按机器 |

- **backup**：各机独立目录，只推不拉，永不互盖。并行使用的机器之间天然安全。换机恢复需要显式调用 `restoreFromMachine`。
- **union**：共享目录，新增都收，冲突逐文件三方比对，本地版本保留、远端版本存成 `<file>.conflictN`。
- **remote / local**：纯覆盖，不做任何合并推理，分别以远端或本地为准。

四种策略可以在配置里按切片单独指定：

```yaml
slices:
  skills: union
  sessions: backup
  settings: local
  plugins: backup
```

## 跨平台：路径中性化

会话日志和 `settings.yaml` 里嵌着绝对路径。Windows 存 `C:\Users\alice\...`，macOS 存 `/Users/bob/...`，原样同步过去，对方读到的是一个不存在的路径——**而且是静默失败**：应用能起来，某个功能悄悄不工作。

解决办法：出站时把机器专属前缀替换成占位符（`{{DSH_HOME}}`、`{{HOME}}`、`{{CWD}}`、工作区用 `{{WS:<name>}}`），入站时按本机展开。仓库里只有平台中性的内容。

另外两处平台适配：

- **Windows MSYS2 路径改写**：Git Bash 会把传给原生 exe 的参数做 POSIX→Windows 转换，目录名里的点会被当成分隔符（`.dsh` 变成 `dsh`），git 于是在不存在的目录里执行并报 `fetch failed`。这是 Git for Windows 的既有行为，官方定性 wontfix。插件在**每个 git 子进程**注入 `MSYS_NO_PATHCONV=1` 和 `MSYS2_ARG_CONV_EXCL='*'`——只作用于该子进程，绝不能写进全局环境。
- 每条命令都带 `-C <绝对路径>`，避免 cwd 漂移；`shell: false`，用户提供的路径永远不经过 shell。

## 安全边界

| 措施 | 说明 |
|---|---|
| 硬排除 | `.credentials.yaml`、`profiles/`（插件清单除外）、`node_modules/`、`storages/`、`workspace.json`、`session.lock`、`*.tmp` |
| 白名单例外 | `profiles/*/package.json` 通过 `allow` 逃过 `profiles/` 的整体排除——清单本身正是要带走的，依赖不带 |
| 出站密钥扫描 | 提交前扫一遍，命中 `sk-`、`ghp_`、`AKIA`、私钥头、`apiKey=` 等模式的文件**默认阻止上传**并报告（可在配置里显式放行） |
| 令牌不出 argv | 走 `GIT_ASKPASS` 注入，`ps` 看不到。AI 提示词里也不含任何令牌 |
| 输出脱敏 | git 的 stdout/stderr 在记录、返回给 UI、交给模型之前统一过一遍脱敏 |
| 私有仓库强制 | 保存前调 REST 校验，公共仓库一律拒绝；未知主机无法校验时要求手动确认 |
| 快照本地优先 | 默认只落本机 `~/.dsh/dsh-sync-cnb/snapshots/`，滚动保留 30 份（外加每月一份），上传云端是 opt-in |
| 恢复前再拍一份 | 任何恢复操作前自动生成 `pre-restore-*` 快照，坏的恢复本身也可逆 |

**注意**：专用凭据文件不上传，但你写进会话、附件或项目文件里的密钥仍然会被同步。上传前请检查同步范围与排除规则。

## 冲突处理

三方合并需要一个 base——即上次成功同步时远端的样子，存在 `~/.dsh/dsh-sync-cnb/base/`。

| 情况 | 结果 |
|---|---|
| 本地没改，远端改了 | 采用远端 |
| 本地改了，远端没改 | 保留本地 |
| 两边都改且不同 | 保留本地，远端版本存成 `<file>.conflictN`，并在结果里报告 |
| 首次接触，无共同祖先 | 视为冲突，不猜哪边权威 |

`conflictMode` 可以设为 `keep-local` / `keep-remote` 直接裁决。**`ai` 模式故意不做自动调用**：把 `settings.yaml` 交给模型，等于把那个文件里的密钥一起交出去。接口预留了，但默认关闭。

## 定时同步

```yaml
autoSyncMinutes: 5   # 0 表示关闭
```

定时器通过 `ctx.effect` 注册，插件卸载时自动清理；改配置会替换而不是叠加。两次同步不会重叠。会话结束事件也会触发一次（仅在开启定时时）。

## 与 weibaohui/dsh-sync 的差异

| | weibaohui/dsh-sync | 本插件 |
|---|---|---|
| 托管方 | GitCode / GitHub / GitLab / Gitee | 上述 + **CNB** + 自建 |
| 分支模型 | 一机一分支 + PR 语义 | 单分支按机器分目录（PR 为 opt-in） |
| git 层冲突 | 由 git 解决 | git 层无冲突，内容层三方合并 |
| 路径中性化 | 无 | 有，Windows/macOS 往返可用 |
| 密钥扫描 | 无 | 有，默认阻止 |
| 实现形态 | TS + 构建 | 纯 ESM，零构建 |

## 已知限制

- **没有 UI 面板实现**：`panel.js` 只注册了路由与 handler，没有前端页面。设置目前走配置文件，或者通过 Agent 工具（`sync_status` 等）交互。
- **PR 模式未端到端验证**：`createPr` / `mergePr` 在 CNB 与 GitHub 上按文档实现，但测试里没有真实远端可打。默认关闭。
- **未做 AI 语义合并**：见上文理由。
- **快照不上传云端**：`uploadSnapshotsToRemote` 字段已定义，尚未实现。
- **未验证真实 DSH 宿主**：测试是在 Node 里用本地裸仓库跑的引擎级验证；`ctx.tools` / `ctx.webServer` 的挂载做了能力探测与降级，但在真实 profile 上还没跑过。

## 测试

```bash
npm test
```

26 项，全部离线。其中 10 项是端到端：两台"机器"通过本地裸仓库真实走一遍同步，覆盖排除规则、路径中性化、并集合并、冲突副本、跨机恢复、密钥拦截、快照。

## 许可

MIT。
