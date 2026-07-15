import { describe, expect, test } from "bun:test";
import {
  createManagedPreviewFleet,
  type ManagedPreviewRecord,
  type ManagedPreviewStore,
} from "../src/managedPreview";

type Context = { projectId: string };
type Output = { nodeId: string };

const createStore = (): ManagedPreviewStore<Context, Output> => {
  const records = new Map<string, ManagedPreviewRecord<Context, Output>>();
  return {
    get: async (previewId) => records.get(previewId) ?? null,
    list: async () => [...records.values()],
    put: async (record) => {
      records.set(record.previewId, { ...record });
    },
    remove: async (previewId) => {
      records.delete(previewId);
    },
  };
};

describe("createManagedPreviewFleet", () => {
  test("persists lifecycle state around a streamed publication", async () => {
    const store = createStore();
    const seen: string[] = [];
    const originalPut = store.put;
    store.put = async (record) => {
      seen.push(record.status);
      await originalPut(record);
    };
    const fleet = createManagedPreviewFleet<Context, Output>({
      createRuntimeId: () => "runtime-1",
      destroy: async () => undefined,
      publish: async (record) => {
        expect(record.context.projectId).toBe("project-1");
        return {
          output: { nodeId: "node-1" },
          releaseId: "release-1",
          url: "https://preview.example.com",
        };
      },
      store,
    });

    const record = await fleet.create({
      context: { projectId: "project-1" },
      previewId: "preview-1",
    });

    expect(seen).toEqual(["provisioning", "running"]);
    expect(record).toMatchObject({
      releaseId: "release-1",
      runtimeId: "runtime-1",
      status: "running",
    });
  });

  test("retains a failed record and resumes with the same runtime identity", async () => {
    const store = createStore();
    let attempts = 0;
    const fleet = createManagedPreviewFleet<Context, Output>({
      createRuntimeId: () => "runtime-stable",
      destroy: async () => undefined,
      publish: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("host unavailable");
        return {
          releaseId: "release-2",
          url: "https://recovered.example.com",
        };
      },
      store,
    });

    await expect(
      fleet.create({
        context: { projectId: "project-1" },
        previewId: "preview-1",
      }),
    ).rejects.toThrow("host unavailable");
    expect(await fleet.get("preview-1")).toMatchObject({
      error: "host unavailable",
      runtimeId: "runtime-stable",
      status: "failed",
    });

    const resumed = await fleet.resume("preview-1");
    expect(resumed).toMatchObject({
      releaseId: "release-2",
      runtimeId: "runtime-stable",
      status: "running",
    });
    expect(resumed.error).toBeUndefined();
  });

  test("retains ownership when teardown fails and can retry", async () => {
    const store = createStore();
    let destroyAttempts = 0;
    const fleet = createManagedPreviewFleet<Context, Output>({
      destroy: async () => {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error("edge unavailable");
      },
      publish: async () => ({
        releaseId: "release-1",
        url: "https://preview.example.com",
      }),
      store,
    });
    await fleet.create({
      context: { projectId: "project-1" },
      previewId: "preview-1",
    });

    await expect(fleet.teardown("preview-1")).rejects.toThrow(
      "edge unavailable",
    );
    expect(await fleet.get("preview-1")).toMatchObject({
      error: "edge unavailable",
      status: "failed",
    });
    await fleet.teardown("preview-1");
    expect(await fleet.get("preview-1")).toBeNull();
  });

  test("garbage-collects expired previews and reports isolated failures", async () => {
    let now = 100;
    const store = createStore();
    const fleet = createManagedPreviewFleet<Context, Output>({
      clock: () => now,
      destroy: async (record) => {
        if (record.previewId === "bad") throw new Error("busy");
      },
      publish: async (record) => ({
        releaseId: `release-${record.previewId}`,
        url: `https://${record.previewId}.example.com`,
      }),
      store,
    });
    await fleet.create({
      context: { projectId: "project-1" },
      expiresAt: 150,
      previewId: "good",
    });
    await fleet.create({
      context: { projectId: "project-1" },
      expiresAt: 150,
      previewId: "bad",
    });
    await fleet.create({
      context: { projectId: "project-1" },
      expiresAt: 250,
      previewId: "later",
    });

    now = 200;
    const result = await fleet.gc();
    expect(result.removed).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.previewId).toBe("bad");
    expect(
      (await fleet.list()).map((record) => record.previewId).sort(),
    ).toEqual(["bad", "later"]);
  });

  test("serializes concurrent operations for one preview", async () => {
    const store = createStore();
    let active = 0;
    let maximumActive = 0;
    let release = 0;
    const fleet = createManagedPreviewFleet<Context, Output>({
      destroy: async () => undefined,
      publish: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(5);
        active -= 1;
        release += 1;
        return {
          releaseId: `release-${release}`,
          url: "https://preview.example.com",
        };
      },
      store,
    });

    await Promise.all([
      fleet.create({
        context: { projectId: "project-1" },
        previewId: "preview-1",
      }),
      fleet.create({
        context: { projectId: "project-1" },
        previewId: "preview-1",
      }),
    ]);
    expect(maximumActive).toBe(1);
    expect((await fleet.get("preview-1"))?.releaseId).toBe("release-2");
  });
});
