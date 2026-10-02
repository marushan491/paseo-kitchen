import {
  type PluginSurfaceProps,
  type PluginAgentPanelProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { factoryList, factoryPacks, type TeamState } from "../shared/factory-contracts.js";
import { Action, useFactoryStyles } from "./ui.js";
import { Factory } from "./factory.js";
import { Improvements } from "./improvements.js";
import { MigrationSettings } from "./migration.js";
import { Office } from "./office.js";
import { Dashboard } from "./dashboard/dashboard.js";
import { DashboardSettings } from "./dashboard/settings.js";
import { FactorySettings } from "./settings.js";
import { WorkflowProfiles, WorkItemProfileSettings } from "./workflows.js";

const sections = [
  "Overview",
  "Office",
  "Missions",
  "Workflows",
  "Activity",
  "Problems",
  "Settings",
] as const;
const emptyTeams: TeamState[] = [];
const emptyRoles = {};
const settingsPages = ["Kitchen", "Overview", "Migration", "Improvements"] as const;
type Section = (typeof sections)[number];
export function Studio(
  props: PluginSurfaceProps & Partial<Pick<PluginAgentPanelProps, "workspaceId" | "agentId">>,
) {
  const styles = useFactoryStyles(props);
  const [section, setSection] = useState<Section>(props.agentId ? "Missions" : "Overview");
  const [createNew, setCreateNew] = useState(Boolean(props.agentId));
  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const list = useRpc(factoryList);
  const packsRpc = useRpc(factoryPacks);
  const teams = useQuery({
    queryKey: ["factory", "teams"],
    queryFn: () => list({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const packs = useQuery({ queryKey: ["factory", "packs"], queryFn: () => packsRpc({}) });
  const visibleTeams = teams.data?.teams || emptyTeams;
  const configured = useMemo(
    () => findBinding(visibleTeams, selectedAgent),
    [visibleTeams, selectedAgent],
  );
  const configuredRoles = useMemo(
    () =>
      packs.data?.packs.find((pack) => pack.id === configured?.state.team.packId)?.workflow.roles ||
      emptyRoles,
    [packs.data, configured],
  );
  const openTeam = useCallback((id: string) => {
    setSelectedTeam(id);
    setCreateNew(false);
    setSection("Missions");
  }, []);
  const newMission = useCallback(() => {
    setSelectedTeam("");
    setCreateNew(true);
    setSection("Missions");
  }, []);
  const selectSection = useCallback((value: Section) => {
    setSection(value);
    setSelectedAgent("");
  }, []);
  const teamNavigation = useCallback(
    (teamId?: string) => {
      if (teamId) openTeam(teamId);
      else setSection("Missions");
    },
    [openTeam],
  );
  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.row}>
          <Text style={styles.title}>Kitchen Studio</Text>
          <Action
            theme={props.theme}
            title="New mission"
            variant="primary"
            value="new"
            onAction={newMission}
          />
        </View>
        <View style={styles.row}>
          {sections.map((name) => (
            <Action
              key={name}
              theme={props.theme}
              title={name}
              accessibilityLabel={name === "Settings" ? "Studio settings" : name}
              selected={section === name}
              value={name}
              onAction={selectSection}
            />
          ))}
        </View>
      </View>
      {section === "Missions" ? (
        <Factory
          key={`${selectedTeam}:${createNew}`}
          {...props}
          selectedTeamId={selectedTeam}
          createNew={createNew}
          onCreated={openTeam}
        />
      ) : null}
      {["Overview", "Activity", "Problems"].includes(section) ? (
        <Dashboard
          {...props}
          section={section.toLowerCase() as "overview" | "activity" | "problems"}
          teamNavigation={teamNavigation}
        />
      ) : null}
      {section === "Office" ? (
        <ScrollView contentContainerStyle={styles.content}>
          {teams.isPending ? <Text style={styles.muted}>Loading teams…</Text> : null}
          {teams.error ? <Text style={styles.danger}>{String(teams.error)}</Text> : null}
          <Office
            {...props}
            teams={visibleTeams}
            onOpenTeam={openTeam}
            onConfigureAgent={setSelectedAgent}
          />
          {configured ? (
            <WorkItemProfileSettings
              key={configured.binding.id}
              {...props}
              state={configured.state}
              workItemId={configured.binding.workItemId}
              initialRole={configured.binding.role}
              roles={configuredRoles}
            />
          ) : null}
        </ScrollView>
      ) : null}
      {section === "Workflows" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <WorkflowProfiles {...props} />
        </ScrollView>
      ) : null}
      {section === "Settings" ? <StudioSettings {...props} /> : null}
    </View>
  );
}

export function StudioSettings(props: PluginSurfaceProps) {
  const styles = useFactoryStyles(props);
  const [page, setPage] = useState<(typeof settingsPages)[number]>("Kitchen");
  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.row}>
          {settingsPages.map((name) => (
            <Action
              key={name}
              theme={props.theme}
              title={`${name} settings`}
              selected={name === page}
              value={name}
              onAction={setPage}
            />
          ))}
        </View>
      </View>
      {page === "Kitchen" ? <FactorySettings {...props} /> : null}
      {page === "Overview" ? <DashboardSettings {...props} /> : null}
      {page === "Migration" ? <MigrationSettings {...props} /> : null}
      {page === "Improvements" ? <Improvements {...props} /> : null}
    </View>
  );
}

function findBinding(teams: TeamState[], agentId: string) {
  for (const state of teams) {
    const binding = Object.values(state.bindings).find((value) => value.agentId === agentId);
    if (binding) return { state, binding };
  }
  return undefined;
}
