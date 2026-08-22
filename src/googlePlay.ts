import { createHash } from "node:crypto";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import type {
  NativeReleaseBlobStore,
  NativeReleasePublication,
} from "./nativeRelease";

const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_ROOT =
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const DEFAULT_RECEIPT_PREFIX = "absolutejs/google-play-receipts";
const RECEIPT_FORMAT = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRACK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_UPLOAD_ATTEMPTS = 8;

export type GooglePlayReleaseStatus =
  | "completed"
  | "draft"
  | "halted"
  | "inProgress";

export type GooglePlayReviewBehavior =
  | "CANCEL_IN_REVIEW_AND_SUBMIT"
  | "ERROR_IF_IN_REVIEW";

const RELEASE_STATUSES = new Set<GooglePlayReleaseStatus>([
  "completed",
  "draft",
  "halted",
  "inProgress",
]);
const REVIEW_BEHAVIORS = new Set<GooglePlayReviewBehavior>([
  "CANCEL_IN_REVIEW_AND_SUBMIT",
  "ERROR_IF_IN_REVIEW",
]);

export type GooglePlayReleaseTarget = {
  changesNotSentForReview?: boolean;
  inAppUpdatePriority?: number;
  name?: string;
  releaseNotes?: readonly { language: string; text: string }[];
  reviewBehavior?: GooglePlayReviewBehavior;
  status?: GooglePlayReleaseStatus;
  track: string;
  userFraction?: number;
};

export type GooglePlayReleaseIntent = {
  changesNotSentForReview: boolean;
  inAppUpdatePriority: number;
  name?: string;
  releaseNotes: Array<{ language: string; text: string }>;
  reviewBehavior: GooglePlayReviewBehavior;
  status: GooglePlayReleaseStatus;
  track: string;
  userFraction?: number;
};

export type GooglePlayReleaseReceipt = {
  editExpiresAt?: string;
  editId?: string;
  format: typeof RECEIPT_FORMAT;
  intent: GooglePlayReleaseIntent;
  packageName: string;
  provider: "google-play";
  releaseId: string;
  sha256: string;
  stage: "committed" | "editing" | "uploading" | "commit-pending";
  updatedAt: string;
  uploadSession?: string;
  versionCode?: string;
};

export type GooglePlayBundle = {
  sha1?: string;
  sha256?: string;
  versionCode: number;
};

export type GooglePlayTrackRelease = {
  inAppUpdatePriority?: number;
  name?: string;
  releaseNotes?: Array<{ language: string; text: string }>;
  status?: GooglePlayReleaseStatus;
  userFraction?: number;
  versionCodes?: string[];
};

export type GooglePlayTrack = {
  releases?: GooglePlayTrackRelease[];
  track?: string;
};

export type GooglePlayEdit = {
  expiryTimeSeconds?: string;
  id: string;
};

export type GooglePlayClient = {
  commitEdit: (options: {
    changesNotSentForReview: boolean;
    editId: string;
    packageName: string;
    reviewBehavior: GooglePlayReviewBehavior;
    signal?: AbortSignal;
  }) => Promise<void>;
  deleteEdit: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  getEdit: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<GooglePlayEdit | null>;
  getTrack: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
    track: string;
  }) => Promise<GooglePlayTrack>;
  insertEdit: (options: {
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<GooglePlayEdit>;
  listBundles: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<GooglePlayBundle[]>;
  startBundleUpload: (options: {
    bytes: number;
    editId: string;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  updateTrack: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
    track: GooglePlayTrack;
    trackName: string;
  }) => Promise<GooglePlayTrack>;
  uploadBundle: (options: {
    artifactPath: string;
    bytes: number;
    sessionUrl: string;
    signal?: AbortSignal;
  }) => Promise<GooglePlayBundle>;
  validateEdit: (options: {
    editId: string;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<void>;
};

export type GooglePlayReleasePublisherOptions = {
  client?: GooglePlayClient;
  clock?: () => Date;
  receiptPrefix?: string;
  receiptStore: NativeReleaseBlobStore;
  registry: {
    publish: (options: {
      allowUnsigned?: boolean;
      channel?: string;
      releaseRoot: string;
      signal?: AbortSignal;
      [key: string]: unknown;
    }) => Promise<NativeReleasePublication>;
  };
  target?: GooglePlayReleaseTarget;
};

export type GooglePlayNativeReleasePublication = NativeReleasePublication & {
  googlePlay?: {
    receipt: GooglePlayReleaseReceipt;
    reused: boolean;
  };
};

export type GooglePlayNativeReleasePublisher = {
  prepareAndroidRelease: (options: {
    buildIdentity: string;
    googlePlay?: GooglePlayReleaseTarget;
    packageName: string;
    signal?: AbortSignal;
  }) => Promise<{ versionCode?: number }>;
  publish: (options: {
    allowUnsigned?: boolean;
    channel?: string;
    googlePlay?: GooglePlayReleaseTarget;
    releaseRoot: string;
    signal?: AbortSignal;
  }) => Promise<GooglePlayNativeReleasePublication>;
};

export class GooglePlayReleaseError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GooglePlayReleaseError";
    this.status = status;
  }
}

export type GooglePlayAuth = {
  getClient: () => Promise<{
    getRequestHeaders: (
      url?: string | URL,
    ) => Promise<Headers | Record<string, string>>;
  }>;
};

const encodedJson = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const decodedJson = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as unknown;
const sha256Bytes = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const hashIdentity = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return false;

  return new Date(value).toISOString() === value;
};

