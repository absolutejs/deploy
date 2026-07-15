import {
  createHetznerClient,
  destroyHetznerServer,
  findHetznerServer,
  listHetznerServers,
  type HetznerClientLike,
  type HetznerServer,
} from "./hetzner";
import {
  infrastructureAgent,
  leastPopulatedRegion,
  type InfrastructureAgentOptions,
} from "./infrastructureAdapter";
import type {
  InfrastructureNode,
  InfrastructureNodeState,
  InfrastructureProvider,
} from "./infrastructure";

export type HetznerFleetRegion = {
  image: string | number;
  networkId?: number;
  region: string;
  serverType: string;
  sshKeys: ReadonlyArray<string | number>;
  userData?: string;
};

export type HetznerInfrastructureProviderOptions = {
  agent?: InfrastructureAgentOptions;
  client?: HetznerClientLike;
  labelKey?: string;
  labelValue?: string;
  regions: readonly HetznerFleetRegion[];
  token?: string;
};

const stateFor = (status: HetznerServer["status"]): InfrastructureNodeState => {
  if (status === "running") return "ready";
  if (
    ["initializing", "starting", "migrating", "rebuilding"].includes(status)
  )
    return "pending";

  return "terminated";
};

const parseNodeId = (id: string) => {
  const match = /^hetzner:([1-9][0-9]*)$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/hetzner] invalid infrastructure node id");

  return Number(match[1]);
};

export const createHetznerInfrastructureProvider = (
  options: HetznerInfrastructureProviderOptions,
): InfrastructureProvider => {
  if (options.regions.length === 0)
    throw new Error("[deploy/hetzner] at least one fleet region is required");
  const client =
    options.client ??
    (options.token ? createHetznerClient(options.token) : undefined);
  if (!client)
    throw new Error(
      "[deploy/hetzner] either `token` or `client` must be provided",
    );
  const labelKey = options.labelKey ?? "absolutejs-role";
  const labelValue = options.labelValue ?? "absolutejs-paas-node";

  const normalize = (server: HetznerServer): InfrastructureNode => {
    const publicIpv4 = server.public_net.ipv4?.ip;
    const privateIpv4 = server.private_net?.[0]?.ip;
    const agent = infrastructureAgent(options.agent, {
      privateIpv4,
      publicIpv4,
    });

    return {
      id: `hetzner:${server.id}`,
      label: server.name,
      provider: "hetzner",
      region: server.datacenter?.location.name ?? "unknown",
      state: stateFor(server.status),
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(privateIpv4 ? { privateIpv4 } : {}),
      ...(agent ? { agent } : {}),
    };
  };
  const list = () =>
    listHetznerServers({
      client,
      labelSelector: `${labelKey}=${labelValue}`,
    });

  return {
    capabilities: {
      cloudInit: true,
      idempotentProvisioning: true,
      privateNetworking: true,
      regionalPlacement: true,
      regions: options.regions.map(({ region }) => region),
    },
    getNode: async (id) => {
      const result = await client.request<{ server: HetznerServer }>(
        "GET",
        `/servers/${parseNodeId(id)}`,
      );

      return normalize(result.server);
    },
    listNodes: async () => (await list()).map(normalize),
    name: "hetzner",
    provisionNode: async (input) => {
      const existing = await findHetznerServer(client, input.name);
      if (existing) return normalize(existing);
      const servers = await list();
      const region = leastPopulatedRegion(
        options.regions,
        servers.map((server) => server.datacenter?.location.name ?? "unknown"),
        input.region,
      );
      if (!region)
        throw new Error(
          `[deploy/hetzner] region ${input.region ?? "(any)"} is not configured`,
        );
      const result = await client.request<{ server: HetznerServer }>(
        "POST",
        "/servers",
        {
          image: region.image,
          labels: { [labelKey]: labelValue },
          location: region.region,
          name: input.name,
          public_net: { enable_ipv4: true, enable_ipv6: true },
          server_type: region.serverType,
          ssh_keys: [...region.sshKeys],
          start_after_create: true,
          ...(region.networkId ? { networks: [region.networkId] } : {}),
          ...(input.userData ?? region.userData
            ? { user_data: input.userData ?? region.userData }
            : {}),
        },
      );

      return normalize(result.server);
    },
    terminateNode: async (id) =>
      destroyHetznerServer({ client, id: parseNodeId(id) }),
  };
};
