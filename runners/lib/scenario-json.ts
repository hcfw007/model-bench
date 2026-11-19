interface Conclusion {
  readonly value: Record<string, unknown>;
  readonly note: string;
}

interface JsonSpan {
  readonly end: number;
  readonly duplicateKey: boolean;
}

function quotedEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

function jsonSpan(text: string, start: number): JsonSpan | null {
  const stack: string[] = [];
  const topLevelKeys = new Set<string>();
  let duplicateKey = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = quotedEnd(text, index);
      if (stack.length === 1 && stack[0] === '{' && /^\s*:/.test(text.slice(end))) {
        const key: unknown = JSON.parse(text.slice(index, end));
        if (typeof key === 'string') {
          duplicateKey ||= topLevelKeys.has(key);
          topLevelKeys.add(key);
        }
      }
      index = end - 1;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
      if (stack.length === 0) return { end: index + 1, duplicateKey };
    }
  }
  return null;
}

function plausibleConclusion(text: string): boolean {
  return /^\{\s*["}]/.test(text) || /^\[\s*[\[{]/.test(text);
}

export function conclusion(text: string): Conclusion | null {
  let result: Conclusion | null = null;
  for (let index = 0; index < text.length; index += 1) {
    if ((text[index] !== '{' && text[index] !== '[') || !plausibleConclusion(text.slice(index))) continue;
    try {
      const span = jsonSpan(text, index);
      if (result || !span || span.duplicateKey) return null;
      const value: unknown = JSON.parse(text.slice(index, span.end));
      if (!record(value)) return null;
      result = { value, note: text.slice(0, index) + text.slice(span.end) };
      index = span.end - 1;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
  }
  return result;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
