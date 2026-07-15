/** Fleet lifecycle adapter built on the canonical DigitalOcean client. */
import {
  createDigitalOceanClient,
  destroyDigitalOceanDroplet,
  findDigitalOceanDroplet,
  listDigitalOceanDroplets,
  type DigitalOceanClientLike,
  type DigitalOceanDroplet,
} from "./digitalocean";
import type {
  InfrastructureNode,
  InfrastructureNodeState,
  InfrastructureProvider,
} from "./infrastructure";

export type DigitalOceanFleetRegion = {
  image: string | number;
  ipv6?: boolean;
  monitoring?: boolean;
  region: string;
  size: string;
  sshKeys: ReadonlyArray<string | number>;
  userData?: string;
  vpcUuid?: string;
};

export type DigitalOceanInfrastructureProviderOptions = {
  agent?: {
    audience?: string;
    port?: number;
    preferPrivateNetwork?: boolean;
    protocol?: "http" | "https";
  };
  client?: DigitalOceanClientLike;
  regions: readonly DigitalOceanFleetRegion[];
  tag: string;
  token?: string;
};

const resolveClient = (options: DigitalOceanInfrastructureProviderOptions) => {
  if (options.client) return options.client;
  if (options.token) return createDigitalOceanClient(options.token);

  throw new Error(
    "[deploy/digitalocean] either `token` or `client` must be provided",
  );
};

const address = (droplet: DigitalOceanDroplet, type: "private" | "public") =>
  droplet.networks.v4.find((network) => network.type === type)?.ip_address;

const stateFor = (
  status: DigitalOceanDroplet["status"],
): InfrastructureNodeState => {
  if (status === "active") return "ready";
  if (status === "new") return "pending";

  return "terminated";
};

const parseNodeId = (id: string) => {
  const match = /^digitalocean:([1-9][0-9]*)$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/digitalocean] invalid infrastructure node id");

  return Number(match[1]);
};

export const createDigitalOceanInfrastructureProvider = (
  options: DigitalOceanInfrastructureProviderOptions,
): InfrastructureProvider => {
  if (options.regions.length === 0)
    throw new Error(
      "[deploy/digitalocean] at least one fleet region is required",
    );
  if (!options.tag)
    throw new Error("[deploy/digitalocean] a fleet tag is required");
  const client = resolveClient(options);
  const configuredRegions = new Map(
    options.regions.map((region) => [region.region, region]),
  );

  const normalize = (droplet: DigitalOceanDroplet): InfrastructureNode => {
    const publicIpv4 = address(droplet, "public");
    const privateIpv4 = address(droplet, "private");
    const agentHost = options.agent?.preferPrivateNetwork
      ? (privateIpv4 ?? publicIpv4)
      : (publicIpv4 ?? privateIpv4);

    return {
      id: `digitalocean:${droplet.id}`,
      label: droplet.name,
      provider: "digitalocean",
      region: droplet.region?.slug ?? "unknown",
      state: stateFor(droplet.status),
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(privateIpv4 ? { privateIpv4 } : {}),
      ...(options.agent && agentHost
        ? {
            agent: {
              url: `${options.agent.protocol ?? "http"}://${agentHost}:${options.agent.port ?? 8081}/`,
              ...(options.agent.audience
                ? { audience: options.agent.audience }
                : {}),
            },
          }
        : {}),
    };
  };

  const list = () =>
    listDigitalOceanDroplets({ client, tag: options.tag });

  return {
    capabilities: {
      cloudInit: true,
      idempotentProvisioning: true,
      privateNetworking: true,
      regionalPlacement: true,
      regions: [...configuredRegions.keys()],
    },
    getNode: async (id) => {
      const result = await client.request<{ droplet: DigitalOceanDroplet }>(
        "GET",
        `/droplets/${parseNodeId(id)}`,
      );

      return normalize(result.droplet);
    },
    listNodes: async () => (await list()).map(normalize),
    name: "digitalocean",
    provisionNode: async (input) => {
      const existing = await findDigitalOceanDroplet(client, input.name);
      if (existing) return normalize(existing);
      const droplets = await list();
      const eligible = input.region
        ? options.regions.filter((region) => region.region === input.region)
        : [...options.regions];
      if (eligible.length === 0)
        throw new Error(
          `[deploy/digitalocean] region ${input.region} is not configured`,
        );
      const counts = new Map(
        eligible.map((region) => [region.region, 0]),
      );
      for (const droplet of droplets) {
        const region = droplet.region?.slug;
        if (region && counts.has(region))
          counts.set(region, (counts.get(region) ?? 0) + 1);
      }
      const regionName = [...counts].sort(
        (left, right) =>
          left[1] - right[1] || left[0].localeCompare(right[0]),
      )[0]?.[0];
      const region = regionName ? configuredRegions.get(regionName) : undefined;
      if (!region)
        throw new Error(
          "[deploy/digitalocean] no configured fleet region is available",
        );
      const result = await client.request<{ droplet: DigitalOceanDroplet }>(
        "POST",
        "/droplets",
        {
          image: region.image,
          name: input.name,
          region: region.region,
          size: region.size,
          ssh_keys: [...region.sshKeys],
          tags: [options.tag],
          ...(input.userData ?? region.userData
            ? { user_data: input.userData ?? region.userData }
            : {}),
          ...(region.vpcUuid ? { vpc_uuid: region.vpcUuid } : {}),
          ...(region.ipv6 ? { ipv6: true } : {}),
          ...(region.monitoring ? { monitoring: true } : {}),
        },
      );

      return normalize(result.droplet);
    },
    terminateNode: async (id) =>
      destroyDigitalOceanDroplet({ client, id: parseNodeId(id) }),
  };
};
