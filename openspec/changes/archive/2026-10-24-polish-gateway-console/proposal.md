# Proposal

## Why

Gateway Console 已能从公网访问，但审阅发现几处直接影响使用的问题：窄屏下无法退出登录或添加设备；弹窗和抽屉没有键盘与焦点处理；反向代理返回非 JSON 错误时提示难以理解；修改主题也被要求重新输入密码。同时，实时链路每个事件都复制大数组并重渲染整个应用，Canvas 空闲时仍满帧刷新，SSE 之外每 15 秒拉一次全量快照，断线后固定 1 秒重连。这些问题在流量大或 Gateway 不可用时会放大。

## What Changes

- 窄屏导航保留 Sign out 和 Add device 入口。
- `Modal` 和 `Drawer` 支持 Esc 关闭，打开时移入焦点，在弹窗内循环 Tab，关闭后焦点回到触发元素。
- `api()` 能处理非 JSON 和空响应体，给出含 HTTP 状态的可读错误。
- Settings 只提交改动过的字段；主题选择立即预览并单独保存，不再触发重新认证。保留天数仍需重新认证，服务端行为不变。
- 实时事件按帧批量合并后再通知订阅者；Activity 合并只处理新增行，表格行使用稳定 key。
- 拓扑 Canvas 只在有粒子或心跳动画时运行渲染循环。
- 定时全量快照只在页面可见时进行，后台标签页暂停；SSE 重连后和页面重新可见时立即补拉。KPI 和离线判定由服务端计算，因此不能完全去掉轮询。SSE 重连采用带抖动的指数退避，上限 30 秒。
- 相对时间（"x s ago"）定时刷新；设备超过三个心跳周期未上报时，前端直接显示离线，不必等下一次快照。
- Activity 筛选与 URL query 双向同步，可刷新、可分享。
- 所有一次性凭据（Engine token、轮换 token、delegated client token）提供复制按钮。
- 访问权限编辑：workspace 根据所选设备已上报的工作区提供候选，read/write/execute 横向排列，错误提示使用统一样式。
- 代码整洁：删除未使用的 `related()`，把 `Topology.tsx` 拆分为几何、渲染器和抽屉模块，合并重复的最近操作列表，格式化 `ClientsView`。
- 不包含：中英双语 i18n，另开变更处理；不新增依赖，不修改服务端 API。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `gateway-console`：新增窄屏导航可达性、弹窗键盘与焦点、可读的请求错误、实时数据刷新与重连、及时的离线显示、相对时间刷新、可分享的 Activity 筛选、一次性凭据复制和权限编辑中的 workspace 候选等要求；明确主题偏好不需要重新认证。

## Impact

只影响 `packages/gateway-console/`：`App.tsx`、`api.ts`、`store.ts`、`router.ts`、`ui.tsx`、`Topology.tsx`（拆分出新文件）、`Activity.tsx`、`Views.tsx`、`Devices.tsx`、`AccessClients.tsx`、`style.css` 及对应测试。`/api/console/*` 和 `PATCH settings` 的 recent-auth 规则保持不变，无新增依赖，构建产物仍需通过 `check-build.mjs` 和 CSP 检查。
