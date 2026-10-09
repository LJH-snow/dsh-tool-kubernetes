import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KubernetesClient } from './client.js'

export const name = 'dsh-tool-kubernetes'
export const inject = ['tools']

export interface KubernetesPluginConfig {
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
  /** Optional Kubernetes kind allowlist. Sensitive and cluster-scoped kinds require an explicit entry. */
  writeKinds?: string[]
  /** Maximum pod log lines returned by the client. */
  logMaxLines?: number
  /** Maximum pod log UTF-8 bytes returned by the client. */
  logMaxBytes?: number
  /** Pod log request timeout in milliseconds; 0 disables it. */
  logTimeoutMs?: number
}

export function apply(ctx: Context, config: KubernetesPluginConfig = {}) {
  const client = new KubernetesClient(config)
  for (const tool of createTools(client)) {
    ctx.tools.register(tool)
  }
}

/** Build the tool definitions for a client. Exported so tests can drive execute/render directly. */
export function createTools(client: KubernetesClient) {
  return [
    defineTool({
      name: 'k8s_get_config',
      description: 'Get the selected Kubernetes context, kubeconfig contexts, cluster server, and default namespace.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean', description: 'Whether a kubeconfig/context was configured' },
            reason: { type: 'string', description: 'Explanation when Kubernetes is not reachable' },
            currentContext: { type: 'string', description: 'Selected kubeconfig context' },
            server: { type: 'string', description: 'Kubernetes API server URL' },
            defaultNamespace: { type: 'string', description: 'Default namespace for namespaced tools' },
            contexts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', description: 'Context name' },
                  cluster: { type: 'string', description: 'Cluster name' },
                  namespace: { type: 'string', description: 'Context default namespace' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.connected) return [{ type: 'text', text: `Kubernetes is not configured: ${value.reason}` }]
          const lines = [
            `context: ${value.currentContext ?? 'unknown'}`,
            value.server ? `server: ${value.server}` : '',
            `default namespace: ${value.defaultNamespace ?? 'default'}`,
            `contexts: ${(value.contexts ?? []).map((item: any) => item.name).join(', ') || 'none'}`,
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(): ToolCallView {
        return { card: 'generic', title: 'Kubernetes config', kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const value = result as { connected?: boolean; currentContext?: string; defaultNamespace?: string }
        if (!value.connected) return { card: 'generic', title: 'Kubernetes not configured' }
        return { card: 'generic', title: value.currentContext ?? 'Kubernetes', content: [{ type: 'text', text: `namespace ${value.defaultNamespace ?? 'default'}` }] }
      },
      async execute() {
        return client.getClusterInfo()
      },
    }),

    defineListTool(client, {
      name: 'k8s_list_namespaces',
      description: 'List Kubernetes namespaces and their current phase.',
      apiVersion: 'v1',
      kind: 'Namespace',
      namespaced: false,
      itemLabel: 'create namespace',
      itemLabelPlural: 'namespace(s)',
      itemSchema: namespaceItemSchema(),
      mapItem: mapNamespace,
      renderItem: renderNamespace,
    }),

    defineListTool(client, {
      name: 'k8s_list_nodes',
      description: 'List Kubernetes nodes with scheduling status, roles, version, and internal address.',
      apiVersion: 'v1',
      kind: 'Node',
      namespaced: false,
      itemLabel: 'nodes',
      itemLabelPlural: 'node(s)',
      itemSchema: nodeItemSchema(),
      mapItem: mapNode,
      renderItem: renderNode,
    }),

    defineListTool(client, {
      name: 'k8s_list_pods',
      description: 'List pods in a namespace with phase, readiness, node, restart count, and containers.',
      apiVersion: 'v1',
      kind: 'Pod',
      namespaced: true,
      itemLabel: 'pods',
      itemLabelPlural: 'pod(s)',
      itemSchema: podItemSchema(),
      mapItem: mapPod,
      renderItem: renderPod,
    }),

    defineGetTool(client, {
      name: 'k8s_get_pod',
      description: 'Get one pod: phase, ready container count, node, restarts, and container images.',
      apiVersion: 'v1',
      kind: 'Pod',
      namespaced: true,
      itemSchema: podItemSchema(),
      mapItem: mapPod,
      renderItem: renderPod,
    }),

    defineTool({
      name: 'k8s_read_pod_logs',
      description: 'Read recent logs from a pod container. Useful for debugging crash loops, startup errors, and runtime failures.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Pod name' },
        container: { type: 'string', description: 'Container name; defaults to the only container when unspecified' },
        tailLines: { type: 'integer', description: 'Maximum lines to read from the end, 1-500 (default 200)' },
        timestamps: { type: 'boolean', description: 'Prefix each log line with a timestamp' },
        previous: { type: 'boolean', description: 'Read logs from the previous terminated container' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean', description: 'Whether Kubernetes is configured' },
            found: { type: 'boolean', description: 'Whether the pod could be read' },
            reason: { type: 'string', description: 'Explanation when logs are unavailable' },
            namespace: { type: 'string', description: 'Namespace' },
            name: { type: 'string', description: 'Pod name' },
            logs: { type: 'string', description: 'Pod log output' },
          },
        },
        render: (_args, value) => {
          if (!value.connected) return [{ type: 'text', text: `Kubernetes is not configured: ${value.reason}` }]
          if (!value.found) return [{ type: 'text', text: `Pod logs are not available: ${value.reason}` }]
          return [{ type: 'text', text: value.logs || '(no logs)' }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Logs for ${args.name}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const value = result as { connected?: boolean; found?: boolean; logs?: string }
        if (!value.connected || !value.found) return { card: 'generic', title: 'Pod logs unavailable' }
        return { card: 'generic', title: 'Pod logs', content: [{ type: 'text', text: (value.logs ?? '').slice(0, 2000) }] }
      },
      async execute(args) {
        if (!client.hasConnection()) return { connected: false, found: false, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        const tailLines = args.tailLines === undefined ? 200 : Math.max(1, Math.min(clampNumber(args.tailLines), 500))
        try {
          const logs = await client.readPodLog(namespace, args.name as string, {
            container: args.container,
            tailLines,
            timestamps: args.timestamps,
            previous: args.previous,
          })
          return { connected: true, found: true, namespace, name: args.name, logs }
        } catch (error) {
          return { connected: true, found: false, namespace, name: args.name, reason: errorMessage(error) }
        }
      },
    }),

    defineListTool(client, {
      name: 'k8s_list_deployments',
      description: 'List deployments in a namespace with desired, ready, updated, and available replica counts.',
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      namespaced: true,
      itemLabel: 'deployments',
      itemLabelPlural: 'deployment(s)',
      itemSchema: workloadItemSchema('Deployment'),
      mapItem: mapDeployment,
      renderItem: renderWorkload('deployment'),
    }),

    defineGetTool(client, {
      name: 'k8s_get_deployment',
      description: 'Get one deployment with rollout status, replica counts, images, and recent revision.',
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      namespaced: true,
      itemSchema: workloadItemSchema('Deployment'),
      mapItem: mapDeployment,
      renderItem: renderWorkload('deployment'),
    }),

    defineListTool(client, {
      name: 'k8s_list_statefulsets',
      description: 'List StatefulSets in a namespace with desired and ready replica counts.',
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      namespaced: true,
      itemLabel: 'statefulsets',
      itemLabelPlural: 'StatefulSet(s)',
      itemSchema: workloadItemSchema('StatefulSet'),
      mapItem: mapStatefulSet,
      renderItem: renderWorkload('StatefulSet'),
    }),

    defineGetTool(client, {
      name: 'k8s_get_statefulset',
      description: 'Get one StatefulSet with desired/ready replica counts and current images.',
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      namespaced: true,
      itemSchema: workloadItemSchema('StatefulSet'),
      mapItem: mapStatefulSet,
      renderItem: renderWorkload('StatefulSet'),
    }),

    defineListTool(client, {
      name: 'k8s_list_services',
      description: 'List services in a namespace with type, cluster IP, external IP, and ports.',
      apiVersion: 'v1',
      kind: 'Service',
      namespaced: true,
      itemLabel: 'services',
      itemLabelPlural: 'service(s)',
      itemSchema: serviceItemSchema(),
      mapItem: mapService,
      renderItem: renderService,
    }),

    defineGetTool(client, {
      name: 'k8s_get_service',
      description: 'Get one service with type, cluster IP, external IP, selectors, and exposed ports.',
      apiVersion: 'v1',
      kind: 'Service',
      namespaced: true,
      itemSchema: serviceItemSchema(),
      mapItem: mapService,
      renderItem: renderService,
    }),

    defineListTool(client, {
      name: 'k8s_list_ingresses',
      description: 'List ingresses in a namespace with hosts and load balancer address.',
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      namespaced: true,
      itemLabel: 'ingresses',
      itemLabelPlural: 'ingress(es)',
      itemSchema: ingressItemSchema(),
      mapItem: mapIngress,
      renderItem: renderIngress,
    }),

    defineListTool(client, {
      name: 'k8s_list_configmaps',
      description: 'List ConfigMaps in a namespace with key names and creation time.',
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespaced: true,
      itemLabel: 'configmaps',
      itemLabelPlural: 'ConfigMap(s)',
      itemSchema: configMapItemSchema(),
      mapItem: mapConfigMap,
      renderItem: renderConfigMap,
    }),

    defineGetTool(client, {
      name: 'k8s_get_configmap',
      description: 'Get one ConfigMap and its key/value pairs. Values are returned only when requested explicitly.',
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespaced: true,
      itemSchema: configMapItemSchema(),
      mapItem: mapConfigMap,
      renderItem: renderConfigMap,
    }),

    defineListTool(client, {
      name: 'k8s_list_secrets',
      description: 'List Secrets in a namespace without revealing their values.',
      apiVersion: 'v1',
      kind: 'Secret',
      namespaced: true,
      itemLabel: 'secrets',
      itemLabelPlural: 'secret(s)',
      itemSchema: secretItemSchema(),
      mapItem: mapSecret,
      renderItem: renderSecret,
    }),

    defineGetTool(client, {
      name: 'k8s_get_secret',
      description: 'Get one Secret and return its metadata and key names only; Secret values are never returned.',
      apiVersion: 'v1',
      kind: 'Secret',
      namespaced: true,
      itemSchema: secretItemSchema(),
      mapItem: mapSecret,
      renderItem: renderSecret,
    }),

    defineListTool(client, {
      name: 'k8s_list_events',
      description: 'List recent Kubernetes events in a namespace, optionally filtered by involved pod or workload.',
      apiVersion: 'v1',
      kind: 'Event',
      namespaced: true,
      itemLabel: 'events',
      itemLabelPlural: 'event(s)',
      itemSchema: eventItemSchema(),
      mapItem: mapEvent,
      renderItem: renderEvent,
      extraParameters: {
        involvedName: { type: 'string', description: 'Only return events involving this object name' },
        involvedKind: { type: 'string', description: 'Only return events involving this object kind, e.g. Pod or Deployment' },
      },
      filterItem: (item, args) => {
        const involved = item.metadata?.involvedObject ?? {}
        if (args.involvedName && involved.name !== args.involvedName) return false
        if (args.involvedKind && involved.kind !== args.involvedKind) return false
        return true
      },
    }),

    defineTool({
      name: 'k8s_scale_deployment',
      description: 'Scale a deployment to a target replica count. WRITE operation.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Deployment name' },
        replicas: { type: 'integer', required: true, description: 'Target replica count, 0-1000' },
      },
      output: writeOutputSchema('Scale deployment'),
      presentCall(args: any): ToolCallView {
        return { card: 'generic', title: `Scale deployment ${args.name}`, kind: 'edit' }
      },
      presentResult(_args: any, result: any): ToolResultView | undefined {
        return presentWriteResult(result, 'Scale deployment')
      },
      async execute(args: any) {
        if (!client.hasConnection()) return { ok: false, name: args.name, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        return client.scaleResource(namespace, 'apps/v1', 'Deployment', args.name as string, clampNumber(args.replicas, 0, 1000))
      },
    } as any),

    defineTool({
      name: 'k8s_scale_statefulset',
      description: 'Scale a StatefulSet to a target replica count. WRITE operation.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'StatefulSet name' },
        replicas: { type: 'integer', required: true, description: 'Target replica count, 0-1000' },
      },
      output: writeOutputSchema('Scale StatefulSet'),
      presentCall(args: any): ToolCallView {
        return { card: 'generic', title: `Scale StatefulSet ${args.name}`, kind: 'edit' }
      },
      presentResult(_args: any, result: any): ToolResultView | undefined {
        return presentWriteResult(result, 'Scale StatefulSet')
      },
      async execute(args: any) {
        if (!client.hasConnection()) return { ok: false, name: args.name, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        return client.scaleResource(namespace, 'apps/v1', 'StatefulSet', args.name as string, clampNumber(args.replicas, 0, 1000))
      },
    } as any),

    defineTool({
      name: 'k8s_restart_deployment',
      description: 'Restart a deployment by adding a restartedAt annotation to its pod template. WRITE operation.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Deployment name' },
      },
      output: writeOutputSchema('Restart deployment'),
      presentCall(args: any): ToolCallView {
        return { card: 'generic', title: `Restart deployment ${args.name}`, kind: 'edit' }
      },
      presentResult(_args: any, result: any): ToolResultView | undefined {
        return presentWriteResult(result, 'Restart deployment')
      },
      async execute(args: any) {
        if (!client.hasConnection()) return { ok: false, name: args.name, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        return client.restartDeployment(namespace, args.name as string)
      },
    } as any),

    defineTool({
      name: 'k8s_update_deployment_image',
      description: 'Update the image for one container in a deployment. WRITE operation.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Deployment name' },
        container: { type: 'string', required: true, description: 'Container name' },
        image: { type: 'string', required: true, description: 'New image reference, e.g. nginx:1.27.4' },
      },
      output: writeOutputSchema('Update deployment image'),
      presentCall(args: any): ToolCallView {
        return { card: 'generic', title: `Update ${args.name}/${args.container}`, kind: 'edit' }
      },
      presentResult(_args: any, result: any): ToolResultView | undefined {
        return presentWriteResult(result, 'Update deployment image')
      },
      async execute(args: any) {
        if (!client.hasConnection()) return { ok: false, name: args.name, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        return client.updateDeploymentImage(namespace, args.name as string, args.container as string, args.image as string)
      },
    } as any),

    defineTool({
      name: 'k8s_rollout_status_deployment',
      description: 'Read the rollout status of a deployment: observed revision, ready/updated replica counts, and Progressing condition.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Deployment name' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            namespace: { type: 'string' },
            name: { type: 'string' },
            desiredReplicas: { type: 'integer' },
            updatedReplicas: { type: 'integer' },
            readyReplicas: { type: 'integer' },
            availableReplicas: { type: 'integer' },
            observedGeneration: { type: 'integer' },
            currentRevision: { type: 'string' },
            ready: { type: 'boolean' },
            progressReason: { type: 'string', description: 'Progressing reason' },
          },
        },
        render: (_args, value) => {
          if (!value.connected) return [{ type: 'text', text: `Kubernetes is not configured: ${value.reason}` }]
          if (!value.found) return [{ type: 'text', text: `Deployment not found: ${value.reason}` }]
          const lines = [
            `${value.name} in ${value.namespace}`,
            `ready: ${value.ready ? 'yes' : 'no'}`,
            `replicas: ${value.readyReplicas}/${value.desiredReplicas} ready`,
            `updated: ${value.updatedReplicas}`,
            `available: ${value.availableReplicas}`,
            value.currentRevision ? `revision: ${value.currentRevision}` : '',
            `observed generation: ${value.observedGeneration}`,
            `reason: ${value.progressReason}`,
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Rollout status ${args.name}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const value = result as { connected?: boolean; found?: boolean; name?: string; ready?: boolean; readyReplicas?: number; desiredReplicas?: number }
        if (!value.connected || !value.found) return { card: 'generic', title: 'Rollout status unavailable' }
        return { card: 'generic', title: `${value.name} ${value.ready ? 'ready' : 'progressing'}`, content: [{ type: 'text', text: `${value.readyReplicas}/${value.desiredReplicas} ready` }] }
      },
      async execute(args) {
        if (!client.hasConnection()) return { connected: false, found: false, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        try {
          const status = await client.rolloutStatusDeployment(namespace, args.name as string)
          return { connected: true, found: true, ...status }
        } catch (error) {
          return { connected: true, found: false, namespace, name: args.name, reason: errorMessage(error) }
        }
      },
    }),

    defineTool({
      name: 'k8s_rollout_undo_deployment',
      description: 'Roll a deployment back to the previous ReplicaSet revision, or to an explicit revision. WRITE operation.',
      parameters: {
        namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' },
        name: { type: 'string', required: true, description: 'Deployment name' },
        revision: { type: 'integer', description: 'Target revision; defaults to the previous revision' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: 'Whether rollback was initiated' },
            name: { type: 'string' },
            namespace: { type: 'string' },
            reason: { type: 'string', description: 'Explanation when rollback could not be initiated' },
            fromRevision: { type: 'string', description: 'Previously active revision' },
            toRevision: { type: 'string', description: 'Target revision' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `Could not roll back deployment: ${value.reason}` }]
          return [{ type: 'text', text: `${value.reason} ${value.fromRevision ? `from ${value.fromRevision} ` : ''}to ${value.toRevision}.` }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Roll back ${args.name}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const value = result as { ok?: boolean; name?: string; toRevision?: string }
        if (!value.ok) return { card: 'generic', title: 'Rollback failed' }
        return { card: 'generic', title: `Rollback ${value.name}`, content: [{ type: 'text', text: `revision ${value.toRevision}` }] }
      },
      async execute(args) {
        if (!client.hasConnection()) return { ok: false, name: args.name, reason: noConnectionReason }
        const namespace = client.resolveNamespace(args.namespace)
        return client.rolloutUndoDeployment(namespace, args.name as string, args.revision === undefined ? undefined : clampNumber(args.revision, 1))
      },
    }),

    defineTool({
      name: 'k8s_apply_manifest',
      description: 'Apply one or more Kubernetes manifests (YAML or JSON) with create-or-patch semantics. WRITE operation.',
      parameters: {
        manifest: { type: 'string', required: true, description: 'YAML or JSON manifest(s). Multi-document YAML is supported.' },
        dryRun: { type: 'boolean', description: 'Validate and build requests without persisting changes' },
        force: { type: 'boolean', description: 'Pass through to the patch request' },
        fieldManager: { type: 'string', description: 'Field manager name for update operations (default dsh-tool-kubernetes)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            applied: { type: 'integer', description: 'Number of manifests applied' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  namespace: { type: 'string' },
                  kind: { type: 'string' },
                  apiVersion: { type: 'string' },
                  action: { type: 'string', enum: ['created', 'patched'] },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return [{ type: 'text', text: `Could not apply manifests: ${value.reason}` }]
          const lines = (value.items ?? []).map((item: any) =>
            `${item.action.toUpperCase()} ${item.kind} ${item.namespace ? `${item.namespace}/` : ''}${item.name}`,
          )
          return [{ type: 'text', text: lines.join('\n') || 'No manifests applied.' }]
        },
      },
      presentCall(): ToolCallView {
        return { card: 'generic', title: 'Apply Kubernetes manifests', kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const value = result as { ok?: boolean; applied?: number; reason?: string }
        if (!value.ok) return { card: 'generic', title: 'Apply failed', content: [{ type: 'text', text: value.reason ?? '' }] }
        return { card: 'generic', title: `${value.applied ?? 0} manifest(s) applied` }
      },
      async execute(args) {
        if (!client.hasConnection()) return { ok: false, reason: noConnectionReason }
        return client.applyManifest(args.manifest as string, {
          dryRun: args.dryRun,
          force: args.force,
          fieldManager: args.fieldManager,
        })
      },
    }),
  ]
}

