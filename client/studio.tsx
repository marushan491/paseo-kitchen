import {
  type PluginSurfaceProps,
  type PluginAgentPanelProps,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useMemo, useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import type { z } from "zod";
import {
  factoryList,
  factoryPacks,
  FactoryPackSchema,
  type TeamState,
} from "../shared/factory-contracts.js";
import { KITCHEN_EXECUTION_ID } from "../shared/native-contracts.js";
import { missionInProject } from "../shared/mission-stage.js";
import type { NativeNavigation } from "./native-entry.js";
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
interface StudioProps
  extends PluginSurfaceProps, Partial<Pick<PluginAgentPanelProps, "workspaceId" | "agentId">> {
  params?: Record<string, string>;
}
interface StudioView {
  routeTeamId: string;
  routeSection: string;
  section: Section;
  project: string;
  selectedTeam: string;
  selectedAgent: string;
  selectedStation: string | null;
}

export function Studio(props: StudioProps) {
  const theme = useMemo(() => {
    const hex = props.theme.colors.surface0.replace("#", "");
    const dark =
      /^[0-9a-f]{6}$/i.test(hex) &&
      [0, 2, 4].reduce((sum, offset) => sum + parseInt(hex.slice(offset, offset + 2), 16), 0) < 384;
    if (!dark) return props.theme;
    return {
      ...props.theme,
      colors: {
        ...props.theme.colors,
        surface0: "#080e15",
        surface1: "#101922",
        surface2: "#17232f",
        border: "#293642",
        foreground: "#edf2f8",
        foregroundMuted: "#9aaaba",
        accent: "#9d7bff",
        accentForeground: "#14082d",
      },
    };
  }, [props.theme]);
  return <StudioContent {...props} theme={theme} />;
}

function StudioContent(props: StudioProps) {
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const cache = useQueryClient();
  const viewKey = useMemo(
    () => ["factory", "studio-view", props.host.id, props.workspaceId || "", props.agentId || ""],
    [props.host.id, props.workspaceId, props.agentId],
  );
  const routeTeamId = props.params?.teamId || "";
  const routeSection = props.params?.section || "";
  const initialSection = sections.includes(routeSection as Section)
    ? (routeSection as Section)
    : "Overview";
  const { data: view } = useQuery<StudioView>({
    queryKey: viewKey,
    enabled: false,
    initialData: {
      routeTeamId,
      routeSection,
      section: routeTeamId ? "Missions" : initialSection,
      project: "",
      selectedTeam: routeTeamId,
      selectedAgent: "",
      selectedStation: null,
    },
  });
  const updateView = useCallback(
    (patch: Partial<StudioView>) =>
      cache.setQueryData<StudioView>(viewKey, (previous) =>
        previous ? { ...previous, ...patch } : previous,
      ),
    [cache, viewKey],
  );
  const { section, project, selectedTeam, selectedAgent, selectedStation } = view;
  useEffect(() => {
    cache.setQueryData<StudioView>(viewKey, (previous) => {
      if (
        !previous ||
        (previous.routeTeamId === routeTeamId && previous.routeSection === routeSection)
      ) {
        return previous;
      }
      const patch: Partial<StudioView> = { routeTeamId, routeSection };
      if (routeTeamId) {
        patch.selectedTeam = routeTeamId;
        patch.section = "Missions";
      } else if (sections.includes(routeSection as Section)) {
        patch.section = routeSection as Section;
      }
      return { ...previous, ...patch };
    });
  }, [routeTeamId, routeSection, cache, viewKey]);
  const setSelectedAgent = useCallback(
    (value: string) => updateView({ selectedAgent: value }),
    [updateView],
  );
  const setSelectedStation = useCallback(
    (value: string | null) => updateView({ selectedStation: value }),
    [updateView],
  );
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
    () => allTeams.filter((state) => missionInProject(state, project)),
    [allTeams, project],
  );
  const configured = useMemo(
    () => findBinding(visibleTeams, selectedAgent),
    [visibleTeams, selectedAgent],
  );
  const openTeam = useCallback(
    (id: string) => updateView({ selectedTeam: id, section: "Missions" }),
    [updateView],
  );
  const nativeNavigation = props.navigation as NativeNavigation | undefined;
  const nativeReady = Boolean(nativeNavigation?.openNewWorkspace);
  const newMission = useCallback(() => {
    nativeNavigation?.openNewWorkspace?.({
      executionId: KITCHEN_EXECUTION_ID,
      cwd: project || undefined,
      projectId: projects.data?.projects.find((entry) => entry.projectRootPath === project)
        ?.projectId,
      serverId: props.host.id,
    });
  }, [nativeNavigation, project, projects.data, props.host.id]);
  const startAction = nativeReady ? newMission : undefined;
  const selectSection = useCallback(
    (value: Section) => updateView({ section: value, selectedAgent: "" }),
    [updateView],
  );
  const chooseProject = useCallback(
    (value: string) =>
      updateView({ project: value, selectedTeam: "", selectedAgent: "", selectedStation: null }),
    [updateView],
  );
  const teamNavigation = useCallback(
    (teamId?: string) => {
      if (teamId) openTeam(teamId);
      else updateView({ section: "Missions" });
    },
    [openTeam, updateView],
  );
  return (
    <View testID="kitchen-studio" style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.stack}>
            <Text accessibilityRole="header" style={styles.title}>
              Kitchen Studio
            </Text>
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

            <Action
              theme={props.theme}
              title="Start mission"
              accessibilityLabel="Start mission"
              compact={props.layout.compact}
              variant="primary"
              value="new"
              onAction={newMission}
              disabled={!nativeReady}
            />
          </View>
        </View>
        <ScrollView
          accessibilityRole="tablist"
          accessibilityLabel="Kitchen Studio sections"
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
      {!nativeReady ? (
        <Text style={styles.muted}>
          Native Kitchen chat needs an updated host with plugin execution modes. Existing missions
          remain available here.
        </Text>
      ) : null}
      {section === "Missions" ? (
        <Factory
          key={selectedTeam}
          {...props}
          projectPath={project}
          selectedTeamId={selectedTeam}
          createNew={false}
          onCreated={openTeam}
          onNew={startAction}
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
        <KitchenScene
          {...props}
          teams={visibleTeams}
          packs={packs.data}
          loading={teams.isPending}
          error={teams.error}
          project={project}
          configured={configured}
          selectedStation={selectedStation}
          onSelectStation={setSelectedStation}
          onOpen={openTeam}
          onConfigure={setSelectedAgent}
          onNew={startAction}
        />
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

function KitchenScene(
  props: PluginSurfaceProps & {
    teams: TeamState[];
    packs?: { packs: z.infer<typeof FactoryPackSchema>[] };
    loading: boolean;
    error: unknown;
    project: string;
    configured: ReturnType<typeof findBinding>;
    selectedStation: string | null;
    onSelectStation(id: string | null): void;
    onOpen(id: string): void;
    onConfigure(id: string): void;
    onNew?: () => void;
  },
) {
  const styles = useFactoryStyles(props);
  const configured = props.configured;
  const roles =
    configured?.state.team.workflowSnapshot?.roles ||
    getConfiguredRoles(props.packs, configured?.state.team.packId);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {props.loading ? <Text style={styles.muted}>Loading Kitchen…</Text> : null}
      {props.error ? <Text style={styles.danger}>{String(props.error)}</Text> : null}
      <Office
        {...props}
        selected={props.selectedStation}
        onSelect={props.onSelectStation}
        teams={props.teams}
        packs={props.packs?.packs || emptyPacks}
        onOpenTeam={props.onOpen}
        onConfigureAgent={props.onConfigure}
        onNewMission={props.onNew}
      />
      <MissionList
        {...props}
        teams={props.teams}
        packs={props.packs?.packs || emptyPacks}
        projectPath={props.project}
        onOpen={props.onOpen}
        onNew={props.onNew}
      />
      {configured ? (
        <WorkItemProfileSettings
          key={configured.binding.id}
          {...props}
          state={configured.state}
          workItemId={configured.binding.workItemId}
          initialRole={configured.binding.role}
          roles={roles}
        />
      ) : null}
    </ScrollView>
  );
}
