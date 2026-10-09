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

  it('redacts pod log credentials and enforces line and byte limits in the client', async () => {
    const core = {
      readNamespacedPodLog: vi.fn(async () => [
        'token=top-secret password: hunter2',
        'Authorization: Bearer abc123',
        'secret: hidden',
        'a'.repeat(80),
      ].join('\n')),
    }
    const client = new KubernetesClient({
      coreV1Api: core,
      objectApi: objectApi(),
      logMaxLines: 2,
      logMaxBytes: 80,
    })

    const result = await client.readPodLog('team', 'api-0')

    expect(result).toContain('[REDACTED]')
    expect(result).not.toContain('top-secret')
    expect(result).not.toContain('hunter2')
    expect(result).not.toContain('abc123')
    expect(result).not.toContain('hidden')
    expect(result.split('\n').length).toBeLessThanOrEqual(2)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(80)
  })

  it('redacts extended credential fields and keeps UTF-8 byte limits exact', async () => {
    const core = {
      readNamespacedPodLog: vi.fn(async () => [
        'secureJsonData:',
        '  providerSpecificField: raw-log-secret',
        'secureJsonData: { providerSpecificField: inline-log-secret }',
        'secureJsonData: |-',
        '  scalar-log-secret',
        'httpHeaderValue1: header-secret',
        'tlsAuth: tls-secret',
        'password: "value with spaces"',
        'url=https://user:pass@example.test/path',
      ].join('\n')),
    }
    const client = new KubernetesClient({
      coreV1Api: core,
      objectApi: objectApi(),
      logMaxBytes: 1024,
    })

    const result = await client.readPodLog('team', 'api-0')

    expect(result).not.toMatch(/raw-log-secret|inline-log-secret|scalar-log-secret|header-secret|tls-secret|value with spaces|user:pass/)

    const unicodeClient = new KubernetesClient({
      coreV1Api: { readNamespacedPodLog: vi.fn(async () => '中文日志') },
      objectApi: objectApi(),
      logMaxBytes: 1,
    })
    const unicodeResult = await unicodeClient.readPodLog('team', 'api-0')
    expect(Buffer.byteLength(unicodeResult, 'utf8')).toBeLessThanOrEqual(1)
  })

  it('times out a pod log request in the client', async () => {
    const core = {
      readNamespacedPodLog: vi.fn(() => new Promise<string>(() => {})),
    }
    const client = new KubernetesClient({
      coreV1Api: core,
      objectApi: objectApi(),
      logTimeoutMs: 5,
    })

    await expect(client.readPodLog('team', 'api-0')).rejects.toThrow(/timed out/i)
  })

  it('rejects sensitive and cluster-scoped writes unless their kinds are explicitly allowed', async () => {
    const api = objectApi()
    const client = new KubernetesClient({ allowWrite: true, objectApi: api })

    expect(client.canWriteResource('team', 'Secret')).toBe(false)
    expect(client.canWriteResource('', 'Namespace')).toBe(false)
    expect(client.canWriteResource('team', 'Deployment')).toBe(true)
    expect((await client.applyManifest(`
apiVersion: v1
kind: Namespace
metadata:
  name: sandbox
`)).reason).toContain('cluster-scoped')

    const allowed = new KubernetesClient({
      allowWrite: true,
      writeKinds: ['Namespace'],
      objectApi: objectApi({ create: vi.fn(async spec => spec) }),
    })
    const result = await allowed.applyManifest(`
apiVersion: v1
kind: Namespace
metadata:
  name: sandbox
`)
    expect(result).toMatchObject({ ok: true, applied: 1 })
  })

  it('keeps namespaced RBAC manifests inside the namespace allowlist', async () => {
    const api = objectApi({
      create: vi.fn(async spec => spec),
    })
    const client = new KubernetesClient({
      allowWrite: true,
      writeNamespaces: ['team'],
      writeKinds: ['Role', 'RoleBinding'],
      namespace: 'team',
      objectApi: api,
    })

    expect(client.canWriteResource('other', 'Role')).toBe(false)
    expect(client.canWriteResource('team', 'Role')).toBe(true)
    expect(client.canWriteResource('other', 'RoleBinding')).toBe(false)

    const result = await client.applyManifest(`
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: reader
  namespace: other
rules: []
`)

    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toMatch(/namespace/i)
    expect(api.create).not.toHaveBeenCalled()
  })

  it('requires an explicit namespace for unknown kinds when a namespace allowlist is configured', async () => {
    const api = objectApi()
    const client = new KubernetesClient({
      allowWrite: true,
      writeNamespaces: ['team'],
      writeKinds: ['Widget'],
      namespace: 'team',
      objectApi: api,
    })

    expect(client.canWriteResource('', 'Widget')).toBe(false)
    expect(client.canWriteResource('team', 'Widget')).toBe(true)
    const result = await client.applyManifest('apiVersion: example.test/v1\nkind: Widget\nmetadata:\n  name: custom\n')

    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toMatch(/namespace/i)
    expect(api.create).not.toHaveBeenCalled()
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

  it('rejects cluster-scoped manifests by default even when write tools are enabled', async () => {
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
    expect(result).toMatchObject({ ok: false })
    expect(String(result.reason)).toContain('cluster-scoped')
    expect(api.create).not.toHaveBeenCalled()
  })
})
