/** Shared compute-fleet contract implemented by every cloud adapter. */
export type InfrastructureNodeState = "pending" | "ready" | "terminated";

/** A node's size as its provider bills it. Prices are integer micros
 *  (millionths of the currency unit), so cost arithmetic stays exact. */
export type InfrastructureNodeSize = {
  currency: string;
  diskGb: number;
  memoryMb: number;
  priceHourlyMicros: number;
  priceMonthlyMicros: number;
  slug: string;
  vcpus: number;
};

export type InfrastructureNode = {
  id: string;
  label: string;
  provider: string;
  region: string;
  state: InfrastructureNodeState;
  publicIpv4?: string;
  privateIpv4?: string;
  agent?: {
    audience?: string;
    url: string;
  };
  /** When the provider created the node (ISO 8601). */
  createdAt?: string;
  size?: InfrastructureNodeSize;
};

export type InfrastructureProviderCapabilities = {
  cloudInit: boolean;
  idempotentProvisioning: boolean;
  privateNetworking: boolean;
  regionalPlacement: boolean;
  regions: readonly string[];
};

export type ProvisionInfrastructureNode = {
  idempotencyKey: string;
  name: string;
  region?: string;
  /** Per-host bootstrap configuration, overriding the region default. */
  userData?: string;
};

/** One invoice, or the provider's running preview of the open month. */
export type InfrastructureInvoice = {
  amountMicros: number;
  currency: string;
  /** `preview` for the open month, else the provider's invoice id. */
  id: string;
  /** The billing month, `YYYY-MM`. */
  period: string;
  preview: boolean;
};

/** One invoice line: what one resource cost over a span. */
export type InfrastructureBillLine = {
  amountMicros: number;
  /** The provider's own grouping, e.g. "Droplets" or "Spaces". */
  category: string | null;
  currency: string;
  description: string;
  durationHours: number | null;
  endTime: string | null;
  /** Stable within an invoice; identical lines differ by their `:n` suffix. */
  fingerprint: string;
  invoiceId: string;
  period: string;
  product: string;
  projectName: string | null;
  /** The provider's resource id (a droplet's numeric id on DigitalOcean). */
  resourceId: string | null;
  resourceUuid: string | null;
  startTime: string | null;
};

/** Read access to the account's bill, where the provider offers one. */
export type InfrastructureBilling = {
  listInvoiceLines: (invoiceId: string) => Promise<InfrastructureBillLine[]>;
  /** Final invoices, newest first, then the open month's preview. */
  listInvoices: () => Promise<InfrastructureInvoice[]>;
};

export type InfrastructureProvider = {
  /** The account's bill, when the provider exposes one. */
  billing?: InfrastructureBilling;
  capabilities: InfrastructureProviderCapabilities;
  getNode: (id: string) => Promise<InfrastructureNode>;
  listNodes: () => Promise<InfrastructureNode[]>;
  name: string;
  provisionNode: (
    request: ProvisionInfrastructureNode,
  ) => Promise<InfrastructureNode>;
  terminateNode: (id: string, idempotencyKey: string) => Promise<void>;
};

const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;
const MICROS_PER_UNIT = 1_000_000;
const MICRO_DIGITS = 6;

/** A decimal currency amount ("12.34", -0.5, "0.0012") as integer micros,
 *  parsed from its digits so no float rounding enters a bill. */
export const amountToMicros = (value: string | number) => {
  const text =
    typeof value === "number" ? value.toFixed(MICRO_DIGITS) : value.trim();
  const match = DECIMAL_AMOUNT.exec(text);
  if (!match) throw new Error(`[deploy] invalid currency amount: ${value}`);
  const [, sign, whole = "0", fraction = ""] = match;
  const digits = fraction.padEnd(MICRO_DIGITS + 1, "0");
  let micros =
    Number(whole) * MICROS_PER_UNIT + Number(digits.slice(0, MICRO_DIGITS));
  // Half away from zero on the seventh digit.
  if (Number(digits[MICRO_DIGITS]) >= 5) micros += 1;
  if (!Number.isSafeInteger(micros))
    throw new Error(`[deploy] currency amount out of range: ${value}`);

  return sign === "-" && micros !== 0 ? -micros : micros;
};
