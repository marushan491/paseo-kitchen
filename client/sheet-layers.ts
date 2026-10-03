import { useEffect, useId, useSyncExternalStore } from "react";

const sheets: string[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const current = () => sheets.at(-1);

export function useTopSheet() {
  const id = useId();
  const top = useSyncExternalStore(subscribe, current, current);
  useEffect(() => {
    sheets.push(id);
    notify();
    return () => {
      const index = sheets.indexOf(id);
      if (index >= 0) sheets.splice(index, 1);
      notify();
    };
  }, [id]);
  return !top || top === id;
}
