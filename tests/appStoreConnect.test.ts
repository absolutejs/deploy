import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AppStoreConnectReleaseError,
  createAppStoreConnectReleasePublisher,
  createAppStoreConnectClient,
  type AppStoreConnectClient,
} from "../src/appStoreConnect";
import type {
  IosNativeReleaseMetadata,
  NativeReleaseBlobStore,
  NativeReleasePublication,
} from "../src/nativeRelease";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const memoryStore = (): NativeReleaseBlobStore => {
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata?: Record<string, string> }
  >();
  return {
    get: async (key) => objects.get(key)?.bytes ?? null,
    head: async (key) => {
      const value = objects.get(key);
      return value
        ? { key, metadata: value.metadata, size: value.bytes.byteLength }
        : null;
    },
    put: async (key, body, options) => {
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, metadata: options?.metadata });
    },
  };
};

const fixture = async () => {
  const releaseRoot = await mkdtemp(
    path.join(tmpdir(), "absolute-ios-provider-"),
  );
  roots.push(releaseRoot);
  const artifact = new TextEncoder().encode("signed-ios-ipa");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const metadata: IosNativeReleaseMetadata = {
    appBuild: "ambuild_ios",
    appId: "com.example.absolute",
    artifact: "App.ipa",
    buildNumber: 8,
    bytes: artifact.byteLength,
    engine: "capacitor",
    format: 1,
    marketingVersion: "1.4.0",
    platform: "ios",
    releaseId: `amobile_ios_${sha256}`,
    runtime: "runtime-ios",
    sha256,
    signed: true,
    type: "ipa",
  };
  await mkdir(releaseRoot, { recursive: true });
  await writeFile(path.join(releaseRoot, metadata.artifact), artifact);
  const publication: NativeReleasePublication = {
    record: { artifactKey: "native/App.ipa", format: 1, metadata },
    reused: false,
  };
  return { metadata, publication, releaseRoot };
};

const fakeApple = (internal = false, allBuilds = false) => {
  const events: string[] = [];
  let uploaded = false;
  const client: AppStoreConnectClient = {
    findAppId: async () => "apple-app-1",
    listBuildNumbers: async () => [3, 7],
    findBuildUpload: async () => null,
    createBuildUpload: async () => ({
      id: "upload-1",
      state: "AWAITING_UPLOAD",
    }),
    getBuildUpload: async () => ({
      id: "upload-1",
      state: uploaded ? "COMPLETE" : "AWAITING_UPLOAD",
    }),
    createBuildUploadFile: async () => "file-1",
    findBuildUploadFile: async () => null,
    uploadBuildFile: async ({ artifactPath }) => {
      events.push(`upload:${path.basename(artifactPath)}`);
    },
    commitBuildUploadFile: async ({ sha256 }) => {
      uploaded = true;
      events.push(`commit:${sha256}`);
    },
    findBuild: async () =>
      uploaded
        ? { id: "build-1", processingState: "VALID", version: "8" }
        : null,
    resolveGroups: async ({ groups }) =>
      groups.map((name) => ({
        hasAccessToAllBuilds: allBuilds,
        id: "group-1",
        isInternal: internal,
        name,
      })),
    upsertWhatsNew: async ({ locale, text }) => {
      events.push(`notes:${locale}:${text}`);
    },
    addBuildToGroup: async ({ groupId }) => {
      events.push(`group:${groupId}`);
    },
    submitBetaReview: async () => {
      events.push("review");
    },
    hasBetaReviewSubmission: async () => false,
  };
  return { client, events };
};

