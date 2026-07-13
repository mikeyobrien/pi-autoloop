/** Format Autoloop's authoritative, 1-based iteration count for display. */
export function formatIterationProgress(iteration: number, maxIterations: number): string {
  return `${iteration}/${maxIterations}`;
}

type BackendMetadata = {
  kind: string;
  provider: string;
  command: string;
  args: string[];
  promptMode: string;
  agent: string;
  model: string;
};

/** Replace spawned-backend metadata when Pi's own session is the worker. */
export function withNativeBackend<T extends { backend: BackendMetadata }>(loop: T): T {
  return {
    ...loop,
    backend: {
      ...loop.backend,
      kind: "native",
      provider: "pi",
      command: "native",
      args: [],
      promptMode: "session",
      agent: "pi",
      model: "session",
    },
  };
}
