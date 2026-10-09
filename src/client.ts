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
  /** Optional Kubernetes kind allowlist for write tools. Sensitive and cluster-scoped kinds require an explicit entry. */
  writeKinds?: string[]
  /** Maximum number of lines returned by readPodLog. */
  logMaxLines?: number
  /** Maximum UTF-8 bytes returned by readPodLog. */
  logMaxBytes?: number
  /** Timeout in milliseconds for a pod log API request. 0 disables the timeout. */
  logTimeoutMs?: number
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
  'ControllerRevision',
  'DaemonSet',
  'Deployment',
  'Endpoints',
  'EndpointSlice',
  'Event',
  'HorizontalPodAutoscaler',
  'Ingress',
  'Job',
  'Lease',
  'LimitRange',
  'NetworkPolicy',
  'Pod',
  'PodDisruptionBudget',
  'PodTemplate',
  'PersistentVolumeClaim',
  'ReplicaSet',
  'ReplicationController',
  'ResourceQuota',
  'Secret',
  'Service',
  'ServiceAccount',
  'StatefulSet',
  'Role',
  'RoleBinding',
])

const CLUSTER_SCOPED_KINDS = new Set([
  'APIService',
  'CSIDriver',
  'CSINode',
  'CertificateSigningRequest',
  'ClusterRole',
  'ClusterRoleBinding',
  'ComponentStatus',
  'CustomResourceDefinition',
  'FlowSchema',
  'MutatingWebhookConfiguration',
  'Namespace',
  'Node',
  'PersistentVolume',
  'PriorityClass',
  'PriorityLevelConfiguration',
  'RuntimeClass',
  'SelfSubjectAccessReview',
  'SelfSubjectRulesReview',
  'StorageClass',
  'StorageVersion',
  'SubjectAccessReview',
  'TokenReview',
  'ValidatingWebhookConfiguration',
  'VolumeAttachment',
])

const SENSITIVE_WRITE_KINDS = new Set([
  'ClusterRole',
  'ClusterRoleBinding',
  'Role',
  'RoleBinding',
  'Secret',
  'ServiceAccount',
])

const DEFAULT_LOG_MAX_LINES = 1_000
const DEFAULT_LOG_MAX_BYTES = 128 * 1024
const DEFAULT_LOG_TIMEOUT_MS = 15_000

function isNamespacedKind(kind: string): boolean {
  return NAMESPACED_KINDS.has(kind)
}

type ResourceScope = 'namespaced' | 'cluster' | 'unknown'

function resourceScope(namespace: string, kind: string): ResourceScope {
  if (isNamespacedKind(kind) || namespace.length > 0) return 'namespaced'
  if (CLUSTER_SCOPED_KINDS.has(kind)) return 'cluster'
  return 'unknown'
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

  canWriteResource(namespace: string, kind: string): boolean {
    if (!this.options.allowWrite) return false
    const scope = resourceScope(namespace, kind)
    if (scope === 'namespaced' && !this.canWrite(namespace)) return false
    if (scope === 'unknown' && Boolean(this.options.writeNamespaces?.length)) return false
    const allowedKinds = this.options.writeKinds
    if (allowedKinds && allowedKinds.length > 0) return allowedKinds.includes(kind)
    return scope === 'namespaced' && !SENSITIVE_WRITE_KINDS.has(kind)
  }

  writeDisabledReason(namespace: string, kind?: string): string {
    if (!this.options.allowWrite) {
      return 'Kubernetes write tools are disabled. Set allowWrite: true in the plugin config to enable them.'
    }
    const scope = kind ? resourceScope(namespace, kind) : 'namespaced'
    if (kind && scope === 'namespaced' && !this.canWrite(namespace)) {
      return 'Write access is not allowed for namespace "' + namespace + '". Add it to writeNamespaces in the plugin config.'
    }
    if (kind && scope === 'unknown' && this.options.writeNamespaces?.length) {
      return 'Namespace must be specified for unknown Kubernetes kind "' + kind + '" when writeNamespaces is configured.'
    }
    if (kind && (scope !== 'namespaced' || SENSITIVE_WRITE_KINDS.has(kind))) {
      return 'Writes for Kubernetes kind "' + kind + '" are disabled by default because it is ' + (scope === 'namespaced' ? 'sensitive' : scope === 'cluster' ? 'cluster-scoped' : 'unknown-scope') + '. Add "' + kind + '" to writeKinds in the plugin config to explicitly allow it.'
    }
    if (kind && this.options.writeKinds && this.options.writeKinds.length > 0 && !this.options.writeKinds.includes(kind)) {
      return 'Write access is not allowed for Kubernetes kind "' + kind + '". Add it to writeKinds in the plugin config.'
    }
    return 'Write access is not allowed for namespace "' + namespace + '". Add it to writeNamespaces in the plugin config.'
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
    const request = this.coreApi().readNamespacedPodLog({
      name,
      namespace,
      container: options.container,
      tailLines: options.tailLines,
      timestamps: options.timestamps,
      previous: options.previous,
    })
    const timeoutMs = normalizeTimeout(this.options.logTimeoutMs, DEFAULT_LOG_TIMEOUT_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    let logs: string
    try {
      logs = timeoutMs > 0
        ? await Promise.race([
          request,
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Kubernetes pod log request timed out after ' + timeoutMs + ' ms.')), timeoutMs)
          }),
        ])
        : await request
    } finally {
      if (timer) clearTimeout(timer)
    }
    const maxLines = normalizePositiveLimit(this.options.logMaxLines, DEFAULT_LOG_MAX_LINES)
    const maxBytes = normalizePositiveLimit(this.options.logMaxBytes, DEFAULT_LOG_MAX_BYTES)
    return limitLogOutput(redactLogText(logs), maxLines, maxBytes)
  }

  async scaleResource(namespace: string, apiVersion: string, kind: string, name: string, replicas: number): Promise<WriteResult> {
    if (!this.canWriteResource(namespace, kind)) return { ok: false, reason: this.writeDisabledReason(namespace, kind) }
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
    if (!this.canWriteResource(namespace, 'Deployment')) return { ok: false, reason: this.writeDisabledReason(namespace, 'Deployment') }
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
    if (!this.canWriteResource(namespace, 'Deployment')) return { ok: false, reason: this.writeDisabledReason(namespace, 'Deployment') }
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
    if (!this.canWriteResource(namespace, 'Deployment')) return { ok: false, reason: this.writeDisabledReason(namespace, 'Deployment') }
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
      if (!spec.kind || !spec.apiVersion || !spec.metadata?.name) {
        return { ok: false, reason: 'Every manifest must define apiVersion, kind, and metadata.name.' }
      }
      this.applyDefaultNamespace(spec)
      const namespace = spec.metadata?.namespace ?? ''
      if (!this.canWriteResource(namespace, spec.kind)) {
        return { ok: false, reason: this.writeDisabledReason(namespace, spec.kind) }
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

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(1, Math.floor(value))
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === 0) return 0
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(1, Math.floor(value))
}

