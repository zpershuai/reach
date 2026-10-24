# Design

## Context

动机见 proposal.md，要求见 `specs/`。下面是影响实现方式的现状：

- `auth.failed` 事件由 `ConsoleEvents.authFailed()` 发出。同一 path + peer 在 60 秒内的重复请求只累加计数，不另发事件，所以实时事件上带 `count`。落库时 `audit.ts` 的 `columns` 里没有 `count`，存下来的记录就没有次数。
- Activity 查询在 `console-api/activity.ts` 中拼 SQL 条件。`server.ts` 的 `activityQuery` 用 zod 校验 query，查询和导出共用同一套 filters。
- 前端 `ActivityTable` 把没有客户端的行统一显示为 `"Gateway"`（`Activity.tsx:82`）。
- 设备状态由 `glyphState()` 和 `ui.tsx` 里的 `statusText` 决定：idle 没有 tone（灰色），offline 用 `err`（红色）。
- 访问身份（access clients）不在快照里，由 `AccessClients.tsx` 单独请求 `access-clients`。
- 拓扑的边和粒子按 DOM 节点的 `getBoundingClientRect()` 计算，贝塞尔控制点假设三条泳道从左到右排列。
- `Drawer` 已经接入弹窗栈（Esc、焦点还原），但没有遮罩层。

## Goals / Non-Goals

**Goals:**
- 一次请求、一处改动就能把扫描噪声从视图里挪开，不破坏分页。
- 状态颜色和位置只有一套来源，概览、拓扑、设备、抽屉保持一致。
- 窄屏下拓扑可用，同时不重写桌面端渲染器。

**Non-Goals:**
- 不给审计表加 `count` 列，不做数据库迁移。
- 不改 KPI 的服务端计算口径，不新增快照字段。
- 不重新设计主题色板。只调整状态的语义映射和少量 token。

## Decisions

1. **服务端过滤未认证请求。** 在 `activityQuery` 中增加 `excludeAuthFailed: z.enum(["1", "true"]).optional()`，在 `activity.ts` 中追加条件 `event_type <> 'auth.failed'`。
   - 不用 `z.coerce.boolean()`：它会把字符串 `"false"` 转成 `true`。
   - 也不在前端过滤：游标分页下，前端过滤会出现空页，还会把扫描请求混进导出。
   - 导出复用同一套 filters，不用另外改。

2. **折叠只在预览列表中做。** 新增纯函数 `collapseAuthFailures(rows)`：把相邻、path 相同的 `auth.failed` 行合并成一组，记录组内条数（每行有 `count` 就累加 `count`，没有就按 1 计）和最新时间。概览和拓扑的活动列表使用它；Activity 页不折叠，保留完整审计视图，噪声交给"隐藏未认证请求"开关处理。
   - 备选方案是服务端按分钟聚合。没选：它改变了审计数据的含义，也需要迁移。

3. **未认证行的标签。** `type === "auth.failed"` 时客户端列显示新文案 `activity.unauthenticated`。其余没有客户端的行仍走原来的回退逻辑（admin 事件本来就有 caller label）。

4. **状态映射集中到一张表。** 在 `ui.tsx` 中把 `statusText` 扩展为 `{ textKey, tone, shape }`：
   - ready 和 idle 都映射为 `ok`。
   - connecting 和 awaiting 映射为 `warn`。
   - offline 映射为新的 `off` tone：中性色、虚线边框，圆点改为空心。这样不靠颜色也能和在线区分开。

   `DeviceGlyph` 的 `.s-*` 类与这张表对齐。设备离线需要提醒，但这件事交给"需要关注"面板，不靠红色胶囊。

5. **"需要关注"面板的数据来源。** 都从已有数据算，不新增快照字段：
   - 离线设备：`displayOnline()`。
   - 版本落后：所有已上报 `engineVersion` 的众数（出现次数最多的版本）。如果最多的版本有并列，就不标记，避免误报。
   - 待审核的全局访问：Overview 挂载时请求一次 `access-clients`，之后跟随快照刷新节奏。请求失败时，面板显示一行"无法加载访问身份"，不影响其他项。
   - 近 24 小时失败：`snapshot.clients` 的 `errors24h` 之和，链接到 `/activity?outcome=not_ok&excludeAuthFailed=1`。

