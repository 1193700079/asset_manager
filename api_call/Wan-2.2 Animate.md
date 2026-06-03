# Wan-2.2 Animate

# Wan-2.2 Animate API 文档

本文档提供 视频动画生成 API 的接口说明。

## 基础信息

**API 基础域名**: \`https://smartstudio-intl.aliyuncs.com\`

**认证方式**: Bearer Token（在 HTTP Header 中传递 \`Authorization: Bearer sk-xxxxx\`）

**Content-Type**: `application/json`

---

## 1. 创建任务

提交一个生成任务。

### 接口信息

**HTTP 方法**: `POST`

**URL 路径**: `/api/v2/services/aigc/{provider}/{model}/{capability}`

**URL 参数说明**:

| 参数 | 值 |
| --- | --- |
| provider | alibaba |
| model | wan-2.2 |
| capability | animate |

**完整示例 URL**:

```plaintext
https://smartstudio-intl.aliyuncs.com/api/v2/services/aigc/alibaba/wan-2.2/animate
```

### 请求头

| Header 名称 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| Content-Type | 是 | 请求内容类型 | application/json |
| Authorization | 是 | API 访问凭证 | Bearer sk-xxxxxxxxxxxxxxxxxxxxxx |

### 请求参数

#### Request Body

| 字段名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| input | object | 是 | 任务输入参数对象 |
| input.workflow_type | string | 是 | 工作流类型，固定值：`wan22_animate` |
| input.payload | object | 是 | 任务参数对象 |
| input.payload.image | string | 是 | 输入图片的 URL 地址（支持 HTTPS） |
| input.payload.video | string | 是 | 输入视频的 URL 地址（支持 HTTPS） |
| input.payload.mode | string | 是 | 处理模式，固定值：`animate` |
| input.payload.resolution | string | 是 | 输出视频分辨率，可选值：`480p`, `720p` |
| input.payload.prompt | string | 否 | 文本提示词，用于指导生成效果 |
| input.payload.seed | integer | 否 | 随机种子，默认 0 表示随机生成 |

#### 请求示例

```plaintext
{
  "input": {
    "workflow_type": "wan22_animate",
    "payload": {
      "image": "https://aos-finance-singapore.oss-ap-southeast-1.aliyuncs.com/Photo3.JPG",
      "video": "https://aos-finance-singapore.oss-ap-southeast-1.aliyuncs.com/Photo3-template.mp4",
      "mode": "animate",
      "resolution": "480p"
    }
  }
}
```

### 响应参数

#### 成功响应 (200 OK)

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| output | object | 输出结果对象 |
| output.task_status | string | 任务状态，创建成功时为 `PENDING` |
| output.task_id | string | 任务唯一标识符（UUID 格式） |
| request_id | string | 请求唯一标识符，用于问题追踪 |

#### 响应示例

```plaintext
{
  "code":"200",
  "message":"Success",
  "output": {
    "task_status": "PENDING",
    "task_id": "95c457ab-6ea4-4cd9-af18-6f42cdc88411"
  },
  "request_id": "0507ba7e-292d-4a64-b8c5-a7a9d95aea62"
}
```

### 调用示例

#### cURL

```plaintext
curl --location --request POST 'https://smartstudio-intl.aliyuncs.com/api/v2/services/aigc/alibaba/wan-2.2/animate' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxx' \
--data-raw '{
  "input": {
    "workflow_type": "wan22_animate",
    "payload": {
      "image": "https://aos-finance-singapore.oss-ap-southeast-1.aliyuncs.com/Photo3.JPG",
      "video": "https://aos-finance-singapore.oss-ap-southeast-1.aliyuncs.com/Photo3-template.mp4",
      "mode": "animate",
      "resolution": "480p"
    }
  }
}'
```
---

## 2. 查询任务状态

通过任务 ID 查询任务的执行状态和结果。

### 接口信息

**HTTP 方法**: `GET`

**URL 路径**: `/api/v1/tasks/{task_id}`

**URL 参数**:

| 参数名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| task_id | string | 是 | 任务 ID（UUID 格式） |

**完整示例 URL**:

```plaintext
https://smartstudio-intl.aliyuncs.com/api/v1/tasks/95c457ab-6ea4-4cd9-af18-6f42cdc88411
```

### 请求头

| Header 名称 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| Authorization | 是 | API 访问凭证 | Bearer sk-xxxxxxxxxxxxxxxxxxxxxx |

### 请求参数

无需 Request Body

### 响应参数

#### 成功响应 (200 OK)

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| output | object | 输出结果对象 |
| output.task_status | string | 任务状态：`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED` |
| output.task_id | string | 任务唯一标识符 |
| output.video_url | string | 生成的视频 URL（仅 `SUCCEEDED` 状态返回） |
| output.task_message | string | 错误信息（仅 `FAILED` 状态返回） |
| request_id | string | 请求唯一标识符 |

#### 响应示例

**PENDING 状态**（任务排队中）

```plaintext
{
  "code":"200",
  "message":"Success",
  "output": {
    "task_status": "PENDING",
    "task_id": "95c457ab-6ea4-4cd9-af18-6f42cdc88411"
  },
  "request_id": "adeee9aa-db0c-4dcb-b4ee-6ce513fc45e1"
}
```

**RUNNING 状态**（任务执行中）

```plaintext
{
  "code":"200",
  "message":"Success",
  "output": {
    "task_status": "RUNNING",
    "task_id": "95c457ab-6ea4-4cd9-af18-6f42cdc88411"
  },
  "request_id": "adeee9aa-db0c-4dcb-b4ee-6ce513fc45e1"
}
```

**SUCCEEDED 状态**（任务完成）

```plaintext
{
  "code":"200",
  "message":"Success",
  "output": {
    "task_status": "SUCCEEDED",
    "task_id": "95c457ab-6ea4-4cd9-af18-6f42cdc88411",
    "video_url": "https://ai-insight-dev.oss-ap-southeast-1.aliyuncs.com/20260210/xxxx"
  },
  "request_id": "adeee9aa-db0c-4dcb-b4ee-6ce513fc45e1"
}
```

**FAILED 状态**（任务失败）

```plaintext
{
  "code":"500",
  "message":"url error",
  "output": {
    "task_id":"95c457ab-6ea4-4cd9-af18-6f42cdc88411",
    "task_status": "FAILED",
    "task_message": "url error"
  },
  "request_id": "adeee9aa-db0c-4dcb-b4ee-6ce513fc45e1"
}
```

### 调用示例

#### cURL

```plaintext
curl --location --request GET 'https://smartstudio-intl.aliyuncs.com/api/v1/tasks/95c457ab-6ea4-4cd9-af18-6f42cdc88411' \
--header 'Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxx'
```

## 3. 任务状态说明

| 状态 | 英文 | 说明 |
| --- | --- | --- |
| 等待中 | PENDING | 任务已创建，等待执行 |
| 执行中 | RUNNING | 任务正在生成视频 |
| 成功 | SUCCEEDED | 任务执行成功，视频已生成 |
| 失败 | FAILED | 任务执行失败 |