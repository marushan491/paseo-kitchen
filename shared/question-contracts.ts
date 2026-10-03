import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const factoryQuestionActivity = defineRpc({
  name: "factory.question.activity",
  input: z.object({ teamId: z.string(), kind: z.enum(["focus", "typing"]) }),
  output: z.object({}),
});
export const factoryAutonomyStatus = defineRpc({
  name: "factory.autonomy.status",
  input: z.object({}),
  output: z.object({ inputActivitySupported: z.boolean() }),
});