function redactLogText(value: string): string {
  let text = value
  text = text.replace(/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
  const lines = text.split(/\r?\n/)
  let sensitiveBlockIndent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (sensitiveBlockIndent >= 0) {
      if (!line.trim()) continue
      if (indent > sensitiveBlockIndent) {
        lines[index] = line.slice(0, indent) + '[REDACTED]'
        continue
      }
      sensitiveBlockIndent = -1
    }
    const blockKey = line.match(/^(\s*)(?:-\s*)?["']?secure[_-]?json(?:data|fields)?["']?\s*:/i)
    if (!blockKey) continue
    const colon = line.indexOf(':')
    const valuePart = line.slice(colon + 1).trim()
    lines[index] = line.slice(0, colon + 1) + ' [REDACTED]'
    if (!valuePart || /^[|>]/.test(valuePart)) {
      sensitiveBlockIndent = blockKey[1].length
    } else if ((valuePart.startsWith('{') && !valuePart.includes('}')) || (valuePart.startsWith('[') && !valuePart.includes(']'))) {
      sensitiveBlockIndent = blockKey[1].length
    }
  }
  text = lines.join('\n')
  const keyValue = /((?:^|[,{\s])["']?(?:credential|password|passwd|secret|token|bearer(?:[_-]?token)?|api[_-]?key|access[_-]?key|client[_-]?(?:secret|certificate|cert|key)|private[_-]?(?:key|certificate|cert)|tls[_-]?(?:auth|certificate|cert|key)|http[_-]?header[_-]?value\d*|authorization|basic[_-]?auth)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]]+)/gi
  text = text.replace(keyValue, '$1[REDACTED]')
  text = text.replace(/([?&](?:credential|password|passwd|secret|token|bearer(?:[_-]?token)?|api[_-]?key|access[_-]?key|client[_-]?(?:secret|certificate|cert|key)|private[_-]?(?:key|certificate|cert)|tls[_-]?(?:auth|certificate|cert|key)|http[_-]?header[_-]?value\d*|authorization|basic[_-]?auth)=)[^&#\s]+/gi, '$1[REDACTED]')
  text = text.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]:[REDACTED]@')
  return text
}

function limitLogOutput(value: string, maxLines: number, maxBytes: number): string {
  const lines = value.split(/\r?\n/).slice(0, maxLines)
  const limited = lines.join('\n')
  if (Buffer.byteLength(limited, 'utf8') <= maxBytes) return limited
  let result = Buffer.from(limited, 'utf8').subarray(0, maxBytes).toString('utf8')
  while (result && Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1)
  return result
}
