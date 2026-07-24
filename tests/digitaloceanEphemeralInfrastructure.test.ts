import { describe, expect, test } from "bun:test";
import {
  type DigitalOceanClientLike,
  DigitalOceanError,
  type DigitalOceanDroplet,
} from "../src/digitalocean";
import {
  createDigitalOceanEphemeralInfrastructureProvider,
  type DigitalOceanVolume,
} from "../src/digitaloceanEphemeralInfrastructure";

const VOLUME_ID = "7724db7c-e098-11e5-b522-000f53304e51";

const droplet = (): DigitalOceanDroplet => ({
  id: 42,
  name: "criu-staging-abcd1234",
  networks: {
    v4: [
      { ip_address: "203.0.113.2", type: "public" },
      { ip_address: "10.20.0.2", type: "private" },
    ],
  },
  region: { slug: "nyc3" },
  size_slug: "s-2vcpu-4gb",
  status: "active",
  tags: ["absolutejs-criu-staging"],
});

const volume = (): DigitalOceanVolume => ({
  droplet_ids: [42],
  id: VOLUME_ID,
  name: "criu-staging-abcd1234-checkpoint",
  region: { slug: "nyc3" },
  size_gigabytes: 20,
});

const request = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  image: 12345,
  name: "criu-staging-abcd1234",
  region: "nyc3",
  size: "s-2vcpu-4gb",
  sshKeys: [99],
  userData: "#cloud-config\n",
  volumeGiB: 20,
  vpcUuid: "22222222-2222-4222-8222-222222222222",
};

describe("DigitalOcean ephemeral infrastructure", () => {
  test("provisions a volume-attached staging droplet without a command surface", async () => {
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const client: DigitalOceanClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (method === "GET" && path.startsWith("/volumes?"))
          return { volumes: [] } as T;
        if (method === "GET" && path.startsWith("/droplets?"))
          return { droplets: [] } as T;
        if (method === "POST" && path === "/volumes")
          return { volume: volume() } as T;
        if (method === "POST" && path === "/droplets")
          return { droplet: droplet() } as T;
        throw new Error(`Unexpected ${method} ${path}`);
      },
    };
    const provider = createDigitalOceanEphemeralInfrastructureProvider({
      client,
      tag: "absolutejs-criu-staging",
    });

    const resources = await provider.provision(request);

    expect(resources).toMatchObject({
      node: {
        id: "digitalocean:droplet:42",
        privateIpv4: "10.20.0.2",
        provider: "digitalocean",
        state: "ready",
      },
      volume: {
        encryptedAtRest: true,
        id: `digitalocean:volume:${VOLUME_ID}`,
        sizeGiB: 20,
      },
    });
    expect(calls.find(({ path }) => path === "/volumes")?.body).toMatchObject({
      filesystem_type: "ext4",
      region: "nyc3",
      size_gigabytes: 20,
      tags: ["absolutejs-criu-staging"],
    });
    expect(calls.find(({ path }) => path === "/droplets")?.body).toMatchObject({
      backups: false,
      ipv6: false,
      user_data: "#cloud-config\n",
      volumes: [VOLUME_ID],
      vpc_uuid: request.vpcUuid,
    });
    expect("exec" in provider).toBeFalse();
  });

  test("reuses an exact resource pair and rejects topology drift", async () => {
    const client: DigitalOceanClientLike = {
      request: async <T>(
        _method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
      ): Promise<T> => {
        if (path.startsWith("/volumes?")) return { volumes: [volume()] } as T;
        if (path.startsWith("/droplets?"))
          return { droplets: [droplet()] } as T;
        throw new Error(`Unexpected GET ${path}`);
      },
    };
    const provider = createDigitalOceanEphemeralInfrastructureProvider({
      client,
      tag: "absolutejs-criu-staging",
    });

    expect((await provider.provision(request)).node.id).toBe(
      "digitalocean:droplet:42",
    );
    await expect(
      provider.provision({ ...request, volumeGiB: 21 }),
    ).rejects.toThrow("existing volume does not match");
  });

  test("deletes compute before storage and verifies both are absent", async () => {
    const calls: string[] = [];
    let dropletExists = true;
    let volumeExists = true;
    const client: DigitalOceanClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
      ): Promise<T> => {
        calls.push(`${method} ${path}`);
        if (method === "DELETE" && path === "/droplets/42") {
          dropletExists = false;
          return undefined as T;
        }
        if (method === "DELETE" && path === `/volumes/${VOLUME_ID}`) {
          volumeExists = false;
          return undefined as T;
        }
        if (method === "GET" && path === "/droplets/42") {
          if (dropletExists) return { droplet: droplet() } as T;
          throw new DigitalOceanError("gone", 404, undefined);
        }
        if (method === "GET" && path === `/volumes/${VOLUME_ID}`) {
          if (volumeExists) return { volume: volume() } as T;
          throw new DigitalOceanError("gone", 404, undefined);
        }
        throw new Error(`Unexpected ${method} ${path}`);
      },
    };
    const provider = createDigitalOceanEphemeralInfrastructureProvider({
      client,
      cleanupPollIntervalMs: 1,
      sleep: async () => {},
      tag: "absolutejs-criu-staging",
    });
    const resources = {
      node: {
        id: "digitalocean:droplet:42",
        label: request.name,
        provider: "digitalocean",
        region: "nyc3",
        state: "ready" as const,
      },
      volume: {
        encryptedAtRest: true as const,
        id: `digitalocean:volume:${VOLUME_ID}`,
        label: `${request.name}-checkpoint`,
        region: "nyc3",
        sizeGiB: 20,
      },
    };

    expect(await provider.cleanup(resources)).toEqual({
      dropletAbsent: true,
      volumeAbsent: true,
    });
    expect(calls.indexOf("DELETE /droplets/42")).toBeLessThan(
      calls.indexOf(`DELETE /volumes/${VOLUME_ID}`),
    );
  });
});
