# piweb-bridge 模型配置总结

## 📋 概览

piweb-bridge 支持两类模型：
1. **自定义模型**：在 `~/.pi/agent/models.json` 中配置
2. **内置模型**：pi-coding-agent 自带的标准模型（如 OpenAI、Anthropic 等）

---

## ✅ 免费模型列表

### 当前配置的免费模型（自定义）

所有自定义模型都配置为 **免费**（成本为 0）：

| 模型 ID | 模型名称 | Provider | 上下文窗口 | 支持推理 | 状态 |
|---------|---------|----------|-----------|---------|------|
| `glm-5.2-fp8` | glm-5.2-fp8 | my-provider | 128,000 | ✅ | ✅ 免费 |
| `glm5-cdp` | glm5-cdp | my-provider | 128,000 | ✅ | ✅ 免费 |
| `hy3-preview` | hy3-preview | my-provider | 128,000 | ✅ | ✅ 免费 |

**配置位置**：`~/.pi/agent/models.json`

**Provider 信息**：
- **名称**：my-provider
- **Base URL**：`http://11.160.215.64/v1`
- **API Key**：`sk-6lQALtCMQvw5-GL39FlTPg`
- **API 类型**：openai-completions（OpenAI 兼容接口）

---

## 🔧 自定义模型详解

### 如何添加自定义模型

编辑 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "my-provider": {
      "name": "My Provider",
      "baseUrl": "http://your-api-endpoint/v1",
      "apiKey": "your-api-key",
      "api": "openai-completions",
      "authHeader": true,
      "models": [
        {
          "id": "model-id",
          "name": "Model Name",
          "reasoning": true,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

### 自定义模型配置字段说明

| 字段 | 说明 | 示例 |
|------|------|------|
| `providers.<name>.name` | Provider 显示名称 | "My Provider" |
| `providers.<name>.baseUrl` | API 基础 URL | "http://11.160.215.64/v1" |
| `providers.<name>.apiKey` | API 密钥 | "sk-xxx" |
| `providers.<name>.api` | API 类型 | "openai-completions" |
| `providers.<name>.models[].id` | 模型 ID | "glm5-cdp" |
| `providers.<name>.models[].name` | 模型显示名称 | "glm5-cdp" |
| `providers.<name>.models[].reasoning` | 是否支持推理链 | true/false |
| `providers.<name>.models[].contextWindow` | 上下文窗口大小 | 128000 |
| `providers.<name>.models[].maxTokens` | 最大输出 tokens | 16384 |
| `providers.<name>.models[].cost` | 成本配置（设为 0 即免费） | `{"input": 0, "output": 0}` |

---

## 📚 内置模型（标准/付费）

### OpenAI 模型（内置）

pi-coding-agent 内置了 OpenAI 的完整模型列表（38 个），包括：

**GPT-4 系列**：
- `gpt-4`
- `gpt-4-turbo`
- `gpt-4.1` / `gpt-4.1-mini` / `gpt-4.1-nano`
- `gpt-4o` / `gpt-4o-mini`

**GPT-5 系列**（最新）：
- `gpt-5` / `gpt-5-mini` / `gpt-5-nano` / `gpt-5-pro`
- `gpt-5.1` / `gpt-5.2` / `gpt-5.3` / `gpt-5.4`
- `gpt-5.5` / `gpt-5.6-luna`

⚠️ **注意**：OpenAI 官方模型都是 **付费** 的，需要：
1. 有效的 OpenAI API key
2. 账户有余额
3. 在 `~/.pi/agent/auth.json` 中配置认证

### 其他内置 Provider

pi-coding-agent 还支持其他内置 provider（需要在 `auth.json` 中配置）：
- **Anthropic** (Claude 系列)
- **Google** (Gemini 系列)
- 其他 OpenAI 兼容接口

---

## 🎯 推荐配置（免费方案）

当前配置已经使用了 **完全免费** 的自定义模型：

```bash
# 环境变量配置（在 start.sh 或 .env 中）
export PI_PROVIDER=my-provider
export PI_MODEL=glm5-cdp
export OPENAI_API_KEY=sk-6lQALtCMQvw5-GL39FlTPg
export OPENAI_BASE_URL=http://11.160.215.64/v1
```

**优势**：
- ✅ 完全免费（成本为 0）
- ✅ 支持推理链（reasoning: true）
- ✅ 大上下文窗口（128K）
- ✅ OpenAI 兼容接口

---

## 🔍 如何查看当前可用模型

### 方法 1：通过 pi-bridge API

```bash
# 启动 pi-bridge 后
curl http://localhost:8643/providers | jq .
curl http://localhost:8643/models | jq .
```

### 方法 2：直接查看配置文件

```bash
# 自定义模型
cat ~/.pi/agent/models.json | jq .

# 内置模型
cat ~/.pi/agent/models-store.json | jq .

# 当前认证配置
cat ~/.pi/agent/auth.json | jq .
```

---

## 📝 添加新免费模型的步骤

假设你要添加一个免费的 OpenAI 兼容接口：

### 1. 编辑 `models.json`

```bash
vim ~/.pi/agent/models.json
```

添加新 provider 或新模型：

```json
{
  "providers": {
    "my-free-provider": {
      "name": "My Free Provider",
      "baseUrl": "http://free-api.example.com/v1",
      "apiKey": "free-api-key",
      "api": "openai-completions",
      "models": [
        {
          "id": "free-model",
          "name": "Free Model",
          "reasoning": false,
          "cost": {"input": 0, "output": 0},
          "contextWindow": 8192,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

### 2. 重启 pi-bridge

```bash
pkill -f pi-bridge.ts
cd ~/ai-home/piweb-bridge
./start.sh
```

### 3. 验证新模型

```bash
curl http://localhost:8643/providers | jq '.providers[] | select(.name == "my-free-provider")'
```

---

## 🚨 常见问题

### Q1: 如何判断模型是否免费？

查看模型的 `cost` 字段：
```json
"cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
```
所有成本都为 0 即为免费。

### Q2: 为什么 OpenAI 模型不可用？

需要配置 `auth.json`：
```json
{
  "openai": {
    "apiKey": "sk-your-openai-key"
  }
}
```

### Q3: 自定义模型支持哪些 API 类型？

当前支持：
- `openai-completions`（OpenAI 兼容）
- `openai-responses`（OpenAI Responses API）
- 其他（参考 pi-coding-agent 文档）

### Q4: 如何切换默认模型？

**方法 1**：环境变量
```bash
export PI_PROVIDER=my-provider
export PI_MODEL=glm5-cdp
```

**方法 2**：通过 API
```bash
curl -X POST http://localhost:8643/model \
  -H "Content-Type: application/json" \
  -d '{"provider": "my-provider", "modelId": "glm5-cdp"}'
```

---

## 📊 总结

| 类型 | 数量 | 免费？ | 配置位置 |
|------|------|--------|---------|
| 自定义模型 | 3 | ✅ 全部免费 | `~/.pi/agent/models.json` |
| OpenAI 内置 | 38 | ❌ 付费 | `~/.pi/agent/models-store.json` |
| 其他内置 | N | ❌ 付费 | pi-coding-agent 内置 |

**当前推荐**：使用 `my-provider` 的 3 个免费模型（`glm-5.2-fp8`、`glm5-cdp`、`hy3-preview`），已配置好且完全免费。

---

*生成时间: 2025-08-08*
*配置文件: ~/.pi/agent/models.json*
