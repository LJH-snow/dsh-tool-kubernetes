# dsh-tool-kubernetes 开发文档

## 1. 项目概览

| 项目 | 说明 |
|---|---|
| 项目名 | `dsh-tool-kubernetes` |
| 发布名 | `@libai168/dsh-tool-kubernetes` |
| 定位 | DeepSeek Harness（dsh）的独立 Kubernetes 工具插件 |
| 工具数 | 25（19 只读 + 6 写） |
| 架构 | `apply` + `createTools(client)`，通过 `ctx.tools.register(defineTool(...))` 注册 |
| 运行时依赖 | `@kubernetes/client-node` |

## 2. 技术要点

### 2.1 客户端

- `KubernetesClient` 使用官方 `KubeConfig` 加载 kubeconfig：优先 `pluginConfig.kubeconfig`，其次 `$KUBECONFIG` / `~/.kube/config`，最后尝试集群内 ServiceAccount。
- 配置层支持 `context`、默认 `namespace`、`allowWrite` 和 `writeNamespaces`。
- 普通资源读写通过 `KubernetesObjectApi` 动态生成 URI，因此后续扩展 CRD/Job/CronJob 不需要逐个增加生成式 API 客户端。
- Pod 日志通过 `CoreV1Api.readNamespacedPodLog` 获取，支持 container、tailLines、timestamps、previous。
- 测试通过注入 `objectApi` / `coreV1Api`，不依赖真实集群。

### 2.2 写操作安全

- `allowWrite` 默认关闭。
- `writeNamespaces` 非空时作为 namespace 白名单；`applyManifest` 会先校验每个 manifest 的目标 namespace 再写。
- `applyManifest` 同样校验集群级对象（如 Namespace、Node），避免 `allowWrite: false` 时通过集群级 manifest 绕过写门禁。
- `k8s_list_secrets` / `k8s_get_secret` 只返回 key 名称，不返回 Secret 值。
- `k8s_apply_manifest` 使用 create-or-patch：先 `read`，404 后 `create`，否则 `patch`，支持 `dryRun`。
- `k8s_rollout_undo_deployment` 读取 Deployment 的 ReplicaSet revision 列表，默认选择当前 revision 之前的最大 revision。

### 2.3 业务失败

- 未配置 kubeconfig/context：`{ connected: false, reason }`。
- 资源不存在：`{ found: false }`。
- 写权限不足或 API 失败：`{ ok: false, reason }`。
- 列表 limit 默认 20、上限 100；Pod 日志默认 200 行、上限 500 行。

## 3. 决策记录

| 时间 | 决策 | 说明 |
|---|---|---|
| 2026-08-27 | 选择 Kubernetes 作为新插件方向 | 补齐现有代码托管/数据库/监控/项目管理覆盖之外的部署与运行时运维空白 |
| 2026-08-27 | 首批只做 25 个高频工具 | 覆盖常用只读排查、Pod 日志、扩缩容、镜像更新、rollback 和 manifest apply；避免一上来做成 80+ 工具 |
| 2026-08-27 | 使用官方 `@kubernetes/client-node` | 正确处理 kubeconfig、集群内认证、TLS 和 context 选择，比手写 REST 客户端更可靠 |
| 2026-08-27 | 默认关闭写操作 | Kubernetes 写操作影响生产运行，必须显式开启并可选 namespace 白名单 |

## 4. 验证命令

```sh
npm install
npm run typecheck
npm test
npm run build
```

验收时确认：

- `npm run typecheck` 无错误。
- `npm test` 当前 21 例全绿，覆盖工具注册、无配置、读取映射、日志参数、写门禁、manifest apply 和 rollout undo。
- `npm run build` 输出 `lib/`，`exports.types` 指向生成的声明文件。
