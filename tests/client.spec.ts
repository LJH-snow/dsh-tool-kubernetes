import { describe, expect, it, vi } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { KubernetesClient, type KubernetesObjectApiLike } from '../src/client.ts'

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

describe('KubernetesClient', () => {
  it('resolves the namespace from plugin config before context defaults', () => {
    const client = new KubernetesClient({
      namespace: 'plugin',
      clusterNamespace: 'context',
      objectApi: objectApi(),
    })
    expect(client.getDefaultNamespace()).toBe('plugin')
    expect(client.resolveNamespace('explicit')).toBe('explicit')
    expect(client.resolveNamespace(undefined)).toBe('plugin')
  })

  it('reports injected config metadata without touching a local kubeconfig', () => {
    const client = new KubernetesClient({
      contextNames: ['prod', 'staging'],
      currentContext: 'staging',
      clusterServer: 'https://staging.example.com',
      clusterNamespace: 'workloads',
      objectApi: objectApi(),
    })
    expect(client.getClusterInfo()).toEqual({
      connected: true,
      currentContext: 'staging',
      server: 'https://staging.example.com',
      defaultNamespace: 'workloads',
      contexts: [
        { name: 'prod', cluster: 'https://staging.example.com', namespace: 'workloads' },
        { name: 'staging', cluster: 'https://staging.example.com', namespace: 'workloads' },
      ],
    })
  })

  it('applies the write allowlist and allowWrite gate', () => {
    const strict = new KubernetesClient({ allowWrite: true, writeNamespaces: ['platform'], objectApi: objectApi() })
    const loose = new KubernetesClient({ allowWrite: true, objectApi: objectApi() })
    expect(strict.canWrite('platform')).toBe(true)
    expect(strict.canWrite('team')).toBe(false)
    expect(loose.canWrite('team')).toBe(true)
    expect(new KubernetesClient({ objectApi: objectApi() }).canWrite('team')).toBe(false)
  })

  it('forwards label and field selectors to listResources', async () => {
    const api = objectApi({
      list: vi.fn(async () => ({ items: [{ metadata: { name: 'x' } }] })),
    })
    const client = new KubernetesClient({ objectApi: api })
    const result = await client.listResources({
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: 'team',
      labelSelector: 'app=api',
      fieldSelector: 'status.phase=Running',
      limit: 10,
    })
    expect(result.items).toHaveLength(1)
    expect(api.list).toHaveBeenCalledWith(
      'v1',
      'Pod',
      'team',
      undefined,
      undefined,
      undefined,
      'status.phase=Running',
      'app=api',
      10,
    )
  })

  it('returns null for a missing resource and throws for other API failures', async () => {
    const missing = new KubernetesClient({
      objectApi: objectApi({
        read: vi.fn(async () => {
          throw new ApiException(404, 'missing', {}, {})
        }),
      }),
    })
    expect(await missing.readResourceOrNull({ apiVersion: 'v1', kind: 'ConfigMap', namespace: 'team', name: 'nope' })).toBeNull()

    const forbidden = new KubernetesClient({
      objectApi: objectApi({
        read: vi.fn(async () => {
          throw new ApiException(403, 'forbidden', {}, {})
        }),
      }),
    })
    await expect(forbidden.readResourceOrNull({ apiVersion: 'v1', kind: 'Pod', namespace: 'team', name: 'x' })).rejects.toMatchObject({
      code: 403,
    })
  })

  it('forwards pod log options to the injected core API', async () => {
    const core = { readNamespacedPodLog: vi.fn(async () => 'log') }
    const client = new KubernetesClient({
      coreV1Api: core,
      objectApi: objectApi(),
    })
    expect(await client.readPodLog('team', 'api-0', {
      container: 'api',
      tailLines: 100,
      timestamps: true,
      previous: true,
    })).toBe('log')
    expect(core.readNamespacedPodLog).toHaveBeenCalledWith({
      name: 'api-0',
      namespace: 'team',
      container: 'api',
      tailLines: 100,
      timestamps: true,
      previous: true,
    })
  })

  it('adds the plugin default namespace to known namespaced manifest objects', async () => {
    const api = objectApi({
      read: vi.fn(async () => {
        throw new ApiException(404, 'missing', {}, {})
      }),
      create: vi.fn(async spec => spec),
    })
    const client = new KubernetesClient({ namespace: 'team', allowWrite: true, objectApi: api })
    const result = await client.applyManifest(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
`)
    expect(result).toMatchObject({ ok: true, applied: 1, items: [{ name: 'app-config', namespace: 'team', action: 'created' }] })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect((api.create as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      metadata: { name: 'app-config', namespace: 'team' },
    })
  })

  it('returns a business failure for invalid or empty manifests', async () => {
    const api = objectApi()
    const client = new KubernetesClient({ allowWrite: true, objectApi: api })
    expect(await client.applyManifest('# empty\n')).toMatchObject({ ok: false, reason: 'No Kubernetes manifests found in the input.' })
    expect(await client.applyManifest('kind: Pod\nmetadata:\n  name: test\n')).toMatchObject({ ok: false })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('blocks cluster-scoped manifests when write tools are disabled', async () => {
    const api = objectApi()
    const client = new KubernetesClient({ objectApi: api })
    const result = await client.applyManifest(`
apiVersion: v1
kind: Namespace
metadata:
  name: sandbox
`)
    expect(result).toMatchObject({ ok: false })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('allows cluster-scoped manifests when write tools are enabled without an allowlist', async () => {
    const api = objectApi({
      read: vi.fn(async () => {
        throw new ApiException(404, 'missing', {}, {})
      }),
      create: vi.fn(async spec => spec),
    })
    const client = new KubernetesClient({ allowWrite: true, objectApi: api })
    const result = await client.applyManifest(`
apiVersion: v1
kind: Namespace
metadata:
  name: sandbox
`)
    expect(result).toMatchObject({ ok: true, applied: 1, items: [{ name: 'sandbox', action: 'created' }] })
    expect(api.create).toHaveBeenCalledTimes(1)
  })
})
