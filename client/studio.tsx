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
import { Factory } from "./factory.js";
import { Improvements } from "./improvements.js";
import { MigrationSettings } from "./migration.js";
import { Office } from "./office.js";
import { Dashboard } from "./dashboard/dashboard.js";
import { DashboardSettings } from "./dashboard/settings.js";
import { FactorySettings } from "./settings.js";
import { WorkflowProfiles, WorkItemProfileSettings } from "./workflows.js";

const sections = ["Overview", "Kitchen", "Missions", "Roles & workflows", "Settings"] as const;
const emptyTeams: TeamState[] = [];
const emptyRoles = {};
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
  const [monitor, setMonitor] = useState<"overview" | "activity" | "problems">("overview");
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
  const selectSection = useCallback((value: Section) => {
    setSection(value);
    setSelectedAgent("");
  }, []);
  const chooseProject = useCallback((value: string) => {
    setProject(value);
    setSelectedTeam("");
    setSelectedAgent("");
    setCreateNew(false);
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
            <Text style={styles.muted}>
              Give your agents a goal. Follow the work. Review the result.
            </Text>
          </View>
          <View style={styles.row}>
            {section !== "Settings" ? (
              <View style={styles.projectPicker}>
                <Choice
                  {...props}
                  label="Project scope"
                  value={project}
                  options={projectOptions}
                  allowEmpty
                  emptyTitle="All projects"
                  onChange={chooseProject}
                />
              </View>
            ) : null}
            <Action
              theme={props.theme}
              title="+ New mission"
              accessibilityLabel="New mission"
              variant="primary"
              value="new"
              onAction={newMission}
            />{" "}
          </View>
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
        {projects.error ? (
          <Text style={styles.danger}>Projects could not load: {String(projects.error)}</Text>
        ) : null}
      </View>
      {section === "Missions" ? (
        <Factory
          key={`${selectedTeam}:${createNew}:${project}`}
          {...props}
          projectPath={project}
          selectedTeamId={selectedTeam}
          createNew={createNew}
          onCreated={openTeam}
          onNew={newMission}
        />
      ) : null}
      {section === "Overview" ? (
        <View style={styles.screen}>
          <View style={styles.flush}>
            <View style={styles.row}>
              <Action
                theme={props.theme}
                title="Needs you"
                selected={monitor === "overview"}
                value={"overview" as const}
                onAction={setMonitor}
              />
              <Action
                theme={props.theme}
                title="Activity"
                selected={monitor === "activity"}
                value={"activity" as const}
                onAction={setMonitor}
              />
              <Action
                theme={props.theme}
                title="Problems"
                selected={monitor === "problems"}
                value={"problems" as const}
                onAction={setMonitor}
              />
            </View>
            {allTeams.length === 0 && monitor === "overview" ? (
              <View style={styles.card}>
                <Text style={styles.heading}>Your first Kitchen mission</Text>
                <Text style={styles.text}>
                  Choose a project and describe a feature or a whole product. Kitchen plans the
                  work, assigns roles and continues until your goal is verified.
                </Text>
                <Text style={styles.muted}>Plan → Build → Review → Verify → Your acceptance</Text>
                <Action
                  theme={props.theme}
                  title="Create your first mission"
                  variant="primary"
                  value="new"
                  onAction={newMission}
                />
              </View>
            ) : null}
          </View>
          <Dashboard
            {...props}
            projectPath={project}
            section={monitor}
            teamNavigation={teamNavigation}
          />
        </View>
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
      {section === "Roles & workflows" ? (
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
          Missions and Roles & workflows.
        </Text>
        <View style={styles.row}>
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
        </View>
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
