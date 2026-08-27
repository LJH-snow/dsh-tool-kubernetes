# dsh-tool-kubernetes

[English](README.md) | [中文](README.zh.md)

A Cordis tool plugin that gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Kubernetes workflows: cluster/context inspection, namespace and workload discovery, pod logs, replica scaling, deployment rollouts, ConfigMaps, Secrets, Services, and manifest application.

The plugin registers 25 tools with the official `ctx.tools.register(defineTool(...))` contract. It uses the official Kubernetes JavaScript client for kubeconfig loading and API calls, keeps write operations disabled by default, and returns stable business values for missing configuration and missing resources.

## Install

Install directly from GitHub (no npm publish needed):

```sh
npm install github:LJH-snow/dsh-tool-kubernetes
# or a specific branch/tag
npm install github:LJH-snow/dsh-tool-kubernetes#main
```

Or from a local checkout:

```sh
git clone https://github.com/LJH-snow/dsh-tool-kubernetes
cd dsh-tool-kubernetes
npm install && npm run build   # builds to lib/
npm install /path/to/dsh-tool-kubernetes
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies, provided by the host dsh runtime.

## Configuration

Load the plugin in a dsh composition config (`cordis.yml`):

```yaml
- name: 'dsh-tool-kubernetes'
  config:
    # Optional kubeconfig path. Defaults to $KUBECONFIG or ~/.kube/config.
    # kubeconfig: '/Users/you/.kube/config'
    # Optional kubeconfig context. Defaults to current-context.
    # context: 'prod'
    # Optional default namespace. Context namespace is used when omitted.
    namespace: 'team'
    # Write tools are off unless this is true.
    allowWrite: true
    # Optional namespace allowlist. Empty means every namespace is allowed when allowWrite is true.
    writeNamespaces:
      - team
```

Full example: [examples/cordis.yml](examples/cordis.yml).

## Tools

### Read-only

| Tool | Description |
|---|---|
| `k8s_get_config` | Current context, kubeconfig contexts, API server, default namespace |
| `k8s_list_namespaces` | Namespace phase and creation time |
| `k8s_list_nodes` | Node readiness, roles, kubelet version, internal IP |
| `k8s_list_pods` | Pods with phase, ready containers, restarts, node, containers |
| `k8s_get_pod` | One pod with phase and container state |
| `k8s_read_pod_logs` | Tail pod logs with container/timestamps/previous options |
| `k8s_list_deployments` | Replica and rollout counts for all deployments in a namespace |
| `k8s_get_deployment` | One deployment with images and rollout counts |
| `k8s_rollout_status_deployment` | Progressing condition, revision, ready/updated/available replicas |
| `k8s_list_statefulsets` | StatefulSets with desired/ready replicas |
| `k8s_get_statefulset` | One StatefulSet with images and replica state |
| `k8s_list_services` | Service type, cluster IP, external IP, ports |
| `k8s_get_service` | One service with selectors and exposed ports |
| `k8s_list_ingresses` | Ingress hosts and load balancer address |
| `k8s_list_configmaps` | ConfigMap key names and creation time |
| `k8s_get_configmap` | One ConfigMap with key names |
| `k8s_list_secrets` | Secret names/types/key names only, never values |
| `k8s_get_secret` | One Secret with key names only |
| `k8s_list_events` | Recent events with source, involved object, reason, count |

### Write

| Tool | Description |
|---|---|
| `k8s_scale_deployment` | Scale a deployment |
| `k8s_scale_statefulset` | Scale a StatefulSet |
| `k8s_restart_deployment` | Add a restartedAt annotation to a deployment pod template |
| `k8s_update_deployment_image` | Update one container image in a deployment |
| `k8s_rollout_undo_deployment` | Roll a deployment back to a previous ReplicaSet revision |
| `k8s_apply_manifest` | Create or patch one or more YAML/JSON manifests |

## Behavior contract

- Kubernetes access comes from a kubeconfig path, `$KUBECONFIG`, `~/.kube/config`, or in-cluster service account files resolved by the official Kubernetes client.
- Missing configuration returns `{ connected: false, reason }` instead of throwing during normal tool calls.
- Missing resources return `{ found: false }`; write operations return `{ ok: false, reason }` for gating or API failures.
- Write tools are disabled unless `allowWrite: true`. When `writeNamespaces` is set, it acts as a namespace allowlist.
- `k8s_apply_manifest` applies the same write gate to every object, including cluster-scoped manifests such as Namespace or Node.
- `k8s_list_secrets` and `k8s_get_secret` intentionally return key names only; Secret values are not returned.
- List limits are clamped to 1-100 (default 20). Pod log tail lines are clamped to 1-500 (default 200).

## Development

```sh
npm install
npm run typecheck   # type check
npm test            # unit tests (vitest)
npm run build       # build to lib/
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for technical notes and decisions.

## Publishing

1. Ensure `npm run typecheck`, `npm test`, and `npm run build` all pass.
2. Publish with `npm publish --access public`.
3. Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to the GitHub repository for ecosystem discovery.

## License

[MIT](LICENSE)