const noConnectionReason = 'Kubernetes is not configured. Set kubeconfig or context in the plugin config.'

interface ListToolOptions {
  name: string
  description: string
  apiVersion: string
  kind: string
  namespaced: boolean
  itemLabel: string
  itemLabelPlural: string
  itemSchema: Record<string, any>
  mapItem: (item: any) => Record<string, any>
  renderItem: (item: any) => string
  extraParameters?: Record<string, any>
  filterItem?: (item: any, args: Record<string, any>) => boolean
}

function defineListTool(client: KubernetesClient, options: ListToolOptions) {
  const parameters: Record<string, any> = {
    labelSelector: { type: 'string', description: 'Kubernetes label selector, e.g. app=api' },
    fieldSelector: { type: 'string', description: 'Kubernetes field selector' },
    limit: { type: 'integer', description: 'Maximum results, 1-100 (default 20)' },
    ...(options.namespaced ? { namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' } } : {}),
    ...(options.extraParameters ?? {}),
  }
  const properties: Record<string, any> = {
    connected: { type: 'boolean', description: 'Whether Kubernetes is configured' },
    reason: { type: 'string', description: 'Explanation when Kubernetes is unavailable' },
    items: { type: 'array', items: options.itemSchema, description: options.itemLabel },
  }
  if (options.namespaced) properties.namespace = { type: 'string', description: 'Namespace' }

  return defineTool({
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties,
      },
      render: (_args: any, value: any) => {
        if (!value.connected) return [{ type: 'text', text: `Kubernetes is not configured: ${value.reason}` }]
        const items = value.items ?? []
        if (items.length === 0) return [{ type: 'text', text: `No ${options.itemLabel} found.` }]
        return [{ type: 'text', text: items.map(options.renderItem).join('\n') }]
      },
    },
    presentCall(args: any): ToolCallView {
      const namespace = options.namespaced && args.namespace ? ` in ${args.namespace}` : ''
      return { card: 'generic', title: `${titleCase(options.itemLabel)}${namespace}`, kind: 'search' }
    },
    presentResult(_args: any, result: any): ToolResultView | undefined {
      const value = result as { connected?: boolean; items?: any[] }
      if (!value.connected) return { card: 'generic', title: 'Kubernetes not configured' }
      const items = value.items ?? []
      if (items.length === 0) return { card: 'generic', title: `No ${options.itemLabel}` }
      return {
        card: 'generic',
        title: `${items.length} ${options.itemLabelPlural}`,
        content: [{ type: 'text', text: items.slice(0, 5).map(options.renderItem).join('\n') }],
      }
    },
    async execute(args: any) {
      if (!client.hasConnection()) return { connected: false, items: [], reason: noConnectionReason }
      const namespace = options.namespaced ? client.resolveNamespace(args.namespace) : undefined
      const limit = args.limit === undefined ? 20 : clampNumber(args.limit, 1, 100)
      const result = await client.listResources({
        apiVersion: options.apiVersion,
        kind: options.kind,
        namespace,
        labelSelector: args.labelSelector,
        fieldSelector: args.fieldSelector,
        limit,
      })
      const filtered = options.filterItem ? result.items.filter(item => options.filterItem!(item, args)) : result.items
      return {
        connected: true,
        namespace,
        items: filtered.map(options.mapItem),
      }
    },
  } as any)
}

