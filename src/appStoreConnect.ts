import { createHash, createPrivateKey, sign } from "node:crypto";
import path from "node:path";
import type {
  NativeReleaseBlobStore,
  NativeReleasePublication,
} from "./nativeRelease";

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_RECEIPT_PREFIX = "absolutejs/app-store-connect-receipts";
const RECEIPT_FORMAT = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type AppStoreConnectAuth = {
  issuerId: string;
  keyId: string;
  privateKey: string;
};

export type AppStoreConnectReleaseTarget = {
  groups?: readonly string[];
  submitForReview?: boolean;
  whatsNew?: readonly { locale: string; text: string }[];
};

export type AppStoreConnectReleaseIntent = {
  groups: string[];
  submitForReview: boolean;
  whatsNew: Array<{ locale: string; text: string }>;
};

export type AppStoreConnectBuild = {
  id: string;
  processingState: "PROCESSING" | "FAILED" | "INVALID" | "VALID";
  version: string;
};

export type AppStoreConnectBuildUpload = {
  id: string;
  state: "AWAITING_UPLOAD" | "PROCESSING" | "FAILED" | "COMPLETE";
};

export type AppStoreConnectTestFlightGroup = {
  hasAccessToAllBuilds: boolean;
  id: string;
  isInternal: boolean;
  name: string;
};

export type AppStoreConnectReleaseReceipt = {
  appleAppId: string;
  buildId?: string;
  buildNumber: number;
  buildUploadFileId?: string;
  buildUploadId?: string;
  format: typeof RECEIPT_FORMAT;
  intent: AppStoreConnectReleaseIntent;
  marketingVersion: string;
  provider: "app-store-connect";
  releaseId: string;
  sha256: string;
  stage:
    | "preparing"
    | "uploading"
    | "processing"
    | "distributed"
    | "review-submitted";
  updatedAt: string;
};

