import { describe, expect, test } from "bun:test";
import {
  type DigitalOceanClientLike,
  type DigitalOceanDroplet,
} from "../src/digitalocean";
import { createDigitalOceanInfrastructureProvider } from "../src/digitaloceanInfrastructure";
import { createGcpInfrastructureProvider } from "../src/gcp";
import type { InfrastructureProvider } from "../src/infrastructure";

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
});