interface GetToolOptions {
  name: string
  description: string
  apiVersion: string
  kind: string
  namespaced: boolean
  itemSchema: Record<string, any>
  mapItem: (item: any) => Record<string, any>
  renderItem: (item: any) => string
}

function defineGetTool(client: KubernetesClient, options: GetToolOptions) {
  const properties: Record<string, any> = {
    connected: { type: 'boolean' },
    found: { type: 'boolean' },
    reason: { type: 'string' },
    ...(options.namespaced ? { namespace: { type: 'string' } } : {}),
    ...options.itemSchema.properties,
  }
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: {
      ...(options.namespaced ? { namespace: { type: 'string', description: 'Namespace; defaults to plugin config or context namespace' } } : {}),
      name: { type: 'string', required: true, description: `${options.kind} name` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties,
      },
      render: (_args: any, value: any) => {
        if (!value.connected) return [{ type: 'text', text: `Kubernetes is not configured: ${value.reason}` }]
        if (!value.found) return [{ type: 'text', text: `${options.kind} not found.` }]
        return [{ type: 'text', text: options.renderItem(value) }]
      },
    },
    presentCall(args: any): ToolCallView {
      return { card: 'generic', title: `${options.kind} ${args.name}`, kind: 'read' }
    },
    presentResult(_args: any, result: any): ToolResultView | undefined {
      const value = result as { connected?: boolean; found?: boolean; name?: string }
      if (!value.connected) return { card: 'generic', title: 'Kubernetes not configured' }
      if (!value.found) return { card: 'generic', title: `${options.kind} not found` }
      return { card: 'generic', title: `${options.kind} ${value.name}` }
    },
    async execute(args: any) {
      if (!client.hasConnection()) return { connected: false, found: false, reason: noConnectionReason }
      const namespace = options.namespaced ? client.resolveNamespace(args.namespace) : undefined
      try {
        const item = await client.readResourceOrNull({
          apiVersion: options.apiVersion,
          kind: options.kind,
          namespace,
          name: args.name as string,
        })
        if (!item) return { connected: true, found: false, namespace, reason: `${options.kind} ${args.name} was not found.` }
        return { connected: true, found: true, namespace, ...options.mapItem(item) }
      } catch (error) {
        return { connected: true, found: false, namespace, reason: errorMessage(error) }
      }
    },
  } as any)
}

