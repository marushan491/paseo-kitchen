import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import { createTeamState } from "../server/engine.js";
import { kitchenPack } from "../server/pack.js";
import type { TeamState } from "../shared/factory-contracts.js";
import { TeamView } from "./team-view.js";

interface SnapshotQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
  refetchInterval: number;
  refetchIntervalInBackground: boolean;
}
const fixture = vi.hoisted(() => ({
  message: vi.fn(async () => ({})),
  refresh: vi.fn(async (id: string) => ({
    agent: { id, status: "idle", pendingPermissions: [] },
  })),
  snapshots: undefined as SnapshotQuery | undefined,
  state: undefined as TeamState | undefined,
  sender: undefined as ((text: string) => Promise<void>) | undefined,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => react.useState(initial === "Stages" ? "Team chat" : initial),
  };
});
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) =>
    contract.name === "factory.message" ? fixture.message : vi.fn(),
  usePaseo: () => ({
    agents: { ref: (id: string) => ({ refresh: () => fixture.refresh(id) }) },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: (query: SnapshotQuery) => {
    if (query.queryKey[1] === "mission-agent-snapshots") {
      fixture.snapshots = query;
      return { isPending: false, data: {} };
    }
    return {
      isPending: false,
      data: {
        state: fixture.state,
        events: [],
      },
    };
  },
}));
vi.mock("./mission-story.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mission-story.js")>()),
  MissionReply: ({ onSend }: { onSend: (text: string) => Promise<void> }) => {
    fixture.sender = onSend;
    return null;
  },
}));

it("sends Kitchen Teamchat answers through the persisted team message path", async () => {
  const { state } = createTeamState({
    pack: kitchenPack,
    title: "Awaiting decision",
    objective: "Use the agreed acceptance criteria",
    cwd: "/repo",
    bossAgentId: "boss",
    roleProfiles: {},
  });
  state.team.id = "team_test";
  state.team.kitchen = {
    mode: "accompanied",
    idempotencyKey: "test",
    requestFingerprint: "test",
    sourceAgentId: "ordinary-source",
  };
  fixture.state = state;
  const props = {
    teamId: "team_test",
    host: { id: "test", label: "Test" },
    layout: { compact: false, platform: "web" },
    theme: { colors: {} },
  } as unknown as PluginSurfaceProps & { teamId: string };
  renderToStaticMarkup(createElement(TeamView, props));
  expect(fixture.sender).toBeTypeOf("function");
  await fixture.sender!("Use the agreed acceptance criteria");
  expect(fixture.message).toHaveBeenCalledExactlyOnceWith({
    teamId: "team_test",
    text: "Use the agreed acceptance criteria",
    actorId: "human",
  });
  expect(fixture.snapshots).toMatchObject({
    queryKey: ["factory", "mission-agent-snapshots", "test", '["boss"]'],
    enabled: true,
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  expect(await fixture.snapshots!.queryFn()).toEqual({
    boss: { id: "boss", status: "idle", pendingPermissions: [] },
  });
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith("boss");
});
