import moment from 'moment-timezone';
import { Side } from './schedulesSchema.js';
import { Gesture } from './settingsSchema.js';

export type GestureEvent = {
  id: string;
  timestamp: string;
  side: Side;
  gesture: Gesture;
  message: string;
  success: boolean;
  /** Exact target after the action — UI should apply this to avoid gauge jumps */
  targetTemperatureF?: number;
  isOn?: boolean;
};

const MAX_EVENTS = 30;
const events: GestureEvent[] = [];

export function pushGestureEvent(
  event: Omit<GestureEvent, 'id' | 'timestamp'> & { timestamp?: string }
) {
  const full: GestureEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp ?? moment().toISOString(),
    side: event.side,
    gesture: event.gesture,
    message: event.message,
    success: event.success,
    targetTemperatureF: event.targetTemperatureF,
    isOn: event.isOn,
  };
  events.unshift(full);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  return full;
}

export function getRecentGestureEvents(sinceId?: string): GestureEvent[] {
  if (!sinceId) return [...events];
  const index = events.findIndex((event) => event.id === sinceId);
  if (index === -1) return [...events];
  return events.slice(0, index);
}