function writeOutputSchema(title: string): any {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: `Whether the ${title.toLowerCase()} succeeded` },
        name: { type: 'string', description: 'Resource name' },
        namespace: { type: 'string', description: 'Namespace' },
        reason: { type: 'string', description: 'Human-readable result or failure reason' },
      },
    },
    render: (_args: any, value: any) => {
      if (!value.ok) return [{ type: 'text', text: `Could not ${title.toLowerCase()}: ${value.reason}` }]
      return [{ type: 'text', text: `${value.reason}` }]
    },
  }
}

function presentWriteResult(result: unknown, title: string): ToolResultView | undefined {
  const value = result as { ok?: boolean; name?: string; reason?: string }
  if (!value.ok) return { card: 'generic', title: `${title} failed`, content: [{ type: 'text', text: value.reason ?? '' }] }
  return { card: 'generic', title: `${title}: ${value.name}`, content: [{ type: 'text', text: value.reason ?? '' }] }
}

function clampNumber(value: unknown, min = 1, max = 1000): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.max(min, Math.min(number, max))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, character => character.toUpperCase())
}

function namespaceItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      status: { type: 'string' },
      createdAt: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
  }
}

function mapNamespace(item: any) {
  return {
    name: item.metadata?.name ?? '',
    status: item.status?.phase ?? '',
    createdAt: item.metadata?.creationTimestamp ?? '',
    labels: Object.keys(item.metadata?.labels ?? {}),
  }
}

