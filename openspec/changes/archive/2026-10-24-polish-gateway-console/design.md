# Design

## Context

控制台是 `packages/gateway-console/` 下的 React 19 + Vite 单页应用，没有路由库和状态库。`router.ts` 基于 `history` 和 `useSyncExternalStore` 实现路由；`ConsoleStore`（`store.ts`）持有 snapshot，用纯函数 `reduceEvent` 应用 SSE 事件，并通过 `useSyncExternalStore` 通知整个 `App`。

服务端约束：
- `kpis` 和 `engine.online` 只在 `GET snapshot` 中由服务端计算。在线规则是：会话状态为 ready/connecting，或者 `now - lastSeenAt < heartbeatInterval × 3 s`。
- `PATCH settings` 只在请求体包含 `retentionDays` 时要求 recent-auth。

这些服务端行为都不改。CSP 不允许外部资源，也不允许内联字体，本次不引入新依赖。

## Goals / Non-Goals

**Goals:**
- 高事件率下，每个动画帧最多触发一次 React 更新。
- 页面空闲时不消耗 CPU：Canvas 不跑循环，后台标签页不轮询。
- 弹窗焦点行为统一在 `Modal` 和 `Drawer` 两个组件中实现，各个页面不需要单独处理。

**Non-Goals:**
- i18n（另开变更）、引入状态库或路由库、虚拟列表、服务端 KPI 推送。

## Decisions

1. **事件按帧批量合并。** `receive()` 只把事件放进队列，调度一次 flush。页面可见时用 `requestAnimationFrame` 调度；页面隐藏时 rAF 不会触发，改用 `setTimeout(250)`。flush 时依次对队列调用 `reduceEvent`，最后调用一次 `set()`。`reduceEvent` 保持纯函数，现有单测不变。`stop()` 和 `refresh()` 开始前先 flush 或丢弃队列，保证 `refresh` 补放 `recent` 时不会漏事件。
   - 备选方案是节流 `useSyncExternalStore` 的订阅回调。没有采用，因为那样每个事件仍要复制大数组。

2. **减少重渲染。** `Kpis`、`ActivityTable` 和各个抽屉用 `memo` 包裹。由于 `reduceEvent` 对未变化的 engine 和 client 保留原对象引用，`memo` 能直接生效。`ActivityTable` 的行 key 改为 `type:engineId:requestId`，没有 requestId 时用 `id`，不再拼接 index。`ActivityView` 的合并改为只把 `snapshot.activity` 中比当前首行更新的记录 prepend 进去，不再每次全量 Map 加 sort。

3. **Canvas 按需运行。** 渲染循环在没有粒子、没有心跳动画、`stageOf` 也为空时，清屏一次后停止。事件 effect 收到新事件后调用 `wake()` 重启循环。主题监听和 `MutationObserver` 仍随组件挂载期存在。

4. **快照刷新与重连。**
   - 定时 `refresh()` 保留 15 秒周期（KPI 的语义需要），但只在 `document.visibilityState === "visible"` 时执行。
   - `visibilitychange` 切回可见时立即 refresh。
   - SSE 重连延迟取 `min(30 s, 1 s × 2^n)` 范围内的随机值（full jitter），流成功打开后 n 归零。每次重连成功后无条件 refresh，替代现在只在 epoch 回退时才替换 snapshot 的逻辑。
   - 备选方案是只靠事件推导 KPI。没有采用：速率类指标会随时间衰减，必须由服务端计算，不改服务端就做不到。

5. **时钟 tick。** 新增 `useNow(intervalMs = 10_000)`，用一个共享的 store 加 `setInterval` 实现，页面隐藏时暂停。`formatAgo` 接收 `now` 参数。前端的离线判断用同一个 `now`：`displayOnline(engine, now, heartbeatInterval)` 复用服务端规则，在 Topology、Devices 和 Overview 中替代直接读 `engine.online`。KPI 里的在线数仍以服务端为准，最多相差一个刷新周期，可以接受。

