# DSH Cua 电脑控制插件

基于 [Cua Driver](https://cua.ai/docs/cua-driver) 的 DeepSeek Harness Host 插件，为 Agent 注册 `cua_driver` 工具，控制 Windows、macOS 和 Linux 桌面。

**驱动核心随插件分发，用户无需另外安装 Cua Driver。** 插件通过 npm 依赖 `@trycua/cua-driver` 引入官方 SDK（含各平台原生二进制）。非 macOS 在 DSH 进程内直接运行；macOS 优先连接已签名 app daemon 以便归属系统权限。

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 桌面控制 | 应用/窗口发现、截图、无障碍元素、鼠标、键盘、剪贴板、菜单、窗口调整、状态验证 |
| 截图范围 | `scope: window` 把截图与操作都限制在指定应用内，整屏截图被拒绝 |
| 操作审批 | 修改类操作可经 DSH 审批流程确认；只读操作不打扰 |
| 截图清理 | 按时间定时清理，并在每次调用后与对话结束时清除 |
| 焦点指示 | 驱动自带的 agent 光标标记模型正在操作的区域 |

## 安装与启用

在 DSH 的 **Plugins** 页安装本目录并启用，然后**在新会话**中使用。首次安装会安装 `@trycua/cua-driver` 及其平台二进制包（约 28 MB），不需要下载安装脚本、配 PATH、启 daemon 或连接 MCP。

## 在哪里改设置

**侧边栏 → 设置 → Cua 电脑控制**（与「Trae」「WorkBuddy」等第三方插件并列）。

在设置页里可以直接改控制范围、固定应用、审批模式、焦点光标、截图保留与超时，点「保存」后**立即生效**，不需要重启 DSH，也不需要新开会话。

实现方式（供排查参考）：配置字段全部用 `schemastery` 的 `.volatile()` 标记，页面通过 `ctx.configForms` 读写。普通字段无法这样写——DSH 的设置写入会以 “no volatile fields” 拒绝，而客户端 `set()` 仍然 resolve，表现为「显示已保存但静默回滚」。写入使用 `mutate([{op:'set', path:[field], value}])`；命名空间取自 `ctx.fiber.entry.options.id`（profile 可能把它挂成 `include:dsh-cua`），由宿主通过 index 注入传给页面。

也可以直接改配置文件 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `dsh-cua` 行，改动按 Loader 的常规生命周期生效。

## 截图范围（scope）

```yaml
scope: window
app:
  name: WXWork.exe
```

`scope: window` 时：

- 整屏截取被拒绝，`get_desktop_state` / `get_screen_size` 不可用，报错会指向改用 `get_window_state`。
- 每次调用若未给窗口标识，会自动绑定到该应用当前窗口。
- 指向其他应用的窗口会被拒绝，并说明当前固定的是哪个应用。
- 截图文本末尾追加 `[scope: window ...]` 标记，便于模型确认范围。

按 `app.name` 固定时，应用重启换了 pid 仍在范围内；`app.pid` 可精确固定到某个进程。`scope: desktop`（默认）行为与 Cua Driver 原生一致。

**这层限制由插件强制，不是模型自觉遵守。** 实测拒绝信息：

```
dsh-cua: scope is "window", so get_desktop_state is not available.
Use get_window_state on the pinned app instead, or set scope to "desktop" in the plugin configuration.
```

## 操作审批（approval）

| 取值 | 行为 |
| --- | --- |
| `mutations`（默认） | 仅 `click`、`type_text`、`press_key`、`hotkey`、`drag`、`scroll`、`launch_app` 等修改类操作请求确认 |
| `all` | 只读操作也请求确认 |
| `none` | 从不请求确认 |

审批通过 DSH 自身的 `tools/pre-execute` 返回 `{kind:"ask"}` 实现，因此复用 DSH 现有的确认界面与「允许一次」语义；用户拒绝时调用在到达桌面之前就被拦下。中英文提示都会给出具体动作，例如：

```
允许 Cua Driver 执行 click on window 16458664 of pid 75396 (at (60, 40)) 吗？
```

`allowTools` 白名单仍然独立生效。

## 截图清理

截图优先作为 DSH 附件返回给模型（不进磁盘）。模型不支持图片或附件服务不可用时，才写入 `<会话目录>/.dsh-cua/`。这些文件：

1. **定时清理**：`screenshotSweepMs`（默认 60s）扫描一次，删除超过 `screenshotRetentionMs`（默认 15 分钟）的文件。
2. **每次调用后清理**：每次 Cua 调用结算后立刻清扫过期文件。
3. **对话结束清空**：`turn/end` 时删除整个 `.dsh-cua/` 目录。

`screenshotRetentionMs: 0` 表示不按时间删，只保留到本轮对话结束。

## 焦点指示

`showFocusCursor`（默认 `true`）会在首次调用时为本会话启用驱动的 agent 光标（`set_agent_cursor_enabled`），在目标窗口上标记模型当前操作的区域。光标按会话隔离，多个任务互不干扰。平台不支持覆盖层时该调用被静默跳过，不影响桌面操作。

## 配置

```yaml
- id: dsh-cua
  name: '@local/dsh-cua'
  config:
    timeoutMs: 120000
    scope: window
    app:
      name: WXWork.exe
    approval: mutations
    allowTools: [list_apps, get_window_state, click, type_text]
    session: dsh-desktop-task
    maxImageDimension: 1600
    screenshotRetentionMs: 900000
    screenshotSweepMs: 60000
    showFocusCursor: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 单次调用上限 |
| `scope` | `desktop` | `desktop` 或 `window` |
| `app` | — | `scope: window` 时必填：`{name}` 或 `{pid}` |
| `approval` | `mutations` | `mutations` / `all` / `none` |
| `allowTools` | `[]` | 工具白名单，空表示全部 |
| `session` | `dsh-cua` | 默认会话标签，也用于识别焦点光标 |
| `maxImageDimension` | — | 截图长边上限，降低可显著减小体积 |
| `screenshotRetentionMs` | `900000` | 落盘截图保留时长；`0` 表示保留到本轮结束 |
| `screenshotSweepMs` | `60000` | 定时清扫间隔；`0` 表示仅按调用与轮次清理 |
| `showFocusCursor` | `true` | 是否启用 agent 焦点光标 |

`allowTools` 与 `session` 目前只能在配置文件里改，设置页只暴露前面几项。

## 系统权限（仍需用户授予）

驱动自带不等于可以越过操作系统授权：macOS 需授予辅助功能与屏幕录制；Windows 需已登录交互桌面；Linux 需 X11/XWayland。

## 使用

```json
{
  "action": "call",
  "name": "get_window_state",
  "arguments": { "include_accessibility_tree": true, "include_screenshot": true, "session": "dsh-task" }
}
```

| action | 作用 |
| --- | --- |
| `call` | 执行 Cua Driver 工具 |
| `describe` | 读取工具参数说明，并附当前 scope 提示 |
| `status` | 报告驱动版本、scope、审批模式、焦点光标与截图保留策略 |
| `list_tools` | 列出可用工具名 |

参数使用 Cua Driver 文档的 snake_case 名称。两处易错：

- `get_desktop_state` 总是附带截图，只接受 `max_image_dimension` 与 `screenshot_out_file`，传 `include_screenshot` 会被拒绝。
- `get_window_state` 用 `include_screenshot` / `include_accessibility_tree`；无障碍遍历默认 1000 ms 预算，超出返回 `degraded: true` 与部分树，可提高 `timeout_ms` 或限制 `max_elements`。

## 验证

```sh
npm run check
node --test --experimental-test-isolation=none test/*.test.js
$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE test/integration-live.mjs
```

- 37 项单元测试覆盖结果归一化、截图生命周期、范围匹配与审批分类。
- 联调脚本在真实桌面验证：桌面范围允许整屏、窗口范围拒绝整屏并拒绝其他应用、审批钩子对修改类操作返回 `ask` 而对只读放行、`turn/end` 后截图目录清空。测试只使用计算器与只读接口。

## 限制

- **悬窗与强制停止未实现**（二期）。当前由审批确认与插件禁用提供控制；`scope: window` 限制可触达的范围。
- 截图、无障碍树与操作结果会发送给当前模型，请确认隐私要求。
- 工具返回成功不代表 UI 已改变；应重新快照或 `verify_state`。超时或取消后动作可能已到达目标系统。
- `scope: window` 依赖窗口列表是否可枚举；某些全屏独占或无窗口应用无法被固定。
- 第三方 Cua Driver 遵循其自身许可；本插件代码采用 MIT。

## 已知边界

- 截图清理的「每次调用后」与「回合结束」依赖 DSH 的 `agent/turn-stopping` 与会话工作目录服务。前者不存在时插件会记录警告并继续工作，后者不可用时截图落在进程工作目录。
- `screenshotRetentionMs: 0` 时定时清扫关闭，但每次调用后仍会立即删除该次截图，因此实际效果是「不保留」而非「保留到回合结束」。`status` 显示为 `until turn end`，属文案简化。
