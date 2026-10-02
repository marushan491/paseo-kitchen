import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useId, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

export function Action<T>({
  theme,
  title,
  accessibilityLabel,
  value,
  onAction,
  disabled = false,
  variant = "ghost",
  selected = false,
}: {
  theme: PluginHostProps["theme"];
  title: string;
  accessibilityLabel?: string;
  value: T;
  onAction(value: T): void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  selected?: boolean;
}) {
  const nativeId = useId();
  const press = useCallback(() => onAction(value), [onAction, value]);
  const accessibilityState = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  const styles = useMemo(() => {
    let borderColor = theme.colors.border;
    if (variant === "ghost") borderColor = "transparent";
    if (selected) borderColor = theme.colors.accent;
    let backgroundColor = "transparent";
    if (selected) backgroundColor = theme.colors.surface1;
    if (variant === "primary") backgroundColor = theme.colors.accent;
    let color = theme.colors.foreground;
    if (variant === "danger") color = theme.colors.statusDanger;
    if (variant === "primary") color = theme.colors.accentForeground;
    return {
      button: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor,
        backgroundColor,
        minHeight: 40,
        opacity: disabled ? 0.45 : 1,
      },
      text: { color, fontWeight: "600" as const },
    };
  }, [theme, disabled, variant, selected]);
  return (
    <Pressable
      nativeID={nativeId}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={press}
      style={styles.button}
    >
      <Text style={styles.text}>{title}</Text>
    </Pressable>
  );
}

export function Field({
  theme,
  label,
  value,
  onChange,
  multiline = false,
  secureTextEntry = false,
  placeholder,
}: {
  theme: PluginHostProps["theme"];
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  secureTextEntry?: boolean;
  placeholder?: string;
}) {
  const nativeId = useId();
  const styles = useMemo(
    () => ({
      group: { gap: 6 },
      label: { color: theme.colors.foregroundMuted },
      input: {
        color: theme.colors.foreground,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        minHeight: multiline ? 84 : 44,
      },
    }),
    [theme, multiline],
  );
  return (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        nativeID={nativeId}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
      />
    </View>
  );
}

export function useFactoryStyles({ theme, layout }: Pick<PluginHostProps, "theme" | "layout">) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: layout.compact ? 16 : 20,
        gap: 20,
        width: "100%" as const,
        maxWidth: 1180,
        alignSelf: "center" as const,
      },
      footer: {
        padding: 16,
        gap: 8,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      projectPicker: { width: 240 },
      header: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      scope: { minWidth: 230, maxWidth: 420, flex: 1 },
      flush: {
        padding: layout.compact ? 16 : 20,
        paddingTop: 0,
        paddingBottom: 0,
        gap: 20,
        maxWidth: 1180,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      roleInfo: { flex: 1, minWidth: 200 },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        alignItems: "center" as const,
      },
      columns: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        gap: 20,
        alignItems: "stretch" as const,
      },
      sidebar: { width: layout.compact ? undefined : 280, gap: 12 },
      main: { flex: 1, minWidth: 0, gap: 16 },
      stack: { gap: 10 },
      card: {
        padding: 16,
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      branch: {
        marginLeft: 20,
        paddingLeft: 16,
        borderLeftWidth: 2,
        borderColor: theme.colors.border,
        gap: 12,
      },
      title: { color: theme.colors.foreground, fontSize: 24, fontWeight: "600" as const },
      heading: { color: theme.colors.foreground, fontSize: 17, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
}

export function Disclosure({
  theme,
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  theme: PluginHostProps["theme"];
  title: string;
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const styles = useMemo(
    () => ({
      container: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        overflow: "hidden" as const,
      },
      toggle: { padding: 14, gap: 4, backgroundColor: theme.colors.surface1 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const, flex: 1 },
      glyph: { color: theme.colors.foregroundMuted, fontSize: 18 },
      summary: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      body: { padding: 16, gap: 14 },
    }),
    [theme],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.toggle}
      >
        <View style={styles.row}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.glyph}>{expanded ? "−" : "+"}</Text>
        </View>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
      </Pressable>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}
