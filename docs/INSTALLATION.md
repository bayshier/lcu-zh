# 安装指南（中文）

从[最新 release](https://github.com/amontlabs/lcu/releases/latest) 安装 LCU，然后在你的 harness 中注册。涉及源码改动见英文版 [Building from source](DEVELOPMENT.md#building-from-source)。

> 本文档为中文精译，覆盖 macOS / Linux 主流程；少数深水区小节（Linux AppArmor、沙箱细节等）请阅读[英文原文](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md)。

## `lcu` 命令

安装器不会把 `lcu` 加入 `PATH`。请用安装路径调用它：

| 平台 | 命令路径 |
| --- | --- |
| macOS | `~/.local/share/lcu/current/bin/lcu` |
| Linux | `/opt/lcu/current/bin/lcu`（或 `<prefix>/current/bin/lcu`） |
| Windows | `%LOCALAPPDATA%\LCU\lcu.cmd` |

下文写作 `lcu ...` 的命令，都请按平台替换为安装路径。`lcu mcp` 是各 harness 启动的 stdio MCP 服务器；在交互终端里直接运行只会打印一条「这是 stdio MCP 服务器」的提示。

## 如果你就是执行安装的 Agent

1. 检查操作系统、架构、桌面账户与当前 harness。适配器为 `pi`、`codex`、`claude-code`、`omp`（Oh My Pi）、`hermes`（Hermes Agent）；请明确选择用户的 harness。OMP 与 Hermes 为实验性，宣称桌面行为前先查看[验证边界](ADAPTERS.md)。**如果 harness 没有适配器，请如实报告这一缺口**，并参考[适配器契约](ADAPTERS.md)——不要用别的 harness 冒充。
2. 检查前提条件。官方桌面应用与所选 harness 必须已经安装；LCU 不需要任何其他东西（不需要 Python）。缺什么就报告什么与安装链接——LCU 不会代装、也不会代认证。
3. 下载匹配的归档与 SHA-256 伴随文件（来自最新 release），校验后解压，在解压目录内按平台章节执行安装。GitHub 自动生成的源码包不是可安装的 bundle。

匹配的归档：macOS Apple Silicon 为 `darwin-arm64.tar.gz`；Linux ARM64 为 `linux-arm64.tar.gz`；Linux x86-64 为 `linux-x64.tar.gz`。

一条龙脚本（选择归档、校验 SHA-256、解压）：

~~~sh
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) LCU_TARGET=darwin-arm64 ;;
  Linux-aarch64|Linux-arm64) LCU_TARGET=linux-arm64 ;;
  Linux-x86_64) LCU_TARGET=linux-x64 ;;
  *) echo "Unsupported LCU platform" >&2; exit 1 ;;
