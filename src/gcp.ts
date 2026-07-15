/**
 * @absolutejs/deploy/gcp — normalized Compute Engine fleet adapter.
 *
 * Machine image, disks, network, startup policy, and service account stay in
 * an immutable instance template. This adapter owns provider inventory and
 * lifecycle only; deployment and host-agent orchestration compose above it.
 */
import { GoogleAuth } from "google-auth-library";
import type {
  InfrastructureNode,
  InfrastructureNodeState,
  InfrastructureProvider,
} from "./infrastructure";

const COMPUTE_BASE_URL = "https://compute.googleapis.com/compute/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_AGENT_AUDIENCE_METADATA_KEY = "absolutejs-agent-audience";
const DEFAULT_AGENT_URL_METADATA_KEY = "absolutejs-agent-url";
const DEFAULT_NODE_PREFIX = "absolutejs-node";
const NODE_NAME_SUFFIX_LENGTH = 8;
const NODE_NAME_MATCH = /^gcp:([a-z0-9-]+):([a-z]([-a-z0-9]*[a-z0-9])?)$/;

export type GcpComputeRequest = <T>(options: {
  data?: unknown;
  method?: string;
  url: string;
}) => Promise<{ data: T }>;

export type GcpIdentityTokenRequest = (
  audience: string,
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
) => Promise<Response>;

export type GcpIdentityAuth = {
  getIdTokenClient: (audience: string) => Promise<{
    getRequestHeaders: (url: string) => Promise<Headers>;
  }>;
};

export const createGcpIdentityTokenRequest = (
  dependencies: {
    auth?: GcpIdentityAuth;
    fetch?: typeof fetch;
  } = {},
): GcpIdentityTokenRequest => {
  const auth: GcpIdentityAuth = dependencies.auth ?? new GoogleAuth();
  const request = dependencies.fetch ?? fetch;

  return async (audience, url, init) => {
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders(url);

    return request(url, {
      ...init,
      headers: { ...Object.fromEntries(headers), ...init.headers },
    });
  };
};

export type GcpInfrastructureProviderOptions = {
  agentAudience?: string;
  agentAudienceMetadataKey?: string;
  agentUrlMetadataKey?: string;
  authRequest?: GcpComputeRequest;
  instanceTemplate: string;
  labelKey?: string;
  labelValue?: string;
  projectId: string;
  zones: readonly string[];
};

type GcpInstance = {
  labels?: Record<string, string>;
  metadata?: { items?: Array<{ key: string; value?: string }> };
  name: string;
  networkInterfaces?: Array<{
    accessConfigs?: Array<{ natIP?: string }>;
    networkIP?: string;
  }>;
  status: string;
  zone: string;
};

type AggregatedInstances = {
  items?: Record<string, { instances?: GcpInstance[] }>;
};

export class GcpInfrastructureError extends Error {}

const zoneName = (zoneUrl: string) =>
  zoneUrl.slice(zoneUrl.lastIndexOf("/") + 1);
const regionName = (zone: string) => zone.replace(/-[a-z]$/, "");
const metadataValue = (instance: GcpInstance, key: string) =>
  instance.metadata?.items?.find((item) => item.key === key)?.value;

const stateFor = (status: string): InfrastructureNodeState => {
  if (status === "RUNNING") return "ready";
  if (["PROVISIONING", "REPAIRING", "STAGING"].includes(status))
    return "pending";

  return "terminated";
};

const parseNodeId = (id: string) => {
  const match = NODE_NAME_MATCH.exec(id);
  if (!match?.[1] || !match[2])
    throw new GcpInfrastructureError("Invalid GCP infrastructure node id");

  return { name: match[2], zone: match[1] };
};

const normalizeTemplate = (projectId: string, template: string) =>
  template.includes("/")
    ? template
    : `projects/${projectId}/global/instanceTemplates/${template}`;

