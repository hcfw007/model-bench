export async function pool<T extends { readonly model: string }>(
  specs: readonly T[],
  concurrency: number,
  task: (spec: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('并发必须为正整数');
  }

  const pending = specs.map((spec, index) => ({ spec, index, provider: spec.model.split('/', 1)[0] }));
  const active = new Map<string, number>();
  let firstFailure: { error: unknown } | undefined;
  const slots = Array.from({ length: Math.min(concurrency, specs.length) }, async (): Promise<void> => {
    while (pending.length > 0) {
      let selectedIndex = 0;
      let fewestActive = Number.POSITIVE_INFINITY;
      for (const [index, { provider }] of pending.entries()) {
        const count = active.get(provider) ?? 0;
        if (count >= fewestActive) continue;
        selectedIndex = index;
        fewestActive = count;
        if (count === 0) break;
      }

      const [{ spec, index, provider }] = pending.splice(selectedIndex, 1);
      active.set(provider, fewestActive + 1);
      try {
        await task(spec, index);
      } catch (error) {
        firstFailure ??= { error };
      } finally {
        active.set(provider, (active.get(provider) ?? 1) - 1);
      }
    }
  });
  // Wait for every worker before the caller removes the shared workspace.
  await Promise.all(slots);
  if (firstFailure) throw firstFailure.error;
}
