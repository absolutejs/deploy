import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createGooglePlayClient,
  createGooglePlayReleasePublisher,
  GooglePlayReleaseError,
  type GooglePlayAuth,
  type GooglePlayBundle,
  type GooglePlayClient,
  type GooglePlayEdit,
  type GooglePlayTrack,
} from "../src/googlePlay";
import type {
  AndroidNativeReleaseMetadata,
  NativeReleaseBlobStore,
  NativeReleasePublication,
  NativeReleaseRegistry,
} from "../src/nativeRelease";

type MemoryObject = {
  bytes: Uint8Array;
  metadata?: Record<string, string>;
};

const collectBody = async (
  body: ReadableStream<Uint8Array> | Uint8Array | string,
) => {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;

  return new Uint8Array(await new Response(body).arrayBuffer());
};

const memoryStore = () => {
  const objects = new Map<string, MemoryObject>();
  const stages: string[] = [];
  const store: NativeReleaseBlobStore = {
    get: async (key) => objects.get(key)?.bytes ?? null,
    head: async (key) => {
      const object = objects.get(key);

      return object
        ? { key, metadata: object.metadata, size: object.bytes.byteLength }
        : null;
    },
    put: async (key, body, options) => {
      const bytes = await collectBody(body);
      objects.set(key, { bytes, metadata: options?.metadata });
      if (options?.metadata?.stage) stages.push(options.metadata.stage);
    },
  };

  return { objects, stages, store };
};

const artifact = new TextEncoder().encode("signed-android-app-bundle");
const sha256 = createHash("sha256").update(artifact).digest("hex");
const metadata: AndroidNativeReleaseMetadata = {
  appBuild: "ambuild_google_play",
  appId: "com.example.absolute",
  artifact: "app-release.aab",
  bytes: artifact.byteLength,
  engine: "capacitor",
  format: 1,
  platform: "android",
  releaseId: `amobile_android_${sha256}`,
  runtime: "runtime-google-play",
  sha256,
  signed: true,
  type: "aab",
  versionCode: 42,
};

const nativePublication = (
  overrides: Partial<AndroidNativeReleaseMetadata> = {},
): NativeReleasePublication => ({
  record: {
    artifactKey: "native/app-release.aab",
    format: 1,
    metadata: { ...metadata, ...overrides },
  },
  reused: false,
});

const registry = (
  publication: NativeReleasePublication = nativePublication(),
): NativeReleaseRegistry => ({
  promote: async () => {
    throw new Error("not used");
  },
  publish: async () => publication,
  read: async () => publication.record,
  resolve: async () => null,
});

type FakePlayOptions = {
  commitLosesResponseOnce?: boolean;
  initialBundles?: GooglePlayBundle[];
  initialTrack?: GooglePlayTrack;
  validateFailsOnce?: boolean;
};

