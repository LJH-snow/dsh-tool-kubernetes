import { describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { KubernetesClient, type KubernetesObjectApiLike } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function objectApi(overrides: Partial<KubernetesObjectApiLike> = {}): KubernetesObjectApiLike {
  return {
    list: vi.fn(async () => ({ items: [] })),
    read: vi.fn(async () => {
      throw new ApiException(404, 'not found', {}, {})
    }),
    create: vi.fn(async spec => spec),
    patch: vi.fn(async spec => spec),
    delete: vi.fn(async () => ({ status: 'Success' })),
    ...overrides,
  } as KubernetesObjectApiLike
}

function client(options: {
  objectApi?: KubernetesObjectApiLike
  coreV1Api?: { readNamespacedPodLog: (param: any) => Promise<string> }
  allowWrite?: boolean
  writeNamespaces?: string[]
  namespace?: string
} = {}): KubernetesClient {
  return new KubernetesClient({
    contextNames: ['prod'],
    currentContext: 'prod',
    clusterServer: 'https://k8s.example.com',
    clusterNamespace: 'team',
    namespace: options.namespace,
    allowWrite: options.allowWrite,
    writeNamespaces: options.writeNamespaces,
    objectApi: options.objectApi ?? objectApi(),
    coreV1Api: options.coreV1Api ?? { readNamespacedPodLog: vi.fn(async () => 'line 1\nline 2\n') },
  })
}

function tools(kube: KubernetesClient) {
  return Object.fromEntries(createTools(kube).map(tool => [tool.name, tool]))
}

describe('tool definitions', () => {
  it('registers the planned Kubernetes tool set', () => {
    expect(Object.keys(tools(client())).sort()).toEqual([
      'k8s_apply_manifest',
      'k8s_get_config',
      'k8s_get_configmap',
      'k8s_get_deployment',
      'k8s_get_pod',
      'k8s_get_secret',
      'k8s_get_service',
      'k8s_get_statefulset',
      'k8s_list_configmaps',
      'k8s_list_deployments',
      'k8s_list_events',
      'k8s_list_ingresses',
      'k8s_list_namespaces',
      'k8s_list_nodes',
      'k8s_list_pods',
      'k8s_list_secrets',
      'k8s_list_services',
      'k8s_list_statefulsets',
      'k8s_read_pod_logs',
      'k8s_restart_deployment',
      'k8s_rollout_status_deployment',
      'k8s_rollout_undo_deployment',
      'k8s_scale_deployment',
      'k8s_scale_statefulset',
      'k8s_update_deployment_image',
    ])
  })

  it('returns a business value when Kubernetes is not configured', async () => {
    const missing = new KubernetesClient({ kubeconfig: '/no/such/kubeconfig', context: 'missing' })
    const map = tools(missing)
    const result = await map.k8s_list_pods.execute({})
    expect(result).toMatchObject({ connected: false, items: [] })
  })

  it('returns config details and a default namespace', async () => {
    const result = await tools(client()).k8s_get_config.execute({})
    expect(result).toMatchObject({
      connected: true,
      currentContext: 'prod',
      server: 'https://k8s.example.com',
      defaultNamespace: 'team',
      contexts: [{ name: 'prod' }],
    })
  })
})

describe('read tools', () => {
  it('lists pods with filters and maps pod fields', async () => {
    const api = objectApi({
      list: vi.fn(async () => ({
        items: [{
          metadata: { name: 'api-0', namespace: 'team', creationTimestamp: '2026-01-01T00:00:00Z', labels: { app: 'api' } },
          spec: { nodeName: 'node-1', containers: [{ name: 'api' }] },
          status: {
            phase: 'Running',
            containerStatuses: [{ ready: true, restartCount: 2 }],
          },
        }],
      })),
    })
    const map = tools(client({ objectApi: api }))
    const result = await map.k8s_list_pods.execute({ namespace: 'team', labelSelector: 'app=api', limit: 999 })

    expect(result).toMatchObject({
      connected: true,
      namespace: 'team',
      items: [{ name: 'api-0', phase: 'Running', ready: '1/1', restarts: 2, nodeName: 'node-1' }],
    })
    const list = api.list as ReturnType<typeof vi.fn>
    expect(list).toHaveBeenCalledWith(
      'v1',
      'Pod',
      'team',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=api',
      100,
    )
  })

  it('gets a configmap with key names', async () => {
    const api = objectApi({
      read: vi.fn(async () => ({
        metadata: { name: 'app-config', namespace: 'team', creationTimestamp: '2026-01-01T00:00:00Z' },
        data: { DATABASE_URL: '...', LOG_LEVEL: 'info' },
      })),
    })
    const result = await tools(client({ objectApi: api })).k8s_get_configmap.execute({ name: 'app-config' })
    expect(result).toMatchObject({ connected: true, found: true, name: 'app-config', keys: ['DATABASE_URL', 'LOG_LEVEL'] })
  })

  it('reads pod logs with tail lines and previous flags', async () => {
    const core = { readNamespacedPodLog: vi.fn(async () => 'previous log') }
    const map = tools(client({ coreV1Api: core }))
    const result = await map.k8s_read_pod_logs.execute({
      namespace: 'team',
      name: 'api-0',
      container: 'api',
      tailLines: 50,
      previous: true,
    })
    expect(result).toMatchObject({ connected: true, found: true, logs: 'previous log' })
    expect(core.readNamespacedPodLog).toHaveBeenCalledWith({
      name: 'api-0',
      namespace: 'team',
      container: 'api',
      tailLines: 50,
      timestamps: undefined,
      previous: true,
    })
  })

  it('returns deployment rollout status', async () => {
    const api = objectApi({
      read: vi.fn(async () => ({
        metadata: {
          name: 'api',
          namespace: 'team',
          generation: 4,
          annotations: { 'deployment.kubernetes.io/revision': '3' },
        },
        spec: { replicas: 5 },
        status: {
          replicas: 5,
          readyReplicas: 5,
          updatedReplicas: 5,
          availableReplicas: 5,
          observedGeneration: 4,
          conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }],
        },
      })),
    })
    const result = await tools(client({ objectApi: api })).k8s_rollout_status_deployment.execute({ name: 'api' })
    expect(result).toMatchObject({
      connected: true,
      found: true,
      ready: true,
      readyReplicas: 5,
      currentRevision: '3',
      progressReason: 'NewReplicaSetAvailable',
    })
  })
})

