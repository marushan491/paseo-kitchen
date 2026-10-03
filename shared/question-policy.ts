import { z } from "zod";
import type { AutonomySettings } from "./preferences.js";

export const HumanQuestionSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  text: z.string(),
  category: z.string(),
  askedAt: z.string(),
  continueAt: z.string().optional(),
  responseStartedAt: z.string().optional(),
  agentId: z.string().optional(),
  providerRequestId: z.string().optional(),
});
export type HumanQuestion = z.infer<typeof HumanQuestionSchema>;
export function readHumanQuestion(value: unknown): HumanQuestion | null {
  const result = HumanQuestionSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function isBlockingQuestion(category: string, text: string): boolean {
  return (
    !text.trim() ||
    ["access", "irreversible"].includes(category) ||
    /\b(oauth\w*|2fa|mfa|password|passwort|credentials?|zugangsdaten|anmeldedaten|consent|einwilligung|verification code|bestätigungscode|username|benutzername|log[ -]?in|anmelden|authorization|approval|approve|freigabe|genehmigung|merge|publish|deploy)\b/i.test(
      text,
    )
  );
}
export function optionalQuestionDue(
  question: HumanQuestion,
  settings: AutonomySettings,
  now: Date,
): boolean {
  return (
    settings.optionalQuestionBehavior === "continue" &&
    !isBlockingQuestion(question.category, question.text) &&
    !question.responseStartedAt &&
    Boolean(question.continueAt) &&
    Math.max(
      Date.parse(question.continueAt!),
      Date.parse(question.askedAt) + settings.questionWaitSeconds * 1000,
    ) <= now.getTime()
  );
}
export function questionContinuation(text: string): string {
  return `The optional question was not answered before its waiting period ended: ${text}\nContinue investigating the repository, existing documentation, configured tools and available browser sessions. Use a reversible assumption within the already authorized mission when needed and record the assumption and evidence. Silence is not an answer or authorization. Do not fabricate credentials, finish an OAuth consent step for the user, claim approval, expand scope, merge, publish or deploy. Ask again only if the remaining obstacle truly requires the user. Keep independent work moving.`;
}
export function autonomyInstructions(settings: AutonomySettings): string {
  return [
    "Investigate first using the repository, documentation, available skills, configured tools and browser context. Resolve routine implementation and reversible product details within the mission yourself.",
    settings.optionalQuestionBehavior === "continue"
      ? `Optional clarification can wait up to ${settings.questionWaitSeconds} seconds. If no human starts replying, Kitchen may resume research with a documented reversible assumption. Do not hold the whole mission for a preference; continue independent work. A started reply waits for the user.`
      : "Optional questions wait for the operator's answer.",
    'Use needs:{kind:"human",category:"access",text:"the missing access and exact action needed"} only when configured credentials or the existing browser session cannot resolve login, OAuth consent, MFA or another action requiring the user. Required authorization and irreversible actions use category:"irreversible". These never time out into approval.',
  ].join("\n");
}
