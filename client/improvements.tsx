import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import {
  ImprovementRuleSchema,
  factoryImprovementsList,
  factoryImprovementsSave,
  factoryImprovementsScan,
} from "../shared/improvement-contracts.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";

export function Improvements(props: PluginSurfaceProps) {
  const styles = useFactoryStyles(props),
    list = useRpc(factoryImprovementsList),
    save = useRpc(factoryImprovementsSave),
    scan = useRpc(factoryImprovementsScan);
  const query = useQuery({
    queryKey: ["factory", "improvements"],
    queryFn: () => list({}),
    refetchInterval: 10_000,
  });
  const [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const saveRule = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const rule = ImprovementRuleSchema.parse(JSON.parse(draft));
      await save({ rule, actorId: "studio" });
      setDraft("");
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Rule could not be saved");
    } finally {
      setBusy(false);
    }
  }, [draft, save, query]);
  const scanNow = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await scan({ actorId: "studio" });
      if (result.errors.length) setError(result.errors.join("\n"));
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }, [scan, query]);
  const edit = useCallback((value: string) => setDraft(value), []);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Automatic follow-up work</Text>
      <Text style={styles.muted}>
        Enabled rules turn recorded Kitchen events into maintenance missions with a fixed scope,
        criteria, cooldown and run cap. They use the same review, verification and acceptance
        pipeline. No rule merges or deploys changes.
      </Text>
      {query.isPending ? <Text style={styles.muted}>Loading rules…</Text> : null}
      {query.error ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {query.data?.rules.map((rule) => (
        <View key={rule.id} style={styles.card}>
          <Text style={styles.heading}>
            {rule.name} · {rule.enabled ? "Enabled" : "Disabled"}
          </Text>
          <Text style={styles.muted}>
            {rule.minOccurrences} recorded events · {Math.ceil(rule.cooldownMs / 60_000)} min
            cooldown · maximum {rule.maxRuns} missions
          </Text>
          <Text style={styles.text}>{rule.target.objective}</Text>
          <Action
            theme={props.theme}
            title={`Edit ${rule.name}`}
            value={JSON.stringify(rule, null, 2)}
            onAction={edit}
          />
        </View>
      ))}
      {!query.data?.rules.length ? (
        <Text style={styles.muted}>
          No execution rules configured. Analytical Insights and Gardener reports remain suggestions
          until you define an implementation rule.
        </Text>
      ) : null}
      <Disclosure
        theme={props.theme}
        title="Create or edit an improvement rule"
        summary="Optional automation. No rules run until you explicitly enable them."
        defaultOpen={Boolean(draft)}
      >
        <Field
          theme={props.theme}
          label="Improvement rule JSON"
          value={draft}
          onChange={setDraft}
          multiline
        />
        <Text style={styles.muted}>
          Required: id, name, enabled, sourcePackIds, eventTypes, minOccurrences, cooldownMs,
          maxRuns and target (a Kitchen mission with provider, repository, goal and acceptance
          criteria). Save disabled to inspect the rule before enabling it.
        </Text>
        <View style={styles.row}>
          <Action
            theme={props.theme}
            title="Save improvement rule"
            value="save"
            onAction={saveRule}
            disabled={busy || !draft.trim()}
            variant="primary"
          />
          <Action
            theme={props.theme}
            title="Scan recorded events now"
            value="scan"
            onAction={scanNow}
            disabled={busy}
          />
        </View>
      </Disclosure>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {query.data?.runs.map((run) => (
        <View key={run.id} style={styles.card}>
          <Text style={styles.text}>
            {run.ruleId} · {run.status} · {run.at}
          </Text>
          <Text style={styles.muted}>
            {run.teamId ?? "Kickoff pending"} · {run.sourceRefs.length} recorded references
          </Text>
          {run.error ? <Text style={styles.danger}>{run.error}</Text> : null}
        </View>
      ))}
    </View>
  );
}