export type AppStoreConnectClient = {
  addBuildToGroup(options: {
    buildId: string;
    groupId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  commitBuildUploadFile(options: {
    fileId: string;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<void>;
  createBuildUpload(options: {
    appId: string;
    buildNumber: number;
    marketingVersion: string;
    signal?: AbortSignal;
  }): Promise<AppStoreConnectBuildUpload>;
  createBuildUploadFile(options: {
    buildUploadId: string;
    bytes: number;
    fileName: string;
    signal?: AbortSignal;
  }): Promise<string>;
  findAppId(options: {
    bundleId: string;
    signal?: AbortSignal;
  }): Promise<string>;
  findBuild(options: {
    appId: string;
    buildNumber: number;
    signal?: AbortSignal;
  }): Promise<AppStoreConnectBuild | null>;
  findBuildUploadFile(options: {
    buildUploadId: string;
    signal?: AbortSignal;
  }): Promise<string | null>;
  findBuildUpload(options: {
    appId: string;
    buildNumber: number;
    marketingVersion: string;
    signal?: AbortSignal;
  }): Promise<AppStoreConnectBuildUpload | null>;
  getBuildUpload(options: {
    buildUploadId: string;
    signal?: AbortSignal;
  }): Promise<AppStoreConnectBuildUpload>;
  hasBetaReviewSubmission(options: {
    buildId: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
  listBuildNumbers(options: {
    appId: string;
    signal?: AbortSignal;
  }): Promise<number[]>;
  resolveGroups(options: {
    appId: string;
    groups: readonly string[];
    signal?: AbortSignal;
  }): Promise<AppStoreConnectTestFlightGroup[]>;
  submitBetaReview(options: {
    buildId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  uploadBuildFile(options: {
    artifactPath: string;
    fileId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  upsertWhatsNew(options: {
    buildId: string;
    locale: string;
    signal?: AbortSignal;
    text: string;
  }): Promise<void>;
};

type NativePublisherBase = {
  publish(options: {
    allowUnsigned?: boolean;
    channel?: string;
    releaseRoot: string;
    signal?: AbortSignal;
    [key: string]: unknown;
  }): Promise<NativeReleasePublication>;
};

export type AppStoreConnectReleasePublisherOptions = {
  auth?: AppStoreConnectAuth;
  client?: AppStoreConnectClient;
  clock?: () => Date;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  receiptPrefix?: string;
  receiptStore: NativeReleaseBlobStore;
  registry: NativePublisherBase;
  target?: AppStoreConnectReleaseTarget;
};

export type AppStoreConnectNativeReleasePublication =
  NativeReleasePublication & {
    appStoreConnect?: {
      receipt: AppStoreConnectReleaseReceipt;
      reused: boolean;
    };
  };

export type AppStoreConnectNativeReleasePublisher = Omit<
  NativePublisherBase,
  "publish"
> & {
  prepareIosRelease(options: {
    buildIdentity: string;
    bundleId: string;
    marketingVersion: string;
    signal?: AbortSignal;
  }): Promise<{ buildNumber: number }>;
  publish(options: {
    allowUnsigned?: boolean;
    appStoreConnect?: AppStoreConnectReleaseTarget;
    channel?: string;
    releaseRoot: string;
    signal?: AbortSignal;
    [key: string]: unknown;
  }): Promise<AppStoreConnectNativeReleasePublication>;
};

export class AppStoreConnectReleaseError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AppStoreConnectReleaseError";
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const encodedJson = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const decodedJson = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as unknown;
const sha256Bytes = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const hashIdentity = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const normalizedPrefix = (value: string) => {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (
    !prefix ||
    prefix.split("/").some((part) => part === "." || part === "..")
  )
    throw new AppStoreConnectReleaseError(
      "App Store Connect receipt prefix is invalid",
    );
  return prefix;
};

const normalizedIntent = (
  target: AppStoreConnectReleaseTarget = {},
): AppStoreConnectReleaseIntent => {
  const groups = [
    ...new Set((target.groups ?? []).map((value) => value.trim())),
  ].sort();
  if (groups.some((value) => !value))
    throw new AppStoreConnectReleaseError(
      "TestFlight group names or IDs must not be empty",
    );
  const locales = new Set<string>();
  const whatsNew = [...(target.whatsNew ?? [])]
    .map(({ locale, text }) => ({ locale: locale.trim(), text: text.trim() }))
    .sort((left, right) => left.locale.localeCompare(right.locale));
  for (const item of whatsNew) {
    if (!item.locale || !item.text || locales.has(item.locale))
      throw new AppStoreConnectReleaseError(
        "TestFlight notes require unique locales and non-empty text",
      );
    locales.add(item.locale);
  }
  if (target.submitForReview && groups.length === 0)
    throw new AppStoreConnectReleaseError(
      "TestFlight beta review requires at least one external group",
    );
  return { groups, submitForReview: target.submitForReview ?? false, whatsNew };
};

const parseReceipt = (value: unknown): AppStoreConnectReleaseReceipt => {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.provider !== "app-store-connect" ||
    typeof value.appleAppId !== "string" ||
    typeof value.releaseId !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.buildNumber) ||
    Number(value.buildNumber) < 1 ||
    typeof value.marketingVersion !== "string" ||
    !isIsoTimestamp(value.updatedAt) ||
    ![
      "preparing",
      "uploading",
      "processing",
      "distributed",
      "review-submitted",
    ].includes(String(value.stage)) ||
    !isRecord(value.intent)
  )
    throw new AppStoreConnectReleaseError(
      "App Store Connect release receipt is invalid",
    );
  for (const field of ["buildId", "buildUploadFileId", "buildUploadId"])
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw new AppStoreConnectReleaseError(
        "App Store Connect release receipt is invalid",
      );
  const buildId = typeof value.buildId === "string" ? value.buildId : undefined;
  const buildUploadFileId =
    typeof value.buildUploadFileId === "string"
      ? value.buildUploadFileId
      : undefined;
  const buildUploadId =
    typeof value.buildUploadId === "string" ? value.buildUploadId : undefined;
  return {
    appleAppId: value.appleAppId,
    buildNumber: Number(value.buildNumber),
    format: 1,
    intent: normalizedIntent(value.intent as AppStoreConnectReleaseTarget),
    marketingVersion: value.marketingVersion,
    provider: "app-store-connect",
    releaseId: value.releaseId,
    sha256: value.sha256,
    stage: value.stage as AppStoreConnectReleaseReceipt["stage"],
    updatedAt: value.updatedAt,
    ...(buildId ? { buildId } : {}),
    ...(buildUploadFileId ? { buildUploadFileId } : {}),
    ...(buildUploadId ? { buildUploadId } : {}),
  };
};

const base64url = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");
const createTokenProvider = (auth: AppStoreConnectAuth, clock: () => Date) => {
  if (!auth.issuerId || !auth.keyId || !auth.privateKey)
    throw new AppStoreConnectReleaseError(
      "App Store Connect API credentials are incomplete",
    );
  const key = createPrivateKey(auth.privateKey);
  return () => {
    const issuedAt = Math.floor(clock().getTime() / 1000);
    const header = base64url(
      JSON.stringify({ alg: "ES256", kid: auth.keyId, typ: "JWT" }),
    );
    const claims = base64url(
      JSON.stringify({
        aud: "appstoreconnect-v1",
        exp: issuedAt + 1199,
        iat: issuedAt,
        iss: auth.issuerId,
      }),
    );
    const payload = `${header}.${claims}`;
    return `${payload}.${base64url(sign("sha256", Buffer.from(payload), { dsaEncoding: "ieee-p1363", key }))}`;
  };
};

const responseError = async (response: Response) => {
  const body = await response.text().catch(() => "");
  return new AppStoreConnectReleaseError(
    `App Store Connect request failed (${response.status})${body ? `: ${body}` : ""}`,
    response.status,
  );
};

export const createAppStoreConnectClient = (options: {
  auth: AppStoreConnectAuth;
  clock?: () => Date;
  fetch?: typeof fetch;
}): AppStoreConnectClient => {
  const requestFetch = options.fetch ?? fetch;
  const token = createTokenProvider(
    options.auth,
    options.clock ?? (() => new Date()),
  );
  const request = async (route: string, init: RequestInit = {}) => {
    const response = await requestFetch(`${API_ROOT}${route}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await responseError(response);
    return response.status === 204 ? undefined : await response.json();
  };
  const dataList = async (route: string) => {
    const result: Record<string, unknown>[] = [];
    let next: string | undefined = route;
    while (next) {
      const page = (await request(
        next.startsWith(API_ROOT) ? next.slice(API_ROOT.length) : next,
      )) as Record<string, unknown>;
      if (Array.isArray(page.data)) result.push(...page.data.filter(isRecord));
      const links = isRecord(page.links) ? page.links : undefined;
      next = typeof links?.next === "string" ? links.next : undefined;
    }
    return result;
  };
  const buildFrom = (data: Record<string, unknown>): AppStoreConnectBuild => {
    const attributes = isRecord(data.attributes) ? data.attributes : {};
    return {
      id: String(data.id),
      processingState: String(
        attributes.processingState,
      ) as AppStoreConnectBuild["processingState"],
      version: String(attributes.version),
    };
  };
  const uploadFrom = (
    data: Record<string, unknown>,
  ): AppStoreConnectBuildUpload => {
    const attributes = isRecord(data.attributes) ? data.attributes : {};
    const state = isRecord(attributes.state)
      ? attributes.state.state
      : attributes.state;
    return {
      id: String(data.id),
      state: String(state) as AppStoreConnectBuildUpload["state"],
    };
  };

  return {
    findAppId: async ({ bundleId, signal }) => {
      const items = await dataList(
        `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=2`,
      );
      const exact = items.filter(
        (item) =>
          isRecord(item.attributes) && item.attributes.bundleId === bundleId,
      );
      if (exact.length !== 1)
        throw new AppStoreConnectReleaseError(
          `Expected one App Store Connect app for bundle ID ${bundleId}`,
        );
      signal?.throwIfAborted();
      return String(exact[0]!.id);
    },
    listBuildNumbers: async ({ appId, signal }) => {
      signal?.throwIfAborted();
      const items = await dataList(
        `/builds?filter[app]=${encodeURIComponent(appId)}&fields[builds]=version&limit=200`,
      );
      return items
        .map((item) =>
          Number(isRecord(item.attributes) ? item.attributes.version : NaN),
        )
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    },
    findBuild: async ({ appId, buildNumber, signal }) => {
      signal?.throwIfAborted();
      const items = await dataList(
        `/builds?filter[app]=${encodeURIComponent(appId)}&filter[version]=${buildNumber}&fields[builds]=version,processingState&limit=2`,
      );
      return items.length ? buildFrom(items[0]!) : null;
    },
    findBuildUpload: async ({
      appId,
      buildNumber,
      marketingVersion,
      signal,
    }) => {
      signal?.throwIfAborted();
      const items = await dataList(
        `/apps/${encodeURIComponent(appId)}/buildUploads?filter[cfBundleVersion]=${buildNumber}&filter[cfBundleShortVersionString]=${encodeURIComponent(marketingVersion)}&filter[platform]=IOS&fields[buildUploads]=state,cfBundleVersion,cfBundleShortVersionString&limit=2`,
      );
      return items.length ? uploadFrom(items[0]!) : null;
    },
    createBuildUpload: async ({
      appId,
      buildNumber,
      marketingVersion,
      signal,
    }) => {
      const response = (await request("/buildUploads", {
        method: "POST",
        signal,
        body: JSON.stringify({
          data: {
            type: "buildUploads",
            attributes: {
              cfBundleVersion: String(buildNumber),
              cfBundleShortVersionString: marketingVersion,
              platform: "IOS",
            },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        }),
      })) as Record<string, unknown>;
      return uploadFrom(response.data as Record<string, unknown>);
    },
    getBuildUpload: async ({ buildUploadId, signal }) => {
      const response = (await request(
        `/buildUploads/${encodeURIComponent(buildUploadId)}?fields[buildUploads]=state`,
        { signal },
      )) as Record<string, unknown>;
      return uploadFrom(response.data as Record<string, unknown>);
    },
    createBuildUploadFile: async ({
      buildUploadId,
      bytes,
      fileName,
      signal,
    }) => {
      const response = (await request("/buildUploadFiles", {
        method: "POST",
        signal,
        body: JSON.stringify({
          data: {
            type: "buildUploadFiles",
            attributes: {
              assetType: "ASSET",
              fileName,
              fileSize: bytes,
              uti: "com.apple.ipa",
            },
            relationships: {
              buildUpload: {
                data: { type: "buildUploads", id: buildUploadId },
              },
            },
          },
        }),
      })) as Record<string, unknown>;
      return String((response.data as Record<string, unknown>).id);
    },
    findBuildUploadFile: async ({ buildUploadId, signal }) => {
      signal?.throwIfAborted();
      const items = await dataList(
        `/buildUploads/${encodeURIComponent(buildUploadId)}/buildUploadFiles?fields[buildUploadFiles]=fileName&limit=2`,
      );
      return items.length ? String(items[0]!.id) : null;
    },
    uploadBuildFile: async ({ artifactPath, fileId, signal }) => {
      const response = (await request(
        `/buildUploadFiles/${encodeURIComponent(fileId)}?fields[buildUploadFiles]=uploadOperations`,
        { signal },
      )) as Record<string, unknown>;
      const data = response.data as Record<string, unknown>;
      const attrs = isRecord(data.attributes) ? data.attributes : {};
      const operations = Array.isArray(attrs.uploadOperations)
        ? attrs.uploadOperations.filter(isRecord)
        : [];
      if (!operations.length)
        throw new AppStoreConnectReleaseError(
          "App Store Connect returned no IPA upload operations",
        );
      // Apple assembles the package from these operations in order, so upload
      // them sequentially rather than concurrently. Send a materialized
      // Uint8Array (not a Bun.file Blob slice) so fetch does not attach its own
      // Content-Type, which would conflict with the signed operation headers.
      for (const operation of operations) {
        const offset = Number(operation.offset);
        const length = Number(operation.length);
        const headers = new Headers();
        if (Array.isArray(operation.requestHeaders))
          for (const entry of operation.requestHeaders)
            if (isRecord(entry))
              headers.set(String(entry.name), String(entry.value));
        const chunk = new Uint8Array(
          await Bun.file(artifactPath)
            .slice(offset, offset + length)
            .arrayBuffer(),
        );
        const upload = await requestFetch(String(operation.url), {
          method: String(operation.method),
          headers,
          body: chunk,
          signal,
        });
        if (!upload.ok) throw await responseError(upload);
      }
    },
    commitBuildUploadFile: async ({ fileId, sha256, signal }) => {
      await request(`/buildUploadFiles/${encodeURIComponent(fileId)}`, {
        method: "PATCH",
        signal,
        body: JSON.stringify({
          data: {
            type: "buildUploadFiles",
            id: fileId,
            // Apple's Build Upload completion accepts only `uploaded: true`;
            // sending `sourceFileChecksums` is rejected with HTTP 409. Per-chunk
            // integrity is enforced by the upload-operation request headers and
            // Apple's own post-assembly package validation. The `sha256` arg is
            // retained for the caller's release receipt, not sent here.
            attributes: {
              uploaded: true,
            },
          },
        }),
      });
    },
    resolveGroups: async ({ appId, groups, signal }) => {
      signal?.throwIfAborted();
      const items = await dataList(
        `/betaGroups?filter[app]=${encodeURIComponent(appId)}&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds&limit=200`,
      );
      return groups.map((requested) => {
        const matches = items.filter(
          (item) =>
            item.id === requested ||
            (isRecord(item.attributes) && item.attributes.name === requested),
        );
        if (matches.length !== 1)
          throw new AppStoreConnectReleaseError(
            `Expected one TestFlight group matching ${requested}`,
          );
        const item = matches[0]!;
        const attributes = item.attributes as Record<string, unknown>;
        return {
          hasAccessToAllBuilds: attributes.hasAccessToAllBuilds === true,
          id: String(item.id),
          isInternal: attributes.isInternalGroup === true,
          name: String(attributes.name),
        };
      });
    },
    addBuildToGroup: async ({ buildId, groupId, signal }) => {
      await request(
        `/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
        {
          method: "POST",
          signal,
          body: JSON.stringify({ data: [{ type: "builds", id: buildId }] }),
        },
      );
    },
    upsertWhatsNew: async ({ buildId, locale, text, signal }) => {
      const items = await dataList(
        `/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale,whatsNew&limit=200`,
      );
      const existing = items.find(
        (item) =>
          isRecord(item.attributes) && item.attributes.locale === locale,
      );
      if (existing) {
        await request(
          `/betaBuildLocalizations/${encodeURIComponent(String(existing.id))}`,
          {
            method: "PATCH",
            signal,
            body: JSON.stringify({
              data: {
                type: "betaBuildLocalizations",
                id: existing.id,
                attributes: { whatsNew: text },
              },
            }),
          },
        );
      } else {
        await request("/betaBuildLocalizations", {
          method: "POST",
          signal,
          body: JSON.stringify({
            data: {
              type: "betaBuildLocalizations",
              attributes: { locale, whatsNew: text },
              relationships: {
                build: { data: { type: "builds", id: buildId } },
              },
            },
          }),
        });
      }
    },
    submitBetaReview: async ({ buildId, signal }) => {
      await request("/betaAppReviewSubmissions", {
        method: "POST",
        signal,
        body: JSON.stringify({
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: { data: { type: "builds", id: buildId } } },
          },
        }),
      });
    },
    hasBetaReviewSubmission: async ({ buildId, signal }) => {
      const response = (await request(
        `/builds/${encodeURIComponent(buildId)}/relationships/betaAppReviewSubmission`,
        { signal },
      )) as Record<string, unknown>;
      return isRecord(response.data) && typeof response.data.id === "string";
    },
  };
};

export const createAppStoreConnectReleasePublisher = (
  options: AppStoreConnectReleasePublisherOptions,
): AppStoreConnectNativeReleasePublisher => {
  const clock = options.clock ?? (() => new Date());
  const client =
    options.client ??
    (options.auth
      ? createAppStoreConnectClient({ auth: options.auth, clock })
      : undefined);
  if (!client)
    throw new AppStoreConnectReleaseError(
      "App Store Connect auth or client is required",
    );
  const prefix = normalizedPrefix(
    options.receiptPrefix ?? DEFAULT_RECEIPT_PREFIX,
  );
  const maxWaitMs = options.maxWaitMs ?? 20 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const preparationKey = (bundleId: string, buildIdentity: string) =>
    `${prefix}/${hashIdentity(bundleId)}/preparations/${hashIdentity(buildIdentity)}.json`;
  const receiptKey = (
    appId: string,
    releaseId: string,
    intent: AppStoreConnectReleaseIntent,
  ) =>
    `${prefix}/${hashIdentity(appId)}/${releaseId}/${hashIdentity(JSON.stringify(intent))}.json`;
  const readStored = async (key: string) => {
    const bytes = await options.receiptStore.get(key);
    if (!bytes) return null;
    const head = await options.receiptStore.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== sha256Bytes(bytes)
    )
      throw new AppStoreConnectReleaseError(
        "Stored App Store Connect state failed integrity verification",
      );
    return decodedJson(bytes);
  };
  const writeStored = async (key: string, value: unknown, type: string) => {
    const bytes = encodedJson(value);
    await options.receiptStore.put(key, bytes, {
      cacheControl: "no-cache",
      contentType: "application/json",
      maxBytes: bytes.byteLength,
      metadata: { sha256: sha256Bytes(bytes), type },
    });
  };
  const waitForBuild = async (
    appId: string,
    buildNumber: number,
    buildUploadId: string,
    signal?: AbortSignal,
  ) => {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() <= deadline) {
      signal?.throwIfAborted();
      const build = await client.findBuild({ appId, buildNumber, signal });
      if (build?.processingState === "VALID") return build;
      if (
        build &&
        (build.processingState === "FAILED" ||
          build.processingState === "INVALID")
      )
        throw new AppStoreConnectReleaseError(
          `Apple rejected build ${buildNumber} during processing (${build.processingState})`,
        );
      const upload = await client.getBuildUpload({ buildUploadId, signal });
      if (upload.state === "FAILED")
        throw new AppStoreConnectReleaseError(
          `Apple rejected build upload ${buildUploadId}`,
        );
      await Bun.sleep(pollIntervalMs);
    }
    throw new AppStoreConnectReleaseError(
      `Timed out waiting for Apple to process build ${buildNumber}`,
    );
  };

  return {
    ...options.registry,
    prepareIosRelease: async ({ buildIdentity, bundleId, signal }) => {
      if (!buildIdentity)
        throw new AppStoreConnectReleaseError(
          "App Store Connect build identity is invalid",
        );
      const key = preparationKey(bundleId, buildIdentity);
      const stored = await readStored(key);
      if (
        isRecord(stored) &&
        stored.bundleId === bundleId &&
        stored.buildIdentity === buildIdentity &&
        Number.isSafeInteger(stored.buildNumber) &&
        Number(stored.buildNumber) > 0
      )
        return { buildNumber: Number(stored.buildNumber) };
      const appleAppId = await client.findAppId({ bundleId, signal });
      const numbers = await client.listBuildNumbers({
        appId: appleAppId,
        signal,
      });
      const highest = numbers.reduce(
        (maximum, value) => Math.max(maximum, value),
        0,
      );
      if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER)
        throw new AppStoreConnectReleaseError(
          "App Store Connect cannot allocate another iOS build number",
        );
      const buildNumber = highest + 1;
      await writeStored(
        key,
        {
          appleAppId,
          buildIdentity,
          buildNumber,
          bundleId,
          format: 1,
          preparedAt: clock().toISOString(),
        },
        "app-store-connect-build-preparation",
      );
      return { buildNumber };
    },
    publish: async (input) => {
      const publication = await options.registry.publish(input);
      const metadata = publication.record.metadata;
      const target =
        (input.appStoreConnect as AppStoreConnectReleaseTarget | undefined) ??
        options.target;
      if (!target) return publication;
      if (metadata.platform !== "ios" || metadata.type !== "ipa")
        throw new AppStoreConnectReleaseError(
          "App Store Connect publishing requires an iOS IPA release",
        );
      if (!metadata.signed || !metadata.buildNumber)
        throw new AppStoreConnectReleaseError(
          "App Store Connect publishing requires a signed, versioned IPA",
        );
      const intent = normalizedIntent(target);
      const appleAppId = await client.findAppId({
        bundleId: metadata.appId,
        signal: input.signal,
      });
      const key = receiptKey(appleAppId, metadata.releaseId, intent);
      const existingValue = await readStored(key);
      let receipt = existingValue
        ? parseReceipt(existingValue)
        : {
            appleAppId,
            buildNumber: metadata.buildNumber,
            format: 1 as const,
            intent,
            marketingVersion: metadata.marketingVersion,
            provider: "app-store-connect" as const,
            releaseId: metadata.releaseId,
            sha256: metadata.sha256,
            stage: "preparing" as const,
            updatedAt: clock().toISOString(),
          };
      const writeReceipt = async (
        values: Partial<AppStoreConnectReleaseReceipt>,
      ) => {
        receipt = { ...receipt, ...values, updatedAt: clock().toISOString() };
        await writeStored(key, receipt, "app-store-connect-release-receipt");
      };
      if (
        receipt.stage === "distributed" ||
        receipt.stage === "review-submitted"
      )
        return { ...publication, appStoreConnect: { receipt, reused: true } };
      let upload = receipt.buildUploadId
        ? await client.getBuildUpload({
            buildUploadId: receipt.buildUploadId,
            signal: input.signal,
          })
        : await client.findBuildUpload({
            appId: appleAppId,
            buildNumber: metadata.buildNumber,
            marketingVersion: metadata.marketingVersion,
            signal: input.signal,
          });
      if (!upload)
        upload = await client.createBuildUpload({
          appId: appleAppId,
          buildNumber: metadata.buildNumber,
          marketingVersion: metadata.marketingVersion,
          signal: input.signal,
        });
      await writeReceipt({ buildUploadId: upload.id, stage: "uploading" });
      let build = await client.findBuild({
        appId: appleAppId,
        buildNumber: metadata.buildNumber,
        signal: input.signal,
      });
      if (!build || build.processingState !== "VALID") {
        let fileId = receipt.buildUploadFileId;
        if (!fileId) {
          fileId =
            (await client.findBuildUploadFile({
              buildUploadId: upload.id,
              signal: input.signal,
            })) ??
            (await client.createBuildUploadFile({
              buildUploadId: upload.id,
              bytes: metadata.bytes,
              fileName: metadata.artifact,
              signal: input.signal,
            }));
          await writeReceipt({ buildUploadFileId: fileId });
        }
        if (upload.state === "AWAITING_UPLOAD") {
          const artifactPath = path.join(input.releaseRoot, metadata.artifact);
          await client.uploadBuildFile({
            artifactPath,
            fileId,
            signal: input.signal,
          });
          await client.commitBuildUploadFile({
            fileId,
            sha256: metadata.sha256,
            signal: input.signal,
          });
        }
        await writeReceipt({ stage: "processing" });
        build = await waitForBuild(
          appleAppId,
          metadata.buildNumber,
          upload.id,
          input.signal,
        );
      }
      await writeReceipt({ buildId: build.id });
      const groups = await client.resolveGroups({
        appId: appleAppId,
        groups: intent.groups,
        signal: input.signal,
      });
      if (intent.submitForReview && groups.some((group) => group.isInternal))
        throw new AppStoreConnectReleaseError(
          "TestFlight beta review may only be requested for external groups",
        );
      for (const note of intent.whatsNew)
        await client.upsertWhatsNew({
          buildId: build.id,
          locale: note.locale,
          text: note.text,
          signal: input.signal,
        });
      // Internal groups with "access to all builds" automatically include every
      // processed build; Apple rejects an explicit assignment to them with HTTP
      // 422 ("Cannot add internal group to a build"), so skip them.
      for (const group of groups)
        if (!group.hasAccessToAllBuilds)
          await client.addBuildToGroup({
            buildId: build.id,
            groupId: group.id,
            signal: input.signal,
          });
      if (
        intent.submitForReview &&
        !(await client.hasBetaReviewSubmission({
          buildId: build.id,
          signal: input.signal,
        }))
      )
        await client.submitBetaReview({
          buildId: build.id,
          signal: input.signal,
        });
      await writeReceipt({
        stage: intent.submitForReview ? "review-submitted" : "distributed",
      });
      return { ...publication, appStoreConnect: { receipt, reused: false } };
    },
  };
};
