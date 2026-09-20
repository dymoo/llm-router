import { getEnv } from "./env.ts";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") getEnv();
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_MANUAL_SIG_HANDLE === "true"
  ) {
    // Next also compiles this hook for Edge; Node SQLite/process modules cannot be statically imported there.
    const { registerShutdown } = await import("./server/lifecycle.ts");
    registerShutdown();
  }
}
