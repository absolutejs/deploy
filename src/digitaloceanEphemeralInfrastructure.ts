import {
  createDigitalOceanClient,
  DigitalOceanError,
  findDigitalOceanDroplet,
  type DigitalOceanClientLike,
  type DigitalOceanDroplet,
} from "./digitalocean";
import type {
  EphemeralInfrastructureAbsence,
  EphemeralInfrastructureProvider,
  EphemeralInfrastructureResources,
  ProvisionEphemeralInfrastructure,
} from "./ephemeralInfrastructure";

export type DigitalOceanVolume = {
  droplet_ids: number[];
  id: string;
  name: string;
  region: { slug: string };
  size_gigabytes: number;
};

export type DigitalOceanEphemeralInfrastructureOptions = {
  client?: DigitalOceanClientLike;
  cleanupPollIntervalMs?: number;
  cleanupTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  tag: string;
  token?: string;
};

const DEFAULT_CLEANUP_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 120_000;
const MINIMUM_VOLUME_GIB = 1;
const SAFE_RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const resolveClient = (options: DigitalOceanEphemeralInfrastructureOptions) => {
  if (options.client) return options.client;
  if (options.token) return createDigitalOceanClient(options.token);

  throw new Error(
    "[deploy/digitalocean-ephemeral] either `token` or `client` must be provided",
  );
};

const parseDropletId = (id: string) => {
  const match = /^digitalocean:droplet:([1-9][0-9]*)$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/digitalocean-ephemeral] invalid droplet id");

  return Number(match[1]);
};

const parseVolumeId = (id: string) => {
  const match = /^digitalocean:volume:([0-9a-f-]{36})$/.exec(id);
  if (!match?.[1])
    throw new Error("[deploy/digitalocean-ephemeral] invalid volume id");

  return match[1];
};

const privateIpv4 = (droplet: DigitalOceanDroplet) =>
  droplet.networks.v4.find(({ type }) => type === "private")?.ip_address;

const publicIpv4 = (droplet: DigitalOceanDroplet) =>
  droplet.networks.v4.find(({ type }) => type === "public")?.ip_address;

const normalize = (
  droplet: DigitalOceanDroplet,
  volume: DigitalOceanVolume,
): EphemeralInfrastructureResources => {
  const privateAddress = privateIpv4(droplet);
  const publicAddress = publicIpv4(droplet);

  return {
    node: {
      id: `digitalocean:droplet:${droplet.id}`,
      label: droplet.name,
      provider: "digitalocean",
      region: droplet.region?.slug ?? "unknown",
      state:
        droplet.status === "active"
          ? "ready"
          : droplet.status === "new"
            ? "pending"
            : "terminated",
      ...(privateAddress ? { privateIpv4: privateAddress } : {}),
      ...(publicAddress ? { publicIpv4: publicAddress } : {}),
    },
    volume: {
      encryptedAtRest: true,
      id: `digitalocean:volume:${volume.id}`,
      label: volume.name,
      region: volume.region.slug,
      sizeGiB: volume.size_gigabytes,
    },
  };
};

const findVolume = async (client: DigitalOceanClientLike, name: string) => {
  const result = await client.request<{ volumes: DigitalOceanVolume[] }>(
    "GET",
    `/volumes?name=${encodeURIComponent(name)}`,
  );
  const matches = result.volumes.filter((volume) => volume.name === name);
  if (matches.length > 1)
    throw new Error(
      `[deploy/digitalocean-ephemeral] multiple volumes named "${name}"`,
    );

  return matches[0];
};

const absent = async (operation: () => Promise<unknown>): Promise<boolean> => {
  try {
    await operation();
    return false;
  } catch (error) {
    if (error instanceof DigitalOceanError && error.status === 404) return true;
    throw error;
  }
};

const validateRequest = (request: ProvisionEphemeralInfrastructure) => {
  if (!SAFE_RESOURCE_NAME.test(request.name))
    throw new Error("[deploy/digitalocean-ephemeral] invalid resource name");
  if (!request.idempotencyKey)
    throw new Error(
      "[deploy/digitalocean-ephemeral] idempotency key is required",
    );
  if (!request.vpcUuid)
    throw new Error("[deploy/digitalocean-ephemeral] VPC UUID is required");
  if (request.sshKeys.length === 0)
    throw new Error(
      "[deploy/digitalocean-ephemeral] at least one SSH key is required",
    );
  if (
    !Number.isSafeInteger(request.volumeGiB) ||
    request.volumeGiB < MINIMUM_VOLUME_GIB
  )
    throw new Error("[deploy/digitalocean-ephemeral] invalid volume size");
};

