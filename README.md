# Code401Check Web

一个基于 Next.js 的账号批量检测与清理工具，用于：

- 拉取管理端账号列表
- 并发探测账号状态
- 标记并批量删除 `401` 失效账号

---

## 功能概览

- **账号拉取**：从管理 API 获取 auth-files。
- **并发探测**：按配置并发请求探测接口，支持中途停止扫描。
- **失效识别**：根据返回 `status_code === 401` 标记失效账号。
- **批量删除**：对失效账号执行批量删除。
- **结果检索**：支持搜索（防抖）与分页展示。
- **稳定性优化**：扫描过程采用批量状态刷新，降低大数据量下的渲染压力。
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

- **Base URL**：管理端地址（例如 `https://your-cpa-address`）
- **Management Token**：管理令牌
- **Target Type**：默认 `codex`
- **Provider（可选）**：按 provider 过滤
- **并发线程**：范围 `1 ~ 100`
- **超时(秒)**：范围 `1 ~ 120`

操作流程：

1. 点击 **开始检测**
2. 观察进度与结果状态
3. 如需中止，点击 **停止扫描**
4. 检测完成后点击 **删除失效** 批量删除 `401` 账号

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
    page.tsx                 # 主界面与扫描/删除流程
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