function renderNamespace(item: any) {
  return `${item.name} (${item.status || 'active'}) ${item.createdAt ?? ''}`.trim()
}

function nodeItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      status: { type: 'string' },
      roles: { type: 'array', items: { type: 'string' } },
      version: { type: 'string' },
      internalIp: { type: 'string' },
      createdAt: { type: 'string' },
    },
  }
}

function mapNode(item: any) {
  const ready = (item.status?.conditions ?? []).find((condition: any) => condition.type === 'Ready')
  return {
    name: item.metadata?.name ?? '',
    status: ready?.status ?? '',
    roles: Object.keys(item.metadata?.labels ?? {}).filter(key => key.startsWith('node-role.kubernetes.io/')).map(key => key.split('/').pop()),
    version: item.status?.nodeInfo?.kubeletVersion ?? '',
    internalIp: (item.status?.addresses ?? []).find((address: any) => address.type === 'InternalIP')?.address ?? '',
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderNode(item: any) {
  const roles = item.roles?.length ? `[${item.roles.join(',')}]` : ''
  return `${item.name} ${item.status || 'Unknown'} ${roles} ${item.version} ${item.internalIp}`.trim()
}

function podItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      nodeName: { type: 'string' },
      phase: { type: 'string' },
      ready: { type: 'string', description: 'Ready/pod container count' },
      restarts: { type: 'integer' },
      createdAt: { type: 'string' },
      containers: { type: 'array', items: { type: 'string' } },
      labels: { type: 'array', items: { type: 'string' } },
    },
  }
}