6. **焦点管理。** `Modal` 和 `Drawer` 内部实现以下行为：
   - 挂载时记录 `document.activeElement`，聚焦第一个可聚焦元素；
   - 卸载时把焦点还回记录的元素，前提是它还在 DOM 中；
   - 只有栈顶的弹窗响应 Esc，用模块级栈实现，避免抽屉上又开了 Modal 时一次 Esc 关掉两层；
   - `Modal` 在 keydown 时循环 Tab。

   `Modal` 新增 `onCancel` 用于 Esc。没有 `onClose` 和 `onCancel` 的弹窗（比如一次性凭据确认）忽略 Esc。`ReauthDialog` 的 Esc 等同于 Cancel。

7. **请求错误。** 先检查 `content-type`。对于非 JSON 或空响应体，当 `response.ok` 时返回 `{}`；失败时抛出 `ApiError("Gateway returned HTTP <status> <statusText>", status)`。401 的处理逻辑不变。

8. **设置拆分。** 主题 `<select>` 的 onChange 先立即设置 `document.documentElement.dataset.theme`（乐观预览），再 `PATCH {theme}`，不经过 `sensitive`。失败时回滚并提示。表单提交只发送与 snapshot 中不同的 `retentionDays` 和 `heartbeatDisplay`；只有 `retentionDays` 变化时才经过 `sensitive`。`App` 根据 snapshot 设置主题的 effect 保留，refresh 之后两者结果一致。

9. **Activity 筛选与 URL 同步。** 筛选状态的唯一来源是 `location.search`：
   - `router.ts` 新增 `useSearch()` 和 `navigate(path, { replace })`；
   - 修改筛选时用 `replaceState` 更新时间输入，其余用 `pushState`，让后退按钮在筛选状态之间切换；
   - 筛选控件改为受控组件，`datetime-local` 与毫秒时间戳双向转换；
   - 导出链接直接复用这个 query。

10. **复制按钮。** 新增 `<CopyButton value>` 组件，基于 `navigator.clipboard.writeText` 实现。复制成功后显示 "Copied" 2 秒；不可用时（非安全上下文）退化为选中旁边只读输入框里的内容，并提示手动复制。用于 Add device 的 token 和命令、Rotate Engine token、delegated client token。

11. **Workspace 候选。** 用 `<input list>` 加 `<datalist>`，数据来自所选 engine 的 `session.workspaces`。这是原生控件，不需要额外依赖，也允许自由输入。

12. **窄屏导航。** 在 ≤820px 时，`.nav-foot` 不再隐藏，改为导航行末尾的紧凑按钮：Add device 只显示 "+" 加 `aria-label`，"Administrator" 文本隐藏，Sign out 保留。

13. **拆分 Topology。** 拆成以下几个文件，导出的 API 和 DOM 结构保持不变，现有测试照常通过：
    - `topology/geometry.ts`：`bezier`、`along`、`position`；
    - `topology/renderer.ts`：Canvas 绘制和按需循环，输入 geometry、scheduler 和颜色；
    - `topology/drawers.tsx`：`ClientDrawer`、`GatewayDrawer`；
    - `Topology.tsx`：只保留视图。

    `MiniLog` 移到 `ui.tsx`，`DeviceDrawer` 也改用它。

## Risks / Trade-offs

- [风险] rAF 批量合并会让事件最多晚一帧（约 16ms）才显示。→ 这个延迟远低于肉眼能察觉的程度；粒子的 `started` 仍用 flush 时的 `performance.now()`，动画本身不受影响。
- [风险] 前端离线判定与服务端 KPI 计数可能短暂不一致。→ 两者规则相同，最多相差一个刷新周期；页面重新可见时会立即对齐。
- [风险] 焦点栈是模块级全局状态，测试之间可能互相污染。→ 在 `test-setup.ts` 的 `afterEach` 中清空栈。
- [风险] `pushState` 产生的筛选历史可能淹没页面导航历史。→ 只对离散选择项用 push，时间输入用 replace。
- [权衡] 保留 15 秒可见期轮询，而不是改成服务端推送 KPI，换来的是零服务端改动。

## Migration Plan

纯前端改动，随 Gateway 构建一起发布，没有数据迁移。回滚时恢复旧版 console 资产即可。
