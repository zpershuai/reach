# Tasks

前端改动在 `packages/gateway-console/`，服务端改动只在 `packages/reach-rpc/src/console-api/`。每组完成后运行 `npm --prefix packages/gateway-console test`。涉及样式或构建的组再跑 `npm --prefix packages/gateway-console run build`。涉及服务端的组跑 `npm --prefix packages/reach-rpc test`。新增文案必须同时加到 `i18n/en.ts` 和 `i18n/zh-CN.ts`，`catalog.test.ts` 会检查两边键是否一致。

## 1. 服务端：排除未认证记录

- [x] 1.1 在 `server.ts` 的 `activityQuery` 中增加 `excludeAuthFailed: z.enum(["1", "true"]).optional()`。在 `activity.ts` 的 `ActivityFilters` 和 `query()` 中追加条件 `event_type <> 'auth.failed'`，导出走同一套 filters。验证：在 `activity.test.ts` 中新增用例。写入 80 条 `auth.failed` 和 10 条 `rpc.finished`，传入 `excludeAuthFailed=1` 且 `limit=50` 时只返回这 10 条，游标为空；不传参数时 `auth.failed` 仍然返回；导出 CSV 时不包含 `auth.failed`。`npm --prefix packages/reach-rpc test` 通过。
- [x] 1.2 更新 `docs/deploy/console.md` 和 `console_cn.md` 的 Activity 段落，说明可以隐藏未认证请求。验证：两份文档描述一致，并且不包含任何真实部署信息。

## 2. 活动噪声与活动表格

- [x] 2.1 `ActivityTable` 中 `auth.failed` 行的客户端列显示 `activity.unauthenticated`；行上带 `count` 时，在结果旁显示 `×N`。验证：`activity.test.tsx` 断言 `auth.failed` 行不出现 "Gateway"；带 `count: 3` 的实时行显示 `×3`；不带 `count` 的落库行不显示次数。
- [x] 2.2 列顺序调整为 时间 → 客户端 → 方法 → 结果 → 目标 → 设备 → 耗时 → 大小。当前行全部没有耗时和大小时，两列一起隐藏。验证：单测检查表头顺序，以及在只有 auth 和 admin 行时没有耗时、大小两列的 th。
- [x] 2.3 新增 `collapseAuthFailures(rows)`，把相邻、path 相同的 `auth.failed` 行合并为一组，记录条数（按 count 累加）和最新时间。概览和拓扑的活动列表使用它，渲染为可展开的行，文案为"身份验证失败 ≥N · /path"。验证：纯函数单测覆盖"12 条相邻 → 1 组"、"被 `admin.login` 隔开 → 2 组"、"不同 path 不合并"；组件测试点击展开后显示 12 行，展开控件带 `aria-expanded`。
- [x] 2.4 在 Activity 筛选区增加"隐藏未认证请求"复选框，映射为 URL query `excludeAuthFailed=1`，请求和导出链接都带上它。验证：单测从 `?excludeAuthFailed=1` 打开时复选框已勾选，请求 URL 和导出链接都包含该参数；取消勾选后 URL 中不再有它。

## 3. 设备状态与破坏性操作

- [x] 3.1 把 `ui.tsx` 的 `statusText` 改为 ready/idle → `ok`，connecting/awaiting → `warn`，offline → 新 tone `off`。在 `style.css` 中增加 `.pill.off`（中性色、虚线边框、空心圆点），`DeviceGlyph` 的 `.s-idle` 改为在线配色。不在会话中的设备，胶囊上附带 `formatAgo` 相对心跳时间。验证：`components.test.tsx` 断言 idle 设备胶囊带 `ok` 类并显示 "4 s ago"，离线设备带 `off` 类且不带 `err`；在 1440 浏览器中浅色、深色两种主题下各截图确认。
- [x] 3.2 新增 `.btn.danger-outline`。`AccessClients` 的撤销身份、`AuthorizedApps` 的撤销、`ClientsView` 的断开改用它，并放到操作组最后。确认 Modal 的提交按钮在 revoke 和 disconnect 时使用 `.btn.danger`。验证：`access-clients.test.tsx` 断言行内撤销按钮带 `danger-outline`、不带 `danger`，并且是操作组最后一个按钮；打开确认框后提交按钮带 `danger`。

## 4. 页头、右上角与导航

- [x] 4.1 页头重排：左侧是标题和 publicOrigin；右侧是本页操作和外观控件，外观控件包含 `LanguageToggle` 和主题快捷切换（system → light → dark 循环，复用 Settings 的 `PATCH {theme}`，不需要重新认证）。从 `.nav-foot` 中移除 `LanguageToggle`。验证：`localization.test.tsx` 断言语言控件在 `header.topbar` 内、`nav` 中没有；`settings.test.tsx` 断言快捷切换只发送 `{theme}`，且不触发重新认证；在 1440 和 375 两种宽度下截图，确认语言控件都在右上角。
- [x] 4.2 把健康、Gateway 版本、心跳间隔和实时连接状态从页头移到导航里的状态块；≤ 820px 时收成一个状态点，点击后展开。验证：单测断言 Devices 页头内没有 `Gateway v` 和运行状态胶囊，nav 中有；断线时状态块显示 Reconnecting。
- [x] 4.3 导航溢出处理：隐藏原生滚动条；按滚动位置设置 `data-overflow-start` 和 `data-overflow-end`，配合 `mask-image` 做边缘渐隐；路由变化时把当前项滚入视野。验证：单测 mock `scrollIntoView`，导航到 `/settings` 时它被调用；在 375 浏览器中打开 Settings，截图确认标签可见、右侧有渐隐、没有灰色滚动条。