const normalizedPrefix = (value: string) => {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (
    prefix.length === 0 ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new GooglePlayReleaseError("Google Play receipt prefix is invalid");

  return prefix;
};

const normalizedTarget = (
  target: GooglePlayReleaseTarget,
): GooglePlayReleaseIntent => {
  if (!TRACK_PATTERN.test(target.track))
    throw new GooglePlayReleaseError("Google Play track is invalid");
  const status = target.status ?? "completed";
  if (!RELEASE_STATUSES.has(status))
    throw new GooglePlayReleaseError("Google Play release status is invalid");
  const reviewBehavior = target.reviewBehavior ?? "ERROR_IF_IN_REVIEW";
  if (!REVIEW_BEHAVIORS.has(reviewBehavior))
    throw new GooglePlayReleaseError("Google Play review behavior is invalid");
  const hasFraction = target.userFraction !== undefined;
  if (
    hasFraction &&
    (typeof target.userFraction !== "number" ||
      !Number.isFinite(target.userFraction) ||
      target.userFraction <= 0 ||
      target.userFraction >= 1)
  )
    throw new GooglePlayReleaseError(
      "Google Play userFraction must be greater than 0 and less than 1",
    );
  if (hasFraction !== (status === "inProgress" || status === "halted"))
    throw new GooglePlayReleaseError(
      "Google Play staged releases require userFraction, and other statuses forbid it",
    );
  const priority = target.inAppUpdatePriority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 5)
    throw new GooglePlayReleaseError(
      "Google Play inAppUpdatePriority must be an integer from 0 through 5",
    );
  if (target.name !== undefined && target.name.trim().length === 0)
    throw new GooglePlayReleaseError("Google Play release name is invalid");
  const languages = new Set<string>();
  const releaseNotes = [...(target.releaseNotes ?? [])]
    .map(({ language, text }) => ({
      language: language.trim(),
      text: text.trim(),
    }))
    .sort((left, right) => left.language.localeCompare(right.language));
  for (const note of releaseNotes) {
    if (
      note.language.length === 0 ||
      note.text.length === 0 ||
      languages.has(note.language)
    )
      throw new GooglePlayReleaseError(
        "Google Play release notes require unique languages and non-empty text",
      );
    languages.add(note.language);
  }

  return {
    changesNotSentForReview: target.changesNotSentForReview ?? false,
    inAppUpdatePriority: priority,
    ...(target.name ? { name: target.name.trim() } : {}),
    releaseNotes,
    reviewBehavior,
    status,
    track: target.track,
    ...(hasFraction ? { userFraction: target.userFraction } : {}),
  };
};