export const createGcpInfrastructureProvider = (
  options: GcpInfrastructureProviderOptions,
): InfrastructureProvider => {
  if (options.zones.length === 0)
    throw new GcpInfrastructureError("At least one GCP zone is required");
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const request: GcpComputeRequest =
    options.authRequest ?? ((input) => auth.request(input));
  const labelKey = options.labelKey ?? "absolutejs-role";
  const labelValue = options.labelValue ?? "absolutejs-paas-node";
  const agentUrlKey =
    options.agentUrlMetadataKey ?? DEFAULT_AGENT_URL_METADATA_KEY;
  const agentAudienceKey =
    options.agentAudienceMetadataKey ?? DEFAULT_AGENT_AUDIENCE_METADATA_KEY;

  const normalize = (instance: GcpInstance): InfrastructureNode => {
    const zone = zoneName(instance.zone);
    const agentUrl = metadataValue(instance, agentUrlKey);
    const publicIpv4 = instance.networkInterfaces
      ?.flatMap(({ accessConfigs = [] }) => accessConfigs)
      .find(({ natIP }) => natIP)?.natIP;
    const privateIpv4 = instance.networkInterfaces?.find(
      ({ networkIP }) => networkIP,
    )?.networkIP;

    return {
      id: `gcp:${zone}:${instance.name}`,
      label: instance.name,
      provider: "gcp",
      region: regionName(zone),
      state: stateFor(instance.status),
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(privateIpv4 ? { privateIpv4 } : {}),
      ...(agentUrl
        ? {
            agent: {
              url: agentUrl,
              ...((metadataValue(instance, agentAudienceKey) ??
              options.agentAudience)
                ? {
                    audience:
                      metadataValue(instance, agentAudienceKey) ??
                      options.agentAudience,
                  }
                : {}),
            },
          }
        : {}),
    };
  };

  const listInstances = async () => {
    const response = await request<AggregatedInstances>({
      url: `${COMPUTE_BASE_URL}/projects/${encodeURIComponent(options.projectId)}/aggregated/instances?filter=${encodeURIComponent(`labels.${labelKey}=${labelValue}`)}`,
    });

    return Object.values(response.data.items ?? {}).flatMap(
      ({ instances = [] }) => instances,
    );
  };

  return {
    capabilities: {
      cloudInit: true,
      idempotentProvisioning: true,
      privateNetworking: true,
      regionalPlacement: true,
      regions: [...new Set(options.zones.map(regionName))],
    },
    getNode: async (id) => {
      const parsed = parseNodeId(id);
      const response = await request<GcpInstance>({
        url: `${COMPUTE_BASE_URL}/projects/${encodeURIComponent(options.projectId)}/zones/${encodeURIComponent(parsed.zone)}/instances/${encodeURIComponent(parsed.name)}`,
      });

      return normalize(response.data);
    },
    listNodes: async () => (await listInstances()).map(normalize),
    name: "gcp",
    provisionNode: async (input) => {
      const instances = await listInstances();
      const eligibleZones = input.region
        ? options.zones.filter((zone) => regionName(zone) === input.region)
        : [...options.zones];
      if (eligibleZones.length === 0)
        throw new GcpInfrastructureError(
          `GCP region ${input.region} is not configured`,
        );
      const counts = new Map(eligibleZones.map((zone) => [zone, 0]));
      for (const instance of instances) {
        const zone = zoneName(instance.zone);
        if (counts.has(zone)) counts.set(zone, (counts.get(zone) ?? 0) + 1);
      }
      const zone = [...counts].sort(
        (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
      )[0]?.[0];
      if (!zone)
        throw new GcpInfrastructureError("No configured GCP zone is available");
      await request({
        data: { name: input.name },
        method: "POST",
        url: `${COMPUTE_BASE_URL}/projects/${encodeURIComponent(options.projectId)}/zones/${encodeURIComponent(zone)}/instances?requestId=${encodeURIComponent(input.idempotencyKey)}&sourceInstanceTemplate=${encodeURIComponent(normalizeTemplate(options.projectId, options.instanceTemplate))}`,
      });

      return {
        id: `gcp:${zone}:${input.name}`,
        label: input.name,
        provider: "gcp",
        region: regionName(zone),
        state: "pending",
      };
    },
    terminateNode: async (id, idempotencyKey) => {
      const parsed = parseNodeId(id);
      await request({
        method: "DELETE",
        url: `${COMPUTE_BASE_URL}/projects/${encodeURIComponent(options.projectId)}/zones/${encodeURIComponent(parsed.zone)}/instances/${encodeURIComponent(parsed.name)}?requestId=${encodeURIComponent(idempotencyKey)}`,
      });
    },
  };
};

export const createGcpNodeName = (prefix = DEFAULT_NODE_PREFIX) =>
  `${prefix}-${crypto.randomUUID().slice(0, NODE_NAME_SUFFIX_LENGTH)}`;