export const createDigitalOceanEphemeralInfrastructureProvider = (
  options: DigitalOceanEphemeralInfrastructureOptions,
): EphemeralInfrastructureProvider => {
  if (!options.tag)
    throw new Error(
      "[deploy/digitalocean-ephemeral] a resource tag is required",
    );
  const client = resolveClient(options);
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const pollIntervalMs =
    options.cleanupPollIntervalMs ?? DEFAULT_CLEANUP_POLL_INTERVAL_MS;
  const cleanupTimeoutMs =
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

  const inspectAbsence = async (
    resources: EphemeralInfrastructureResources,
  ): Promise<EphemeralInfrastructureAbsence> => {
    const dropletId = parseDropletId(resources.node.id);
    const volumeId = parseVolumeId(resources.volume.id);
    const [dropletAbsent, volumeAbsent] = await Promise.all([
      absent(() => client.request("GET", `/droplets/${dropletId}`)),
      absent(() => client.request("GET", `/volumes/${volumeId}`)),
    ]);

    return { dropletAbsent, volumeAbsent };
  };

  const waitUntil = async (
    predicate: () => Promise<boolean>,
    label: string,
  ) => {
    const deadline = Date.now() + cleanupTimeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline)
        throw new Error(
          `[deploy/digitalocean-ephemeral] timed out waiting for ${label}`,
        );
      await sleep(pollIntervalMs);
    }
  };

  return {
    cleanup: async (resources) => {
      const dropletId = parseDropletId(resources.node.id);
      const volumeId = parseVolumeId(resources.volume.id);
      if (!(await inspectAbsence(resources)).dropletAbsent)
        await client.request("DELETE", `/droplets/${dropletId}`);
      await waitUntil(
        async () => (await inspectAbsence(resources)).dropletAbsent,
        "droplet deletion",
      );
      if (!(await inspectAbsence(resources)).volumeAbsent)
        await client.request("DELETE", `/volumes/${volumeId}`);
      await waitUntil(
        async () => (await inspectAbsence(resources)).volumeAbsent,
        "volume deletion",
      );

      return inspectAbsence(resources);
    },
    inspectAbsence,
    name: "digitalocean",
    provision: async (request) => {
      validateRequest(request);
      const volumeName = `${request.name}-checkpoint`;
      let volume = await findVolume(client, volumeName);
      const createdVolume = !volume;
      if (!volume) {
        const result = await client.request<{ volume: DigitalOceanVolume }>(
          "POST",
          "/volumes",
          {
            description: `Ephemeral ${request.name} checkpoint volume`,
            filesystem_label: "criu-checkpoint",
            filesystem_type: "ext4",
            name: volumeName,
            region: request.region,
            size_gigabytes: request.volumeGiB,
            tags: [options.tag],
          },
        );
        volume = result.volume;
      }
      if (
        volume.region.slug !== request.region ||
        volume.size_gigabytes !== request.volumeGiB
      )
        throw new Error(
          "[deploy/digitalocean-ephemeral] existing volume does not match the requested topology",
        );

      try {
        let droplet = await findDigitalOceanDroplet(client, request.name);
        if (!droplet) {
          const result = await client.request<{ droplet: DigitalOceanDroplet }>(
            "POST",
            "/droplets",
            {
              backups: false,
              image: request.image,
              ipv6: false,
              monitoring: true,
              name: request.name,
              region: request.region,
              size: request.size,
              ssh_keys: [...request.sshKeys],
              tags: [options.tag],
              user_data: request.userData,
              volumes: [volume.id],
              vpc_uuid: request.vpcUuid,
            },
          );
          droplet = result.droplet;
        }
        if (
          droplet.region?.slug !== request.region ||
          (droplet.size_slug && droplet.size_slug !== request.size)
        )
          throw new Error(
            "[deploy/digitalocean-ephemeral] existing droplet does not match the requested topology",
          );
        if (
          volume.droplet_ids.length > 0 &&
          !volume.droplet_ids.includes(droplet.id)
        )
          throw new Error(
            "[deploy/digitalocean-ephemeral] checkpoint volume is attached to another droplet",
          );

        return normalize(droplet, volume);
      } catch (error) {
        if (createdVolume)
          await client.request("DELETE", `/volumes/${volume.id}`);
        throw error;
      }
    },
  };
};
