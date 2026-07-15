import { describe, expect, test } from "bun:test";
import {
  type DigitalOceanClientLike,
  type DigitalOceanDroplet,
} from "../src/digitalocean";
import { createDigitalOceanInfrastructureProvider } from "../src/digitaloceanInfrastructure";
import {
  createGcpIdentityTokenRequest,
  createGcpInfrastructureProvider,
} from "../src/gcp";
import type { HetznerClientLike, HetznerServer } from "../src/hetzner";
import { createHetznerInfrastructureProvider } from "../src/hetznerInfrastructure";
import type { InfrastructureProvider } from "../src/infrastructure";
import type { LinodeClientLike, LinodeInstance } from "../src/linode";
import { createLinodeInfrastructureProvider } from "../src/linodeInfrastructure";
import type { VultrClientLike, VultrInstance } from "../src/vultr";
import { createVultrInfrastructureProvider } from "../src/vultrInfrastructure";

const assertProviderContract = (provider: InfrastructureProvider) => {
  expect(provider.name.length).toBeGreaterThan(0);
  expect(provider.capabilities.regions.length).toBeGreaterThan(0);
  expect(provider.capabilities.idempotentProvisioning).toBeTrue();
};

const droplet = (
  overrides: Partial<DigitalOceanDroplet> = {},
): DigitalOceanDroplet => ({
  id: 42,
  name: "absolutejs-node-existing",
  networks: {
    v4: [
      { ip_address: "203.0.113.2", type: "public" },
      { ip_address: "10.0.0.2", type: "private" },
    ],
  },
  region: { slug: "nyc3" },
  status: "active",
  tags: ["absolutejs-paas-node"],
  ...overrides,
});

