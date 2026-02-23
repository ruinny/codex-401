# Code401Check Web

一个基于 Next.js 的账号批量检测与清理工具，用于：

- 拉取管理端账号列表
- 并发探测账号状态
- 将账号归类为「正常 / 失败」
- 批量删除失败账号

---

## 功能概览

- **账号拉取**：从管理 API 获取 auth-files。
- **并发探测**：按配置并发请求探测接口，支持中途停止扫描。
- **多次复检判定**：每个账号会进行多轮探测，最终只输出两类结果：`正常` / `失败`。
- **结果筛选**：支持按结果筛选（全部 / 正常 / 失败）。
- **批量删除**：只对“失败”账号执行批量删除。
- **结果检索**：支持搜索（防抖）与分页展示。
- **性能优化**：扫描过程采用批量状态刷新，降低大数据量下的渲染压力。
- **安全边界**：服务端统一校验 `baseUrl / timeout / payload`，并返回结构化错误。

---

## 技术栈

- Next.js 14 (App Router)
- React 18
- TypeScript
- Axios
- Tailwind CSS

---

## 快速开始

## 1) 安装依赖

```bash
npm install
```

## 2) 本地开发

```bash
npm run dev
```

默认访问：`http://localhost:3000`

## 3) 生产构建与启动

```bash
npm run build
npm run start
```

---

## 页面使用说明

启动后填写：

- **Base URL**：管理端地址（可包含路径前缀），例如 `https://your-cpa-address` 或 `https://host/prefix`
- **Management Token**：管理令牌
- **Target Type**：默认 `codex`
- **Provider（可选）**：按 provider 过滤
- **并发线程**：范围 `1 ~ 10`
- **超时(秒)**：范围 `1 ~ 120`

操作流程：

1. 点击 **开始检测**
2. 观察扫描进度与结果
3. 如需中止，点击 **停止扫描**
4. 使用 **按结果筛选** 查看“正常”或“失败”账号
5. 点击 **删除失败账号** 批量清理失败账号

---

## 运行机制（重点）

本节说明系统如何从“单次探测结果”得到最终判定，帮助理解为何会出现波动与最终结果。

### 1) 总体执行链路

1. 前端调用 `POST /api/accounts` 获取账号列表。
2. 前端按配置并发逐个账号调用 `POST /api/probe`。
3. 每个账号不是只探测 1 次，而是进行**多轮探测（默认 3 轮）**。
4. 根据多轮结果做最终分类：`正常` 或 `失败`。
5. 删除阶段只针对最终分类为 `失败` 的账号调用 `POST /api/delete`。

---

### 2) 多轮复检判定规则（核心）

每个账号会收集多轮 `status_code`（默认 3 轮）。

- `401` 次数 >= 2：判定为 **失败**
- 非 `401` 次数 >= 2：判定为 **正常**
- 边界情况（例如部分轮次失败/缺失）：按最后可用结果归并到“正常/失败”之一

> 这意味着：系统内部保留“多次复检逻辑”，但 UI 只显示两类结果，不再暴露 `unstable`。

---

### 3) 为什么同一账号可能出现前后不一致

即使使用多轮判定，账号状态仍可能在不同扫描批次间变化，常见原因：

- 上游 token/session 状态变化（失效、刷新、风控）
- 上游服务瞬时波动
- 并发压力触发限流或策略变化

多轮判定的作用是降低单次抖动的误判概率，而不是保证“永远一致”。

---

### 4) 并发与停止机制

- 扫描使用 worker 池限制并发，避免一次性打满请求。
- 点击“停止扫描”会触发 `AbortController`，中断未完成请求。
- 进度与结果更新采用批量 flush，减少频繁重渲染。

---

### 5) Base URL 规范化规则

系统会校验 `baseUrl` 必须为 `http/https`，并进行规范化：

- 保留 `origin`
- 保留路径前缀（如果有）
- 去除末尾 `/`

例如：

- `https://host/` -> `https://host`
- `https://host/prefix///` -> `https://host/prefix`

---

### 6) 删除机制

- 仅删除最终结果为 `失败` 的账号
- 删除请求使用独立并发（默认 5）
- 每行会显示删除状态：成功 / 失败

---

## 内部 API

这些路由由前端调用，服务端再转发到管理端。

### `POST /api/accounts`

请求体：

```json
{
  "baseUrl": "https://example.com",
  "token": "xxx",
  "timeout": 12
}
```

### `POST /api/probe`

请求体（`payload` 受白名单校验）：

```json
{
  "baseUrl": "https://example.com",
  "token": "xxx",
  "timeout": 12,
  "payload": {
    "authIndex": "...",
    "method": "GET",
    "url": "https://chatgpt.com/backend-api/wham/usage",
    "header": {
      "Authorization": "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "..."
    }
  }
}
```

### `POST /api/delete`

请求体：

```json
{
  "baseUrl": "https://example.com",
  "token": "xxx",
  "name": "account-name",
  "timeout": 12
}
```

### 错误响应格式

```json
{
  "error": {
    "message": "...",
    "status": 400,
    "code": "INVALID_INPUT"
  }
}
```

---

## 环境变量

可选：

- `ALLOWED_BASE_HOSTS`：逗号分隔的主机白名单。

示例：

```bash
ALLOWED_BASE_HOSTS=api.example.com,api-backup.example.com
```

配置后，仅允许这些 host 作为 `baseUrl`。

---

## 脚本

- `npm run dev`：开发模式
- `npm run build`：生产构建
- `npm run start`：生产启动
- `npm run lint`：运行 Next.js lint

> 注意：当前仓库若未初始化 ESLint 配置，首次执行 `npm run lint` 可能出现交互式引导。

---

## 关键目录

```text
src/
  app/
    page.tsx                 # 主界面与扫描/筛选/删除流程
    api/
      accounts/route.ts      # 拉取账号
      probe/route.ts         # 探测账号状态
      delete/route.ts        # 删除账号
  lib/
    useDebouncedValue.ts     # 搜索防抖
    server/
      request-validation.ts  # 服务端请求校验
      api-error.ts           # 统一错误映射
```

---

## 免责声明

本项目用于账号管理与可用性检测，请仅在你有权限的系统中使用。