describe('write tools', () => {
  it('keeps write tools disabled unless allowWrite is true', async () => {
    const api = objectApi({ patch: vi.fn() })
    const map = tools(client({ objectApi: api, allowWrite: false }))
    const result = await map.k8s_scale_deployment.execute({ name: 'api', replicas: 3 })
    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toContain('allowWrite')
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('enforces the write namespace allowlist', async () => {
    const map = tools(client({ objectApi: objectApi(), allowWrite: true, writeNamespaces: ['platform'] }))
    const result = await map.k8s_restart_deployment.execute({ namespace: 'team', name: 'api' })
    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toContain('team')
  })

  it('scales a deployment in an allowed namespace', async () => {
    const api = objectApi()
    const result = await tools(client({ objectApi: api, allowWrite: true, writeNamespaces: ['team'] }))
      .k8s_scale_deployment.execute({ name: 'api', replicas: 4 })
    expect(result).toMatchObject({ ok: true, name: 'api', namespace: 'team' })
    expect(api.patch).toHaveBeenCalledWith({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace: 'team', name: 'api' },
      spec: { replicas: 4 },
    })
  })

  it('applies a new manifest by reading and creating', async () => {
    const read = vi.fn(async () => {
      throw new ApiException(404, 'not found', {}, {})
    })
    const api = objectApi({ read, create: vi.fn(async spec => spec) })
    const result = await tools(client({ objectApi: api, allowWrite: true, writeNamespaces: ['team'] }))
      .k8s_apply_manifest.execute({
        manifest: `
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
  namespace: team
data:
  LOG_LEVEL: info
`,
      })
    expect(result).toMatchObject({ ok: true, applied: 1, items: [{ name: 'api-config', action: 'created' }] })
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it('applies a multi-document manifest and records patched items', async () => {
    const read = vi.fn(async () => ({ metadata: { name: 'api' } }))
    const api = objectApi({ read, patch: vi.fn(async spec => spec) })
    const result = await tools(client({ objectApi: api, allowWrite: true })).k8s_apply_manifest.execute({
      manifest: `
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared
  namespace: team
data:
  A: "1"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: team
spec:
  replicas: 2
`,
    })
    expect(result).toMatchObject({
      ok: true,
      applied: 2,
      items: [
        { name: 'shared', action: 'patched' },
        { name: 'api', action: 'patched' },
      ],
    })
  })

  it('rolls a deployment back to the previous revision', async () => {
    const reads = vi.fn(async (spec: any) => {
      if (spec.kind === 'Deployment') {
        return {
          metadata: {
            name: 'api',
            namespace: 'team',
            uid: 'deploy-1',
            annotations: { 'deployment.kubernetes.io/revision': '3' },
          },
          spec: {},
        }
      }
      throw new ApiException(404, 'unexpected', {}, {})
    })
    const api = objectApi({
      read: reads,
      list: vi.fn(async () => ({
        items: [
          {
            metadata: {
              ownerReferences: [{ kind: 'Deployment', name: 'api', uid: 'deploy-1' }],
              annotations: { 'deployment.kubernetes.io/revision': '2' },
            },
            spec: { template: { spec: { containers: [{ name: 'api', image: 'nginx:1.26' }] } } },
          },
          {
            metadata: {
              ownerReferences: [{ kind: 'Deployment', name: 'api', uid: 'deploy-1' }],
              annotations: { 'deployment.kubernetes.io/revision': '3' },
            },
            spec: { template: { spec: { containers: [{ name: 'api', image: 'nginx:1.27' }] } } },
          },
        ],
      })),
    })
    const result = await tools(client({ objectApi: api, allowWrite: true, writeNamespaces: ['team'] }))
      .k8s_rollout_undo_deployment.execute({ name: 'api' })
    expect(result).toMatchObject({ ok: true, fromRevision: '3', toRevision: '2' })
    expect(api.patch).toHaveBeenCalledWith({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { namespace: 'team', name: 'api' },
      spec: { template: { spec: { containers: [{ name: 'api', image: 'nginx:1.26' }] } } },
    })
  })
})
