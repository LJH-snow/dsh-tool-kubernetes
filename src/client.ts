import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  loadAllYaml,
  PatchStrategy,
  type KubernetesObject,
} from '@kubernetes/client-node'

export interface KubernetesClientOptions {
  /** Path to a kubeconfig file. Defaults to KUBECONFIG or ~/.kube/config. */
  kubeconfig?: string
  /** Kubeconfig context to select. Defaults to current-context. */
  context?: string
  /** Default namespace. Context namespace is used when omitted. */
  namespace?: string
  /** Enable write tools. Write tools stay disabled unless this is true. */
  allowWrite?: boolean
  /** Optional namespace allowlist for write tools. Empty means every namespace is allowed when allowWrite is true. */
  writeNamespaces?: string[]
  /** Test-only API injection. */
  objectApi?: KubernetesObjectApiLike
  /** Test-only Core v1 API injection for pod logs. */
  coreV1Api?: CoreV1ApiLike
  /** Test-only kubeconfig metadata injection. */
  contextNames?: string[]
  currentContext?: string
  clusterServer?: string
  clusterNamespace?: string
}

export interface KubernetesObjectRef {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
  }
}

export interface KubernetesObjectApiLike {
  list<T = KubernetesObject>(
    apiVersion: string,
    kind: string,
    namespace?: string,
    pretty?: string,
    exact?: boolean,
    exportt?: boolean,
    fieldSelector?: string,
    labelSelector?: string,
    limit?: number,
    continueToken?: string,
    options?: any,
  ): Promise<{ items: T[] }>
  read<T = KubernetesObject>(spec: KubernetesObjectRef): Promise<T>
  create<T = KubernetesObject>(
    spec: T,
    pretty?: string,
    dryRun?: string,
    fieldManager?: string,
    options?: any,
  ): Promise<T>
  patch<T = KubernetesObject>(
    spec: T,
    pretty?: string,
    dryRun?: string,
    fieldManager?: string,
    force?: boolean,
    patchStrategy?: string,
    options?: any,
  ): Promise<T>
  delete(
    spec: KubernetesObjectRef,
    pretty?: string,
    dryRun?: string,
    gracePeriodSeconds?: number,
    orphanDependents?: boolean,
    propagationPolicy?: string,
    body?: any,
    options?: any,
  ): Promise<any>
}

export interface PodLogOptions {
  container?: string
  tailLines?: number
  timestamps?: boolean
  previous?: boolean
}

export interface CoreV1ApiLike {
  readNamespacedPodLog(
    param: {
      name: string
      namespace: string
      container?: string
      tailLines?: number
      timestamps?: boolean
      previous?: boolean
    },
  ): Promise<string>
}

export interface ContextInfo {
  name: string
  cluster: string
  namespace?: string
}

export interface ClusterInfo {
  connected: boolean
  reason?: string
  currentContext?: string
  server?: string
  defaultNamespace?: string
  contexts?: ContextInfo[]
}

export interface ListRequest {
  apiVersion: string
  kind: string
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
  limit?: number
}

export interface ReadRequest {
  apiVersion: string
  kind: string
  namespace?: string
  name: string
}

export interface ManifestItem {
  name: string
  namespace?: string
  kind: string
  apiVersion: string
  action: 'created' | 'patched'
}

export interface ManifestApplyResult {
  ok: boolean
  reason?: string
  applied?: number
  items?: ManifestItem[]
}

export interface WriteResult {
  ok: boolean
  reason?: string
  name?: string
  namespace?: string
}

export class KubernetesError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'KubernetesError'
  }
}

const NAMESPACED_KINDS = new Set([
  'ConfigMap',
  'CronJob',
  'Deployment',
  'Ingress',
  'Job',
  'Pod',
  'ReplicaSet',
  'Secret',
  'Service',
  'ServiceAccount',
  'StatefulSet',
])

function isNamespacedKind(kind: string): boolean {
  return NAMESPACED_KINDS.has(kind)
}

function errorStatus(error: unknown): number | null {
  if (error instanceof ApiException) return error.code
  if (error instanceof KubernetesError) return error.status
  return null
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404
}

