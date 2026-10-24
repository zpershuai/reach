# Tasks

全部改动限于 `packages/gateway-console/`。每组完成后运行 `npm --prefix packages/gateway-console test`；涉及样式或构建的组再加跑 `npm --prefix packages/gateway-console run build`（包含 `tsc`、Vite 构建和 `check-build.mjs`）。

## 1. 代码整洁与拆分（行为不变）

- [x] 1.1 删除 `Topology.tsx` 中未使用的 `related()`；用 prettier 格式化 `Views.tsx` 中 `AccessClients` 那一行。验证：`tsc --noEmit` 通过，`git diff` 中没有行为改动。
- [x] 1.2 把 `bezier`、`along`、`position` 移到 `src/topology/geometry.ts`，把 `ClientDrawer`、`GatewayDrawer` 移到 `src/topology/drawers.tsx`，`Topology.tsx` 改为 import。验证：`topology.test.tsx` 和 `components.test.tsx` 不修改即可通过。
- [x] 1.3 把 `MiniLog` 移到 `ui.tsx`，`DeviceDrawer` 的最近操作列表改用它；`MiniLog` 和 `ActivityTable` 的行 key 改为不含 index 的稳定 key。验证：新增单测，断言同一行在列表前插新行后仍是同一个 DOM 节点。

## 2. 请求错误与窄屏导航

- [x] 2.1 `api()` 支持非 JSON 和空响应体：成功时返回 `{}`，失败时抛出含 HTTP 状态的 `ApiError`，401 仍派发 `reach:unauthorized`。验证：单测覆盖 502 HTML（消息含 `502`、不含 `Unexpected token`）、204 空体和 401 HTML 三种情况。
- [x] 2.2 ≤820px 时保留 `.nav-foot`，改为紧凑排列（Add device 显示 "+" 并带 `aria-label`，Sign out 保留），桌面布局不变。验证：`npm run build` 通过；在 390px 视口下用浏览器手动确认两个按钮可见且 Sign out 能正常退出，并在 PR 中附截图。

## 3. 弹窗焦点与键盘

- [x] 3.1 在 `ui.tsx` 中实现模块级弹窗栈：`Modal` 和 `Drawer` 挂载时聚焦首个可聚焦元素、卸载时还原焦点、只有栈顶响应 Esc，`Modal` 内 Tab 循环；`Modal` 新增 `onCancel`。在 `test-setup.ts` 的 `afterEach` 中清空栈。验证：单测覆盖 Esc 关闭、焦点还原、Tab 循环，以及"抽屉上开 Modal 时按一次 Esc 只关 Modal"。
- [x] 3.2 给现有弹窗接上 Esc：Disconnect、Revoke、AccessClients 编辑和 AddDevice 映射到取消或关闭；`ReauthDialog` 的 Esc 等同 Cancel，不执行挂起的操作；一次性凭据弹窗忽略 Esc。验证：单测断言 `ReauthDialog` 按 Esc 后 `onCancel` 被调用、`onConfirm` 未被调用。

## 4. 实时链路性能与刷新

- [x] 4.1 `ConsoleStore.receive` 改为入队，按帧 flush（可见时用 rAF，隐藏时用 `setTimeout(250)`），一次 `set()` 应用整批事件；`refresh`、`stop` 正确处理队列。验证：`store.test.ts` 新增用例，同一帧收到 50 个事件只通知订阅者 1 次，结果与逐条 `reduceEvent` 一致；现有 refresh 补放用例仍通过。
- [x] 4.2 SSE 重连改为 full-jitter 指数退避（上限 30 秒），连接成功后归零，每次重连成功后无条件 refresh。验证：用 fake timers 写单测，连续失败时延迟递增且不超过 30 秒，成功一次后下次延迟回到 1 秒以内；epoch 回退用例仍通过。
- [x] 4.3 15 秒定时 refresh 只在页面可见时执行，`visibilitychange` 切回可见时立即 refresh。验证：单测模拟 `visibilityState`，隐藏 5 分钟（fake timers）期间不发 snapshot 请求，切回可见后立即发 1 次。
- [x] 4.4 `Kpis`、`ActivityTable` 和各抽屉用 `memo` 包裹；`ActivityView` 的 live 合并改为只 prepend 新行。验证：现有 Activity 测试通过；新增用例确认 live 新行出现在顶部、已加载的分页行保留且不重复。
- [x] 4.5 拓扑渲染器抽到 `src/topology/renderer.ts`，空闲时（没有粒子、心跳和 `stageOf`）清屏并停止 rAF，新事件到来时 `wake()`。验证：单测 mock `requestAnimationFrame`，空闲后不再调度，收到 rpc 事件后恢复；`particles.test.ts` 通过。

