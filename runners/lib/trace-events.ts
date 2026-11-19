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
  readonly data: string;
  readonly time_created: number;
  readonly time_updated: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseMessage(row: MessageRow): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(row.data));
  } catch {
    return undefined;
  }
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
    const data = parseMessage(message);
    if (!Array.isArray(data?.content) || data.content.length === 0) return [];
    const time = record(data.time);
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