function mapPod(item: any) {
  const statuses = item.status?.containerStatuses ?? []
  const ready = statuses.filter((status: any) => status.ready).length
  const restarts = statuses.reduce((total: number, status: any) => total + (status.restartCount ?? 0), 0)
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    nodeName: item.spec?.nodeName ?? '',
    phase: item.status?.phase ?? '',
    ready: `${ready}/${item.spec?.containers?.length ?? statuses.length}`,
    restarts,
    createdAt: item.metadata?.creationTimestamp ?? '',
    containers: (item.spec?.containers ?? []).map((container: any) => container.name),
    labels: Object.keys(item.metadata?.labels ?? {}),
  }
}

function renderPod(item: any) {
  const containers = item.containers?.length ? ` [${item.containers.join(',')}]` : ''
  return `${item.name} (${item.phase}) ready ${item.ready} restarts ${item.restarts} node ${item.nodeName ?? ''}${containers}`.trim()
}

function workloadItemSchema(kind: string) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      replicas: { type: 'integer' },
      readyReplicas: { type: 'integer' },
      updatedReplicas: { type: 'integer' },
      availableReplicas: { type: 'integer' },
      ready: { type: 'boolean' },
      images: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string' },
    },
  }
}

function mapDeployment(item: any) {
  const status = item.status ?? {}
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    replicas: status.replicas ?? item.spec?.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    ready: status.readyReplicas === status.replicas && status.replicas !== undefined,
    images: containerImages(item),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function mapStatefulSet(item: any) {
  const status = item.status ?? {}
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    replicas: status.replicas ?? item.spec?.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    ready: status.readyReplicas === status.replicas && status.replicas !== undefined,
    images: containerImages(item),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderWorkload(kind: string) {
  return (item: any) =>
    `${item.name} ${item.readyReplicas}/${item.replicas} ready${item.images?.length ? ` [${item.images.join(',')}]` : ''}`.trim()
}

function containerImages(item: any) {
  return (item.spec?.template?.spec?.containers ?? []).map((container: any) => container.image ?? '')
}

function serviceItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      type: { type: 'string' },
      clusterIp: { type: 'string' },
      externalIp: { type: 'string' },
      ports: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string' },
    },
  }
}

