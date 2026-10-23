/** The DigitalOcean account's bill: invoices and their per-resource lines. */
import { createHash } from "node:crypto";
import type { DigitalOceanClientLike } from "./digitalocean";
import {
  amountToMicros,
  type InfrastructureBilling,
  type InfrastructureBillLine,
  type InfrastructureInvoice,
} from "./infrastructure";

type DigitalOceanInvoiceSummary = {
  amount: string;
  invoice_period: string;
  invoice_uuid: string;
};

type DigitalOceanInvoiceItem = {
  amount: string;
  category?: string;
  description: string;
  duration?: string;
  duration_unit?: string;
  end_time?: string;
  group_description?: string;
  product: string;
  project_name?: string;
  resource_id?: string;
  resource_uuid?: string;
  start_time?: string;
};

type Page = { links?: { pages?: { next?: string } } };

const PER_PAGE = 200;
const MAX_PAGES = 500;
const FINGERPRINT_LENGTH = 32;
const HOURS_PER_DAY = 24;
const INVOICE_REFERENCE = /^(preview|[0-9a-f-]{36})$/i;

const text = (value: string | undefined) => value?.trim() || null;

/** A line's identity within its invoice, computed exactly as Management's
 *  DigitalOcean import does so both sides name the same line identically. */
export const digitalOceanLineFingerprint = (item: DigitalOceanInvoiceItem) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        item.product,
        item.description,
        item.start_time,
        item.resource_id,
      ]),
    )
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);

const durationHours = (item: DigitalOceanInvoiceItem) => {
  if (!item.duration) return null;
  const amount = Number(item.duration);
  if (!Number.isFinite(amount)) return null;
  const unit = item.duration_unit?.toLowerCase() ?? "";
  if (unit.startsWith("hour")) return amount;
  if (unit.startsWith("day")) return amount * HOURS_PER_DAY;

  return null;
};

export const createDigitalOceanBilling = ({
  client,
}: {
  client: DigitalOceanClientLike;
}): InfrastructureBilling => {
  const allPages = async <T>(path: string, field: string) => {
    const rows: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const body = await client.request<Page & Record<string, unknown>>(
        "GET",
        `${path}${separator}per_page=${PER_PAGE}&page=${page}`,
      );
      const items = body[field];
      if (!Array.isArray(items))
        throw new Error(
          `[deploy/digitalocean] billing response has no ${field}`,
        );
      rows.push(...(items as T[]));
      if (!body.links?.pages?.next || items.length === 0) return rows;
    }
    throw new Error("[deploy/digitalocean] billing exceeds the page limit");
  };

  const listInvoices = async (): Promise<InfrastructureInvoice[]> => {
    const first = await client.request<{
      invoice_preview?: DigitalOceanInvoiceSummary;
    }>("GET", `/customers/my/invoices?per_page=1`);
    const finals = await allPages<DigitalOceanInvoiceSummary>(
      "/customers/my/invoices",
      "invoices",
    );
    const invoices: InfrastructureInvoice[] = finals.map((invoice) => ({
      amountMicros: amountToMicros(invoice.amount),
      currency: "USD",
      id: invoice.invoice_uuid,
      period: invoice.invoice_period,
      preview: false,
    }));
    if (first.invoice_preview)
      invoices.push({
        amountMicros: amountToMicros(first.invoice_preview.amount),
        currency: "USD",
        id: "preview",
        period: first.invoice_preview.invoice_period,
        preview: true,
      });

    return invoices;
  };

  const listInvoiceLines = async (
    invoiceId: string,
  ): Promise<InfrastructureBillLine[]> => {
    if (!INVOICE_REFERENCE.test(invoiceId))
      throw new Error("[deploy/digitalocean] invalid invoice reference");
    // Lines carry no billing month; their invoice's month is the period.
    const period =
      (await listInvoices()).find((invoice) => invoice.id === invoiceId)
        ?.period ?? null;
    const items = await allPages<DigitalOceanInvoiceItem>(
      `/customers/my/invoices/${invoiceId}`,
      "invoice_items",
    );
    const occurrences = new Map<string, number>();

    return items.map((item) => {
      const hash = digitalOceanLineFingerprint(item);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);

      return {
        amountMicros: amountToMicros(item.amount),
        category: text(item.category) ?? text(item.group_description),
        currency: "USD",
        description: item.description,
        durationHours: durationHours(item),
        endTime: text(item.end_time),
        fingerprint: `${hash}:${occurrence}`,
        invoiceId,
        period:
          period ?? item.start_time?.slice(0, 7) ?? item.end_time?.slice(0, 7) ?? "",
        product: item.product,
        projectName: text(item.project_name),
        resourceId: text(item.resource_id),
        resourceUuid: text(item.resource_uuid),
        startTime: text(item.start_time),
      };
    });
  };

  return { listInvoiceLines, listInvoices };
};
