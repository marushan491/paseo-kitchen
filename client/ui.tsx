import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useId } from "react";
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
    if (variant === "primary") color = theme.colors.surface0;
    return {
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor,
        backgroundColor,
        minHeight: 44,
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
}: {
  theme: PluginHostProps["theme"];
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  secureTextEntry?: boolean;
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
      content: { padding: layout.compact ? 16 : 24, gap: 20 },
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
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
}
