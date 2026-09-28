import { Context, Effect, Layer } from "effect";
import type { KeyPolicy } from "../domain.ts";
import { KeyRepository } from "./repository.ts";
import type { Admission, FinalizeOutcome } from "./types.ts";

export class ApiKeys extends Context.Service<
  ApiKeys,
  {
    listKeys: KeyRepository["Service"]["listKeys"];
    createKey: KeyRepository["Service"]["createKey"];
    getKey: KeyRepository["Service"]["getKey"];
    updateKey: KeyRepository["Service"]["updateKey"];
    revokeKey: KeyRepository["Service"]["revokeKey"];
    rotateKey: KeyRepository["Service"]["rotateKey"];
    admit: KeyRepository["Service"]["admit"];
    admitByKeyId: KeyRepository["Service"]["admitByKeyId"];
    attach: KeyRepository["Service"]["attach"];
    defer: KeyRepository["Service"]["defer"];
    recheckDeferred: KeyRepository["Service"]["recheckDeferred"];
    finalizeDeferred: KeyRepository["Service"]["finalizeDeferred"];
    finalizeInterrupted: KeyRepository["Service"]["finalizeInterrupted"];
    authenticate: KeyRepository["Service"]["authenticate"];
    recheck: KeyRepository["Service"]["recheck"];
    finalize: KeyRepository["Service"]["finalize"];
    usageSummary: KeyRepository["Service"]["usageSummary"];
    recentRequests: KeyRepository["Service"]["recentRequests"];
    analytics: KeyRepository["Service"]["analytics"];
  }
>()("dymoo/llm-router/keys/ApiKeys") {}

export const apiKeysLayer: Layer.Layer<ApiKeys, never, KeyRepository> = Layer.effect(
  ApiKeys,
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    return ApiKeys.of({
      listKeys: (input) => keys.listKeys(input),
      createKey: (input: { name: string; expiresAt: number | null; policy: KeyPolicy }) =>
        keys.createKey(input),
      getKey: (id) => keys.getKey(id),
      updateKey: (input) => keys.updateKey(input),
      revokeKey: (id) => keys.revokeKey(id),
      rotateKey: (input) => keys.rotateKey(input),
      admit: (rawKey) => keys.admit(rawKey),
      admitByKeyId: (keyId) => keys.admitByKeyId(keyId),
      attach: (admission: Admission, itemId: string) => keys.attach(admission, itemId),
      defer: (
        admission: Admission,
        itemId: string,
        metadata: Omit<FinalizeOutcome, "status">,
        deadlineAt: number,
      ) => keys.defer(admission, itemId, metadata, deadlineAt),
      recheckDeferred: (admission: Admission) => keys.recheckDeferred(admission),
      finalizeDeferred: (keyId: string, requestId: string, outcome: FinalizeOutcome) =>
        keys.finalizeDeferred(keyId, requestId, outcome),
      finalizeInterrupted: (keyId: string, itemId: string) =>
        keys.finalizeInterrupted(keyId, itemId),
      authenticate: (rawKey) => keys.authenticate(rawKey),
      recheck: (admission: Admission) => keys.recheck(admission),
      finalize: (admission: Admission, outcome: FinalizeOutcome) =>
        keys.finalize(admission, outcome),
      usageSummary: (input) => keys.usageSummary(input),
      recentRequests: (input) => keys.recentRequests(input),
      analytics: (input, qualifications) => keys.analytics(input, qualifications),
    });
  }),
);