const parseReceipt = (value: unknown): GooglePlayReleaseReceipt => {
  if (
    !isRecord(value) ||
    value.format !== RECEIPT_FORMAT ||
    value.provider !== "google-play" ||
    typeof value.packageName !== "string" ||
    typeof value.releaseId !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isIsoTimestamp(value.updatedAt) ||
    !["committed", "editing", "uploading", "commit-pending"].includes(
      String(value.stage),
    ) ||
    !isRecord(value.intent)
  )
    throw new GooglePlayReleaseError("Google Play release receipt is invalid");
  const intent = normalizedTarget(value.intent as GooglePlayReleaseTarget);
  if (
    (value.editId !== undefined && typeof value.editId !== "string") ||
    (value.editExpiresAt !== undefined &&
      typeof value.editExpiresAt !== "string") ||
    (value.uploadSession !== undefined &&
      typeof value.uploadSession !== "string") ||
    (value.versionCode !== undefined && typeof value.versionCode !== "string")
  )
    throw new GooglePlayReleaseError("Google Play release receipt is invalid");

  return {
    format: RECEIPT_FORMAT,
    intent,
    packageName: value.packageName,
    provider: "google-play",
    releaseId: value.releaseId,
    sha256: value.sha256,
    stage: value.stage as GooglePlayReleaseReceipt["stage"],
    updatedAt: value.updatedAt,
    ...(value.editId ? { editId: value.editId } : {}),
    ...(value.editExpiresAt ? { editExpiresAt: value.editExpiresAt } : {}),
    ...(value.uploadSession ? { uploadSession: value.uploadSession } : {}),
    ...(value.versionCode ? { versionCode: value.versionCode } : {}),
  };
};

const responseError = async (response: Response) => {
  const text = await response.text().catch(() => "");

  return new GooglePlayReleaseError(
    `Google Play API request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`,
    response.status,
  );
};

const headersObject = (headers: Headers | Record<string, string>) =>
  headers instanceof Headers ? Object.fromEntries(headers) : headers;

