import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, View, type LayoutChangeEvent } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { clampGraphZoom, fitGraphZoom } from "./role-graph-model.js";
export function GraphViewport(
  props: PluginSurfaceProps & {
    width: number;
    height: number;
    zoom: number;
    fitKey: number;
    onZoom(value: number): void;
    onScale?(value: number): void;
    children: ReactNode;
  },
) {
  const [bounds, setBounds] = useState({ width: 640, height: 420 });
  const translation = useRef(new Animated.ValueXY()).current;
  const scale = useRef(new Animated.Value(1)).current;
  const gesture = useRef({
    x: 0,
    y: 0,
    zoom: 100,
    originX: 0,
    originY: 0,
    startZoom: 100,
    distance: 0,
  });
  const lastFit = useRef("");
  const fit = fitGraphZoom(props.width, props.height, bounds.width, bounds.height);
  const { onZoom } = props;
  useEffect(() => {
    const key = `${bounds.width}:${bounds.height}:${props.fitKey}`;
    if (lastFit.current === key) return;
    lastFit.current = key;
    onZoom(fit);
  }, [bounds.width, bounds.height, props.fitKey, fit, onZoom]);
  const layout = useCallback((event: LayoutChangeEvent) => setBounds(event.nativeEvent.layout), []);
  const { onScale } = props;
  useEffect(() => {
    onScale?.(props.zoom / 100);
    scale.setValue(props.zoom / 100);
    gesture.current.zoom = props.zoom;
  }, [scale, props.zoom, onScale]);
  useEffect(() => {
    translation.setValue({ x: 0, y: 0 });
    gesture.current.x = 0;
    gesture.current.y = 0;
  }, [translation, props.fitKey]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, state) =>
          state.numberActiveTouches > 1 || Math.abs(state.dx) + Math.abs(state.dy) > 6,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          const value = gesture.current;
          value.originX = value.x;
          value.originY = value.y;
          value.startZoom = value.zoom;
          value.distance =
            touches.length > 1
              ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY)
              : 0;
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          const value = gesture.current;
          if (touches.length > 1) {
            const distance = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            if (!value.distance) value.distance = distance;
            value.zoom = clampGraphZoom((value.startZoom * distance) / Math.max(1, value.distance));
            scale.setValue(value.zoom / 100);
          } else {
            value.x = value.originX + state.dx;
            value.y = value.originY + state.dy;
            translation.setValue({ x: value.x, y: value.y });
          }
        },
        onPanResponderRelease: () => onZoom(gesture.current.zoom),
        onPanResponderTerminationRequest: () => true,
      }),
    [onZoom, scale, translation],
  );
  const styles = useMemo(
    () => ({
      viewport: {
        height: props.layout.compact ? 340 : 420,
        overflow: "hidden" as const,
        borderWidth: 1,
        borderColor: props.theme.colors.border,
        borderRadius: 14,
        backgroundColor: props.theme.colors.surface0,
      },
      canvas: {
        position: "absolute" as const,
        width: props.width,
        height: props.height,
        left: (bounds.width - props.width) / 2,
        top: (bounds.height - props.height) / 2,
        transform: [{ translateX: translation.x }, { translateY: translation.y }, { scale }],
      },
    }),
    [props.layout.compact, props.theme, props.width, props.height, bounds, translation, scale],
  );
  return (
    <View style={styles.viewport} onLayout={layout} {...responder.panHandlers}>
      <Animated.View style={styles.canvas}>{props.children}</Animated.View>
    </View>
  );
}
