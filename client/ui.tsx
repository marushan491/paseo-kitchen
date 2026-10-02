import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useId, useState } from "react";
import type { ReactNode, Ref } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
  useWindowDimensions,
} from "react-native";

export function Action<T>({
  theme,
  title,
  accessibilityLabel,
  value,
  onAction,
  disabled = false,
  variant = "ghost",
  selected = false,
  compact,
  buttonRef,
  trailing,
}: {
  theme: PluginHostProps["theme"];
  title: string;
  accessibilityLabel?: string;
  value: T;
  onAction(value: T): void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "tab";
  selected?: boolean;
  compact?: boolean;
  buttonRef?: Ref<View>;
  trailing?: string;
}) {
  const nativeId = useId();
  const { width } = useWindowDimensions();
  const touchControls = compact ?? width < 768;
  const press = useCallback(() => onAction(value), [onAction, value]);
  const accessibilityState = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  const styles = useMemo(() => {
    let borderColor = theme.colors.border;
    if (variant === "ghost") borderColor = "transparent";
    if (selected) borderColor = theme.colors.accent;
    if (variant === "tab" && !selected) borderColor = "transparent";
    let backgroundColor = "transparent";
    if (selected) backgroundColor = theme.colors.surface1;
    if (variant === "primary") backgroundColor = theme.colors.accent;
    let color = theme.colors.foreground;
    if (variant === "danger") color = theme.colors.statusDanger;
    if (variant === "primary") color = theme.colors.accentForeground;
    if (variant === "tab" && selected) color = theme.colors.accent;
    return {
      button: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: variant === "tab" ? 0 : 8,
        borderWidth: variant === "tab" ? 0 : 1,
        borderBottomWidth: variant === "tab" ? 2 : 1,
        borderColor,
        backgroundColor,
        minHeight: touchControls ? 48 : 44,
        justifyContent: "center" as const,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        opacity: disabled ? 0.45 : 1,
      },
      text: { color, fontWeight: "600" as const, fontSize: 14, flexShrink: 1 },
    };
  }, [theme, disabled, variant, selected, touchControls]);
  return (
    <Pressable
      nativeID={nativeId}
      ref={buttonRef}
      accessibilityRole={variant === "tab" ? "tab" : "button"}
      accessibilityLabel={accessibilityLabel || title}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={press}
      style={styles.button}
    >
      <Text style={styles.text}>{title}</Text>
      {trailing ? (
        <Text accessibilityElementsHidden style={styles.text}>
          {trailing}
        </Text>
      ) : null}
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
  keyboardType,
  autoFocus = false,
}: {
  theme: PluginHostProps["theme"];
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  secureTextEntry?: boolean;
  placeholder?: string;
  keyboardType?: TextInputProps["keyboardType"];
  autoFocus?: boolean;
}) {
  const nativeId = useId();
  const { width } = useWindowDimensions();
  const controlHeight = width < 768 ? 48 : 44;
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
        minHeight: multiline ? 112 : controlHeight,
        textAlignVertical: multiline ? ("top" as const) : ("center" as const),
        backgroundColor: theme.colors.surface0,
      },
    }),
    [theme, multiline, controlHeight],
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
        keyboardType={keyboardType}
        autoFocus={autoFocus}
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
        maxWidth: 1520,
        alignSelf: "center" as const,
      },
      footer: {
        padding: 16,
        gap: 8,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      projectPicker: {
        width: layout.compact ? undefined : 240,
        flex: layout.compact ? 1 : undefined,
      },
      header: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        alignItems: "flex-end" as const,
        justifyContent: "space-between" as const,
      },
      scope: { minWidth: 230, maxWidth: 420, flex: 1 },
      flush: {
        padding: layout.compact ? 16 : 20,
        paddingTop: 0,
        paddingBottom: 0,
        gap: 20,
        maxWidth: 1520,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      roleInfo: { flex: 1, minWidth: 200 },
      fieldGroup: { gap: 6 },
      roleLine: { paddingVertical: 12, borderBottomWidth: 1, borderColor: theme.colors.border },
      alignedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 16 },
      roleSummary: { flex: 1, minWidth: 0, gap: 4 },
      footerActions: { flexDirection: "row" as const, gap: 8, justifyContent: "flex-end" as const },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        alignItems: "center" as const,
      },
      navigation: { flexDirection: "row" as const, gap: 8, paddingBottom: 1 },
      controls: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        gap: 12,
        width: layout.compact ? ("100%" as const) : undefined,
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

export function SurfaceSheet(
  props: PluginHostProps & {
    title: string;
    children: ReactNode;
    onClose(): void;
    footer?: ReactNode;
    narrow?: boolean;
    side?: boolean;
  },
) {
  const styles = useFactoryStyles(props);
  const { theme, layout, side, narrow } = props;
  const sheet = useMemo(() => {
    let alignItems = "center" as "center" | "stretch" | "flex-end";
    if (side) alignItems = "flex-end";
    if (layout.compact) alignItems = "stretch";
    let width: number | "100%" = narrow ? 440 : 640;
    if (layout.compact) width = "100%";
    const fullHeight = Boolean(side && !layout.compact);
    return {
      overlay: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.6)",
        justifyContent: layout.compact ? ("flex-end" as const) : ("center" as const),
        alignItems,
      },
      dismiss: { position: "absolute" as const, inset: 0 },
      surface: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: fullHeight ? 0 : 16,
        width,
        maxWidth: "100%" as const,
        maxHeight: fullHeight ? ("100%" as const) : ("90%" as const),
        height: fullHeight ? ("100%" as const) : undefined,
        paddingTop: 4,
        overflow: "hidden" as const,
      },
      header: {
        ...styles.header,
        padding: 16,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      body: { padding: 20, gap: 16 },
    };
  }, [theme, layout.compact, side, narrow, styles.header]);
  return (
    <Modal transparent visible animationType="none" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        behavior={props.layout.platform === "ios" ? "padding" : "height"}
        style={sheet.overlay}
      >
        <Pressable
          accessibilityLabel="Dismiss dialog"
          onPress={props.onClose}
          style={sheet.dismiss}
        />
        <SafeAreaView accessibilityViewIsModal style={sheet.surface}>
          <View style={sheet.header}>
            <Text accessibilityRole="header" style={styles.heading}>
              {props.title}
            </Text>
            <Action
              theme={props.theme}
              title="Close"
              accessibilityLabel={`Close ${props.title}`}
              value="close"
              onAction={props.onClose}
              compact={props.layout.compact}
            />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={sheet.body}>
            {props.children}
          </ScrollView>
          {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
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