export const createGooglePlayClient = (
  dependencies: {
    auth?: GooglePlayAuth;
    fetch?: typeof fetch;
  } = {},
): GooglePlayClient => {
  const auth: GooglePlayAuth =
    dependencies.auth ?? new GoogleAuth({ scopes: [ANDROID_PUBLISHER_SCOPE] });
  const request = dependencies.fetch ?? fetch;
  const authorizedFetch = async (url: string, init: RequestInit = {}) => {
    const client = await auth.getClient();
    const authHeaders = await client.getRequestHeaders(url);

    return request(url, {
      ...init,
      headers: { ...headersObject(authHeaders), ...init.headers },
    });
  };
  const requestJson = async <T>(url: string, init: RequestInit = {}) => {
    const response = await authorizedFetch(url, init);
    if (!response.ok) throw await responseError(response);

    return (await response.json()) as T;
  };
  const app = (packageName: string) =>
    `${API_ROOT}/applications/${encodeURIComponent(packageName)}`;
  const edit = (packageName: string, editId: string) =>
    `${app(packageName)}/edits/${encodeURIComponent(editId)}`;

  return {
    commitEdit: async (input) => {
      const query = new URLSearchParams({
        changesInReviewBehavior: input.reviewBehavior,
        changesNotSentForReview: String(input.changesNotSentForReview),
      });
      await requestJson(
        `${edit(input.packageName, input.editId)}:commit?${query}`,
        { method: "POST", signal: input.signal },
      );
    },
    deleteEdit: async (input) => {
      const response = await authorizedFetch(
        edit(input.packageName, input.editId),
        { method: "DELETE", signal: input.signal },
      );
      if (!response.ok && response.status !== 404)
        throw await responseError(response);
    },
    getEdit: async (input) => {
      const response = await authorizedFetch(
        edit(input.packageName, input.editId),
        {
          signal: input.signal,
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw await responseError(response);

      return (await response.json()) as GooglePlayEdit;
    },
    getTrack: (input) =>
      requestJson(
        `${edit(input.packageName, input.editId)}/tracks/${encodeURIComponent(input.track)}`,
        { signal: input.signal },
      ),
    insertEdit: (input) =>
      requestJson(`${app(input.packageName)}/edits`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: input.signal,
      }),
    listBundles: async (input) => {
      const response = await requestJson<{ bundles?: GooglePlayBundle[] }>(
        `${edit(input.packageName, input.editId)}/bundles`,
        { signal: input.signal },
      );

      return response.bundles ?? [];
    },
    startBundleUpload: async (input) => {
      const url = `${UPLOAD_ROOT}/applications/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(input.editId)}/bundles?uploadType=resumable`;
      const response = await authorizedFetch(url, {
        headers: {
          "content-length": "0",
          "x-upload-content-length": String(input.bytes),
          "x-upload-content-type": "application/octet-stream",
        },
        method: "POST",
        signal: input.signal,
      });
      if (!response.ok) throw await responseError(response);
      const location = response.headers.get("location");
      if (!location)
        throw new GooglePlayReleaseError(
          "Google Play did not return a resumable upload session",
        );

      return location;
    },
    updateTrack: (input) =>
      requestJson(
        `${edit(input.packageName, input.editId)}/tracks/${encodeURIComponent(input.trackName)}`,
        {
          body: JSON.stringify(input.track),
          headers: { "content-type": "application/json" },
          method: "PUT",
          signal: input.signal,
        },
      ),
    uploadBundle: async (input) => {
      let offset = 0;
      const statusResponse = await authorizedFetch(input.sessionUrl, {
        headers: {
          "content-length": "0",
          "content-range": `bytes */${input.bytes}`,
        },
        method: "PUT",
        signal: input.signal,
      });
      if (statusResponse.ok)
        return (await statusResponse.json()) as GooglePlayBundle;
      if (statusResponse.status !== 308)
        throw await responseError(statusResponse);
      const range = statusResponse.headers.get("range");
      if (range) offset = Number(range.slice(range.lastIndexOf("-") + 1)) + 1;
      for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
        const end = input.bytes - 1;
        const body = Bun.file(input.artifactPath).slice(offset, input.bytes);
        const response = await authorizedFetch(input.sessionUrl, {
          body,
          headers: {
            "content-length": String(input.bytes - offset),
            "content-range": `bytes ${offset}-${end}/${input.bytes}`,
            "content-type": "application/octet-stream",
          },
          method: "PUT",
          signal: input.signal,
        });
        if (response.ok) return (await response.json()) as GooglePlayBundle;
        if (response.status !== 308) throw await responseError(response);
        const nextRange = response.headers.get("range");
        if (!nextRange)
          throw new GooglePlayReleaseError(
            "Google Play resumable upload did not report its received range",
          );
        offset = Number(nextRange.slice(nextRange.lastIndexOf("-") + 1)) + 1;
      }
      throw new GooglePlayReleaseError(
        "Google Play resumable upload exceeded its retry limit",
      );
    },
    validateEdit: async (input) => {
      await requestJson(`${edit(input.packageName, input.editId)}:validate`, {
        method: "POST",
        signal: input.signal,
      });
    },
  };
};

const desiredRelease = (
  intent: GooglePlayReleaseIntent,
  versionCode: string,
): GooglePlayTrackRelease => ({
  inAppUpdatePriority: intent.inAppUpdatePriority,
  ...(intent.name ? { name: intent.name } : {}),
  ...(intent.releaseNotes.length > 0
    ? { releaseNotes: intent.releaseNotes }
    : {}),
  status: intent.status,
  ...(intent.userFraction !== undefined
    ? { userFraction: intent.userFraction }
    : {}),
  versionCodes: [versionCode],
});

const matchingRelease = (track: GooglePlayTrack, versionCode: string) =>
  track.releases?.find(({ versionCodes = [] }) =>
    versionCodes.includes(versionCode),
  );

const releaseMatchesIntent = (
  release: GooglePlayTrackRelease | undefined,
  intent: GooglePlayReleaseIntent,
) => {
  if (!release || release.status !== intent.status) return false;
  if ((release.inAppUpdatePriority ?? 0) !== intent.inAppUpdatePriority)
    return false;
  if (
    intent.userFraction !== undefined
      ? release.userFraction !== intent.userFraction
      : release.userFraction !== undefined
  )
    return false;
  if (intent.name !== undefined && release.name !== intent.name) return false;
  if (
    JSON.stringify(
      [...(release.releaseNotes ?? [])].sort((left, right) =>
        left.language.localeCompare(right.language),
      ),
    ) !== JSON.stringify(intent.releaseNotes)
  )
    return false;

  return true;
};

