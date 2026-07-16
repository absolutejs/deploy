/**
 * Durable, transport-neutral preview lifecycle.
 *
 * Unlike `createPreviewFleet`, this surface does not assume that the caller can
 * construct a Deployer for the destination. It is intended for control planes
 * that stream an immutable artifact to a remote fleet agent and own routing in
 * a separate edge service.
 */

export type ManagedPreviewStatus =
  | "provisioning"
  | "running"
  | "failed"
  | "deleting";

export type ManagedPreviewRecord<
  Context = Record<string, unknown>,
  Output = unknown,
> = {
  previewId: string;
  runtimeId: string;
  status: ManagedPreviewStatus;
  context: Context;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  releaseId?: string;
  url?: string;
  output?: Output;
  error?: string;
};

export type ManagedPreviewStore<
  Context = Record<string, unknown>,
  Output = unknown,
> = {
  list: () => Promise<ManagedPreviewRecord<Context, Output>[]>;
  get: (
    previewId: string,
  ) => Promise<ManagedPreviewRecord<Context, Output> | null>;
  put: (record: ManagedPreviewRecord<Context, Output>) => Promise<void>;
  remove: (previewId: string) => Promise<void>;
};

export type ManagedPreviewPublication<Output = unknown> = {
  releaseId: string;
  url: string;
  output?: Output;
};

export type CreateManagedPreviewInput<Context> = {
  previewId: string;
  context: Context;
  runtimeId?: string;
  expiresAt?: number;
  releaseId?: string;
};

export type ManagedPreviewFleetOptions<Context, Output> = {
  store: ManagedPreviewStore<Context, Output>;
  publish: (
    record: ManagedPreviewRecord<Context, Output>,
  ) => Promise<ManagedPreviewPublication<Output>>;
  destroy: (record: ManagedPreviewRecord<Context, Output>) => Promise<void>;
  createRuntimeId?: () => string;
  clock?: () => number;
};

export type ManagedPreviewFleet<Context, Output> = {
  create: (
    input: CreateManagedPreviewInput<Context>,
  ) => Promise<ManagedPreviewRecord<Context, Output>>;
  resume: (previewId: string) => Promise<ManagedPreviewRecord<Context, Output>>;
  teardown: (previewId: string) => Promise<void>;
  list: () => Promise<ManagedPreviewRecord<Context, Output>[]>;
  get: (
    previewId: string,
  ) => Promise<ManagedPreviewRecord<Context, Output> | null>;
  gc: () => Promise<{
    removed: string[];
    errors: { previewId: string; error: Error }[];
  }>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createManagedPreviewFleet = <Context, Output = unknown>(
  options: ManagedPreviewFleetOptions<Context, Output>,
): ManagedPreviewFleet<Context, Output> => {
  const clock = options.clock ?? Date.now;
  const createRuntimeId =
    options.createRuntimeId ?? (() => crypto.randomUUID());
  const operations = new Map<string, Promise<void>>();

  const exclusive = async <Result>(
    previewId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const prior = operations.get(previewId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    operations.set(previewId, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (operations.get(previewId) === queued) operations.delete(previewId);
    }
  };

  const publish = async (
    record: ManagedPreviewRecord<Context, Output>,
  ): Promise<ManagedPreviewRecord<Context, Output>> => {
    const provisioning: ManagedPreviewRecord<Context, Output> = {
      ...record,
      status: "provisioning",
      updatedAt: clock(),
    };
    delete provisioning.error;
    await options.store.put(provisioning);

    try {
      const publication = await options.publish(provisioning);
      const running: ManagedPreviewRecord<Context, Output> = {
        ...provisioning,
        releaseId: publication.releaseId,
        url: publication.url,
        status: "running",
        updatedAt: clock(),
        ...(publication.output === undefined
          ? {}
          : { output: publication.output }),
      };
      await options.store.put(running);
      return running;
    } catch (error) {
      const failed: ManagedPreviewRecord<Context, Output> = {
        ...provisioning,
        error: errorMessage(error),
        status: "failed",
        updatedAt: clock(),
      };
      await options.store.put(failed);
      throw error;
    }
  };

  const create = async (
    input: CreateManagedPreviewInput<Context>,
  ): Promise<ManagedPreviewRecord<Context, Output>> =>
    exclusive(input.previewId, async () => {
      const existing = await options.store.get(input.previewId);
      const now = clock();
      const record: ManagedPreviewRecord<Context, Output> = {
        ...(existing ?? {
          createdAt: now,
          runtimeId: input.runtimeId ?? createRuntimeId(),
        }),
        context: input.context,
        previewId: input.previewId,
        status: "provisioning",
        updatedAt: now,
        ...(input.expiresAt === undefined
          ? existing?.expiresAt === undefined
            ? {}
            : { expiresAt: existing.expiresAt }
          : { expiresAt: input.expiresAt }),
        ...(input.releaseId === undefined
          ? {}
          : { releaseId: input.releaseId }),
      };
      return publish(record);
    });

  const resume = async (
    previewId: string,
  ): Promise<ManagedPreviewRecord<Context, Output>> =>
    exclusive(previewId, async () => {
      const record = await options.store.get(previewId);
      if (record === null) {
        throw new Error(`managed-preview: unknown preview ${previewId}`);
      }
      if (record.status === "deleting") {
        throw new Error(`managed-preview: preview ${previewId} is deleting`);
      }
      return publish(record);
    });

  const teardown = async (previewId: string): Promise<void> =>
    exclusive(previewId, async () => {
      const record = await options.store.get(previewId);
      if (record === null) return;
      const deleting: ManagedPreviewRecord<Context, Output> = {
        ...record,
        status: "deleting",
        updatedAt: clock(),
      };
      await options.store.put(deleting);
      try {
        await options.destroy(deleting);
        await options.store.remove(previewId);
      } catch (error) {
        await options.store.put({
          ...deleting,
          error: errorMessage(error),
          status: "failed",
          updatedAt: clock(),
        });
        throw error;
      }
    });

  const gc = async (): Promise<{
    removed: string[];
    errors: { previewId: string; error: Error }[];
  }> => {
    const now = clock();
    const expired = (await options.store.list()).filter(
      (record) => record.expiresAt !== undefined && record.expiresAt <= now,
    );
    const removed: string[] = [];
    const errors: { previewId: string; error: Error }[] = [];
    for (const record of expired) {
      try {
        await teardown(record.previewId);
        removed.push(record.previewId);
      } catch (error) {
        errors.push({
          error: error instanceof Error ? error : new Error(String(error)),
          previewId: record.previewId,
        });
      }
    }
    return { errors, removed };
  };

  return {
    create,
    gc,
    get: (previewId) => options.store.get(previewId),
    list: () => options.store.list(),
    resume,
    teardown,
  };
};