describe("App Store Connect native releases", () => {
  test("signs Apple requests and follows reserved IPA byte-range operations", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const requests: Array<{
      body: string;
      headers: Headers;
      method: string;
      url: string;
    }> = [];
    const responses = [
      {
        data: [
          {
            attributes: { bundleId: "com.example.absolute" },
            id: "app-1",
            type: "apps",
          },
        ],
      },
      {
        data: {
          attributes: { state: { state: "AWAITING_UPLOAD" } },
          id: "upload-1",
          type: "buildUploads",
        },
      },
      { data: { id: "file-1", type: "buildUploadFiles" } },
      {
        data: {
          attributes: {
            uploadOperations: [
              {
                length: 3,
                method: "PUT",
                offset: 0,
                requestHeaders: [{ name: "x-apple-part", value: "1" }],
                url: "https://upload.example/part",
              },
            ],
          },
          id: "file-1",
          type: "buildUploadFiles",
        },
      },
      undefined,
    ];
    const requestFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const body = init?.body ? await new Response(init.body).text() : "";
      requests.push({
        body,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      if (url === "https://upload.example/part")
        return new Response(null, { status: 200 });
      const response = responses.shift();
      return response === undefined
        ? new Response(null, { status: 204 })
        : Response.json(response, {
            status: init?.method === "POST" ? 201 : 200,
          });
    };
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer-1",
        keyId: "key-1",
        privateKey: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
      },
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      fetch: requestFetch as typeof fetch,
    });
    expect(await client.findAppId({ bundleId: "com.example.absolute" })).toBe(
      "app-1",
    );
    await client.createBuildUpload({
      appId: "app-1",
      buildNumber: 8,
      marketingVersion: "1.4.0",
    });
    await client.createBuildUploadFile({
      buildUploadId: "upload-1",
      bytes: 3,
      fileName: "App.ipa",
    });
    const root = await mkdtemp(path.join(tmpdir(), "absolute-ios-upload-"));
    roots.push(root);
    await writeFile(path.join(root, "App.ipa"), "ipa");
    await client.uploadBuildFile({
      artifactPath: path.join(root, "App.ipa"),
      fileId: "file-1",
    });
    await client.commitBuildUploadFile({
      fileId: "file-1",
      sha256: "a".repeat(64),
    });

    expect(requests[0]?.headers.get("authorization")?.split(".")).toHaveLength(
      3,
    );
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      data: {
        attributes: {
          cfBundleShortVersionString: "1.4.0",
          cfBundleVersion: "8",
          platform: "IOS",
        },
        relationships: { app: { data: { id: "app-1" } } },
      },
    });
    expect(requests[4]).toMatchObject({
      body: "ipa",
      method: "PUT",
      url: "https://upload.example/part",
    });
    expect(requests[4]?.headers.get("x-apple-part")).toBe("1");
    const commitBody = JSON.parse(requests[5]!.body);
    expect(commitBody).toMatchObject({
      data: { attributes: { uploaded: true } },
    });
    // Apple rejects `sourceFileChecksums` on the completion PATCH (HTTP 409);
    // it must not be sent.
    expect(commitBody.data.attributes.sourceFileChecksums).toBeUndefined();
  });

  test("allocates a stable build number and uploads a retry-safe TestFlight release", async () => {
    const release = await fixture();
    const apple = fakeApple();
    const publisher = createAppStoreConnectReleasePublisher({
      client: apple.client,
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      receiptStore: memoryStore(),
      registry: { publish: async () => release.publication },
    });
    const firstPreparation = await publisher.prepareIosRelease({
      buildIdentity: "identity",
      bundleId: release.metadata.appId,
      marketingVersion: "1.4.0",
    });
    const secondPreparation = await publisher.prepareIosRelease({
      buildIdentity: "identity",
      bundleId: release.metadata.appId,
      marketingVersion: "1.4.0",
    });
    expect(firstPreparation).toEqual({ buildNumber: 8 });
    expect(secondPreparation).toEqual(firstPreparation);

    const input = {
      appStoreConnect: {
        groups: ["External Beta"],
        submitForReview: true,
        whatsNew: [{ locale: "en-US", text: "Faster sync" }],
      },
      releaseRoot: release.releaseRoot,
    };
    const first = await publisher.publish(input);
    const second = await publisher.publish(input);
    expect(first.appStoreConnect?.receipt.stage).toBe("review-submitted");
    expect(first.appStoreConnect?.reused).toBe(false);
    expect(second.appStoreConnect?.reused).toBe(true);
    expect(apple.events).toEqual([
      "upload:App.ipa",
      `commit:${release.metadata.sha256}`,
      "notes:en-US:Faster sync",
      "group:group-1",
      "review",
    ]);
  });

  test("never silently submits an internal group for beta review", async () => {
    const release = await fixture();
    const apple = fakeApple(true);
    const publisher = createAppStoreConnectReleasePublisher({
      client: apple.client,
      receiptStore: memoryStore(),
      registry: { publish: async () => release.publication },
    });
    await expect(
      publisher.publish({
        appStoreConnect: { groups: ["Employees"], submitForReview: true },
        releaseRoot: release.releaseRoot,
      }),
    ).rejects.toBeInstanceOf(AppStoreConnectReleaseError);
    expect(apple.events).not.toContain("review");
  });

  test("skips assignment for a group that already has access to all builds", async () => {
    const release = await fixture();
    const apple = fakeApple(true, true);
    const publisher = createAppStoreConnectReleasePublisher({
      client: apple.client,
      receiptStore: memoryStore(),
      registry: { publish: async () => release.publication },
    });
    const result = await publisher.publish({
      appStoreConnect: { groups: ["Employees"], submitForReview: false },
      releaseRoot: release.releaseRoot,
    });
    expect(result.appStoreConnect?.receipt.stage).toBe("distributed");
    expect(apple.events).not.toContain("group:group-1");
  });
});
