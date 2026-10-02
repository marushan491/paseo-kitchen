import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Action, Field, useFactoryStyles } from "./ui.js";

export interface ChoiceOption {
  id: string;
  title: string;
  disabled?: boolean;
}

export function filterChoices(options: ChoiceOption[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  const matches = options.filter((option) =>
    `${option.title} ${option.id}`.toLocaleLowerCase().includes(query),
  );
  return { visible: matches.slice(0, 8), count: matches.length };
}

export function Choice(
  props: PluginSurfaceProps & {
    label: string;
    value: string;
    options: ChoiceOption[];
    onChange(value: string): void;
    allowEmpty?: boolean;
    emptyTitle?: string;
  },
) {
  const styles = useFactoryStyles(props);
  const { onChange } = props;
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const choose = useCallback(
    (value: string) => {
      onChange(value);
      setExpanded(false);
      setSearch("");
    },
    [onChange],
  );
  const result = useMemo(() => filterChoices(props.options, search), [props.options, search]);
  const selected = props.options.find((option) => option.id === props.value);
  const emptyTitle = props.emptyTitle ?? "None";
  const placeholder = props.allowEmpty ? emptyTitle : `Choose ${props.label.toLocaleLowerCase()}`;
  const title = props.value ? (selected?.title ?? props.value) : placeholder;
  return (
    <View style={styles.stack}>
      <Text style={styles.muted}>{props.label}</Text>
      <Action
        theme={props.theme}
        title={title}
        accessibilityLabel={`${props.label}: ${title}`}
        value={null}
        onAction={toggle}
        variant="secondary"
        selected={expanded}
      />
      {expanded ? (
        <View style={styles.stack}>
          <Field
            theme={props.theme}
            label={`Search ${props.label.toLocaleLowerCase()}`}
            value={search}
            onChange={setSearch}
          />
          {props.allowEmpty ? (
            <Action
              theme={props.theme}
              title={emptyTitle}
              accessibilityLabel={`${props.label}: ${emptyTitle}`}
              value=""
              onAction={choose}
              selected={!props.value}
            />
          ) : null}
          {result.visible.map((option) => (
            <Action
              key={option.id}
              theme={props.theme}
              title={option.title}
              accessibilityLabel={`${props.label}: ${option.title}`}
              value={option.id}
              onAction={choose}
              disabled={option.disabled}
              selected={option.id === props.value}
            />
          ))}
          <Text style={styles.muted}>
            {result.visible.length} of {result.count} matches
            {result.count > 8 ? " · refine your search" : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
