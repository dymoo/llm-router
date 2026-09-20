import { z } from "zod";
import { InvalidInput } from "./http/errors.ts";

const Sampling = z.object({
  temperature: z.number().finite().min(0).max(2).optional(),
  top_p: z.number().finite().min(0).max(1).optional(),
  presence_penalty: z.number().finite().min(-2).max(2).optional(),
  frequency_penalty: z.number().finite().min(-2).max(2).optional(),
  seed: z.number().int().safe().optional(),
  stop: z
    .union([z.string().min(1).max(4096), z.array(z.string().min(1).max(4096)).min(1).max(4)])
    .optional(),
});
export type SamplingOptions = z.infer<typeof Sampling>;
export const SAMPLING_FIELDS = Object.keys(Sampling.shape);
export function decodeSampling(input: Record<string, unknown>): SamplingOptions {
  const parsed = Sampling.safeParse(input);
  if (!parsed.success) throw new InvalidInput("Invalid generation sampling controls");
  return parsed.data;
}
