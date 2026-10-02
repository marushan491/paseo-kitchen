import type { RoleProfileOverride } from "../shared/factory-contracts.js";
import type { NativePresets, TeamPreset } from "../shared/native-contracts.js";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";
import type { WorkflowPack } from "./pack.js";
import type { PaseoAgentConfig } from "@getpaseo/client";
import { validateDefinition } from "./workflow-definitions.js";

const nonDelivery = new Set(["kitchen-insights", "kitchen-gardener", "kitchen-single"]);
export function teamPreset(pack: Pick<WorkflowPack, "id" | "title">): TeamPreset {
  if (pack.id === "kitchen")
    return {
      id: pack.id,
      title: "Standard team",
      description: "Plan → Build → Review → Verify → Integrate → Final verification",
      group: "Standard",
    };
  if (pack.id === "software-basic")
    return {
      id: pack.id,
      title: "Basic team",
      description: "Plan → Build → Test → Review",
      group: "Standard",
    };
  return {
    id: pack.id,
    title: pack.title,
    description: "Configured delivery team",
    group: "Project teams",
  };
}
export function nativePresets(
  packs: WorkflowPack[],
  workflows: WorkflowDefinition[],
  profile: { workflowPack?: string; workflowId?: string },
): NativePresets {
  const presets = packs
    .filter((pack) => !nonDelivery.has(pack.id))
    .sort((a, b) => Number(b.id === "kitchen") - Number(a.id === "kitchen"))
    .map(teamPreset);
  for (const definition of workflows) {
    const base = packs.find((pack) => pack.id === definition.basePackId);
    if (!base || base.id !== "kitchen") continue;
    try {
      validateDefinition(definition, base);
    } catch {
      continue;
    }
    presets.push({
      id: definition.id,
      title: definition.title,
      description: `Custom delivery team · version ${definition.revision}`,
      group: "Project teams",
    });
  }
  const defaultPresetId = profile.workflowId || profile.workflowPack || "kitchen";
  return {
    presets,
    defaultPresetId,
    ...(!presets.some((preset) => preset.id === defaultPresetId)
      ? {
          unavailableReason:
            "This project's Kitchen team is unavailable. Choose Standard team or manage the team configuration.",
        }
      : {}),
  };
}
export function headChefConfig(input: PaseoAgentConfig, profile: RoleProfileOverride | undefined) {
  if (!profile) return input;
  const separator = input.provider.indexOf("/");
  const originalProvider = separator < 0 ? input.provider : input.provider.slice(0, separator);
  const provider = profile.provider || originalProvider;
  const sameProvider = provider === originalProvider;
  const inheritedModel =
    sameProvider && separator >= 0 ? input.provider.slice(separator + 1) : undefined;
  const model = profile.model || inheritedModel;
  return {
    ...input,
    provider: model ? `${provider}/${model}` : provider,
    modeId: profile.mode || (sameProvider ? input.modeId : undefined),
    thinkingOptionId: profile.thinking || (sameProvider ? input.thinkingOptionId : undefined),
    ...(sameProvider ? {} : { options: undefined, featureValues: undefined }),
  };
}
