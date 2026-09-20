import "server-only";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const adminBasicAuth = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ADMIN_BASIC_AUTH must be username:password with both parts nonempty",
      });
      return z.NEVER;
    }
    return {
      username: value.slice(0, colon),
      password: value.slice(colon + 1),
    };
  })
  .optional();

const loadEnv = () =>
  createEnv({
    server: {
      APP_ORIGIN: z.string().url(),
      SQLITE_PATH: z.string().min(1),
      API_KEY_PEPPER: z.string().min(1),
      MODEL_CATALOG: z.string().min(1),
      AUXILIARY_CATALOG: z.string().min(1).optional(),
      CLASSIFIER_MODE: z.enum(["laya", "jev"]),
      LAYA_URL: z.string().url().optional(),
      LAYA_MODEL_REVISION: z.string().min(1).default("1c5edc17a7acd8701df6fc341c0d179f1c62c982"),
      TYPESAFE_API_KEY: z.string().min(1).optional(),
      TYPESAFE_MODEL: z.string().min(1).default("jev-1.13.0"),
      TYPESAFE_BASE_URL: z.string().url().default("https://api.typesafe.ai"),
      OPENROUTER_API_KEY: z.string().min(1).optional(),
      ADMIN_BASIC_AUTH: adminBasicAuth,
    },
    client: {},
    runtimeEnv: {
      APP_ORIGIN: process.env.APP_ORIGIN,
      SQLITE_PATH: process.env.SQLITE_PATH,
      API_KEY_PEPPER: process.env.API_KEY_PEPPER,
      MODEL_CATALOG: process.env.MODEL_CATALOG,
      AUXILIARY_CATALOG: process.env.AUXILIARY_CATALOG,
      CLASSIFIER_MODE: process.env.CLASSIFIER_MODE,
      LAYA_URL: process.env.LAYA_URL,
      LAYA_MODEL_REVISION: process.env.LAYA_MODEL_REVISION,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
      TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      ADMIN_BASIC_AUTH: process.env.ADMIN_BASIC_AUTH,
    },
    emptyStringAsUndefined: true,
  });

export interface Env {
  APP_ORIGIN: string;
  SQLITE_PATH: string;
  API_KEY_PEPPER: string;
  MODEL_CATALOG: string;
  AUXILIARY_CATALOG?: string;
  CLASSIFIER_MODE: "laya" | "jev";
  LAYA_URL?: string;
  LAYA_MODEL_REVISION: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL: string;
  TYPESAFE_BASE_URL: string;
  OPENROUTER_API_KEY?: string;
  ADMIN_BASIC_AUTH?: { username: string; password: string };
}

let loaded: Env | undefined;

/** Parse and cache env at first runtime use. Importing this module does not read secrets. */
export const getEnv = (): Env => {
  if (loaded === undefined) {
    loaded = loadEnv();
  }
  return loaded;
};

/** Lazy view of getEnv(). Property access validates; module import does not. Malformed ADMIN_BASIC_AUTH fails closed. */
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
