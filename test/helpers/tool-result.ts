import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** No-op logger matching the handlers' LogFn signature — tests don't need debug logging. */
export const noopLog = (_tool: string, _input: Record<string, unknown>, _output: string, _ms: number): void => {};

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Expected first content block to be type "text", got: ${JSON.stringify(first)}`);
  }
  return first.text;
}
