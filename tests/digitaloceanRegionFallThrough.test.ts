import { describe, expect, test } from "bun:test";
import {
  DigitalOceanError,
  type DigitalOceanClientLike,
  type DigitalOceanDroplet,
  type DigitalOceanSize,
} from "../src/digitalocean";
import { createDigitalOceanInfrastructureProvider } from "../src/digitaloceanInfrastructure";

const droplet = (region: string): DigitalOceanDroplet => ({
  id: 7,
  name: "absolutejs-host-new",
  networks: { v4: [{ ip_address: "10.0.0.7", type: "private" }] },
  region: { slug: region },
  status: "new",
});

/* nyc3 on 2026-10-27: a region that still exists but creates nothing. */
const sizes: DigitalOceanSize[] = [
  {
    available: true,
    disk: 80,
    memory: 4096,
    price_monthly: 24,
    regions: ["nyc1"],
    slug: "s-2vcpu-4gb",
    vcpus: 2,
  },
];
const refuse = () => {
  throw new DigitalOceanError(
    "DigitalOcean API POST /droplets failed: 422 Unprocessable Entity: Size is not available in this region.",
    422,
    undefined,
  );
};

const fakeClient = (options: {
  existing?: string[];
  refuses: ReadonlySet<string>;
  fail?: Error;
}) => {
  const posts: string[] = [];
  const client: DigitalOceanClientLike = {
    request: async <T>(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (path.includes("?name=")) return { droplets: [] } as T;
      if (path.startsWith("/sizes")) return { sizes } as T;
      if (method === "POST") {
        const region = (body as { region: string }).region;
        posts.push(region);
        if (options.fail) throw options.fail;
        if (options.refuses.has(region)) refuse();

        return { droplet: droplet(region) } as T;
      }

      return {
        droplets: (options.existing ?? []).map((region) => droplet(region)),
      } as T;
    },
  };

  return { client, posts };
};

const regions = ["nyc3", "nyc1"].map((region) => ({
  image: "ubuntu-24-04-x64",
  region,
  size: "s-2vcpu-4gb",
  sshKeys: ["key"],
}));

describe("a region that refuses every size", () => {
  test("the node is created in the next configured region, and the refusal is reported", async () => {
    // nyc3 holds fewer droplets, so it is tried first and refuses.
    const { client, posts } = fakeClient({
      existing: ["nyc1"],
      refuses: new Set(["nyc3"]),
    });
    const refused: string[] = [];
    const provider = createDigitalOceanInfrastructureProvider({
      client,
      onRegionRefused: (region) => refused.push(region),
      regions,
      tag: "absolutejs-paas-production-fleet",
    });

    const created = await provider.provisionNode({
      idempotencyKey: crypto.randomUUID(),
      name: "absolutejs-host-new",
    });

    expect(created.region).toBe("nyc1");
    expect(refused).toEqual(["nyc3"]);
    // nyc3 once (its substitute search finds nothing there to retry
    // with), then nyc1 once.
    expect(posts).toEqual(["nyc3", "nyc1"]);
  });

  test("every region refusing names them all", async () => {
    const { client } = fakeClient({ refuses: new Set(["nyc3", "nyc1"]) });
    const provider = createDigitalOceanInfrastructureProvider({
      client,
      onRegionRefused: () => {},
      regions,
      tag: "absolutejs-paas-production-fleet",
    });

    await expect(
      provider.provisionNode({
        idempotencyKey: crypto.randomUUID(),
        name: "absolutejs-host-new",
      }),
    ).rejects.toThrow(
      /every configured region refused the node: nyc1: .*; nyc3: /,
    );
  });

  test("any other failure stops at once rather than trying elsewhere", async () => {
    const { client, posts } = fakeClient({
      fail: new DigitalOceanError(
        "creating this droplet will exceed your droplet limit",
        422,
        undefined,
      ),
      refuses: new Set(),
    });
    const provider = createDigitalOceanInfrastructureProvider({
      client,
      regions,
      tag: "absolutejs-paas-production-fleet",
    });

    await expect(
      provider.provisionNode({
        idempotencyKey: crypto.randomUUID(),
        name: "absolutejs-host-new",
      }),
    ).rejects.toThrow(/droplet limit/);
    expect(posts).toHaveLength(1);
  });

  test("a node pinned to one region tries only that region", async () => {
    const { client, posts } = fakeClient({ refuses: new Set(["nyc3"]) });
    const provider = createDigitalOceanInfrastructureProvider({
      client,
      onRegionRefused: () => {},
      regions,
      tag: "absolutejs-paas-production-fleet",
    });

    await expect(
      provider.provisionNode({
        idempotencyKey: crypto.randomUUID(),
        name: "absolutejs-host-new",
        region: "nyc3",
      }),
    ).rejects.toThrow(/every configured region refused the node: nyc3/);
    expect(posts.every((region) => region === "nyc3")).toBeTrue();
  });
});
