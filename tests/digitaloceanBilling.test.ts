import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { DigitalOceanClientLike } from "../src/digitalocean";
import {
  createDigitalOceanBilling,
  digitalOceanLineFingerprint,
} from "../src/digitaloceanBilling";
import { createDigitalOceanInfrastructureProvider } from "../src/digitaloceanInfrastructure";
import { amountToMicros } from "../src/infrastructure";

const UUID = "11111111-2222-3333-4444-555555555555";

const item = (overrides: Record<string, string> = {}) => ({
  amount: "31.50",
  category: "iaas",
  description: "absolutejs-paas-production-deploy-1 (s-2vcpu-4gb)",
  duration: "744",
  duration_unit: "Hours",
  end_time: "2026-10-01T00:00:00Z",
  group_description: "Droplets",
  product: "Droplets",
  project_name: "AbsoluteJS",
  resource_id: "611756175",
  resource_uuid: "uuid-1",
  start_time: "2026-09-01T00:00:00Z",
  ...overrides,
});

const fakeClient = (pages: Record<string, unknown[]>) => {
  const calls: string[] = [];
  const client: DigitalOceanClientLike = {
    request: async <T>(_method: string, path: string) => {
      calls.push(path);
      const url = new URL(path, "https://api.example");
      const page = Number(url.searchParams.get("page") ?? "1");
      if (url.pathname === "/customers/my/invoices")
        return {
          invoice_preview: {
            amount: "42.10",
            invoice_period: "2026-10",
            invoice_uuid: "preview-uuid",
          },
          invoices:
            page === 1
              ? [{ amount: "100.00", invoice_period: "2026-09", invoice_uuid: UUID }]
              : [],
          links: page === 1 && url.searchParams.get("per_page") !== "1"
            ? { pages: { next: "more" } }
            : {},
        } as T;
      const rows = pages[url.pathname] ?? [];
      const perPage = Number(url.searchParams.get("per_page"));
      const slice = rows.slice((page - 1) * perPage, page * perPage);

      return {
        invoice_items: slice,
        links: page * perPage < rows.length ? { pages: { next: "more" } } : {},
      } as T;
    },
  };

  return { calls, client };
};

describe("amountToMicros", () => {
  test("parses decimal strings exactly, with no float rounding", () => {
    expect(amountToMicros("12.34")).toBe(12_340_000);
    expect(amountToMicros("0.1")).toBe(100_000);
    expect(amountToMicros("-3.000001")).toBe(-3_000_001);
    expect(amountToMicros("0.0000005")).toBe(1);
    expect(amountToMicros(0.03571)).toBe(35_710);
    expect(amountToMicros("7")).toBe(7_000_000);
    expect(() => amountToMicros("1,000.00")).toThrow();
  });
});

describe("DigitalOcean billing", () => {
  test("lists final invoices and the open month's preview", async () => {
    const { client } = fakeClient({});
    const invoices = await createDigitalOceanBilling({ client }).listInvoices();
    expect(invoices).toEqual([
      { amountMicros: 100_000_000, currency: "USD", id: UUID, period: "2026-09", preview: false },
      { amountMicros: 42_100_000, currency: "USD", id: "preview", period: "2026-10", preview: true },
    ]);
  });

  test("normalizes every line across pages, in the invoice's own month", async () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      item({ resource_id: String(1000 + index) }),
    );
    const { client } = fakeClient({ [`/customers/my/invoices/${UUID}`]: rows });
    const lines = await createDigitalOceanBilling({ client }).listInvoiceLines(UUID);
    expect(lines).toHaveLength(250);
    expect(lines[0]).toMatchObject({
      amountMicros: 31_500_000,
      category: "iaas",
      durationHours: 744,
      invoiceId: UUID,
      period: "2026-09",
      product: "Droplets",
      resourceId: "1000",
    });
  });

  test("names lines the way Management's import does, numbering repeats", async () => {
    const duplicate = item();
    const { client } = fakeClient({
      "/customers/my/invoices/preview": [duplicate, duplicate],
    });
    const lines = await createDigitalOceanBilling({ client }).listInvoiceLines("preview");
    const management = createHash("sha256")
      .update(
        JSON.stringify([
          duplicate.product,
          duplicate.description,
          duplicate.start_time,
          duplicate.resource_id,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    expect(digitalOceanLineFingerprint(duplicate)).toBe(management);
    expect(lines.map((line) => line.fingerprint)).toEqual([
      `${management}:0`,
      `${management}:1`,
    ]);
    expect(lines[0]?.period).toBe("2026-10");
  });

  test("refuses an invoice reference that is not one", async () => {
    const { client } = fakeClient({});
    await expect(
      createDigitalOceanBilling({ client }).listInvoiceLines("../droplets"),
    ).rejects.toThrow("invalid invoice reference");
  });
});

describe("DigitalOcean node sizes", () => {
  test("a node reports its billed size and creation time", async () => {
    const client: DigitalOceanClientLike = {
      request: async <T>() =>
        ({
          droplet: {
            created_at: "2026-10-23T00:41:00Z",
            id: 611756175,
            name: "deploy-1",
            networks: { v4: [{ ip_address: "10.0.0.5", type: "private" }] },
            region: { slug: "nyc3" },
            size: {
              disk: 80,
              memory: 4096,
              price_hourly: 0.03571,
              price_monthly: 24,
              slug: "s-2vcpu-4gb",
              vcpus: 2,
            },
            status: "active",
          },
        }) as T,
    };
    const provider = createDigitalOceanInfrastructureProvider({
      client,
      regions: [{ image: "x", region: "nyc3", size: "s-2vcpu-4gb", sshKeys: [] }],
      tag: "fleet",
    });
    const node = await provider.getNode("digitalocean:611756175");
    expect(node.createdAt).toBe("2026-10-23T00:41:00Z");
    expect(node.size).toEqual({
      currency: "USD",
      diskGb: 80,
      memoryMb: 4096,
      priceHourlyMicros: 35_710,
      priceMonthlyMicros: 24_000_000,
      slug: "s-2vcpu-4gb",
      vcpus: 2,
    });
    expect(provider.billing).toBeDefined();
  });
});