const updatedTrack = (
  current: GooglePlayTrack,
  intent: GooglePlayReleaseIntent,
  versionCode: string,
): GooglePlayTrack => {
  const desired = desiredRelease(intent, versionCode);
  const releases = current.releases ?? [];
  if (intent.status === "completed")
    return { releases: [desired], track: intent.track };
  const existingIndex = releases.findIndex(({ versionCodes = [] }) =>
    versionCodes.includes(versionCode),
  );
  if (existingIndex !== -1) {
    return {
      track: intent.track,
      releases: releases.map((release, index) =>
        index === existingIndex ? desired : release,
      ),
    };
  }
  return { releases: [...releases, desired], track: intent.track };
};

export const createGooglePlayReleasePublisher = (
  options: GooglePlayReleasePublisherOptions,
): GooglePlayNativeReleasePublisher => {
  const client = options.client ?? createGooglePlayClient();
  const clock = options.clock ?? (() => new Date());
  const prefix = normalizedPrefix(
    options.receiptPrefix ?? DEFAULT_RECEIPT_PREFIX,
  );
  const receiptKey = (packageName: string, track: string, releaseId: string) =>
    `${prefix}/${hashIdentity(`${packageName}\0${track}`)}/${releaseId}.json`;
  const preparationKey = (packageName: string, buildIdentity: string) =>
    `${prefix}/${hashIdentity(packageName)}/preparations/${hashIdentity(buildIdentity)}.json`;
  const readPreparation = async (
    packageName: string,
    buildIdentity: string,
  ) => {
    const key = preparationKey(packageName, buildIdentity);
    const bytes = await options.receiptStore.get(key);
    if (!bytes) return null;
    const head = await options.receiptStore.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== sha256Bytes(bytes)
    )
      throw new GooglePlayReleaseError(
        "Stored Google Play version preparation failed integrity verification",
      );
    const value = decodedJson(bytes);
    if (
      !isRecord(value) ||
      value.format !== RECEIPT_FORMAT ||
      value.packageName !== packageName ||
      value.buildIdentity !== buildIdentity ||
      !Number.isSafeInteger(value.versionCode) ||
      Number(value.versionCode) < 1 ||
      Number(value.versionCode) > 2_100_000_000
    )
      throw new GooglePlayReleaseError(
        "Stored Google Play version preparation is invalid",
      );

    return Number(value.versionCode);
  };
  const writePreparation = async (
    packageName: string,
    buildIdentity: string,
    versionCode: number,
  ) => {
    const serialized = encodedJson({
      buildIdentity,
      format: RECEIPT_FORMAT,
      packageName,
      preparedAt: clock().toISOString(),
      versionCode,
    });
    await options.receiptStore.put(
      preparationKey(packageName, buildIdentity),
      serialized,
      {
        cacheControl: "no-cache",
        contentType: "application/json",
        maxBytes: serialized.byteLength,
        metadata: {
          sha256: sha256Bytes(serialized),
          type: "google-play-version-preparation",
        },
      },
    );
  };
  const readReceipt = async (
    packageName: string,
    track: string,
    releaseId: string,
  ) => {
    const key = receiptKey(packageName, track, releaseId);
    const bytes = await options.receiptStore.get(key);
    if (!bytes) return null;
    const head = await options.receiptStore.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== sha256Bytes(bytes)
    )
      throw new GooglePlayReleaseError(
        "Stored Google Play receipt failed integrity verification",
      );
    const receipt = parseReceipt(decodedJson(bytes));
    if (
      receipt.packageName !== packageName ||
      receipt.intent.track !== track ||
      receipt.releaseId !== releaseId
    )
      throw new GooglePlayReleaseError(
        "Stored Google Play receipt identity does not match",
      );

    return receipt;
  };
  const writeReceipt = async (receipt: GooglePlayReleaseReceipt) => {
    const serialized = encodedJson(receipt);
    await options.receiptStore.put(
      receiptKey(receipt.packageName, receipt.intent.track, receipt.releaseId),
      serialized,
      {
        cacheControl: "no-cache",
        contentType: "application/json",
        maxBytes: serialized.byteLength,
        metadata: {
          provider: receipt.provider,
          releaseId: receipt.releaseId,
          sha256: sha256Bytes(serialized),
          stage: receipt.stage,
        },
      },
    );

    return receipt;
  };
  const withStage = (
    receipt: GooglePlayReleaseReceipt,
    stage: GooglePlayReleaseReceipt["stage"],
    values: Partial<GooglePlayReleaseReceipt> = {},
  ): GooglePlayReleaseReceipt => ({
    ...receipt,
    ...values,
    stage,
    updatedAt: clock().toISOString(),
  });

  return {
    ...options.registry,
    prepareAndroidRelease: async (input) => {
      const target = input.googlePlay ?? options.target;
      if (!target) return {};
      const intent = normalizedTarget(target);
      if (input.buildIdentity.length === 0)
        throw new GooglePlayReleaseError(
          "Google Play build identity is invalid",
        );
      const prepared = await readPreparation(
        input.packageName,
        input.buildIdentity,
      );
      if (prepared) return { versionCode: prepared };
      const edit = await client.insertEdit({
        packageName: input.packageName,
        signal: input.signal,
      });
      try {
        const bundles = await client.listBundles({
          editId: edit.id,
          packageName: input.packageName,
          signal: input.signal,
        });
        const highest = bundles.reduce(
          (maximum, bundle) => Math.max(maximum, bundle.versionCode),
          0,
        );
        if (!Number.isSafeInteger(highest) || highest >= 2_100_000_000)
          throw new GooglePlayReleaseError(
            "Google Play cannot allocate another Android version code",
          );

        const versionCode = highest + 1;
        await writePreparation(
          input.packageName,
          input.buildIdentity,
          versionCode,
        );

        return { versionCode };
      } finally {
        await client.deleteEdit({
          editId: edit.id,
          packageName: input.packageName,
          signal: input.signal,
        });
      }
    },
    publish: async (input) => {
      const publication = await options.registry.publish(input);
      const target = input.googlePlay ?? options.target;
      if (!target) return publication;
      const intent = normalizedTarget(target);
      const metadata = publication.record.metadata;
      if (metadata.platform !== "android")
        throw new GooglePlayReleaseError(
          "Google Play publishing requires an Android App Bundle release",
        );
      if (!metadata.signed)
        throw new GooglePlayReleaseError(
          "Unsigned Android releases cannot be sent to Google Play",
        );
      if (!metadata.versionCode)
        throw new GooglePlayReleaseError(
          "Google Play releases require an automatically prepared Android version code",
        );
      input.signal?.throwIfAborted();
      const priorReceipt = await readReceipt(
        metadata.appId,
        intent.track,
        metadata.releaseId,
      );
      if (
        priorReceipt &&
        (priorReceipt.sha256 !== metadata.sha256 ||
          priorReceipt.packageName !== metadata.appId)
      )
        throw new GooglePlayReleaseError(
          "Google Play receipt refers to a different native release",
        );
      let receipt = await writeReceipt({
        format: RECEIPT_FORMAT,
        intent,
        packageName: metadata.appId,
        provider: "google-play",
        releaseId: metadata.releaseId,
        sha256: metadata.sha256,
        stage: "editing",
        updatedAt: clock().toISOString(),
        ...(priorReceipt?.editId ? { editId: priorReceipt.editId } : {}),
        ...(priorReceipt?.editExpiresAt
          ? { editExpiresAt: priorReceipt.editExpiresAt }
          : {}),
        ...(priorReceipt?.uploadSession
          ? { uploadSession: priorReceipt.uploadSession }
          : {}),
        ...(priorReceipt?.versionCode
          ? { versionCode: priorReceipt.versionCode }
          : {}),
      });

      let edit: GooglePlayEdit | null = null;
      let resumedEdit = false;
      if (
        receipt.editId &&
        receipt.editExpiresAt &&
        Number(receipt.editExpiresAt) * 1000 > clock().getTime()
      )
        edit = await client.getEdit({
          editId: receipt.editId,
          packageName: metadata.appId,
          signal: input.signal,
        });
      resumedEdit = edit !== null;
      if (!edit) {
        edit = await client.insertEdit({
          packageName: metadata.appId,
          signal: input.signal,
        });
        receipt = await writeReceipt(
          withStage(receipt, "editing", {
            editExpiresAt: edit.expiryTimeSeconds,
            editId: edit.id,
            uploadSession: undefined,
          }),
        );
      }
      const [bundles, currentTrack] = await Promise.all([
        client.listBundles({
          editId: edit.id,
          packageName: metadata.appId,
          signal: input.signal,
        }),
        client.getTrack({
          editId: edit.id,
          packageName: metadata.appId,
          signal: input.signal,
          track: intent.track,
        }),
      ]);
      const existingBundle = bundles.find(
        ({ sha256 }) => sha256?.toLowerCase() === metadata.sha256,
      );
      let versionCode = existingBundle
        ? String(existingBundle.versionCode)
        : undefined;
      if (
        versionCode &&
        !resumedEdit &&
        releaseMatchesIntent(matchingRelease(currentTrack, versionCode), intent)
      ) {
        receipt = await writeReceipt(
          withStage(receipt, "committed", {
            editExpiresAt: undefined,
            editId: undefined,
            uploadSession: undefined,
            versionCode,
          }),
        );
        await client.deleteEdit({
          editId: edit.id,
          packageName: metadata.appId,
          signal: input.signal,
        });

        return {
          ...publication,
          googlePlay: { receipt, reused: true },
        };
      }
      if (!versionCode) {
        let sessionUrl =
          receipt.editId === edit.id ? receipt.uploadSession : undefined;
        if (!sessionUrl) {
          sessionUrl = await client.startBundleUpload({
            bytes: metadata.bytes,
            editId: edit.id,
            packageName: metadata.appId,
            signal: input.signal,
          });
          receipt = await writeReceipt(
            withStage(receipt, "uploading", {
              editExpiresAt: edit.expiryTimeSeconds,
              editId: edit.id,
              uploadSession: sessionUrl,
            }),
          );
        }
        const upload = (uploadSession: string) =>
          client.uploadBundle({
            artifactPath: path.join(input.releaseRoot, metadata.artifact),
            bytes: metadata.bytes,
            sessionUrl: uploadSession,
            signal: input.signal,
          });
        let uploaded: GooglePlayBundle;
        try {
          uploaded = await upload(sessionUrl);
        } catch (error) {
          if (
            !(error instanceof GooglePlayReleaseError) ||
            (error.status !== 404 && error.status !== 410)
          )
            throw error;
          sessionUrl = await client.startBundleUpload({
            bytes: metadata.bytes,
            editId: edit.id,
            packageName: metadata.appId,
            signal: input.signal,
          });
          receipt = await writeReceipt(
            withStage(receipt, "uploading", { uploadSession: sessionUrl }),
          );
          uploaded = await upload(sessionUrl);
        }
        if (uploaded.sha256?.toLowerCase() !== metadata.sha256)
          throw new GooglePlayReleaseError(
            "Google Play returned a different bundle digest",
          );
        if (
          !Number.isSafeInteger(uploaded.versionCode) ||
          uploaded.versionCode < 1
        )
          throw new GooglePlayReleaseError(
            "Google Play returned an invalid bundle version code",
          );
        if (uploaded.versionCode !== metadata.versionCode)
          throw new GooglePlayReleaseError(
            "Google Play returned a different embedded Android version code",
          );
        versionCode = String(uploaded.versionCode);
        receipt = await writeReceipt(
          withStage(receipt, "editing", { versionCode }),
        );
      }
      await client.updateTrack({
        editId: edit.id,
        packageName: metadata.appId,
        signal: input.signal,
        track: updatedTrack(currentTrack, intent, versionCode),
        trackName: intent.track,
      });
      await client.validateEdit({
        editId: edit.id,
        packageName: metadata.appId,
        signal: input.signal,
      });
      receipt = await writeReceipt(withStage(receipt, "commit-pending"));
      await client.commitEdit({
        changesNotSentForReview: intent.changesNotSentForReview,
        editId: edit.id,
        packageName: metadata.appId,
        reviewBehavior: intent.reviewBehavior,
        signal: input.signal,
      });
      receipt = await writeReceipt(
        withStage(receipt, "committed", {
          editExpiresAt: undefined,
          editId: undefined,
          uploadSession: undefined,
          versionCode,
        }),
      );

      return {
        ...publication,
        googlePlay: { receipt, reused: false },
      };
    },
  };
};