export class KubernetesClient {
  private readonly options: KubernetesClientOptions
  private kubeConfig: KubeConfig | null = null
  private objectApi: KubernetesObjectApiLike | null
  private coreV1Api: CoreV1ApiLike | null

  constructor(options: KubernetesClientOptions = {}) {
    this.options = options
    this.objectApi = options.objectApi ?? null
    this.coreV1Api = options.coreV1Api ?? null
  }

  hasConnection(): boolean {
    if (this.objectApi || this.coreV1Api) return true
    try {
      return Boolean(this.ensureConfig().getCurrentContext())
    } catch {
      return false
    }
  }

  getClusterInfo(): ClusterInfo {
    if (this.options.currentContext || this.options.contextNames) {
      const contexts = (this.options.contextNames ?? []).map(name => ({
        name,
        cluster: this.options.clusterServer ?? '',
        namespace: this.options.clusterNamespace,
      }))
      return {
        connected: true,
        currentContext: this.options.currentContext ?? this.options.contextNames?.[0],
        server: this.options.clusterServer,
        defaultNamespace: this.getDefaultNamespace(),
        contexts,
      }
    }
    try {
      const kubeConfig = this.ensureConfig()
      const cluster = kubeConfig.getCurrentCluster()
      return {
        connected: true,
        currentContext: kubeConfig.getCurrentContext(),
        server: cluster?.server,
        defaultNamespace: this.getDefaultNamespace(),
        contexts: kubeConfig.getContexts().map(context => ({
          name: context.name,
          cluster: context.cluster,
          namespace: context.namespace,
        })),
      }
    } catch (error) {
      return { connected: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  getDefaultNamespace(): string {
    return (
      this.options.namespace
      ?? this.options.clusterNamespace
      ?? this.contextNamespace()
      ?? 'default'
    )
  }

  resolveNamespace(explicit?: string): string {
    return explicit ?? this.getDefaultNamespace()
  }

  canWrite(namespace: string): boolean {
    if (!this.options.allowWrite) return false
    const allowed = this.options.writeNamespaces
    return !allowed || allowed.length === 0 || allowed.includes(namespace)
  }

  writeDisabledReason(namespace: string): string {
    if (!this.options.allowWrite) {
      return 'Kubernetes write tools are disabled. Set allowWrite: true in the plugin config to enable them.'
    }
    return `Write access is not allowed for namespace "${namespace}". Add it to writeNamespaces in the plugin config.`
  }

  async listResources<T = any>(request: ListRequest): Promise<{ items: T[] }> {
    const response = await this.api().list<T>(
      request.apiVersion,
      request.kind,
      request.namespace,
      undefined,
      undefined,
      undefined,
      request.fieldSelector,
      request.labelSelector,
      request.limit,
    )
    return { items: response.items ?? [] }
  }

  async readResource<T = any>(request: ReadRequest): Promise<T> {
    return this.api().read<T>({
      apiVersion: request.apiVersion,
      kind: request.kind,
      metadata: {
        name: request.name,
        namespace: request.namespace,
      },
    })
  }

  async readResourceOrNull<T = any>(request: ReadRequest): Promise<T | null> {
    try {
      return await this.readResource<T>(request)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async readPodLog(namespace: string, name: string, options: PodLogOptions = {}): Promise<string> {
    return this.coreApi().readNamespacedPodLog({
      name,
      namespace,
      container: options.container,
      tailLines: options.tailLines,
      timestamps: options.timestamps,
      previous: options.previous,
    })
  }

  async scaleResource(namespace: string, apiVersion: string, kind: string, name: string, replicas: number): Promise<WriteResult> {
    if (!this.canWrite(namespace)) return { ok: false, reason: this.writeDisabledReason(namespace) }
    try {
      const updated = await this.api().patch({
        apiVersion,
        kind,
        metadata: { namespace, name },
        spec: { replicas },
      })
      return { ok: true, name, namespace, reason: `Scaled ${kind.toLowerCase()} ${name} to ${replicas} replica(s).` }
    } catch (error) {
      return this.mapWriteError(error, name, namespace)
    }
  }

  async restartDeployment(namespace: string, name: string): Promise<WriteResult> {
    if (!this.canWrite(namespace)) return { ok: false, reason: this.writeDisabledReason(namespace) }
    try {
      await this.api().patch({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { namespace, name },
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
              },
            },
          },
        },
      })
      return { ok: true, name, namespace, reason: `Restarted deployment ${name}.` }
    } catch (error) {
      return this.mapWriteError(error, name, namespace)
    }
  }

  async updateDeploymentImage(
    namespace: string,
    name: string,
    container: string,
    image: string,
  ): Promise<WriteResult> {
    if (!this.canWrite(namespace)) return { ok: false, reason: this.writeDisabledReason(namespace) }
    try {
      await this.api().patch({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { namespace, name },
        spec: {
          template: {
            spec: {
              containers: [{ name: container, image }],
            },
          },
        },
      })
      return { ok: true, name, namespace, reason: `Updated deployment ${name} container ${container} to ${image}.` }
    } catch (error) {
      return this.mapWriteError(error, name, namespace)
    }
  }

  async rolloutStatusDeployment(namespace: string, name: string) {
    const deployment = await this.readResource<any>({ apiVersion: 'apps/v1', kind: 'Deployment', namespace, name })
    const status = deployment.status ?? {}
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const progressing = conditions.find((condition: any) => condition.type === 'Progressing')
    return {
      name,
      namespace,
      desiredReplicas: status.replicas ?? deployment.spec?.replicas ?? 0,
      updatedReplicas: status.updatedReplicas ?? 0,
      readyReplicas: status.readyReplicas ?? 0,
      availableReplicas: status.availableReplicas ?? 0,
      observedGeneration: status.observedGeneration ?? deployment.metadata?.generation ?? 0,
      currentRevision: deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '',
      ready: status.readyReplicas === status.replicas && progressing?.status === 'True',
      progressReason: progressing?.reason ?? 'NewReplicaSetAvailable',
    }
  }

  async rolloutUndoDeployment(namespace: string, name: string, revision?: number): Promise<WriteResult & { fromRevision?: string; toRevision?: string }> {
    if (!this.canWrite(namespace)) return { ok: false, reason: this.writeDisabledReason(namespace) }
    try {
      const deployment = await this.readResource<any>({ apiVersion: 'apps/v1', kind: 'Deployment', namespace, name })
      const currentRevision = Number(deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
      const ownerUid = deployment.metadata?.uid
      const replicaSets = await this.api().list<any>('apps/v1', 'ReplicaSet', namespace)
      const revisions = replicaSets.items
        .filter((item: any) => item.metadata?.ownerReferences?.some((owner: any) =>
          owner.kind === 'Deployment' && owner.name === name && (!ownerUid || owner.uid === ownerUid),
        ))
        .map((item: any) => ({
          revision: Number(item.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0),
          template: item.spec?.template,
        }))
        .filter((item: any) => item.revision > 0 && item.template)
        .sort((a: any, b: any) => a.revision - b.revision)

      const target = revision
        ? revisions.find((item: any) => item.revision === revision)
        : [...revisions].reverse().find((item: any) => item.revision < currentRevision)

      if (!target) {
        return {
          ok: false,
          name,
          namespace,
          reason: revision
            ? `Revision ${revision} was not found for deployment ${name}.`
            : `No previous revision found for deployment ${name}.`,
        }
      }

      const updated = await this.api().patch<any>({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { namespace, name },
        spec: { template: target.template },
      })
      const updatedRevision = updated.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? ''
      return {
        ok: true,
        name,
        namespace,
        reason: `Started rollback of deployment ${name} to revision ${target.revision}.`,
        fromRevision: currentRevision ? String(currentRevision) : undefined,
        toRevision: String(target.revision),
      }
    } catch (error) {
      return this.mapWriteError(error, name, namespace)
    }
  }

  async applyManifest(input: string, options: { dryRun?: boolean; force?: boolean; fieldManager?: string } = {}): Promise<ManifestApplyResult> {
    const specs = parseManifests(input)
    if (specs.length === 0) return { ok: false, reason: 'No Kubernetes manifests found in the input.' }

    for (const spec of specs) {
      this.applyDefaultNamespace(spec)
      const namespace = spec.metadata?.namespace ?? ''
      if (!this.canWrite(namespace)) {
        return { ok: false, reason: this.writeDisabledReason(namespace) }
      }
      if (!spec.kind || !spec.apiVersion || !spec.metadata?.name) {
        return { ok: false, reason: 'Every manifest must define apiVersion, kind, and metadata.name.' }
      }
    }

    const items: ManifestItem[] = []
    const dryRun = options.dryRun ? 'All' : undefined
    const fieldManager = options.fieldManager ?? 'dsh-tool-kubernetes'
    try {
      for (const spec of specs) {
        const ref: KubernetesObjectRef = {
          apiVersion: spec.apiVersion,
          kind: spec.kind,
          metadata: {
            name: spec.metadata!.name,
            namespace: spec.metadata?.namespace,
          },
        }
        try {
          await this.api().read(ref)
          await this.api().patch(
            spec,
            undefined,
            dryRun,
            fieldManager,
            options.force ?? false,
            PatchStrategy.StrategicMergePatch,
          )
          items.push({
            name: spec.metadata!.name!,
            namespace: spec.metadata?.namespace,
            kind: spec.kind!,
            apiVersion: spec.apiVersion!,
            action: 'patched',
          })
        } catch (error) {
          if (!isNotFound(error)) throw error
          await this.api().create(spec, undefined, dryRun, fieldManager)
          items.push({
            name: spec.metadata!.name!,
            namespace: spec.metadata?.namespace,
            kind: spec.kind!,
            apiVersion: spec.apiVersion!,
            action: 'created',
          })
        }
      }
      return { ok: true, applied: items.length, items }
    } catch (error) {
      return { ok: false, reason: this.mapError(error) }
    }
  }

  private applyDefaultNamespace(spec: KubernetesObject): void {
    if (!isNamespacedKind(spec.kind ?? '') || spec.metadata?.namespace) return
    spec.metadata = { ...(spec.metadata ?? {}), namespace: this.getDefaultNamespace() }
  }

  private mapWriteError(error: unknown, name: string, namespace: string): WriteResult {
    return { ok: false, name, namespace, reason: this.mapError(error) }
  }

  private mapError(error: unknown): string {
    if (error instanceof ApiException) {
      const body = error.body as { message?: string; reason?: string } | undefined
      return body?.message ?? body?.reason ?? `Kubernetes API request failed with status ${error.code}.`
    }
    if (error instanceof Error) return error.message
    return String(error)
  }

  private contextNamespace(): string | undefined {
    if (this.options.clusterNamespace) return this.options.clusterNamespace
    try {
      const kubeConfig = this.ensureConfig()
      const context = kubeConfig.getContextObject(kubeConfig.getCurrentContext())
      return context?.namespace
    } catch {
      return undefined
    }
  }

  private ensureConfig(): KubeConfig {
    if (this.kubeConfig) return this.kubeConfig
    const kubeConfig = new KubeConfig()
    if (this.options.kubeconfig) {
      kubeConfig.loadFromFile(this.options.kubeconfig)
    } else {
      kubeConfig.loadFromDefault()
    }
    if (this.options.context) kubeConfig.setCurrentContext(this.options.context)
    this.kubeConfig = kubeConfig
    return kubeConfig
  }

  private api(): KubernetesObjectApiLike {
    if (this.objectApi) return this.objectApi
    const kubeConfig = this.ensureConfig()
    this.objectApi = KubernetesObjectApi.makeApiClient(kubeConfig) as unknown as KubernetesObjectApiLike
    return this.objectApi
  }

  private coreApi(): CoreV1ApiLike {
    if (this.coreV1Api) return this.coreV1Api
    const kubeConfig = this.ensureConfig()
    this.coreV1Api = kubeConfig.makeApiClient(CoreV1Api) as unknown as CoreV1ApiLike
    return this.coreV1Api
  }
}

function parseManifests(input: string): KubernetesObject[] {
  return loadAllYaml(input, { json: true })
    .filter((value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    .map(value => value as unknown as KubernetesObject)
}
