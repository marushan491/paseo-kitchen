import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Animated, PanResponder, Platform, View, type LayoutChangeEvent } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  clampGraphZoom,
  fitGraphZoom,
  graphZoomTranslation,
  graphPanOrigin,
  type GraphBounds,
} from "./role-graph-model.js";

interface GraphInput {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  key: string;
  target: unknown;
  preventDefault(): void;
}
interface GraphElement {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(
    name: string,
    listener: (event: GraphInput) => void,
    options?: { passive: boolean },
  ): void;
  removeEventListener(name: string, listener: (event: GraphInput) => void): void;
}
export interface GraphViewportHandle {
  toGraphPoint(point: { x: number; y: number }): { x: number; y: number };
}
export function GraphViewport(
  props: PluginSurfaceProps & {
    width: number;
    height: number;
    zoom: number;
    fitKey: number;
    viewKey: string;
    focus: GraphBounds;
    onZoom(value: number): void;
    onScale?(value: number): void;
    onFit?(): void;
    controllerRef?: Ref<GraphViewportHandle>;
    children: ReactNode;
  },
) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const viewport = useRef<View>(null);
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
    pinchX: 0,
    pinchY: 0,
    left: 0,
    top: 0,
  });
  const lastView = useRef("");
  const lastFit = useRef(props.fitKey);
  const canvasSize = useRef({ width: props.width, height: props.height });
  const { onZoom, onScale, onFit } = props;
  useImperativeHandle(
    props.controllerRef,
    () => ({
      toGraphPoint: (point) => {
        const value = gesture.current;
        let left = value.left;
        let top = value.top;
        if (Platform.OS === "web") {
          const rect = (
            viewport.current as unknown as GraphElement | null
          )?.getBoundingClientRect();
          if (rect) {
            left = rect.left;
            top = rect.top;
          }
        }
        return {
          x: (point.x - left - bounds.width / 2 - value.x) / (value.zoom / 100) + props.width / 2,
          y: (point.y - top - bounds.height / 2 - value.y) / (value.zoom / 100) + props.height / 2,
        };
      },
    }),
    [bounds, props.width, props.height],
  );
  useLayoutEffect(() => {
    const previous = canvasSize.current;
    if (lastView.current === props.viewKey) {
      const value = gesture.current;
      value.x += ((props.width - previous.width) * value.zoom) / 200;
      value.y += ((props.height - previous.height) * value.zoom) / 200;
      translation.setValue({ x: value.x, y: value.y });
    }
    canvasSize.current = { width: props.width, height: props.height };
  }, [props.width, props.height, props.viewKey, translation]);
  const zoomAt = useCallback(
    (zoom: number, x: number, y: number) => {
      const value = gesture.current;
      const next = clampGraphZoom(zoom);
      const point = graphZoomTranslation(value, { x, y }, bounds, value.zoom, next);
      value.x = point.x;
      value.y = point.y;
      value.zoom = next;
      translation.setValue(point);
      scale.setValue(next / 100);
      onZoom(next);
    },
    [bounds, onZoom, scale, translation],
  );
  const frame = useCallback(
    (all: boolean) => {
      const area = all ? { x: 0, y: 0, width: props.width, height: props.height } : props.focus;
      const fit = fitGraphZoom(area.width, area.height, bounds.width, bounds.height);
      const zoom = all ? fit : Math.max(75, fit);
      const point = {
        x: ((props.width / 2 - area.x - area.width / 2) * zoom) / 100,
        y: ((props.height / 2 - area.y - area.height / 2) * zoom) / 100,
      };
      if (!all && zoom > fit) {
        point.x = ((props.width / 2 - area.x) * zoom) / 100 - bounds.width / 2 + 24;
        point.y = ((props.height / 2 - area.y) * zoom) / 100 - bounds.height / 2 + 24;
      }
      Object.assign(gesture.current, point, { zoom });
      translation.setValue(point);
      scale.setValue(zoom / 100);
      onZoom(zoom);
    },
    [props.width, props.height, props.focus, bounds, translation, scale, onZoom],
  );
  useEffect(() => {
    if (!bounds.width || !bounds.height) return;
    const key = props.viewKey;
    const requested = lastFit.current !== props.fitKey;
    if (!requested && lastView.current === key) return;
    lastView.current = key;
    lastFit.current = props.fitKey;
    frame(requested);
  }, [props.viewKey, props.fitKey, bounds, frame]);
  const layout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBounds({ width, height });
    viewport.current?.measureInWindow((left, top) => Object.assign(gesture.current, { left, top }));
  }, []);
  useEffect(() => {
    const value = gesture.current;
    if (value.zoom !== props.zoom) {
      const point = graphZoomTranslation(
        value,
        { x: bounds.width / 2, y: bounds.height / 2 },
        bounds,
        value.zoom,
        props.zoom,
      );
      Object.assign(value, point);
      translation.setValue(point);
    }
    onScale?.(props.zoom / 100);
    scale.setValue(props.zoom / 100);
    value.zoom = props.zoom;
  }, [bounds, scale, translation, props.zoom, onScale]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const element = viewport.current as unknown as GraphElement | null;
    if (!element?.addEventListener) return;
    const wheel = (event: GraphInput) => {
      event.preventDefault();
      let unit = 1;
      if (event.deltaMode === 1) unit = 16;
      if (event.deltaMode === 2) unit = bounds.height;
      if (!event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
        gesture.current.x -= (event.deltaX || event.deltaY) * unit;
        gesture.current.y -= event.shiftKey ? 0 : event.deltaY * unit;
        translation.setValue({ x: gesture.current.x, y: gesture.current.y });
        return;
      }
      const rect = element.getBoundingClientRect();
      zoomAt(
        gesture.current.zoom * Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.006 : 0.002)),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    const keydown = (event: GraphInput) => {
      if (event.target !== element) return;
      if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        const zoom =
          event.key === "0" ? 100 : gesture.current.zoom + (event.key === "-" ? -10 : 10);
        zoomAt(zoom, bounds.width / 2, bounds.height / 2);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (onFit) onFit();
        else frame(true);
      } else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 100 : 40;
        if (event.key === "ArrowLeft") gesture.current.x += step;
        if (event.key === "ArrowRight") gesture.current.x -= step;
        if (event.key === "ArrowUp") gesture.current.y += step;
        if (event.key === "ArrowDown") gesture.current.y -= step;
        translation.setValue({ x: gesture.current.x, y: gesture.current.y });
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", keydown);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", keydown);
    };
  }, [bounds, frame, onFit, translation, zoomAt]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, state) =>
          state.numberActiveTouches > 1 || Math.abs(state.dx) + Math.abs(state.dy) > 6,
        onPanResponderGrant: (event) => {
          viewport.current?.measureInWindow((left, top) =>
            Object.assign(gesture.current, { left, top }),
          );
          const touches = event.nativeEvent.touches;
          const value = gesture.current;
          value.originX = value.x;
          value.originY = value.y;
          value.startZoom = value.zoom;
          value.distance =
            touches.length > 1
              ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY)
              : 0;
          if (touches.length > 1) {
            value.pinchX = (touches[0].pageX + touches[1].pageX) / 2 - value.left;
            value.pinchY = (touches[0].pageY + touches[1].pageY) / 2 - value.top;
          }
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          const value = gesture.current;
          if (touches.length > 1) {
            const distance = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            if (!value.distance) {
              value.distance = distance;
              value.startZoom = value.zoom;
              value.originX = value.x;
              value.originY = value.y;
              value.pinchX = (touches[0].pageX + touches[1].pageX) / 2 - value.left;
              value.pinchY = (touches[0].pageY + touches[1].pageY) / 2 - value.top;
            }
            value.zoom = clampGraphZoom((value.startZoom * distance) / Math.max(1, value.distance));
            const point = graphZoomTranslation(
              { x: value.originX, y: value.originY },
              { x: value.pinchX, y: value.pinchY },
              bounds,
              value.startZoom,
              value.zoom,
            );
            value.x =
              point.x + (touches[0].pageX + touches[1].pageX) / 2 - value.left - value.pinchX;
            value.y =
              point.y + (touches[0].pageY + touches[1].pageY) / 2 - value.top - value.pinchY;
            scale.setValue(value.zoom / 100);
          } else {
            if (value.distance) {
              const origin = graphPanOrigin(value, { x: state.dx, y: state.dy });
              value.originX = origin.x;
              value.originY = origin.y;
              value.distance = 0;
            }
            value.x = value.originX + state.dx;
            value.y = value.originY + state.dy;
          }
          translation.setValue({ x: value.x, y: value.y });
        },
        onPanResponderRelease: () => onZoom(gesture.current.zoom),
        onPanResponderTerminationRequest: () => true,
      }),
    [bounds, onZoom, scale, translation],
  );
  const styles = useMemo(
    () => ({
      viewport: {
        height: props.layout.compact ? 360 : 480,
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
    <View
      ref={viewport}
      role="group"
      accessibilityLabel="Workflow graph canvas"
      accessibilityHint="Scroll to zoom, drag to pan. Use plus, minus, zero, F or arrow keys."
      focusable={Platform.OS === "web"}
      tabIndex={Platform.OS === "web" ? 0 : undefined}
      style={styles.viewport}
      onLayout={layout}
      {...responder.panHandlers}
    >
      <Animated.View style={styles.canvas}>{props.children}</Animated.View>
    </View>
  );
}
