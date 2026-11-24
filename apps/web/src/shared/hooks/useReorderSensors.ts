import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

export function useReorderSensors({ keyboard = true, startKeys = ["Space", "Enter"] } = {}) {
  const keys = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
    keyboardCodes: { start: startKeys, end: ["Space", "Enter", "Tab"], cancel: ["Escape"] },
  });
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    keyboard ? keys : undefined
  );
}
