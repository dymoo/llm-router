import "server-only";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const loadEnv = () =>
  createEnv({
    server: {
      APP_ORIGIN: z.string().url(),
      SQLITE_PATH: z.string().min(1),
      API_KEY_PEPPER: z.string().min(1),
      MODEL_CATALOG: z.string().min(1),
      AUXILIARY_CATALOG: z.string().min(1).optional(),
      BATCH_CATALOG: z.string().min(1).optional(),
      BATCH_RESULTS_DIR: z.string().min(1).optional(),
      OPENROUTER_API_KEY: z.string().min(1).optional(),
      METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    },
    client: {},
    runtimeEnv: {
      APP_ORIGIN: process.env.APP_ORIGIN,
      SQLITE_PATH: process.env.SQLITE_PATH,
      API_KEY_PEPPER: process.env.API_KEY_PEPPER,
      MODEL_CATALOG: process.env.MODEL_CATALOG,
      AUXILIARY_CATALOG: process.env.AUXILIARY_CATALOG,
      BATCH_CATALOG: process.env.BATCH_CATALOG,
      BATCH_RESULTS_DIR: process.env.BATCH_RESULTS_DIR,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      METRICS_PORT: process.env.METRICS_PORT,
    },
    emptyStringAsUndefined: true,
  });

export interface Env {
  APP_ORIGIN: string;
  SQLITE_PATH: string;
  API_KEY_PEPPER: string;
  MODEL_CATALOG: string;
  AUXILIARY_CATALOG?: string;
  BATCH_CATALOG?: string;
  BATCH_RESULTS_DIR?: string;
  OPENROUTER_API_KEY?: string;
  METRICS_PORT?: number;
}

let loaded: Env | undefined;

/** Parse and cache env at first runtime use. Importing this module does not read secrets. */
export const getEnv = (): Env => {
  if (loaded === undefined) {
    const parsed = loadEnv();
    if (
      parsed.METRICS_PORT !== undefined &&
      parsed.METRICS_PORT === Number(process.env.PORT ?? 3000)
    )
      throw new Error("METRICS_PORT must differ from the application PORT");
    loaded = parsed;
  }
  return loaded;
};

/** Lazy view of getEnv(). Property access validates; module import does not. */
export const env: Env = new Proxy({} as Env, {
  get(_target, property, receiver) {
    return Reflect.get(getEnv(), property, receiver);
  },
});

/** Validate only catalogue-selected provider secrets; absent credentials keep the console usable. */
export function getProviderCredentials(names: readonly string[]) {
  const server: Record<string, z.ZodOptional<z.ZodString>> = {};
  const runtimeEnv: Record<string, string | undefined> = {};
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error("Invalid provider credential environment-variable name");
    }
    server[name] = z.string().min(1).optional();
    runtimeEnv[name] = process.env[name];
  }
  return createEnv({ server, runtimeEnv, emptyStringAsUndefined: true });
}