esac
LCU_TAG=$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/amontlabs/lcu/releases/latest)
LCU_TAG=${LCU_TAG##*/}
LCU_ARCHIVE="lcu-${LCU_TAG#v}-${LCU_TARGET}.tar.gz"
LCU_URL="https://github.com/amontlabs/lcu/releases/download/$LCU_TAG"
mkdir -p lcu-release && cd lcu-release &&
curl -fLO "$LCU_URL/$LCU_ARCHIVE" &&
curl -fLO "$LCU_URL/$LCU_ARCHIVE.sha256" &&
shasum -a 256 -c "$LCU_ARCHIVE.sha256" &&
  tar -xzf "$LCU_ARCHIVE" &&
  cd "${LCU_ARCHIVE%.tar.gz}"
~~~

校验报告 **OK** 之后再继续。请使用解压归档自带的安装器。

## 账户与 Agent 注册

用 `--agent pi|codex|claude-code|omp|hermes` 选择 Agent；重复 `--agent` 可选多个；`--agent all` 选全部五个（缺可执行文件的 harness 会失败，可加 `--allow-missing` 延后）；`--agent auto` 自动选择检测到的 Agent。不传 `--agent` 时交互式安装会让你选。`--runtime-only` 只装运行时不注册 Agent。安装与认证每个 harness 请自行完成——LCU 都不代劳。

~~~sh
/opt/lcu/current/bin/lcu setup --agent codex --agent claude-code
./scripts/install.sh --list-agents
~~~

Setup 会用 release 自带的私有 `agent-tools` Node 运行时执行各 harness 的原生注册工具：Pi 收到扩展、OMP 与 Hermes 收到原生插件、Codex CLI 与 Claude Code 收到 MCP 注册。Setup 不会动无关配置。

## macOS

在解压的 release 目录里，以目标桌面账户运行（把 `codex` 换成你的 harness）：

~~~sh
./scripts/install.sh --agent codex
~~~

无人值守安装加 `--yes`，然后自己在桌面终端运行：

~~~sh
~/.local/share/lcu/current/bin/lcu doctor
~~~

之后重启 harness，让它用 LCU 对一个无害窗口（比如空白 TextEdit）截屏并批准该请求——这是 macOS 权限的首次验证。

LCU 安装在 `~/.local/share/lcu` 下，原地复用已签名的应用与原生助手。它会校验应用的官方签名、Apple Silicon 架构、运行时清单、必需文件与已知的原版宿主布局，并报告观察到的应用/运行时版本。完整签名校验（`codesign --verify --deep`）在安装、更新、`lcu setup`、`lcu doctor`、`lcu status` 以及应用变更后的首次启动时运行；后续启动只确认签名者以保持速度。

**家目录长度限制**：签名的助手把 socket 绑定在真实家目录下的 `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock`，路径超过 103 字节就拒绝工作——即 `/Users/` 之后最多 13 个 ASCII 字符。超长时只会出现 `computeruse.sock.lock`，所有调用报 `Sky Computer Use native pipe startup failed`；ChatGPT 应用本身有同样限制。`lcu doctor` 会以退出码 2 报告路径与长度。请改用家目录路径更短的账户。

## macOS 隐私权限

首次调用前，请在「系统设置 > 隐私与安全性」中批准：

- **辅助功能**：ChatGPT Computer Use（位于 `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`）
- **屏幕与系统录音**（或 **屏幕录制**）：ChatGPT（`/Applications/ChatGPT.app`）

macOS 在首次批准使用之前可能不会列出这些应用。LCU 永远不会代你授权、也不会自己打开设置面板。验证方式：让 Agent 用 LCU 对无害窗口截屏一次并批准请求。

`lcu doctor` 退出码 0 且能成功截图，即安装验证完成。

## 管理已批准的应用

```sh
lcu apps                 # 查看始终允许的清单
lcu apps allow Zed       # 触控 ID（或密码）后允许
lcu apps revoke Zed      # 撤销
```

可传应用名、bundle 标识符或 `.app` 路径。列表免费；allow/revoke 需要你本人在场。浏览器与密码管理器等高危应用自带警告；Terminal、iTerm2 这类 Computer Use 直接拒绝的应用会被拒。

## 跨回合 Computer Use（Claude Code）

```sh
lcu cross-turn           # 状态
lcu cross-turn on        # macOS 需触控 ID（或密码）
lcu cross-turn off
```

默认关闭；只影响 Claude Code 中继。这是防误操作护栏而非安全边界。细节见英文原文 [cross-turn Computer Use](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md#cross-turn-computer-use)。

## 审批模式

你的 harness 决定 Agent 能否调用 LCU 的工具；LCU 决定 Agent 能否碰某个应用（所有权限模式下生效）。`lcu setup --approval auto` 面向无人值守机器（VM、CI）：预允许 LCU 的两个模型工具，按应用的审批保留。细节见英文原文 [approval mode](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md#approval-mode)。

## 在 ZCode 等无官方适配器的 Harness 中使用

LCU 的核心是 stdio MCP 服务器。官方适配器之外，通用 MCP 客户端是被文档明确考虑的路径（这类客户端不会发送 Codex 特有的沙箱元数据，Linux 沙箱行为见英文原文）。以 ZCode 为例：

1. 按 `--runtime-only` 安装运行时（不注册官方适配器）：

   ```sh
   ./scripts/install.sh --runtime-only --yes
   ```

2. 把 MCP 服务器注册进 harness 配置（ZCode 为 `~/.zcode/cli/config.json` 的 `mcp.servers`）：

   ```json
   {
     "lcu": {
       "command": "~/.local/share/lcu/current/bin/lcu",
       "args": ["mcp"]
     }
   }
   ```

3. 重启 harness，发一条无害的截图请求（如空白 TextEdit 窗口），批准 macOS 权限提示，确认返回的截图。

## 卸载

```sh
~/.local/share/lcu/current/bin/lcu setup --uninstall   # 撤销 harness 注册
rm -rf ~/.local/share/lcu                              # 移除 LCU 本体
```

Chrome 模式的浏览器宿主清理、Claude 模组的移除等细节见英文原文 [uninstall](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md#uninstall)。

## 桌面与浏览器

`lcu doctor` 校验应用签名与布局、运行时健康、macOS 权限提示状态、Linux 桌面会话可达性等；退出码 0 为全部通过。Chrome 模式需要官方浏览器扩展与站点审批；站点决策由原版运行时记录与撤销。这些深水区细节见英文原文 [Desktop and browser](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md#desktop-and-browser)。
