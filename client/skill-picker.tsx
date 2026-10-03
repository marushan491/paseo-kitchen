import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { factorySkillsList, type InstalledSkill } from "../shared/skill-contracts.js";
import { skillOptions, skillProviderStatus } from "./skill-options.js";
import { Action, Field, SurfaceSheet, useFactoryStyles } from "./ui.js";

export function SkillPicker(
  props: PluginSurfaceProps & {
    value: string[];
    onChange(value: string[]): void;
    cwd?: string;
    provider?: string;
    role?: string;
    title?: string;
    instructions?: string;
  },
) {
  const styles = useFactoryStyles(props);
  const list = useRpc(factorySkillsList);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const catalog = useQuery({
    queryKey: ["factory", "skills", props.cwd || "", props.provider || ""],
    queryFn: () => list({ cwd: props.cwd || undefined, provider: props.provider || undefined }),
    enabled: open,
    staleTime: 60_000,
  });
  const { value, onChange } = props;
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
  }, []);
  const add = useCallback(
    (name: string) => {
      if (!value.includes(name)) onChange([...value, name]);
    },
    [value, onChange],
  );
  const remove = useCallback(
    (name: string) => onChange(value.filter((entry) => entry !== name)),
    [value, onChange],
  );
  const refresh = useCallback(() => {
    void catalog.refetch();
  }, [catalog]);
  const options = useMemo(
    () => skillOptions(catalog.data?.skills || [], search, props, value),
    [catalog.data, search, props, value],
  );
  const missing = catalog.data
    ? value.filter((name) => !catalog.data.skills.some((entry) => entry.name === name))
    : [];
  const render = (skill: InstalledSkill & { reason?: string }) => (
    <View key={skill.name} style={styles.stack}>
      <View style={styles.header}>
        <View style={styles.roleSummary}>
          <Text style={styles.text}>{skill.name}</Text>
          {skill.description ? (
            <Text style={styles.muted} numberOfLines={3}>
              {skill.description}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            {skill.scope === "project" ? "Project skill" : "Host skill"}
            {skill.providers.length
              ? ` / ${skillProviderStatus(skill.providers, catalog.data?.providers || [])}`
              : ""}
          </Text>
          {skill.reason ? <Text style={styles.muted}>{skill.reason}</Text> : null}
        </View>
        <Action
          theme={props.theme}
          title={value.includes(skill.name) ? "Added" : "Add"}
          accessibilityLabel={`Add skill ${skill.name}`}
          value={skill.name}
          onAction={add}
          disabled={value.includes(skill.name) || value.length >= 32}
          variant="secondary"
          compact={props.layout.compact}
        />
      </View>
    </View>
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Skills</Text>
      <View style={styles.row}>
        {value.map((name) => (
          <Action
            key={name}
            theme={props.theme}
            title={`${name} ×`}
            accessibilityLabel={`Remove skill ${name}`}
            value={name}
            onAction={remove}
            variant="secondary"
          />
        ))}
        <Action
          theme={props.theme}
          title="+ Add skill"
          value="add"
          onAction={show}
          variant="secondary"
        />
      </View>
      {missing.length ? (
        <Text style={styles.muted}>
          Not found for this context: {missing.join(", ")}. Existing selections are kept.
        </Text>
      ) : null}
      {open ? (
        <SurfaceSheet {...props} title="Choose skills" onClose={close} narrow>
          <Field
            theme={props.theme}
            label="Search skills"
            value={search}
            onChange={setSearch}
            placeholder="Name or purpose, e.g. review or taste"
            autoFocus
          />
          <Text style={styles.muted}>
            Skills discovered on this host
            {props.provider ? ` for ${props.provider}` : " in known provider folders"}. Choose what
            this role needs; its agent confirms that its harness can load them.
          </Text>
          {catalog.isPending ? <Text style={styles.muted}>Reading skill metadata…</Text> : null}
          {catalog.error ? (
            <Text style={styles.danger}>Skills could not be loaded: {String(catalog.error)}</Text>
          ) : null}
          <Action
            theme={props.theme}
            title={catalog.isFetching ? "Refreshing…" : "Refresh skills"}
            value="refresh"
            onAction={refresh}
            disabled={catalog.isFetching}
          />
          {options.suggested.length ? (
            <>
              <Text style={styles.heading}>Suggested for this role</Text>
              {options.suggested.map(render)}
            </>
          ) : null}
          {options.available.length ? (
            <>
              <Text style={styles.heading}>Discovered skills</Text>
              {options.available.map(render)}
            </>
          ) : null}
          {catalog.data && !options.suggested.length && !options.available.length ? (
            <Text style={styles.muted}>
              {search
                ? "No skills match this search."
                : "No skills were found for this project and provider."}
            </Text>
          ) : null}
          {catalog.data?.warnings.map((warning) => (
            <Text key={warning} style={styles.muted}>
              {warning}
            </Text>
          ))}
        </SurfaceSheet>
      ) : null}
    </View>
  );
}