const fakePlay = (options: FakePlayOptions = {}) => {
  const events: string[] = [];
  const edits = new Map<string, GooglePlayEdit>();
  let bundles = [...(options.initialBundles ?? [])];
  let track: GooglePlayTrack = options.initialTrack ?? {
    releases: [],
    track: "internal",
  };
  let pendingTrack = track;
  let editCounter = 0;
  let loseCommit = options.commitLosesResponseOnce ?? false;
  let failValidation = options.validateFailsOnce ?? false;
  const client: GooglePlayClient = {
    commitEdit: async ({ editId, reviewBehavior }) => {
      events.push(`commit:${reviewBehavior}`);
      track = pendingTrack;
      edits.delete(editId);
      if (loseCommit) {
        loseCommit = false;
        throw new Error("connection closed after commit");
      }
    },
    deleteEdit: async ({ editId }) => {
      events.push("delete-edit");
      edits.delete(editId);
    },
    getEdit: async ({ editId }) => {
      events.push("get-edit");

      return edits.get(editId) ?? null;
    },
    getTrack: async () => {
      events.push("get-track");

      return pendingTrack;
    },
    insertEdit: async () => {
      events.push("insert-edit");
      const edit = {
        expiryTimeSeconds: String(
          Date.parse("2026-08-23T00:00:00.000Z") / 1000,
        ),
        id: `edit-${++editCounter}`,
      };
      edits.set(edit.id, edit);
      pendingTrack = track;

      return edit;
    },
    listBundles: async () => {
      events.push("list-bundles");

      return bundles;
    },
    startBundleUpload: async () => {
      events.push("start-upload");

      return "https://upload.example/session-secret";
    },
    updateTrack: async ({ track: nextTrack }) => {
      events.push("update-track");
      pendingTrack = nextTrack;

      return nextTrack;
    },
    uploadBundle: async () => {
      events.push("upload-bundle");
      const uploaded = { sha256, versionCode: 42 };
      bundles = [...bundles, uploaded];

      return uploaded;
    },
    validateEdit: async () => {
      events.push("validate-edit");
      if (failValidation) {
        failValidation = false;
        throw new Error("process stopped after track update");
      }
    },
  };

  return {
    client,
    events,
    get track() {
      return track;
    },
  };
};

