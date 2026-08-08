# Pensieve — 暖色调视觉主题 设计文档

日期：2026-08-08

## 背景与目标

当前所有页面用的是 shadcn/ui 的默认黑白灰样式，没有体现产品的视觉定位。通过可视化 mockup 对比三个方向（暖色调/杂志感、极简黑白灰、现代科技感蓝紫色系）后，选定"暖色调/杂志感"方向，应用到全应用（登录页、Dashboard、建 Track、Track 详情、调整计划、当日教材页）。

## Design Tokens

写入 `app/globals.css`，作为 CSS 变量（覆盖 shadcn 默认 token）：

| Token | 值 | 用途 |
|---|---|---|
| `--background` | `#F4EFE4` | 页面背景（米色） |
| `--card` | `#FBF6EC` | 卡片背景（米白） |
| `--foreground` | `#2E2A22` | 主文字 |
| `--muted-foreground` | `#6B6555` | 次要文字 |
| `--primary` | `#C0674A` | 主色/强调色（按钮、进度条、streak 徽章） |
| `--primary-foreground` | `#FBF3E9` | 主色上的文字 |
| `--border` | `#E7DCC5` | 边框 |
| `--muted` | `#F0E3CB` | 徽章底色（pending 等次要状态） |

字体：
- 标题（`h1`/页面大标题）：衬线字体，`font-family: Georgia, 'Noto Serif SC', serif`
- 正文/UI 文字：保持系统无衬线字体（中英文混排可读性更好）

## 组件层面调整

- **按钮**：圆角药丸形（`rounded-full`），主要按钮用 `--primary` 底色
- **Track 卡片**：`--card` 背景 + `--border` 细边框 + 圆角，进度条 fill 用 `--primary`
- **状态徽章**（pending/generated/completed）：`--muted` 底色 + 深色文字；streak 徽章用 `--primary` 底色
- **应用范围**：这是全局 token 替换 + 少量组件类名调整，不改变任何页面的数据流、路由结构或业务逻辑

## 范围

包含：
- `app/globals.css` 的颜色/字体 token 替换
- shadcn 按钮、卡片、徽章组件的圆角/配色微调（如需要）
- 所有现有页面自动继承新 token，无需逐页改动业务代码

不包含：
- 任何新页面、新交互、新数据模型
- 深色模式适配（当前应用无深色模式支持，不在本次范围内）
