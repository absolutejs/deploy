import {
  createLinodeClient,
  destroyLinodeInstance,
  findLinodeInstance,
  listLinodeInstances,
  type LinodeClientLike,
  type LinodeInstance,
} from "./linode";
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

export type LinodeFleetRegion = {
  image: string;
  region: string;
  sshKeys: ReadonlyArray<string>;
  type: string;
  userData?: string;
};

export type LinodeInfrastructureProviderOptions = {
  agent?: InfrastructureAgentOptions;
  client?: LinodeClientLike;
  regions: readonly LinodeFleetRegion[];
  tag?: string;
  token?: string;
};

const isPrivate = (ip: string) =>
  ip.startsWith("10.") ||
  ip.startsWith("192.168.") ||
  ip.startsWith("172.") ||
  ip.startsWith("169.254.");

const stateFor = (status: LinodeInstance["status"]): InfrastructureNodeState => {
  if (status === "running") return "ready";
  if (
    [
      "booting",
      "rebooting",
      "provisioning",
      "migrating",
      "rebuilding",
      "cloning",
      "restoring",
    ].includes(status)
  )
    return "pending";

  return "terminated";
};

const parseNodeId = (id: string) => {
  const match = /^linode:([1-9][0-9]*)$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/linode] invalid infrastructure node id");

  return Number(match[1]);
};

const rootPassword = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));

  return Buffer.from(bytes).toString("base64url");
};

export const createLinodeInfrastructureProvider = (
  options: LinodeInfrastructureProviderOptions,
): InfrastructureProvider => {
  if (options.regions.length === 0)
    throw new Error("[deploy/linode] at least one fleet region is required");
  const client =
    options.client ?? (options.token ? createLinodeClient(options.token) : undefined);
  if (!client)
    throw new Error(
      "[deploy/linode] either `token` or `client` must be provided",
    );
  const tag = options.tag ?? "absolutejs-paas-node";

  const normalize = (instance: LinodeInstance): InfrastructureNode => {
    const publicIpv4 = instance.ipv4.find((ip) => !isPrivate(ip));
    const privateIpv4 = instance.ipv4.find(isPrivate);
    const agent = infrastructureAgent(options.agent, {
      privateIpv4,
      publicIpv4,
    });

    return {
      id: `linode:${instance.id}`,
      label: instance.label,
      provider: "linode",
      region: instance.region ?? "unknown",
      state: stateFor(instance.status),
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(privateIpv4 ? { privateIpv4 } : {}),
      ...(agent ? { agent } : {}),
    };
  };
  const list = () => listLinodeInstances({ client, tag });

  return {
    capabilities: {
      cloudInit: true,
      idempotentProvisioning: true,
      privateNetworking: true,
      regionalPlacement: true,
      regions: options.regions.map(({ region }) => region),
    },
    getNode: async (id) => {
      const instance = await client.request<LinodeInstance>(
        "GET",
        `/linode/instances/${parseNodeId(id)}`,
      );

      return normalize(instance);
    },
    listNodes: async () => (await list()).map(normalize),
    name: "linode",
    provisionNode: async (input) => {
      const existing = await findLinodeInstance(client, input.name);
      if (existing) return normalize(existing);
      const instances = await list();
      const region = leastPopulatedRegion(
        options.regions,
        instances.map((instance) => instance.region ?? "unknown"),
        input.region,
      );
      if (!region)
        throw new Error(
          `[deploy/linode] region ${input.region ?? "(any)"} is not configured`,
        );
      const instance = await client.request<LinodeInstance>(
        "POST",
        "/linode/instances",
        {
          authorized_keys: [...region.sshKeys],
          image: region.image,
          label: input.name,
          private_ip: true,
          region: region.region,
          root_pass: rootPassword(),
          tags: [tag],
          type: region.type,
          ...(input.userData ?? region.userData
            ? { stackscript_data: { user_data: input.userData ?? region.userData } }
            : {}),
        },
      );

      return normalize(instance);
    },
    terminateNode: async (id) =>
      destroyLinodeInstance({ client, id: parseNodeId(id) }),
  };
};