## 5. 时间与在线状态

- [x] 5.1 新增 `useNow()`（共享的 10 秒 tick，页面隐藏时暂停），`formatAgo` 调用方传入 `now`。验证：用 fake timers 写单测，无事件时 "5 s ago" 在 60 秒后变为 "1 min ago"。
- [x] 5.2 新增 `displayOnline(engine, now, heartbeatInterval)`，复用服务端规则（会话为 ready/connecting，或心跳间隔不足 3 个周期），Topology、Devices、Overview、`EngineStatus` 和 glyph 改用它。验证：单测覆盖心跳超时后无会话的设备显示离线、有 ready 会话的设备保持在线。

## 6. 设置、筛选、复制和权限编辑

- [x] 6.1 Settings 的主题选择立即预览并单独 `PATCH {theme}`，不经过 `sensitive`，失败时回滚；保存按钮只发送有改动的字段，只有 `retentionDays` 变化时才经过 `sensitive`。验证：单测断言改主题的请求体只有 `theme` 且不触发重认证；只改 heartbeatDisplay 也不触发；改保留天数的请求体包含 `retentionDays`，返回 `REAUTH_REQUIRED` 时弹出重认证。
- [x] 6.2 `router.ts` 增加 `useSearch()` 和带 `replace` 选项的导航；Activity 筛选以 URL query 为唯一来源，控件改为受控，离散项用 push、时间用 replace，导出链接复用同一个 query。验证：单测从 `?engineId=nas-01&outcome=not_ok` 打开时控件已选中、请求带上同样的参数，`popstate` 后控件和请求随之变化。
- [x] 6.3 新增 `CopyButton`（剪贴板不可用时退化为选中文本），用于 Add device 的 token 和命令、Rotate Engine token、delegated client token。验证：单测 mock clipboard，断言写入值正确并显示 "Copied"；断言 `localStorage` 和 `sessionStorage` 中没有该 token。
- [x] 6.4 AccessClients 权限编辑：workspace 用 `<datalist>` 列出所选 Engine 上报的工作区，仍允许自由输入；read/write/execute 横排；错误提示使用 `.notice.err` 并带重试按钮。验证：`access-clients.test.tsx` 新增用例，选择 Engine 后 datalist 中有其上报的工作区，自由输入的名称会出现在提交的请求体中。

## 7. 集成验证

- [x] 7.1 按 `packages/gateway-console/README.md` 启动本地 Gateway 和 Engine，用 MCP 产生流量，依次检查：粒子、空闲时 CPU 回落（Performance 面板中没有持续的 rAF）、停掉 Gateway 后看到 Reconnecting 并且退避间隔递增、恢复后回到 Live、隐藏标签页时没有 snapshot 请求、亮暗主题、reduced-motion、390px 视口。然后运行 `npm --prefix packages/gateway-console test`、`npm --prefix packages/gateway-console run build` 和 `npm --prefix packages/reach-rpc test`，结果全部通过。

## Workflow follow-up

- 评审通过后归档此变更，把 `gateway-console` 的增量合并进主 spec。
- 另开变更处理控制台的中英双语 i18n。
