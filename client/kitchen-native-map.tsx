import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { clampZoom, kitchenStations } from "./kitchen-stations.js";
import { officeToneColor, type OfficeDesk } from "./office-model.js";
import type { OfficePalette } from "./web.js";

const mapWidth = 800,
  mapHeight = 630;
export function NativeKitchenMap(
  props: PluginSurfaceProps & {
    desks: readonly OfficeDesk[];
    selected: string | null;
    onSelect(value: string): void;
    zoom: number;
    onZoom(value: number): void;
    fitKey: number;
    palette: OfficePalette;
  },
) {
  const [bounds, setBounds] = useState({ width: 320, height: 400 });
  const translation = useRef(new Animated.ValueXY()).current;
  const scale = useRef(new Animated.Value(1)).current;
  const gesture = useRef({
    x: 0,
    y: 0,
    zoom: 100,
    startDistance: 0,
    startZoom: 100,
    initialX: 0,
    initialY: 0,
  });
  const fit = Math.min(bounds.width / mapWidth, bounds.height / mapHeight) * 0.94;
  const layout = useCallback((event: LayoutChangeEvent) => setBounds(event.nativeEvent.layout), []);
  useEffect(() => {
    scale.setValue((fit * props.zoom) / 100);
    gesture.current.zoom = props.zoom;
  }, [scale, fit, props.zoom]);
  useEffect(() => {
    translation.setValue({ x: 0, y: 0 });
    gesture.current.x = 0;
    gesture.current.y = 0;
  }, [translation, props.fitKey]);
  const { onZoom } = props;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, state) =>
          state.numberActiveTouches > 1 || Math.abs(state.dx) + Math.abs(state.dy) > 5,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          gesture.current.initialX = gesture.current.x;
          gesture.current.initialY = gesture.current.y;
          gesture.current.startZoom = gesture.current.zoom;
          gesture.current.startDistance =
            touches.length > 1
              ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY)
              : 0;
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          if (touches.length > 1) {
            const distance = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            if (!gesture.current.startDistance) gesture.current.startDistance = distance;
            gesture.current.zoom = clampZoom(
              (gesture.current.startZoom * distance) / gesture.current.startDistance,
            );
            scale.setValue((fit * gesture.current.zoom) / 100);
          } else {
            gesture.current.x = gesture.current.initialX + state.dx;
            gesture.current.y = gesture.current.initialY + state.dy;
            translation.setValue({ x: gesture.current.x, y: gesture.current.y });
          }
        },
        onPanResponderRelease: () => onZoom(gesture.current.zoom),
        onPanResponderTerminationRequest: () => true,
      }),
    [translation, scale, fit, onZoom],
  );
  const styles = useMemo(
    () => ({
      viewport: {
        height: 420,
        overflow: "hidden" as const,
        backgroundColor: props.theme.colors.surface1,
        borderRadius: 14,
      },
      room: {
        position: "absolute" as const,
        left: bounds.width / 2 - mapWidth / 2,
        top: bounds.height / 2 - mapHeight / 2,
        width: mapWidth,
        height: mapHeight,
        backgroundColor: props.theme.colors.surface0,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: props.theme.colors.border,
        transform: [{ translateX: translation.x }, { translateY: translation.y }, { scale }],
      },
    }),
    [props.theme, bounds, translation, scale],
  );
  return (
    <View style={styles.viewport} onLayout={layout} {...responder.panHandlers}>
      <Animated.View style={styles.room}>
        {kitchenStations.map((station) => (
          <NativeStation key={station.id} {...props} station={station} />
        ))}
      </Animated.View>
    </View>
  );
}
function NativeStation(
  props: Parameters<typeof NativeKitchenMap>[0] & { station: (typeof kitchenStations)[number] },
) {
  const { station, onSelect } = props;
  const workers = props.desks.filter((desk) => desk.stationId === station.id);
  const select = useCallback(() => onSelect(`station:${station.id}`), [onSelect, station.id]);
  const styles = useMemo(
    () => ({
      island: {
        position: "absolute" as const,
        left: mapWidth / 2 + station.x * 47 - 83,
        top: 85 + (station.z + 4) * 45,
        width: 166,
        minHeight: 92,
        padding: 12,
        borderRadius: 12,
        borderWidth: 2,
        borderColor:
          props.selected === `station:${station.id}`
            ? props.theme.colors.accent
            : props.theme.colors.border,
        backgroundColor: props.theme.colors.surface1,
      },
      title: { color: props.theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      muted: { color: props.theme.colors.foregroundMuted, fontSize: 12 },
      stove: {
        height: 13,
        marginBottom: 8,
        borderRadius: 4,
        backgroundColor: props.theme.colors.border,
      },
      agents: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
    }),
    [station, props.selected, props.theme],
  );
  return (
    <Pressable
      style={styles.island}
      onPress={select}
      accessibilityRole="button"
      accessibilityLabel={`Map station ${station.title}`}
    >
      <View style={styles.stove} />
      <Text style={styles.title}>{station.title}</Text>
      <Text style={styles.muted}>
        {workers.length ? `${workers.length} assigned` : "No agent assigned"}
      </Text>
      <View style={styles.agents}>
        {workers.map((desk) => (
          <NativeWorker
            key={desk.agentId}
            desk={desk}
            palette={props.palette}
            onSelect={onSelect}
          />
        ))}
      </View>
    </Pressable>
  );
}
function NativeWorker({
  desk,
  palette,
  onSelect,
}: {
  desk: OfficeDesk;
  palette: OfficePalette;
  onSelect(value: string): void;
}) {
  const select = useCallback(() => onSelect(`agent:${desk.agentId}`), [desk.agentId, onSelect]);
  const style = useMemo(
    () => ({
      minHeight: 48,
      minWidth: 48,
      padding: 6,
      borderRadius: 8,
      backgroundColor: palette.background,
      borderWidth: 1,
      borderColor: officeToneColor(desk.tone, palette),
    }),
    [desk, palette],
  );
  const text = useMemo(() => ({ color: palette.foreground, fontSize: 11 }), [palette]);
  return (
    <Pressable
      style={style}
      onPress={select}
      accessibilityRole="button"
      accessibilityLabel={`Map agent ${desk.title}`}
    >
      <Text style={text}>{desk.title}</Text>
    </Pressable>
  );
}