6. **页头和右上角。**
   - 页头改为两栏：左边是标题和 publicOrigin，右边是本页操作和外观控件。外观控件包括语言切换，以及主题快捷切换（system / light / dark 循环，图标加 `aria-label`）。
   - 主题快捷切换复用 Settings 里已有的 `PATCH {theme}` 路径，不需要重新认证。
   - 健康、版本、心跳和实时连接状态移到 `.nav-foot` 上方的状态块。≤ 820px 时，状态块变成导航行里的一个状态点，点击后展开详情。
   - 右上角的位置在两种宽度下都一样，满足 console-localization 的修改。

7. **窄屏拓扑。**
   - ≤ 820px 时 `.lanes` 改为单列纵向排列，同时隐藏 `svg.edges` 和 `canvas.flow`。泳道之间用一个静态的"↓"分隔条，上面写明方向（客户端 → Gateway → 设备）。
   - Gateway 阶段的闪烁、节点 `.hit` 动画、选中和抽屉都保留。
   - 用 `matchMedia` 判断宽度，渲染器在窄屏下不启动 rAF。
   - 备选方案是给纵向布局重写贝塞尔几何。没选：工作量大，在手机宽度上边线也难以辨认。

8. **导航溢出提示。**
   - `.nav ul` 设置 `scrollbar-width: none` 并隐藏 webkit 滚动条。
   - 一个小 hook 监听 scroll 和 resize，切换 `data-overflow-start` / `data-overflow-end`，CSS 用 `mask-image` 在对应边缘做渐隐。
   - 路由变化时对 `aria-current` 项调用 `scrollIntoView({ inline: "nearest", block: "nearest" })`。

9. **表格空列。**
   - 客户端表和活动表都按"当前渲染的行"计算每一列是否全为空，全空就不渲染这一列的 th 和 td。
   - 活动表的耗时和大小合并判断：两列都全空时一起隐藏。
   - 列顺序按 spec 调整。

10. **破坏性按钮。**
    - 新增 `.btn.danger-outline`（透明背景，危险色描边和文字）。列表内的撤销、断开按钮改用它，并放在操作组最后。
    - 确认 Modal 的提交按钮按 `edit.kind` 选择 `danger` 或 `primary`。

11. **抽屉遮罩。** `Drawer` 外层渲染 `.drawer-backdrop`（z-index 比抽屉低 1）。点击遮罩时，如果抽屉可关闭（dismissible），就调用 `onClose`，焦点还原沿用弹窗栈。一次性凭据抽屉不可关闭，点击遮罩不起作用。

12. **访问身份时间（实现时确认的范围扩展）。** `access-clients` 列表补充 `approvedAt` 和 `lastUsedAt`：OAuth 批准时间来自现有记录，委托身份以创建时间作为批准时间；最近使用取 OAuth 与按身份归属的 RPC 审计记录的最新时间。不新增数据库列或快照字段。审计保留期外的使用时间无法恢复，空值明确标为暂无记录，而非从未使用。元数据实时读取，不混入权限缓存。

13. **头像颜色。** `ui.tsx` 的 `hues` 改为避开 `--c-read`、`--c-write`、`--c-exec`、`--c-skill` 色相的一组中性偏冷色。

## Risks / Trade-offs

- [隐藏边线后，窄屏拓扑不再显示实时粒子] → 节点 `.hit` 闪烁和 Gateway 阶段高亮仍能提示有活动，活动表也在下方。
- [众数判断版本落后，在两台设备、两个版本时无法判断] → 并列时不标记，设备抽屉里仍能看到具体版本。
- [Overview 多一个 `access-clients` 请求] → 只在 Overview 挂载时和快照刷新时请求，页面隐藏时随快照轮询一起暂停。
- [落库的 `auth.failed` 没有次数，折叠后的总数可能偏低] → 文案写成"至少 N 次"（`≥`），不冒充精确值。
- [去掉页头的状态胶囊后，窄屏用户要多点一次才能看到版本] → 状态点本身用颜色和形状显示健康状态和是否实时连接，异常时显示文字。

## Migration Plan

前后端在同一个包版本里发布。`excludeAuthFailed` 是可选参数，旧前端不会传它。`activityQuery` 没有使用 `.strict()`，所以新前端连到旧 Gateway 时，这个参数会被忽略：结果只是不过滤，不会报错。回滚时直接回退版本即可，没有数据变更。
