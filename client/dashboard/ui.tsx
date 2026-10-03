import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useId } from "react";
import { Pressable, Text, TextInput, View, useWindowDimensions } from "react-native";

export function Action<T>({
  theme,
  title,
  value,
  onAction,
  disabled = false,
  variant = "ghost",
  selected = false,
  compact = false,
}: {
  theme: PluginHostProps["theme"];
  title: string;
  value: T;
  onAction(value: T): void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  selected?: boolean;
  compact?: boolean;
}) {
  const nativeId = useId();
  const { width } = useWindowDimensions();
  const touchControls = width < 768;
  const press = useCallback(() => onAction(value), [onAction, value]);
  const accessibilityState = useMemo(() => ({ disabled, selected }), [disabled, selected]);
  const passiveBackground = selected ? theme.colors.surface2 : "transparent";
  const styles = useMemo(
    () => ({
      button: {
        minHeight: touchControls ? 48 : 40,
        minWidth: touchControls ? 48 : undefined,
        justifyContent: "center" as const,
        paddingVertical: compact ? 6 : 9,
        paddingHorizontal: compact ? 10 : 12,
        borderRadius: 8,
        borderWidth: variant === "secondary" || selected ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor: variant === "primary" ? theme.colors.accent : passiveBackground,
        opacity: disabled ? 0.45 : 1,
      },
      text: {
        color: {
          primary: theme.colors.accentForeground,
          secondary: theme.colors.foreground,
          ghost: theme.colors.foreground,
          danger: theme.colors.statusDanger,
        }[variant],
        fontWeight: "600" as const,
      },
    }),
    [theme, disabled, variant, selected, compact, passiveBackground, touchControls],
  );
  return (
    <Pressable
      nativeID={nativeId}
      accessibilityRole="button"
      accessibilityLabel={title}
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
}: {
  theme: PluginHostProps["theme"];
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
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
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
      />
    </View>
  );
}

export function useDashboardStyles({ theme, layout }: Pick<PluginHostProps, "theme" | "layout">) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: layout.compact ? 16 : 28,
        gap: 20,
        maxWidth: 1180,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
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
      main: { minWidth: 0, gap: 8 },
      stack: { gap: 10 },
      card: {
        paddingVertical: 12,
        gap: 8,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
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
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
}
