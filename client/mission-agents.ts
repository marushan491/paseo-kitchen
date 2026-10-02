import type { PaseoAgent } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { TeamState } from "../shared/factory-contracts.js";
import { missionAgentIds } from "../shared/mission-stage.js";

const noAgents: Readonly<Record<string, PaseoAgent>> = {};

export function useMissionAgents(state: TeamState | undefined, hostId: string) {
  return useMissionListAgents(state ? [state] : [], hostId);
}

export function useMissionListAgents(teams: readonly TeamState[], hostId: string, enabled = true) {
  const paseo = usePaseo();
  const membership = JSON.stringify(missionAgentIds(teams));
  const query = useQuery({
    queryKey: ["factory", "mission-agent-snapshots", hostId, membership],
    enabled: enabled && membership !== "[]",
    queryFn: async () => {
      const selected: string[] = JSON.parse(membership);
      const snapshots: PaseoAgent[] = [];
      for (let offset = 0; offset < selected.length; offset += 8) {
        const entries = await Promise.all(
          selected.slice(offset, offset + 8).map(async (id) => {
            try {
              return (await paseo.agents.ref(id).refresh())?.agent;
            } catch (error) {
              if (error instanceof Error && error.message === `Agent not found: ${id}`)
                return undefined;
              throw error;
            }
          }),
        );
        snapshots.push(...entries.filter((entry): entry is PaseoAgent => Boolean(entry)));
      }
      return Object.fromEntries(snapshots.map((agent) => [agent.id, agent]));
    },
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  return { agents: query.isError ? noAgents : (query.data ?? noAgents), error: query.error };
}
