import { z } from "zod";
export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
});
export const RoleProfileOverrideSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  routingMode: z.enum(["auto", "manual"]).optional(),
  thinking: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  workflowProfileId: z.string().min(1).optional(),
  instructions: z.string().optional(),
  skills: z.array(z.string().min(1)).optional(),
  steps: z.array(WorkflowStepSchema).optional(),
});
