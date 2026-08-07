# Pensieve — 每日学习打卡 App 设计文档

日期：2026-08-07

## 背景与目标

一个个人使用的学习打卡工具：用户选择任意学习方向（历史、政治、股票、面试准备等），AI 辅助生成学习大纲和每日打卡计划，并按需生成当日教材（AI 自己总结的内容，附带原始来源链接）。

MVP 先聚焦一个垂类切入：**Senior SWE Interview / System Design 面试准备**，但整体架构（数据模型、内容生成流程）必须能轻松扩展到任意主题，不需要为新主题写专门代码。

产品定位为个人自用工具，但数据模型按多用户设计，为未来开放给其他人使用打基础。

## 范围（MVP）

包含：
- 创建学习 Track，AI 生成大纲（按天拆分的任务列表），支持对话式反馈调整后再确认
- Track 进行中，用户随时可对未完成部分提出修改意见，AI 重新生成草稿供确认
- 按需生成当日教材（markdown 正文 + 引用来源），AI 自主判断是否需要联网搜索
- 用户可选提供参考 source（含 YouTube 链接），AI 生成内容时优先参考
- YouTube 链接以嵌入卡片形式展示，不做 transcript 提取/总结
- 简单打卡（标记完成 + streak 计数）

不包含（明确排除，作为后续迭代）：
- AI 出题/测验来验证掌握程度
- YouTube transcript 自动提取与总结
- 社交/分享功能
- 移动端原生 App

## 技术架构

- **Next.js (App Router)**，部署在 Vercel，Fluid Compute（Node.js runtime，非 Edge）
- **AI SDK v6 + Vercel AI Gateway**：模型统一用 `"provider/model"` 字符串调用；agent 内置 `web_search` 工具，由模型自主判断何时调用
- **模型选择对用户开放**：大纲生成、大纲修改、当日教材生成，每次操作用户都可以从一个模型下拉列表中挑选要用的模型（默认预选一个性价比高的选项）。因为已经走 AI Gateway 的 `"provider/model"` 字符串调用方式，未来加入非 Anthropic 的模型（如 GPT、Gemini）只需要在可选列表里加一行配置，不需要改动生成逻辑代码
- **数据库**：Postgres，通过 Vercel Marketplace 接入 Neon
- **认证**：Clerk（多用户设计，即使当前只有一个真实用户）
- **UI**：shadcn/ui + Tailwind CSS

不需要额外的队列/worker 服务——按需生成的内容用 Server Action 同步调用 LLM 即可满足当前规模。

## 数据模型

```
User（Clerk 管理身份，本地表只存 userId 映射及必要的 profile 字段）

Track（一个学习方向，如 "System Design 面试准备"）
  - id, userId, title, description
  - status: active / completed / archived
  - createdAt
  （创建流程见下方"AI 内容生成流程"：Track 与其 OutlineItem 是在用户确认草稿后一起写入的，草稿阶段不落库）

Source（用户可选提供的参考资料，归属某个 Track）
  - id, trackId, type: link / youtube
  - url, title

OutlineItem（大纲中的一天任务，创建 Track 时批量生成）
  - id, trackId, dayIndex, title, summary
  - status: pending / generated / completed

DailyContent（某个 OutlineItem 对应的详细教材，按需生成，与 OutlineItem 一对一）
  - id, outlineItemId, contentMarkdown, citations (jsonb)
  - model（生成本篇内容所用的 "provider/model" 字符串，用于展示和"换模型重新生成"时的默认预选值）
  - generatedAt

CheckIn（打卡记录）
  - id, outlineItemId, completedAt
```

关键设计点：`OutlineItem`（轻量大纲骨架）与 `DailyContent`（重量级正文）分离。创建 Track 时只生成大纲骨架，避免一次性生成整门课程的高成本和信息过时问题；正文在用户点开当天任务时才生成，并缓存复用。

所有业务表都带 `userId`（直接或通过 Track 关联），从第一天起就是多租户结构。

## AI 内容生成流程

**创建 Track（对话式生成大纲草稿）：**
1. 用户输入主题、可选学习周期、可选 sources 链接，并从模型下拉列表中选择本次大纲生成用的模型（默认预选一个性价比高的选项，用户可改）
2. Agent 用选定模型 + 结构化生成（`generateObject`）产出大纲草稿：`OutlineItem[]`（dayIndex/title/summary），内容由易到难排列。若提供了 sources，草稿会参考其目录/内容规划顺序；若主题偏时效性，agent 会先用 `web_search` 查一轮再生成
3. 草稿只在前端展示，不写入数据库。用户可以输入反馈文字（如"第5-10天太难了，拆细一点"）并可重新选择模型，agent 基于当前草稿 + 反馈重新生成整份草稿，可反复多轮
4. 用户点击"确认"后，才一次性将 Track 和确认版的 `OutlineItem[]` 写入数据库，Track 状态变为 active
5. 是否联网完全由模型自主判断，不在产品层面为不同 topic 写死规则

**学习中调整大纲：**
1. Track 处于 active 状态时，用户可随时打开"调整计划"入口，输入修改意见，并可选择这次调整用的模型
2. Agent 基于当前大纲中**未完成**的 `OutlineItem`（status 为 pending 或 generated）+ 用户反馈，重新生成这部分的草稿，同样可反复调整（每轮都可换模型）；已 completed 的条目不参与，也不会展示为可改
3. 用户确认后，原来未完成的 `OutlineItem` 连同其关联的 `DailyContent`（若已生成过还未打卡）一起删除，替换为新草稿对应的记录，`dayIndex` 从最后一个 completed 之后重新连续排列
4. 若用户在预览草稿阶段放弃，数据库中原有大纲不受任何影响

**打开某天任务（生成当日教材）：**
1. 若 `DailyContent` 已存在，直接展示缓存内容，同时提供"换个模型重新生成"入口
2. 生成时（首次或重新生成）：用户从下拉列表选择模型（重新生成时默认预选上次使用的 `DailyContent.model`），调用 agent：传入当天 title/summary、Track 的 sources 列表，模型自主决定是否调用 `web_search`，生成 markdown 教材正文，引用来源写入 `citations`。重新生成会覆盖原有 `DailyContent`（含 `model` 字段），不保留历史版本
3. YouTube 类型的 source 仅以嵌入卡片（标题+缩略图+跳转链接）形式展示在正文中，不提取 transcript

**打卡：** 用户完成当天内容后点击"标记完成" → 写入 `CheckIn` → 对应 `OutlineItem.status` 更新为 completed → dashboard 展示连续打卡天数（streak）。

## 页面结构

- `/dashboard` — 所有 Track 卡片列表（标题、进度条、streak），"新建 Track" 入口
- `/tracks/new` — 创建 Track 表单（主题、可选周期、可选 sources、模型下拉选择）→ 提交后进入大纲草稿对话式确认界面（展示当前草稿列表 + 反馈输入框 + 模型下拉 + "重新生成"/"确认"按钮），确认后写入数据库并跳转详情页
- `/tracks/[id]` — 大纲总览：按天列出的任务列表，展示完成状态；提供"调整计划"入口，打开后进入与创建时类似的草稿确认界面（含模型选择），但只针对未完成部分
- `/tracks/[id]/day/[dayIndex]` — 当日教材页：markdown 正文、引用来源、YouTube 卡片、生成/重新生成时的模型下拉选择、"标记完成"按钮

## 后续迭代方向（不在 MVP 范围内）

- AI 出题/闪卡验证掌握程度，取代简单打卡
- YouTube transcript 自动提取与总结（有字幕的视频优先支持）
- 移动端支持
- 多用户间的分享/协作
