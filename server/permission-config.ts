import type { PaseoAgentConfig, PaseoApi } from "@getpaseo/client";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";

export async function kitchenPermissionConfig(
  paseo: PaseoApi,
  config: PaseoAgentConfig,
  cwd: string,
  enabled: boolean,
): Promise<PaseoAgentConfig> {
  if (!enabled) return config;
  const provider = config.provider.split("/", 1)[0]!;
  const [catalog, features] = await Promise.all([
    paseo.providers.listModes(provider, { cwd }),
    paseo.providers.listFeatures({
      provider: config.provider,
      cwd,
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      featureValues: config.featureValues,
    }),
  ]);
  if (catalog.error || features.error)
    throw new Error(
      `Cannot configure Kitchen auto-accept for ${provider}: ${catalog.error || features.error}`,
    );
  if (
    features.features?.some((feature) => feature.id === "auto_accept" && feature.type === "toggle")
  )
    return { ...config, featureValues: { ...config.featureValues, auto_accept: true } };
  const definition = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === provider);
  const unattended = new Set(
    (definition ? [definition] : AGENT_PROVIDER_DEFINITIONS).flatMap((entry) =>
      entry.modes.filter((mode) => mode.isUnattended).map((mode) => mode.id),
    ),
  );
  const mode = catalog.modes?.find((entry) => {
    const advertised = (entry as typeof entry & { isUnattended?: boolean }).isUnattended;
    return advertised === undefined ? unattended.has(entry.id) : advertised === true;
  });
  if (!mode)
    throw new Error(
      `Kitchen auto-accept is unavailable for ${provider}: no supported unattended mode or auto-accept toggle was advertised. Disable auto-accept or choose a provider that supports it.`,
    );
  if (mode.id === "full-access" && config.options) {
    const options = { ...config.options };
    delete options.approval_policy;
    delete options.sandbox_mode;
    return { ...config, modeId: mode.id, options };
  }
  return { ...config, modeId: mode.id };
}
