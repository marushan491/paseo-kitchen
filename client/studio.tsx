import {
  type PluginSurfaceProps,
  type PluginAgentPanelProps,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { factoryList, factoryPacks, type TeamState } from "../shared/factory-contracts.js";
import { Action, useFactoryStyles } from "./ui.js";
import { Choice } from "./choice.js";
import { MissionList } from "./mission-summary.js";
import { Factory } from "./factory.js";
import { Improvements } from "./improvements.js";
import { MigrationSettings } from "./migration.js";
import { Office } from "./office.js";
import { Dashboard } from "./dashboard/dashboard.js";
import { DashboardSettings } from "./dashboard/settings.js";
import { FactorySettings } from "./settings.js";
import { WorkflowProfiles, WorkItemProfileSettings } from "./workflows.js";

const sections = ["Overview", "Kitchen", "Missions", "Team", "Settings"] as const;
const emptyTeams: TeamState[] = [];
const emptyRoles = {};
const emptyPacks = [] as const;
const settingsTitles = {
  Kitchen: "Connection & capacity",
  Overview: "Dashboard",
  Migration: "Migration",
  Improvements: "Improvements",
};
const settingsPages = ["Kitchen", "Overview", "Migration", "Improvements"] as const;
type Section = (typeof sections)[number];

export function Studio(
  props: PluginSurfaceProps & Partial<Pick<PluginAgentPanelProps, "workspaceId" | "agentId">>,
) {
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const [section, setSection] = useState<Section>(props.agentId ? "Missions" : "Overview");
  const [project, setProject] = useState("");
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
  const projects = useQuery({
    queryKey: ["factory", "projects"],
    queryFn: () => paseo.projects.list({}),
  });
  const projectOptions = useMemo(
    () =>
      (projects.data?.projects ?? []).map((entry) => ({
        id: entry.projectRootPath,
        title: entry.projectDisplayName,
      })),
    [projects.data],
  );
  const allTeams = teams.data?.teams || emptyTeams;
  const visibleTeams = useMemo(
    () =>
      allTeams.filter(
        (state) =>
          !project || state.team.cwd === project || state.team.cwd.startsWith(project + "/"),
      ),
    [allTeams, project],
  );
  const configured = useMemo(
    () => findBinding(visibleTeams, selectedAgent),
    [visibleTeams, selectedAgent],
  );
  const configuredRoles = getConfiguredRoles(packs.data, configured?.state.team.packId);
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
  const cancelMission = useCallback(() => setCreateNew(false), []);
  const selectSection = useCallback((value: Section) => {
    setSection(value);
    setSelectedAgent("");
  }, []);
  const chooseProject = useCallback((value: string) => {
    setProject(value);
    setSelectedTeam("");
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
        <View style={styles.header}>
          <View style={styles.stack}>
            <Text style={styles.title}>Kitchen Studio</Text>
            <Text style={styles.muted}>Turn a goal into verified work.</Text>
          </View>
          <View style={styles.controls}>
            {section !== "Settings" ? (
              <View style={styles.projectPicker}>
                <Choice
                  {...props}
                  label="Project"
                  value={project}
                  options={projectOptions}
                  allowEmpty
                  emptyTitle="All projects"
                  onChange={chooseProject}
                />
              </View>
            ) : null}
            {!createNew ? (
              <Action
                theme={props.theme}
                title="Start mission"
                accessibilityLabel="Start mission"
                compact={props.layout.compact}
                variant="primary"
                value="new"
                onAction={newMission}
              />
            ) : null}
          </View>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.navigation}
        >
          {sections.map((name) => (
            <Action
              key={name}
              theme={props.theme}
              title={name}
              accessibilityLabel={name === "Settings" ? "Studio settings" : name}
              variant="tab"
              compact={props.layout.compact}
              selected={section === name}
              value={name}
              onAction={selectSection}
            />
          ))}
        </ScrollView>
        {projects.error ? (
          <Text style={styles.danger}>Projects could not load: {String(projects.error)}</Text>
        ) : null}
      </View>
      {section === "Missions" ? (
        <Factory
          key={`${selectedTeam}:${createNew}`}
          {...props}
          projectPath={project}
          selectedTeamId={selectedTeam}
          createNew={createNew}
          onCreated={openTeam}
          onNew={newMission}
          onCancel={cancelMission}
        />
      ) : null}
      {section === "Overview" ? (
        <Dashboard
          {...props}
          projectPath={project}
          section="overview"
          teamNavigation={teamNavigation}
        />
      ) : null}
      {section === "Kitchen" ? (
        <ScrollView contentContainerStyle={styles.content}>
          {teams.isPending ? <Text style={styles.muted}>Loading Kitchen…</Text> : null}
          {teams.error ? <Text style={styles.danger}>{String(teams.error)}</Text> : null}
          <Office
            {...props}
            teams={visibleTeams}
            onOpenTeam={openTeam}
            onConfigureAgent={setSelectedAgent}
            onNewMission={newMission}
          />
          <MissionList
            {...props}
            teams={visibleTeams}
            packs={packs.data?.packs || emptyPacks}
            projectPath={project}
            onOpen={openTeam}
            onNew={newMission}
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
      {section === "Team" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <WorkflowProfiles {...props} projectPath={project} />
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
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.muted}>
          Connection and capacity for this host. Mission goals and role instructions live in
          Missions and Team.
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.navigation}
        >
          {settingsPages.map((name) => (
            <Action
              key={name}
              theme={props.theme}
              title={settingsTitles[name]}
              accessibilityLabel={`${name} settings`}
              selected={name === page}
              value={name}
              onAction={setPage}
            />
          ))}
        </ScrollView>
      </View>
      {page === "Kitchen" ? <FactorySettings {...props} /> : null}
      {page === "Overview" ? <DashboardSettings {...props} /> : null}
      {page === "Migration" ? <MigrationSettings {...props} /> : null}
      {page === "Improvements" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Improvements {...props} />
        </ScrollView>
      ) : null}
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

function getConfiguredRoles(
  data:
    | { packs: { id: string; workflow: { roles: Record<string, { title: string }> } }[] }
    | undefined,
  packId?: string,
) {
  return data?.packs.find((pack) => pack.id === packId)?.workflow.roles || emptyRoles;
}
