import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  factoryList,
  factoryStatus,
  factoryStart,
  factoryMessage,
  factorySetStatus,
  factoryRetry,
  factoryReport,
  factoryPlan,
  factoryKitchenStart,
  factoryKitchenControl,
  factoryPacks,
  factoryRequestWork,
  factoryScheduleList,
  factoryScheduleSave,
  factoryScheduleControl,
} from "../shared/factory-contracts.js";
import { KitchenSchedules } from "./schedules.js";
import type { HostControlOptions } from "./host-control.js";
import { sdkController, factoryLogger } from "./controller.js";
import { PackRegistry, type WorkflowPack } from "./pack.js";
import { TeamService, type TeamServiceOptions } from "./service.js";
import { parseFactoryCompletion, factoryValidationFeedback } from "./completion.js";
export type FactoryOptions = Omit<
  TeamServiceOptions,
  "controller" | "logger" | "packs" | "storageRoot"
> & {
  storageRoot: string | (() => Promise<string>);
  packs?: PackRegistry;
  logger?: TeamServiceOptions["logger"];
  enabled?: () => boolean;
  hostControl?: HostControlOptions | (() => Promise<HostControlOptions>);
  packDirectory?: () => Promise<string | undefined>;
};

export function registerFactory(server: PluginServerContext, options: FactoryOptions) {
  let service: TeamService | null = null;
  let schedules: KitchenSchedules | null = null;
  let starting: Promise<TeamService> | null = null;
  let disposed = false;
  const ready = async (paseo: PaseoApi) => {
    if (disposed || options.enabled?.() === false) throw new Error("Factory plugin is disabled");
    if (starting) return starting;
    if (service) return service;
    starting = (async () => {
      const storageRoot =
        typeof options.storageRoot === "function"
          ? await options.storageRoot()
          : options.storageRoot;
      const packs = options.packs ?? new PackRegistry();
      const packDirectory = await options.packDirectory?.();
      if (packDirectory) {
        const result = await packs.loadFrom(packDirectory);
        if (result.failed.length)
          throw new Error(result.failed.map((value) => `${value.path}: ${value.error}`).join("; "));
      }
      const hostControl =
        typeof options.hostControl === "function"
          ? await options.hostControl()
          : options.hostControl;
      const next = new TeamService({
        ...options,
        storageRoot,
        controller: sdkController(paseo, hostControl),
        logger: options.logger ?? factoryLogger,
        packs,
      });
      const nextSchedules = new KitchenSchedules({
        storageRoot,
        service: next,
        now: options.now,
        timers: options.timers,
      });
      try {
        await next.start();
        await nextSchedules.start();
        if (disposed) throw new Error("Factory stopped during startup");
      } catch (error) {
        await nextSchedules.stop();
        await next.shutdown();
        throw error;
      }
      service = next;
      schedules = nextSchedules;
      return next;
    })().finally(() => {
      starting = null;
    });
    return starting;
  };
  server.handle(factoryList, async (input, { paseo }) => {
    const factory = await ready(paseo);
    const teams = [];
    for (const id of await factory.store.listIds()) {
      const state = await factory.store.get(id);
      if (state && (!input.bossAgentId || state.team.bossAgentId === input.bossAgentId))
        teams.push(state);
    }
    return { teams };
  });
  server.handle(factoryStatus, async (input, { paseo }) =>
    (await ready(paseo)).status(input.teamId),
  );
  server.handle(factoryStart, async (input, { paseo }) => (await ready(paseo)).startTeam(input));
  server.handle(factoryKitchenStart, async (input, { paseo }) =>
    (await ready(paseo)).startKitchen(input),
  );
  server.handle(factoryKitchenControl, async (input, { paseo }) =>
    (await ready(paseo)).controlKitchen(input.teamId, input.action, input.actorId),
  );
  server.handle(factoryRequestWork, async (input, { paseo }) => ({
    message: await (await ready(paseo)).requestWork(input.agentId, input.request),
  }));
  server.handle(factoryPacks, async (_, { paseo }) => ({
    packs: (await ready(paseo)).listPacks().map((pack) => ({
      id: pack.id,
      title: pack.title,
      version: pack.version,
      requireVerification: pack.requireVerification,
      maxDelegationDepth: pack.maxDelegationDepth,
      maxDelegatedItems: pack.maxDelegatedItems,
      workflow: workflowOf(pack),
    })),
  }));
  server.handle(factoryScheduleList, async (_, { paseo }) => {
    await ready(paseo);
    return { schedules: await schedules!.list() };
  });
  server.handle(factoryScheduleSave, async (input, { paseo }) => {
    await ready(paseo);
    return schedules!.save(input);
  });
  server.handle(factoryScheduleControl, async (input, { paseo }) => {
    await ready(paseo);
    return schedules!.control(input.id, input.action, input.actorId);
  });
  server.handle(factoryMessage, async (input, { paseo }) => {
    await (
      await ready(paseo)
    ).message(input.teamId, input.text, { type: "human", id: input.actorId });
    return {};
  });
  server.handle(factorySetStatus, async (input, { paseo }) => {
    await (await ready(paseo)).setStatus(input.teamId, input.status, input.actorId);
    return {};
  });
  server.handle(factoryRetry, async (input, { paseo }) => {
    await (await ready(paseo)).retryDecision(input.teamId, input.decisionId, input.actorId);
    return {};
  });
  server.handle(factoryReport, async (input, { paseo }) => ({
    message: await (await ready(paseo)).report(input.agentId, input.report),
  }));
  server.handle(factoryPlan, async (input, { paseo }) => ({
    message: await (await ready(paseo)).plan(input.agentId, input.items),
  }));
  const remove = server.on("agent.turn_ended", async (event, { paseo }) => {
    if (disposed || options.enabled?.() === false) return;
    const factory = await ready(paseo);
    const caller = await factory.resolveCaller(event.agent.id);
    if (!caller || caller.binding.turn === "reported") return;
    let validationError: string | undefined;
    if (event.outcome.kind === "completed") {
      try {
        const completion = parseFactoryCompletion(event.timeline);
        if (completion) {
          await factory.report(
            event.agent.id,
            completion.report,
            completion.items,
            completion.workRequests,
          );
          return;
        }
      } catch (error) {
        validationError = factoryValidationFeedback(error);
        (options.logger ?? factoryLogger).warn(
          {
            agentId: event.agent.id,
            error: validationError,
          },
          "Factory completion rejected",
        );
      }
    }
    await factory.onTurnEnded(
      caller.teamId,
      event.agent.id,
      event.outcome.kind === "failed",
      caller.binding.decisionId,
      validationError,
    );
  });
  return {
    getService: ready,
    initialize: ready,
    get service() {
      return service;
    },
    async cleanup() {
      disposed = true;
      remove();
      await starting?.catch(() => undefined);
      await schedules?.stop();
      await service?.shutdown();
    },
  };
}

function workflowOf(pack: WorkflowPack) {
  return {
    maxParallel: pack.maxParallel,
    roles: Object.fromEntries(
      Object.entries(pack.roles).map(([id, role]) => [id, { title: role.title }]),
    ),
    boards: Object.fromEntries(
      Object.entries(pack.boards).map(([id, board]) => [
        id,
        {
          initialPhase: board.initialPhase,
          phases: Object.fromEntries(
            Object.entries(board.phases).map(([phaseId, phase]) => [
              phaseId,
              { title: phase.title, kind: phase.kind, role: phase.role },
            ]),
          ),
        },
      ]),
    ),
  };
}
