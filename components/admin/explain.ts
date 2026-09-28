import type { KeyPolicy, Priority } from "./types";

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function explainPriority(priority: Priority): string {
  if (priority === "high") {
    return "Interactive: a person is waiting. GPU first with reserved slots; if the GPU can’t take it within 5 s, it goes to cloud when Cloud is on, otherwise it fails fast.";
  }
  if (priority === "medium") {
    return "Standard: GPU first, waiting up to 30 s; then cloud when Cloud is on, otherwise it fails.";
  }
  return "Background: idle GPU only (flex). Waits up to 10 minutes for spare compute and never uses cloud.";
}

/** Low priority never uses cloud, whatever the stored switch says. */
export function usesCloud(policy: KeyPolicy): boolean {
  return policy.cloud && policy.priority !== "low";
}

export function policySummary(policy: KeyPolicy): string {
  return `${PRIORITY_LABEL[policy.priority]} · ${usesCloud(policy) ? "cloud on" : "GPU only"}`;
}
