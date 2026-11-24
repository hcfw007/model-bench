export interface ActivityWindow {
  readonly start: number;
  readonly end: number;
}

export interface ChildInvocation extends ActivityWindow {
  readonly sessionId: string;
  readonly parentId: string;
  readonly activity: readonly ActivityWindow[];
}

export interface MessageRow {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown> | undefined;
  readonly content: readonly Record<string, unknown>[] | undefined;
  readonly time_created: number;
  readonly time_updated: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseRecord(data: unknown): Record<string, unknown> | undefined {
  try {
    const json = data instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(data) : data;
    return typeof json === 'string' ? record(JSON.parse(json)) : undefined;
  } catch {
    return undefined;
  }
}

export function contentPart(value: unknown): Record<string, unknown> | undefined {
  const part = record(value);
  if (!part || typeof part.type !== 'string') return undefined;
  if (part.type === 'text' && typeof part.text !== 'string') return undefined;
  if (part.type === 'tool' && (typeof part.name !== 'string' || typeof record(part.state)?.status !== 'string')) {
    return undefined;
  }
  return part;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function textParts(content: readonly unknown[]): string {
  return content.flatMap((part: unknown): string[] => {
    const value = record(part);
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
  }).join('\n');
}

export function initialInvocation(
  sessionId: string,
  parentId: string,
  messages: readonly MessageRow[],
  observedAt: number,
): ChildInvocation | undefined {
  const request = messages.find((message: MessageRow): boolean => message.type === 'user');
  if (!request) return undefined;
  const boundary = messages.find((message: MessageRow): boolean => message.seq > request.seq
    && (message.type === 'idle' || message.type === 'user' || message.type === 'synthetic'));
  const end = boundary?.time_created ?? observedAt;
  const activity = messages.flatMap((message: MessageRow): ActivityWindow[] => {
    if (message.type !== 'assistant' || message.seq <= request.seq || (boundary && message.seq >= boundary.seq)) return [];
    if (!message.content?.length) return [];
    const time = record(message.data?.time);
    const start = Math.max(request.time_created, numberValue(time?.created) ?? message.time_created);
    const stop = Math.min(end, numberValue(time?.completed) ?? message.time_updated);
    return start < stop ? [{ start, end: stop }] : [];
  });
  if (!activity.length || end <= request.time_created) return undefined;
  return { sessionId, parentId, start: request.time_created, end, activity };
}

export function hasActiveOverlap(invocations: readonly ChildInvocation[]): boolean {
  if (invocations.length < 2) return false;
  // Intersect observed activity intervals, never the gaps between messages or resumed invocations.
  return invocations[0].activity.some((first: ActivityWindow): boolean =>
    overlapsRemaining(invocations, 1, first.start, first.end));
}

function overlapsRemaining(
  invocations: readonly ChildInvocation[], index: number, start: number, end: number,
): boolean {
  if (index === invocations.length) return true;
  return invocations[index].activity.some((activity: ActivityWindow): boolean => {
    const nextStart = Math.max(start, activity.start);
    const nextEnd = Math.min(end, activity.end);
    return nextStart < nextEnd && overlapsRemaining(invocations, index + 1, nextStart, nextEnd);
  });
}