## 5. 概览：KPI 与"需要关注"

- [x] 5.1 KPI 改为 CSS grid：宽屏 6 列，≤ 1100px 时 3 列，≤ 560px 时 2 列，去掉 `border-right` 和移动端多出的 `border-bottom`，改用 gap 加背景色画分隔线。"x 台会话中"移到数值下方。0 值使用 `.kpi.zero`（弱化显示）；错误率或策略拒绝大于 0 时使用 `.kpi.alert`。拓扑页不再渲染 `Kpis`。验证：单测断言 0 值带 `zero`、`errorRate5m: 0.02` 带 `alert`，拓扑视图中没有 `section.kpis`；在 800 宽度下截图，确认没有单独一项占一行。
- [x] 5.2 用 `AttentionPanel` 替换"版本"面板。条目包括：离线设备（`displayOnline`）、版本落后（众数，并列时不标记）、待审核的全局访问（Overview 挂载时请求 `access-clients`，失败时显示一行提示）、近 24 小时失败（`errors24h` 之和，链接到 `/activity?outcome=not_ok&excludeAuthFailed=1`）。没有任何条目时显示"一切正常"，并附 Gateway/MCP 版本和自动更新状态。验证：新增 `attention.test.tsx`，覆盖每一类条目及其链接、版本并列不标记、`access-clients` 失败时其他条目照常显示、全部正常时的文案。

## 6. 客户端表格

- [x] 6.1 客户端表：数字列使用 `.num` 并收紧宽度；某一列在所有行都为空（如 owned Engine sessions）时隐藏。验证：单测在所有客户端 `ownedEngines: []` 时断言该列表头不存在，有一个客户端带值时该列出现。
- [x] 6.2 访问身份行：标识缩短为前 8 位加省略号，旁边放 `CopyButton` 复制完整值；显示批准时间和最近使用时间；"全局访问"改为 `.pill.warn`，去掉整块 `.notice.warn` 底色。验证：`access-clients.test.tsx` 断言显示的是缩短后的 id，复制写入的是完整 id，行内有批准和最近使用两个时间。

## 7. 窄屏拓扑与其余细节

- [x] 7.1 ≤ 820px 时，`.lanes` 改为单列纵向排列，去掉 `.topo` 的 `min-width`，隐藏 `svg.edges` 和 `canvas.flow`，泳道之间插入方向分隔条。渲染器在窄屏下不启动 rAF（`matchMedia` 监听宽度变化）。验证：`topology.test.tsx` mock `matchMedia` 为窄屏，断言没有 rAF 调度，点击 Engine 节点仍会打开抽屉并过滤表格；在 375 浏览器中检查 `document.documentElement.scrollWidth === innerWidth`，并且没有任何元素超出视口宽度。
- [x] 7.2 `Drawer` 增加 `.drawer-backdrop`。点击遮罩时，可关闭的抽屉执行关闭，并按弹窗栈规则还原焦点；不可关闭的抽屉（一次性凭据）忽略点击。验证：`ui.test.tsx` 断言点击遮罩后 `onClose` 被调用、焦点回到触发元素；`dismissible={false}` 时 `onClose` 不被调用。
- [x] 7.3 设备页：卡片补充会话所有者、最近一次操作和工作区数量；网格改为 `repeat(auto-fill, minmax(250px, 320px))`，设备少时卡片不会拉伸。设置页拆成"活动保留""外观""拓扑"三张卡片，表单宽度与其他面板一致。验证：组件测试断言设备卡片中出现最近操作的方法名；设置页三个分组都有标题，保存逻辑相关的测试不修改即可通过。
- [x] 7.4 把 `ui.tsx` 的头像 `hues` 换成避开读、写、执行、技能语义色相的一组颜色，并在 `style.css` 的注释中写明这一约束。验证：单测断言 `hues` 中没有与 `--c-read`、`--c-write`、`--c-exec`、`--c-skill` 相同的颜色值；浅色和深色主题下头像文字对比度达到 WCAG AA（用现有对比度工具函数，没有的话在测试里计算）。

## 8. 集成验收

- [ ] 8.1 运行 `npm --prefix packages/gateway-console run build` 和两个包的 test，全部通过，`check-build.mjs` 与 CSP 检查通过。在本地 dev server 中按以下矩阵逐页截图：宽度 1440 / 800 / 375 × 主题浅色 / 深色 × 页面 概览、拓扑、客户端、设备、活动、设置。对照 `specs/` 中每个 Scenario 逐条打勾，截图附在 PR 中。

## Workflow follow-up

- 部署到 Gateway 后，在线上 Console 复查一遍 8.1 的矩阵。
- 评审通过后执行 `/opsx:archive` 归档本变更。
