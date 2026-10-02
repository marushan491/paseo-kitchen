import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import { TeamView } from "./team-view.js";

const fixture = vi.hoisted(() => ({
  message: vi.fn(async () => ({})),
  sender: undefined as ((text: string) => Promise<void>) | undefined,
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) =>
    contract.name === "factory.message" ? fixture.message : vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({
    isPending: false,
    data: {
      state: {
        commit: 1,
        team: {
          id: "team_test",
          title: "Awaiting decision",
          status: "active",
          cwd: "/repo",
          bossAgentId: "boss",
          rootItemId: "root",
        },
        items: { root: { phase: "blocked", pack: {} } },
        bindings: {},
        decisions: {},
      },
      events: [],
    },
  }),
}));
vi.mock("./timeline.js", () => ({
  AgentTimeline: ({ sendMessage }: { sendMessage?: (text: string) => Promise<void> }) => {
    fixture.sender = sendMessage;
    return null;
  },
}));

it("sends Kitchen Teamchat answers through the persisted team message path", async () => {
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
});