describe("Google Play native release publisher", () => {
  test("prepares the next version code from every bundle already known to Play", async () => {
    const receipts = memoryStore();
    const play = fakePlay({
      initialBundles: [
        { sha256: "a".repeat(64), versionCode: 7 },
        { sha256: "b".repeat(64), versionCode: 44 },
      ],
    });
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      receiptStore: receipts.store,
      registry: registry(),
    });

    expect(
      await publisher.prepareAndroidRelease({
        buildIdentity: "ambuild_google_play",
        googlePlay: { track: "production" },
        packageName: metadata.appId,
      }),
    ).toEqual({ versionCode: 45 });
    expect(play.events).toEqual(["insert-edit", "list-bundles", "delete-edit"]);
    expect(
      await publisher.prepareAndroidRelease({
        buildIdentity: "ambuild_google_play",
        googlePlay: { track: "internal" },
        packageName: metadata.appId,
      }),
    ).toEqual({ versionCode: 45 });
    expect(play.events).toHaveLength(3);
  });

  test("uploads, validates, and commits a signed release with durable stage receipts", async () => {
    const receipts = memoryStore();
    const play = fakePlay();
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      receiptStore: receipts.store,
      registry: registry(),
    });
    const publication = await publisher.publish({
      googlePlay: { track: "internal" },
      releaseRoot: "/project/release",
    });

    expect(publication.googlePlay?.reused).toBe(false);
    expect(publication.googlePlay?.receipt).toMatchObject({
      packageName: metadata.appId,
      stage: "committed",
      versionCode: "42",
    });
    expect(receipts.stages).toEqual([
      "editing",
      "editing",
      "uploading",
      "editing",
      "commit-pending",
      "committed",
    ]);
    expect(play.events).toEqual([
      "insert-edit",
      "list-bundles",
      "get-track",
      "start-upload",
      "upload-bundle",
      "update-track",
      "validate-edit",
      "commit:ERROR_IF_IN_REVIEW",
    ]);
    expect(play.track.releases).toEqual([
      {
        inAppUpdatePriority: 0,
        status: "completed",
        versionCodes: ["42"],
      },
    ]);
    const receiptKey = [...receipts.objects.keys()][0];
    expect(receiptKey).not.toContain(metadata.appId);
    const serializedReceipt = receipts.objects.get(receiptKey ?? "")?.bytes;
    expect(serializedReceipt).toBeDefined();
    if (serializedReceipt)
      expect(new TextDecoder().decode(serializedReceipt)).not.toContain(
        "session-secret",
      );
  });

  test("reconciles a committed release after the commit response is lost", async () => {
    const receipts = memoryStore();
    const play = fakePlay({ commitLosesResponseOnce: true });
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      receiptStore: receipts.store,
      registry: registry(),
    });
    await expect(
      publisher.publish({
        googlePlay: { track: "internal" },
        releaseRoot: "/project/release",
      }),
    ).rejects.toThrow("connection closed after commit");
    const uploadsAfterLostResponse = play.events.filter(
      (event) => event === "upload-bundle",
    ).length;
    const recovered = await publisher.publish({
      googlePlay: { track: "internal" },
      releaseRoot: "/project/release",
    });

    expect(recovered.googlePlay?.reused).toBe(true);
    expect(recovered.googlePlay?.receipt.stage).toBe("committed");
    expect(
      play.events.filter((event) => event === "upload-bundle"),
    ).toHaveLength(uploadsAfterLostResponse);
    expect(play.events.at(-1)).toBe("delete-edit");
  });

  test("resumes and commits an uncommitted edit instead of mistaking it for provider state", async () => {
    const receipts = memoryStore();
    const play = fakePlay({ validateFailsOnce: true });
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      receiptStore: receipts.store,
      registry: registry(),
    });
    await expect(
      publisher.publish({
        googlePlay: { track: "internal" },
        releaseRoot: "/project/release",
      }),
    ).rejects.toThrow("process stopped after track update");
    const recovered = await publisher.publish({
      googlePlay: { track: "internal" },
      releaseRoot: "/project/release",
    });

    expect(recovered.googlePlay?.reused).toBe(false);
    expect(
      play.events.filter((event) => event === "upload-bundle"),
    ).toHaveLength(1);
    expect(
      play.events.filter((event) => event.startsWith("commit:")),
    ).toHaveLength(1);
    expect(play.events.at(-1)).toBe("commit:ERROR_IF_IN_REVIEW");
  });

  test("preserves the served release for a staged rollout and changes its fraction without reuploading", async () => {
    const receipts = memoryStore();
    const play = fakePlay({
      initialBundles: [{ sha256, versionCode: 42 }],
      initialTrack: {
        releases: [{ status: "completed", versionCodes: ["41"] }],
        track: "production",
      },
    });
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      receiptStore: receipts.store,
      registry: registry(),
    });
    await publisher.publish({
      googlePlay: {
        status: "inProgress",
        track: "production",
        userFraction: 0.1,
      },
      releaseRoot: "/project/release",
    });
    expect(play.track.releases).toEqual([
      { status: "completed", versionCodes: ["41"] },
      {
        inAppUpdatePriority: 0,
        status: "inProgress",
        userFraction: 0.1,
        versionCodes: ["42"],
      },
    ]);
    await publisher.publish({
      googlePlay: {
        status: "inProgress",
        track: "production",
        userFraction: 0.5,
      },
      releaseRoot: "/project/release",
    });

    expect(
      play.track.releases?.find(({ versionCodes }) =>
        versionCodes?.includes("42"),
      )?.userFraction,
    ).toBe(0.5);
    expect(play.events).not.toContain("upload-bundle");
  });

  test("completes a staged rollout by replacing obsolete track releases", async () => {
    const receipts = memoryStore();
    const play = fakePlay({
      initialBundles: [{ sha256, versionCode: 42 }],
      initialTrack: {
        releases: [
          { status: "completed", versionCodes: ["41"] },
          {
            status: "inProgress",
            userFraction: 0.5,
            versionCodes: ["42"],
          },
        ],
        track: "production",
      },
    });
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      receiptStore: receipts.store,
      registry: registry(),
    });
    await publisher.publish({
      googlePlay: { status: "completed", track: "production" },
      releaseRoot: "/project/release",
    });

    expect(play.track.releases).toEqual([
      {
        inAppUpdatePriority: 0,
        status: "completed",
        versionCodes: ["42"],
      },
    ]);
  });

  test("fails closed for unsigned artifacts and invalid rollout intent", async () => {
    const receipts = memoryStore();
    const play = fakePlay();
    const unsigned = createGooglePlayReleasePublisher({
      client: play.client,
      receiptStore: receipts.store,
      registry: registry(nativePublication({ signed: false })),
    });
    await expect(
      unsigned.publish({
        allowUnsigned: true,
        googlePlay: { track: "internal" },
        releaseRoot: "/project/release",
      }),
    ).rejects.toThrow("Unsigned Android releases");
    const publisher = createGooglePlayReleasePublisher({
      client: play.client,
      receiptStore: receipts.store,
      registry: registry(),
    });
    await expect(
      publisher.publish({
        googlePlay: {
          status: "inProgress",
          track: "production",
        },
        releaseRoot: "/project/release",
      }),
    ).rejects.toBeInstanceOf(GooglePlayReleaseError);
    await expect(
      publisher.publish({
        googlePlay: {
          status: "completed",
          track: "production",
          userFraction: 0.5,
        },
        releaseRoot: "/project/release",
      }),
    ).rejects.toThrow("other statuses forbid it");
    expect(play.events).toHaveLength(0);
  });
});