function mapService(item: any) {
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    type: item.spec?.type ?? '',
    clusterIp: item.spec?.clusterIP ?? '',
    externalIp: item.status?.loadBalancer?.ingress?.[0]?.ip ?? item.spec?.externalIPs?.[0] ?? '',
    ports: (item.spec?.ports ?? []).map((port: any) =>
      `${port.port}/${port.protocol ?? 'TCP'}${port.nodePort ? `:${port.nodePort}` : ''}`,
    ),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderService(item: any) {
  const ports = item.ports?.length ? ` [${item.ports.join(',')}]` : ''
  return `${item.name} (${item.type || 'ClusterIP'}) ${item.clusterIp} ${item.externalIp ?? ''}${ports}`.trim()
}

function ingressItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      hosts: { type: 'array', items: { type: 'string' } },
      loadBalancer: { type: 'string' },
      createdAt: { type: 'string' },
    },
  }
}

function mapIngress(item: any) {
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    hosts: (item.spec?.rules ?? []).map((rule: any) => rule.host ?? '').filter(Boolean),
    loadBalancer: (item.status?.loadBalancer?.ingress ?? []).map((ingress: any) => ingress.ip ?? ingress.hostname ?? '').join(', '),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderIngress(item: any) {
  const hosts = item.hosts?.length ? ` [${item.hosts.join(',')}]` : ''
  return `${item.name}${hosts} ${item.loadBalancer ?? ''}`.trim()
}

function configMapItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string' },
    },
  }
}