describe("infrastructure provider contract", () => {
  test("normalizes DigitalOcean inventory and provisions in the least-populated region", async () => {
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const client: DigitalOceanClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (path.includes("?name=")) return { droplets: [] } as T;
        if (method === "POST")
          return {
            droplet: droplet({
              id: 99,
              name: "absolutejs-node-new",
              region: { slug: "sfo3" },
              status: "new",
            }),
          } as T;
        return { droplets: [droplet()] } as T;
      },
    };
    const provider = createDigitalOceanInfrastructureProvider({
      agent: { port: 8081, preferPrivateNetwork: true },
      client,
      regions: [
        {
          image: "ubuntu-24-04-x64",
          region: "nyc3",
          size: "s-1vcpu-1gb",
          sshKeys: ["key"],
        },
        {
          image: "ubuntu-24-04-x64",
          region: "sfo3",
          size: "s-1vcpu-1gb",
          sshKeys: ["key"],
        },
      ],
      tag: "absolutejs-paas-node",
    });
    assertProviderContract(provider);
    const nodes = await provider.listNodes();
    expect(nodes[0]).toMatchObject({
      agent: { url: "http://10.0.0.2:8081/" },
      id: "digitalocean:42",
      provider: "digitalocean",
      state: "ready",
    });
    const created = await provider.provisionNode({
      idempotencyKey: crypto.randomUUID(),
      name: "absolutejs-node-new",
    });
    expect(created).toMatchObject({
      id: "digitalocean:99",
      region: "sfo3",
      state: "pending",
    });
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({
      region: "sfo3",
      tags: ["absolutejs-paas-node"],
    });
  });

  test("normalizes GCP inventory and provisions from the configured template", async () => {
    const requests: Array<{ data?: unknown; method?: string; url: string }> =
      [];
    const instance = {
      metadata: {
        items: [
          { key: "absolutejs-agent-url", value: "https://node.internal/" },
        ],
      },
      name: "node-east",
      status: "RUNNING",
      zone: "projects/paas/zones/us-east1-b",
    };
    const provider = createGcpInfrastructureProvider({
      authRequest: async <T>(request: {
        data?: unknown;
        method?: string;
        url: string;
      }) => {
        requests.push(request);
        return {
          data: (request.method === "POST"
            ? {}
            : { items: { east: { instances: [instance] } } }) as T,
        };
      },
      instanceTemplate: "node-v1",
      projectId: "paas",
      zones: ["us-east1-b", "us-west1-a"],
    });
    assertProviderContract(provider);
    expect(await provider.listNodes()).toEqual([
      {
        agent: { url: "https://node.internal/" },
        id: "gcp:us-east1-b:node-east",
        label: "node-east",
        provider: "gcp",
        region: "us-east1",
        state: "ready",
      },
    ]);
    const created = await provider.provisionNode({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      name: "node-west",
    });
    expect(created.region).toBe("us-west1");
    expect(requests.at(-1)?.url).toContain(
      "sourceInstanceTemplate=projects%2Fpaas%2Fglobal%2FinstanceTemplates%2Fnode-v1",
    );
  });

  test("signs GCP service requests with an audience identity token", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const request = createGcpIdentityTokenRequest({
      auth: {
        getIdTokenClient: async (audience: string) => ({
          getRequestHeaders: async () => new Headers({ authorization: `Bearer ${audience}` }),
        }),
      },
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ init, url });

        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    await request("node-agent", "https://node.internal/health", { method: "GET" });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer node-agent" });
  });

  test("normalizes and provisions Hetzner fleet nodes", async () => {
    const existing: HetznerServer = {
      datacenter: { location: { name: "nbg1" } },
      id: 41,
      name: "existing",
      private_net: [{ ip: "10.0.0.4", network: 1 }],
      public_net: { ipv4: { blocked: false, id: 1, ip: "203.0.113.4" }, ipv6: null },
      status: "running",
    };
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const client: HetznerClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (path.includes("?name=")) return { servers: [] } as T;
        if (method === "POST")
          return {
            server: { ...existing, datacenter: { location: { name: "ash" } }, id: 42, name: "new", status: "initializing" },
          } as T;
        return { servers: [existing] } as T;
      },
    };
    const provider = createHetznerInfrastructureProvider({
      agent: { preferPrivateNetwork: true },
      client,
      regions: [
        { image: "ubuntu-24.04", region: "nbg1", serverType: "cx22", sshKeys: [1] },
        { image: "ubuntu-24.04", region: "ash", serverType: "cx22", sshKeys: [1] },
      ],
    });
    expect((await provider.listNodes())[0]).toMatchObject({ agent: { url: "http://10.0.0.4:8081/" }, id: "hetzner:41" });
    expect(await provider.provisionNode({ idempotencyKey: "request", name: "new" })).toMatchObject({ id: "hetzner:42", region: "ash", state: "pending" });
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({ location: "ash", labels: { "absolutejs-role": "absolutejs-paas-node" } });
  });

  test("normalizes and provisions Linode fleet nodes", async () => {
    const existing: LinodeInstance = {
      id: 51,
      ipv4: ["203.0.113.5", "10.0.0.5"],
      label: "existing",
      region: "us-east",
      status: "running",
      tags: ["absolutejs-paas-node"],
    };
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const client: LinodeClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (method === "POST")
          return { ...existing, id: 52, label: "new", region: "us-west", status: "provisioning" } as T;
        return { data: path.includes("tag=") ? [existing] : [] } as T;
      },
    };
    const provider = createLinodeInfrastructureProvider({
      agent: { preferPrivateNetwork: true },
      client,
      regions: [
        { image: "linode/ubuntu24.04", region: "us-east", sshKeys: ["key"], type: "g6-nanode-1" },
        { image: "linode/ubuntu24.04", region: "us-west", sshKeys: ["key"], type: "g6-nanode-1" },
      ],
    });
    expect((await provider.listNodes())[0]).toMatchObject({ agent: { url: "http://10.0.0.5:8081/" }, id: "linode:51" });
    expect(await provider.provisionNode({ idempotencyKey: "request", name: "new" })).toMatchObject({ id: "linode:52", region: "us-west", state: "pending" });
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({ private_ip: true, region: "us-west" });
  });

  test("normalizes and provisions Vultr fleet nodes", async () => {
    const existing: VultrInstance = {
      id: "11111111-1111-4111-8111-111111111111",
      internal_ip: "10.0.0.6",
      label: "existing",
      main_ip: "203.0.113.6",
      power_status: "running",
      region: "ewr",
      status: "active",
      tags: ["absolutejs-paas-node"],
    };
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    const client: VultrClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "DELETE" | "PATCH",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (path.includes("label=")) return { instances: [] } as T;
        if (method === "POST")
          return {
            instance: { ...existing, id: "22222222-2222-4222-8222-222222222222", label: "new", region: "lax", status: "pending" },
          } as T;
        return { instances: [existing] } as T;
      },
    };
    const provider = createVultrInfrastructureProvider({
      agent: { preferPrivateNetwork: true },
      client,
      regions: [
        { osId: 2284, plan: "vc2-1c-1gb", region: "ewr", sshKeys: ["key"] },
        { osId: 2284, plan: "vc2-1c-1gb", region: "lax", sshKeys: ["key"] },
      ],
    });
    expect((await provider.listNodes())[0]).toMatchObject({ agent: { url: "http://10.0.0.6:8081/" }, id: "vultr:11111111-1111-4111-8111-111111111111" });
    expect(await provider.provisionNode({ idempotencyKey: "request", name: "new" })).toMatchObject({ id: "vultr:22222222-2222-4222-8222-222222222222", region: "lax", state: "pending" });
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({ region: "lax", tags: ["absolutejs-paas-node"] });
  });
});
