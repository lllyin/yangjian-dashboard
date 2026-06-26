# 杨戬 Dashboard

> 基于 [yangjian](https://github.com/lllyin/yangjian) 项目的收益率监控仪表盘，实时展示周 / 月 / 年盈亏数据。

## 功能

- 📅 **周收益**：本周每日盈亏柱状图 + 周总盈亏 / 周收益率
- 📆 **月收益**：每月盈亏柱状图 + 月总盈亏 / 月收益率
- 📊 **年收益**：年内每月收益柱状图 + 年总盈亏 / 年收益率
- 🎨 支持自定义涨跌颜色（红涨绿跌 / 绿涨红跌）
- 📱 响应式布局，兼容 PC 和手机

## 依赖

- Node.js 20+（使用原生 `--env-file` 加载环境变量）
- [yangjian](https://github.com/lllyin/yangjian) 项目（数据来源）

## 快速开始

### 1. 克隆并安装依赖

```bash
git clone git@github.com:lllyin/yangjian-dashboard.git
cd yangjian-dashboard
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入你本机的 yangjian 项目路径：

```env
YANGJIAN_ROOT=/path/to/your/yangjian
```

### 3. 确保 yangjian 项目已编译

```bash
cd /path/to/your/yangjian
npm run build
```

### 4. 启动 Dashboard

```bash
cd yangjian-dashboard
npm run dashboard
```

打开浏览器访问：[http://localhost:3000](http://localhost:3000)

## 项目结构

```
yangjian-dashboard/
├── src/
│   ├── server.ts       # Node.js HTTP 服务，读取 journal 数据并提供 API
│   ├── config.json     # 可选配置（主题颜色、起始周）
│   ├── index.html      # 前端页面
│   ├── app.js          # 前端逻辑（Chart.js）
│   └── style.css       # 样式
├── .env                # 本地环境变量（不提交，含 YANGJIAN_ROOT）
├── .env.example        # 环境变量模板
├── tsconfig.json
└── package.json
```

## 配置说明

`src/config.json` 支持以下配置项（不含机器相关路径）：

| 字段 | 说明 | 示例 |
|------|------|------|
| `startWeek` | 数据起始周（跳过格式不规范的旧数据） | `"2026-W20"` |
| `theme.upColor` | 上涨颜色 | `"#ef4444"`（红）|
| `theme.downColor` | 下跌颜色 | `"#10b981"`（绿）|

机器相关配置通过 `.env` 文件设置：

| 变量 | 说明 |
|------|------|
| `YANGJIAN_ROOT` | yangjian 项目根目录的绝对路径 |

## yangjian 作为本地依赖

本项目通过 npm `file:` 协议引用 yangjian，直接复用其 `calculation` 模块，无需重复实现数据解析逻辑。如果 yangjian 更新了代码，只需重新 `npm run build` 即可。
