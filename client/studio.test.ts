// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { afterEach, expect, it, vi } from "vitest";
import { Studio } from "./studio.js";

const fixture = vi.hoisted(() => ({
  list: vi.fn(async () => ({ teams: [] })),
  packs: vi.fn(async () => ({ packs: [] })),
  paseo: { projects: { list: vi.fn(async () => ({ projects: [] })) } },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => fixture.paseo,
  useRpc: (contract: { name: string }) =>
    contract.name === "factory.list" ? fixture.list : fixture.packs,
}));
vi.mock("./ui.js", () => ({
  useFactoryStyles: () => ({}),
  Action: (props: {
    title: string;
    value: string;
    selected: boolean;
    variant: string;
    onAction(value: string): void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        role: props.variant === "tab" ? "tab" : "button",
        "aria-selected": props.selected,
        onClick: () => props.onAction(props.value),
      },
      props.title,
    ),
}));
vi.mock("./choice.js", () => ({ Choice: () => null }));
vi.mock("./mission-summary.js", () => ({ MissionList: () => null }));
vi.mock("./factory.js", () => ({
  Factory: (props: { selectedTeamId: string }) =>
    createElement("div", { "data-mission": props.selectedTeamId }, "Missions"),
}));
vi.mock("./workflows.js", () => ({
  WorkflowProfiles: () => createElement("div", { "data-editor": true }, "Team editor"),
  WorkItemProfileSettings: () => null,
}));
vi.mock("./improvements.js", () => ({ Improvements: () => null }));
vi.mock("./migration.js", () => ({ MigrationSettings: () => null }));
vi.mock("./office.js", () => ({ Office: () => null }));
vi.mock("./dashboard/dashboard.js", () => ({ Dashboard: () => null }));
vi.mock("./dashboard/settings.js", () => ({ DashboardSettings: () => null }));
vi.mock("./settings.js", () => ({ FactorySettings: () => null }));

const props = {
  host: { id: "host", label: "Test host" },
  layout: { compact: false, platform: "web" },
  theme: { colors: { surface0: "#ffffff" } },
} as PluginSurfaceProps;
const viewKey = ["factory", "studio-view", "host", "", ""];
let cache: QueryClient;
let root: Root;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setup() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

async function render(children: ReactNode) {
  act(() => {
    root.render(createElement(QueryClientProvider, { client: cache }, children));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function click(title: string) {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (entry) => entry.textContent === title,
  );
  expect(tab).toBeTruthy();
  await act(async () => {
    tab!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function selectedTabs() {
  return [...container.querySelectorAll('[role="tab"][aria-selected="true"]')].map(
    (entry) => entry.textContent,
  );
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  cache?.clear();
  container?.remove();
  vi.clearAllMocks();
});

it("settles conflicting mounted routes and keeps manual tabs stable through mission refreshes", async () => {
  setup();
  let navigationUpdates = 0;
  const unsubscribe = cache.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.query.queryKey[1] !== "studio-view" ||
      event.action.type !== "success"
    ) {
      return;
    }
    navigationUpdates += 1;
    if (navigationUpdates > 20) throw new Error("Kitchen navigation keeps switching tabs");
  });
  try {
    await render(
      createElement(
        "div",
        null,
        createElement(Studio, { ...props, params: { section: "Missions" } }),
        createElement(Studio, { ...props, params: { section: "Team" } }),
      ),
    );
    expect(selectedTabs()).toEqual(["Team", "Team"]);
    await click("Missions");
    expect(selectedTabs()).toEqual(["Missions", "Missions"]);
    await click("Team");
    const settledUpdates = navigationUpdates;
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await cache.invalidateQueries({ queryKey: ["factory"] });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(fixture.list.mock.calls.length).toBeGreaterThan(1);
    expect(selectedTabs()).toEqual(["Team", "Team"]);
    expect(container.querySelectorAll("[data-editor]")).toHaveLength(2);
    expect(navigationUpdates).toBe(settledUpdates);
  } finally {
    unsubscribe();
  }
});

it("handles a new mission link once and preserves a manual tab when that link is unchanged", async () => {
  setup();
  const mission = (id: string) =>
    createElement(Studio, { ...props, params: { teamId: id, section: "Missions" } });
  await render(mission("first"));
  expect(container.querySelector('[data-mission="first"]')).toBeTruthy();
  await click("Team");
  await render(mission("first"));
  expect(selectedTabs()).toEqual(["Team"]);
  await render(mission("second"));
  expect(selectedTabs()).toEqual(["Missions"]);
  expect(container.querySelector('[data-mission="second"]')).toBeTruthy();
  await click("Team");
  await render(null);
  await render(mission("second"));
  expect(selectedTabs()).toEqual(["Team"]);
  expect(cache.getQueryData(viewKey)).toMatchObject({ selectedTeam: "second", section: "Team" });
});
