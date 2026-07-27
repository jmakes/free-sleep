import moment from 'moment-timezone';
const MAX_EVENTS = 30;
const events = [];
export function pushGestureEvent(event) {
    const full = {
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
export function getRecentGestureEvents(sinceId) {
    if (!sinceId)
        return [...events];
    const index = events.findIndex((event) => event.id === sinceId);
    if (index === -1)
        return [...events];
    return events.slice(0, index);
}
//# sourceMappingURL=gestureEvents.js.map