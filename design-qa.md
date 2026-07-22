# Design QA — 大盘卡片响应式标题

**Source visual truth**

- `/var/folders/t9/l3t0cc1x3m97rpkbg4j7jlzh0000gn/T/codex-clipboard-55fdee94-496e-491c-9835-524dcc82c7e8.png`
- Source pixels: `540 × 152`。
- 目标状态：压缩右侧日期块高度和行距，并改善标题与日期块的左右视觉平衡。

**Implementation evidence**

- Mobile full view: `/private/tmp/yangjian-market-header-balanced-mobile.png`
- Mobile today-market view: `/private/tmp/yangjian-today-market-mobile-qa.png`
- Desktop full view: `/private/tmp/yangjian-market-header-desktop-qa.png`
- Combined source/implementation comparison: `/private/tmp/yangjian-market-header-balance-comparison.png`
- Browser viewport: mobile `371 × 820` CSS px, requested DPR `2`; browser capture `363 × 802` px. Desktop `1440 × 900` CSS px, DPR `1`。
- Focused comparison normalization: implementation heading crop `331 × 75` px scaled and padded to `540 × 152`，与 source 并排检查标题、日期块高度和视觉重心。
- State: 周收益、当前周 `2026-W30`；当日大盘与同期大盘涨幅均展示。

**Findings**

- 无 P0/P1/P2 问题。
- 字体与层级：标题、日期继续沿用现有 Outfit/系统回退和既有字号；日期弱化层级符合原卡片。
- 间距与布局：窄屏日期块由约 `47px` 收紧至 `34.23px`；标题与日期块中心差约 `0px`，日期继续右对齐，页面横向溢出为 `0`。
- 颜色与视觉令牌：未引入新卡片样式；区间分隔符沿用弱化文字色并提高可读性。
- 图片与资产：本次改动不新增图片或图标资产。
- 文案与内容：当日日期为单行；同期日期在窄屏为 `2026-07-17 / ~ / 2026-07-22`，桌面为 `2026-07-17 → 2026-07-22`。
- 浏览器控制台无运行错误；仅有项目既存的 Tailwind CDN production warning。

**Comparison history**

1. 初次实现将日期移至右侧，并把同期区间拆为三行；窄屏检查发现 `~` 字形在缩放截图中偏弱。
2. 提高 `~` 的字号、字重、颜色与行高后重新构建；最终 DOM 文本、对齐和桌面/移动端布局均通过检查。
3. 针对最新反馈收紧日期行高和分隔符占位，并让同期标题相对日期块垂直居中；复测中心差约 `0px`，无新增溢出。

**Implementation checklist**

- [x] 当日日期保持标题右侧单行。
- [x] 同期日期在窄屏右侧纵向换行并显示 `~`。
- [x] 同期标题与压缩后的日期块垂直居中。
- [x] 同期日期在桌面保持单行箭头连接。
- [x] 移动端与桌面端无横向溢出。
- [x] 构建通过，浏览器主要状态验证完成。

**Follow-up polish**

- 无阻塞项。

final result: passed
