import { z } from "zod";
import { v4 as uuid } from "uuid";

export type HandlerInput<T> = {
  data: T;
  headers: Record<string, string>;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
};
export type HandlerConfiguration<T> = {
  name: string;
  inputSchema: z.ZodSchema;
  outputSchema: z.ZodSchema;
  execute: (args: HandlerInput<T>, context: any) => Promise<unknown>;
};

export type RuntimeContext = Record<string, unknown>;

export const getTraceId = (
  args: Record<string, unknown>,
  tracePath?: string
) => {
  if (tracePath) {
    try {
      return args[tracePath].toString() || uuid();
    } catch {
      // do nothing
    }
  }
  return uuid();
};