function mapConfigMap(item: any) {
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    keys: Object.keys(item.data ?? item.binaryData ?? {}),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderConfigMap(item: any) {
  return `${item.name} (${(item.keys ?? []).length} keys) ${item.createdAt ?? ''}`.trim()
}

function secretItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      type: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string' },
    },
  }
}

function mapSecret(item: any) {
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    type: item.type ?? '',
    keys: Object.keys(item.data ?? item.stringData ?? {}),
    createdAt: item.metadata?.creationTimestamp ?? '',
  }
}

function renderSecret(item: any) {
  return `${item.name} (${item.type || 'Opaque'}, ${(item.keys ?? []).length} keys) ${item.createdAt ?? ''}`.trim()
}

function eventItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      namespace: { type: 'string' },
      type: { type: 'string' },
      reason: { type: 'string' },
      message: { type: 'string' },
      source: { type: 'string' },
      involvedObject: { type: 'string' },
      count: { type: 'integer' },
      firstTimestamp: { type: 'string' },
      lastTimestamp: { type: 'string' },
    },
  }
}

function mapEvent(item: any) {
  const involved = item.involvedObject ?? item.metadata?.involvedObject ?? {}
  return {
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    type: item.type ?? '',
    reason: item.reason ?? '',
    message: item.message ?? '',
    source: item.source?.component ?? item.reportingComponent ?? '',
    involvedObject: `${involved.kind ?? ''}/${involved.name ?? ''}`.replace(/^\//, ''),
    count: item.count ?? 0,
    firstTimestamp: item.firstTimestamp ?? item.eventTime ?? '',
    lastTimestamp: item.lastTimestamp ?? '',
  }
}

function renderEvent(item: any) {
  return `${item.lastTimestamp ?? ''} [${item.type || 'Normal'}] ${item.reason} ${item.message} (${item.involvedObject || 'unknown'}, ${item.count})`.trim()
}