describe("Google Play HTTP client", () => {
  test("uses Android Publisher edit endpoints and explicit safe review behavior", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const auth: GooglePlayAuth = {
      getClient: async () => ({
        getRequestHeaders: async () => ({ authorization: "Bearer test" }),
      }),
    };
    const request: typeof fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ init, url });
      if (url.endsWith("/edits"))
        return Response.json({ expiryTimeSeconds: "2000000000", id: "edit-1" });
      if (url.includes(":commit"))
        return Response.json({ expiryTimeSeconds: "2000000000", id: "edit-1" });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const client = createGooglePlayClient({ auth, fetch: request });

    await client.insertEdit({ packageName: "com.example.absolute" });
    await client.commitEdit({
      changesNotSentForReview: true,
      editId: "edit-1",
      packageName: "com.example.absolute",
      reviewBehavior: "ERROR_IF_IN_REVIEW",
    });

    expect(requests[0]?.url).toBe(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.absolute/edits",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    const commitUrl = new URL(requests[1]?.url ?? "");
    expect(commitUrl.pathname).toEndWith("/edits/edit-1:commit");
    expect(commitUrl.searchParams.get("changesInReviewBehavior")).toBe(
      "ERROR_IF_IN_REVIEW",
    );
    expect(commitUrl.searchParams.get("changesNotSentForReview")).toBe("true");
  });

  test("initiates and resumes a bundle upload through the upload endpoint", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const auth: GooglePlayAuth = {
      getClient: async () => ({
        getRequestHeaders: async () =>
          new Headers({ authorization: "Bearer test" }),
      }),
    };
    const request: typeof fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ init, url });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          headers: { location: "https://upload.example/session" },
          status: 200,
        });
      if (
        init?.headers &&
        new Headers(init.headers).get("content-range")?.startsWith("bytes */")
      )
        return new Response(null, { status: 308 });

      return Response.json({ sha256, versionCode: 42 });
    }) as typeof fetch;
    const client = createGooglePlayClient({ auth, fetch: request });
    const sessionUrl = await client.startBundleUpload({
      bytes: artifact.byteLength,
      editId: "edit-1",
      packageName: metadata.appId,
    });
    const uploaded = await client.uploadBundle({
      artifactPath: "/unused-by-fake-fetch.aab",
      bytes: artifact.byteLength,
      sessionUrl,
    });

    expect(sessionUrl).toBe("https://upload.example/session");
    expect(uploaded.versionCode).toBe(42);
    expect(requests[0]?.url).toContain(
      "/upload/androidpublisher/v3/applications/com.example.absolute/edits/edit-1/bundles?uploadType=resumable",
    );
    expect(new Headers(requests[1]?.init?.headers).get("content-range")).toBe(
      `bytes */${artifact.byteLength}`,
    );
    expect(new Headers(requests[2]?.init?.headers).get("content-range")).toBe(
      `bytes 0-${artifact.byteLength - 1}/${artifact.byteLength}`,
    );
  });
});
