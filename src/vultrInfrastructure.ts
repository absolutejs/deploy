import type {
  InfrastructureNode,
  InfrastructureNodeState,
  InfrastructureProvider,
} from "./infrastructure";
import {
  infrastructureAgent,
  leastPopulatedRegion,
  type InfrastructureAgentOptions,
} from "./infrastructureAdapter";
import {
  createVultrClient,
  destroyVultrInstance,
  findVultrInstance,
  listVultrInstances,
  type VultrClientLike,
  type VultrInstance,
} from "./vultr";

export type VultrFleetRegion = {
  osId: number;
  plan: string;
  region: string;
  sshKeys: ReadonlyArray<string>;
  userData?: string;
};

export type VultrInfrastructureProviderOptions = {
  agent?: InfrastructureAgentOptions;
  client?: VultrClientLike;
  regions: readonly VultrFleetRegion[];
  tag?: string;
  token?: string;
};

const stateFor = (instance: VultrInstance): InfrastructureNodeState => {
  if (
    instance.status === "active" &&
    (instance.power_status === "running" || !instance.power_status)
  )
    return "ready";
  if (
    instance.status === "pending" ||
    instance.status === "resizing" ||
    instance.power_status === "starting"
  )
    return "pending";

  return "terminated";
};

const parseNodeId = (id: string) => {
  const match = /^vultr:([a-f0-9-]{16,64})$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/vultr] invalid infrastructure node id");

  return match[1];
};

export const createVultrInfrastructureProvider = (
  options: VultrInfrastructureProviderOptions,
): InfrastructureProvider => {
  if (options.regions.length === 0)
    throw new Error("[deploy/vultr] at least one fleet region is required");
  const client =
    options.client ?? (options.token ? createVultrClient(options.token) : undefined);
  if (!client)
    throw new Error(
      "[deploy/vultr] either `token` or `client` must be provided",
    );
  const tag = options.tag ?? "absolutejs-paas-node";

  const normalize = (instance: VultrInstance): InfrastructureNode => {
    const publicIpv4 =
      instance.main_ip && instance.main_ip !== "0.0.0.0"
        ? instance.main_ip
        : undefined;
    const privateIpv4 = instance.internal_ip || undefined;
    const agent = infrastructureAgent(options.agent, {
      privateIpv4,
      publicIpv4,
    });

    return {
      id: `vultr:${instance.id}`,
      label: instance.label,
      provider: "vultr",
      region: instance.region ?? "unknown",
      state: stateFor(instance),
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(privateIpv4 ? { privateIpv4 } : {}),
      ...(agent ? { agent } : {}),
    };
  };
  const list = () => listVultrInstances({ client, tag });

  return {
    capabilities: {
      cloudInit: true,
      idempotentProvisioning: true,
      privateNetworking: true,
      regionalPlacement: true,
      regions: options.regions.map(({ region }) => region),
    },
    getNode: async (id) => {
      const result = await client.request<{ instance: VultrInstance }>(
        "GET",
        `/instances/${parseNodeId(id)}`,
      );

      return normalize(result.instance);
    },
    listNodes: async () => (await list()).map(normalize),
    name: "vultr",
    provisionNode: async (input) => {
      const existing = await findVultrInstance(client, input.name);
      if (existing) return normalize(existing);
      const instances = await list();
      const region = leastPopulatedRegion(
        options.regions,
        instances.map((instance) => instance.region ?? "unknown"),
        input.region,
      );
      if (!region)
        throw new Error(
          `[deploy/vultr] region ${input.region ?? "(any)"} is not configured`,
        );
      const result = await client.request<{ instance: VultrInstance }>(
        "POST",
        "/instances",
        {
          enable_ipv6: true,
          hostname: input.name,
          label: input.name,
          os_id: region.osId,
          plan: region.plan,
          region: region.region,
          sshkey_id: [...region.sshKeys],
          tags: [tag],
          ...(region.userData ? { user_data: btoa(region.userData) } : {}),
        },
      );

      return normalize(result.instance);
    },
    terminateNode: async (id) =>
      destroyVultrInstance({ client, id: parseNodeId(id) }),
  };
};
