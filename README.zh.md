# dsh-tool-kubernetes

[English](README.md) | [中文](README.zh.md)

面向 **DeepSeek Harness**(`dsh`) 的 Cordis 工具插件，为 Agent 提供 Kubernetes 运维工作流：集群与 context 检查、namespace 和工作负载发现、Pod 日志、副本扩缩、Deployment rollout、ConfigMap、Secret、Service、Ingress 以及 manifest 应用。

插件按官方 `ctx.tools.register(defineTool(...))` 契约注册 25 个工具，使用官方 Kubernetes JavaScript Client 完成 kubeconfig 加载和 API 调用。写操作默认关闭，只有显式 `allowWrite: true` 后才可用，并支持 namespace 白名单。

## 安装

直接从 GitHub 安装（无需发布 npm）：

```sh
npm install github:LJH-snow/dsh-tool-kubernetes
# 或指定分支/标签
npm install github:LJH-snow/dsh-tool-kubernetes#main
```

或从本地安装：

```sh
git clone https://github.com/LJH-snow/dsh-tool-kubernetes
cd dsh-tool-kubernetes
npm install && npm run build   # 构建到 lib/
npm install /path/to/dsh-tool-kubernetes
```

需要 `@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）作为 peer 依赖，由 dsh 运行时提供。

## 配置

在 dsh 组合配置（`cordis.yml`）中加载插件：

```yaml
- name: 'dsh-tool-kubernetes'
  config:
    # 可选 kubeconfig 路径；默认读取 $KUBECONFIG 或 ~/.kube/config
    # kubeconfig: '/Users/you/.kube/config'
    # 可选 kubeconfig context；默认 current-context
    # context: 'prod'
    # 可选默认 namespace；未设置时使用 context namespace
    namespace: 'team'
    # 写工具默认关闭
    allowWrite: true
    # 可选写操作 namespace 白名单；为空表示 allowWrite 后所有 namespace 都可写
    writeNamespaces:
      - team
    # 可选 kind 白名单；集群级、RBAC、Secret、ServiceAccount 写入必须显式加入
    # writeKinds: [Deployment, StatefulSet]
    # 可选客户端 Pod 日志限制
    # logMaxLines: 1000
    # logMaxBytes: 131072
    # logTimeoutMs: 15000
```

完整示例见 [examples/cordis.yml](examples/cordis.yml)。

## 工具列表

### 只读

| 工具 | 功能 |
|---|---|
| `k8s_get_config` | 当前 context、kubeconfig contexts、API server、默认 namespace |
| `k8s_list_namespaces` | namespace phase 与创建时间 |
| `k8s_list_nodes` | 节点就绪状态、角色、kubelet 版本、Internal IP |
| `k8s_list_pods` | Pod 列表：phase、就绪容器、重启次数、节点、容器 |
| `k8s_get_pod` | 单个 Pod 及容器状态 |
| `k8s_read_pod_logs` | 读取 Pod 日志，支持 container/timestamps/previous |
| `k8s_list_deployments` | Deployment 列表及副本/rollout 计数 |
| `k8s_get_deployment` | 单个 Deployment 及镜像/rollout 计数 |
| `k8s_rollout_status_deployment` | Progressing 条件、revision、ready/updated/available 副本数 |
| `k8s_list_statefulsets` | StatefulSet 列表及期望/就绪副本数 |
| `k8s_get_statefulset` | 单个 StatefulSet 及镜像/副本状态 |
| `k8s_list_services` | Service 类型、ClusterIP、External IP、端口 |
| `k8s_get_service` | 单个 Service 及选择器和端口 |
| `k8s_list_ingresses` | Ingress hosts 与负载均衡地址 |
| `k8s_list_configmaps` | ConfigMap key 列表与创建时间 |
| `k8s_get_configmap` | 单个 ConfigMap key 列表 |
| `k8s_list_secrets` | Secret 名称/类型/key 列表，不返回值 |
| `k8s_get_secret` | 单个 Secret key 列表，不返回值 |
| `k8s_list_events` | 最近事件：来源、对象、reason、次数 |

### 写操作

| 工具 | 功能 |
|---|---|
| `k8s_scale_deployment` | 扩缩容 Deployment |
| `k8s_scale_statefulset` | 扩缩容 StatefulSet |
| `k8s_restart_deployment` | 给 Deployment pod template 添加 restartedAt 注解以触发重启 |
| `k8s_update_deployment_image` | 更新 Deployment 中单个容器的镜像 |
| `k8s_rollout_undo_deployment` | 回滚 Deployment 到之前的 ReplicaSet revision |
| `k8s_apply_manifest` | 创建或 patch 一个或多个 YAML/JSON manifest |

## 行为约定

- Kubernetes 认证来自 kubeconfig 路径、`$KUBECONFIG`、`~/.kube/config` 或集群内 ServiceAccount 文件，由官方 Kubernetes Client 解析。
- 配置缺失时正常返回 `{ connected: false, reason }`，而不是在普通工具调用中抛错。
- 资源不存在返回 `{ found: false }`；写操作失败返回 `{ ok: false, reason }`。
- Secret 工具只返回 key 名称，不返回 Secret 值。
- 写工具默认关闭；`allowWrite: true` 开启，`writeNamespaces` 作为 namespace 白名单，`writeKinds` 作为明确的 kind 白名单。
- 集群级、RBAC、`Secret`、`ServiceAccount` 写入默认拒绝；必须把精确 kind 加入 `writeKinds` 才能显式开启。
- `k8s_apply_manifest` 会在任何 API 请求前检查 namespace 和 kind，包括 Namespace、Node 等集群级 manifest。
- 列表 limit 钳制为 1-100（默认 20）；Pod 日志 tailLines 钳制为 1-500（默认 200），客户端还会应用 15 秒超时、递归脱敏，并按 `logMaxLines`/`logMaxBytes` 限制输出（默认 1000 行/128 KiB）。

## 开发

```sh
npm install
npm run typecheck   # 类型检查
npm test            # 单元测试（vitest）
npm run build       # 构建到 lib/
```

技术说明与决策见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 发布

1. 确认 `npm run typecheck`、`npm test`、`npm run build` 全部通过。
2. 执行 `npm publish --access public`。
3. 为 GitHub 仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic，便于生态发现。

## License

[MIT](LICENSE)
