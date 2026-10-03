import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";
import { Choice } from "./choice.js";
import {
  editableItemConnections,
  graphOutcomeTitle,
  graphPhaseTitle,
  insertWorkflowRole,
} from "./role-graph-model.js";
import { Action, Field, SurfaceSheet, useFactoryStyles } from "./ui.js";

export function NewWorkflowNode(
  props: PluginSurfaceProps & {
    definition: WorkflowDefinition;
    onApply(definition: WorkflowDefinition): void | Promise<void>;
    onClose(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [clarification, setClarification] = useState<"human" | "head-chef">("human");
  const [investigation, setInvestigation] = useState<"human" | "request-work">("human");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const edges = useMemo(() => editableItemConnections(props.definition), [props.definition]);
  const [edgeId, setEdgeId] = useState(edges[0]?.id ?? "");
  const edge = edges.find((value) => value.id === edgeId);
  const options = useMemo(
    () =>
      edges.map((value) => ({
        id: value.id,
        title: `${graphPhaseTitle({ ...props.definition, maxParallel: 4 }, "item", value.from)}: ${graphOutcomeTitle(value)} → ${graphPhaseTitle({ ...props.definition, maxParallel: 4 }, "item", value.to)}`,
      })),
    [edges, props.definition],
  );
  const { definition, onApply, onClose } = props;
  const apply = useCallback(async () => {
    if (!edge) return;
    setPending(true);
    setError("");
    try {
      await onApply(
        insertWorkflowRole(definition, edge, {
          title,
          instructions,
          canEdit,
          clarification,
          investigation,
        }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [
    edge,
    onApply,
    definition,
    title,
    instructions,
    canEdit,
    clarification,
    investigation,
    onClose,
  ]);
  const toggleEdit = useCallback(() => setCanEdit((value) => !value), []);
  const chooseClarification = useCallback(
    (value: string) => setClarification(value === "head-chef" ? "head-chef" : "human"),
    [],
  );
  const chooseInvestigation = useCallback(
    (value: string) => setInvestigation(value === "request-work" ? "request-work" : "human"),
    [],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title="Cancel"
          value="cancel"
          onAction={onClose}
          disabled={pending}
        />
        <Action
          theme={props.theme}
          title={pending ? "Checking…" : "Add to workflow"}
          value="add"
          onAction={apply}
          variant="primary"
          disabled={pending || !title.trim() || !instructions.trim() || !edge}
        />
      </View>
    ),
    [styles.footerActions, props.theme, onClose, pending, apply, title, instructions, edge],
  );
  return (
    <SurfaceSheet {...props} title="Create role manually" onClose={onClose} footer={footer}>
      <Text style={styles.muted}>
        Add a working stage to Each feature. Its Done outcome continues to the existing destination.
      </Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {error}
        </Text>
      ) : null}
      <Field theme={props.theme} label="Role name" value={title} onChange={setTitle} autoFocus />
      <Field
        theme={props.theme}
        label="Responsibility and instructions"
        value={instructions}
        onChange={setInstructions}
        multiline
        placeholder="Inspect the feature for accessibility issues and record concrete evidence."
      />
      <Choice
        {...props}
        label="Insert into handoff"
        value={edgeId}
        options={options}
        onChange={setEdgeId}
      />
      {!edges.length ? (
        <Text style={styles.danger}>This workflow has no editable feature handoff.</Text>
      ) : null}
      <Action
        theme={props.theme}
        title="May edit implementation files"
        selected={canEdit}
        value="edit"
        onAction={toggleEdit}
      />
      <Text style={styles.muted}>
        {canEdit
          ? "Changes run in this role’s own isolated worktree."
          : "Read-only access to the feature worktree."}
      </Text>
      <Choice
        {...props}
        label="When requirements are unclear"
        value={clarification}
        options={clarificationOptions}
        onChange={chooseClarification}
      />
      <Choice
        {...props}
        label="When more investigation is needed"
        value={investigation}
        options={investigationOptions}
        onChange={chooseInvestigation}
      />
    </SurfaceSheet>
  );
}
const clarificationOptions = [
  { id: "human", title: "Ask me" },
  { id: "head-chef", title: "Ask Head Chef" },
];
const investigationOptions = [
  { id: "human", title: "Ask me" },
  { id: "request-work", title: "Request another work item" },
];
