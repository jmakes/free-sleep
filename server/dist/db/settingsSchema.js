import { z } from 'zod';
import { TIME_ZONES } from './timeZones.js';
import { TimeSchema } from './schedulesSchema.js';
export const TEMPERATURES = ['celsius', 'fahrenheit'];
const Temperatures = z.enum(TEMPERATURES);
const TemperatureTapConfig = z.object({
    type: z.literal('temperature'),
    change: z.enum(['increment', 'decrement']),
    amount: z.number().min(0).max(10),
});
const PowerTapConfig = z.object({
    type: z.literal('power'),
    action: z.enum(['off', 'on', 'toggle']),
});
/** Copy current target temp into the active schedule slot for all days of the week */
const ScheduleApplyTapConfig = z.object({
    type: z.literal('scheduleApply'),
});
const AlarmTapConfig = z.object({
    type: z.literal('alarm'),
    behavior: z.enum(['snooze', 'dismiss']),
    snoozeDuration: z.number().min(60).max(600),
    inactiveAlarmBehavior: z.enum(['power', 'none'])
});
const NoneTapConfig = z.object({
    type: z.literal('none'),
});
export const TapConfig = z.discriminatedUnion('type', [
    TemperatureTapConfig,
    PowerTapConfig,
    ScheduleApplyTapConfig,
    AlarmTapConfig,
    NoneTapConfig,
]);
/** Multi-tap patterns reported by the Pod cover (Pod 4/5). singleTap is optional on hardware. */
export const GestureSchema = z.enum(['singleTap', 'doubleTap', 'tripleTap', 'quadTap']);
const SideSettingsSchema = z.object({
    name: z.string().min(1).max(20),
    awayMode: z.boolean(),
    scheduleOverrides: z.object({
        temperatureSchedules: z.object({
            disabled: z.boolean(),
            expiresAt: z.string(),
        }),
        alarm: z.object({
            disabled: z.boolean(),
            timeOverride: z.string(),
            expiresAt: z.string(),
        })
    }),
    taps: z.object({
        singleTap: TapConfig,
        doubleTap: TapConfig,
        tripleTap: TapConfig,
        quadTap: TapConfig,
    })
}).strict();
export const SettingsSchema = z.object({
    id: z.string(),
    timeZone: z.enum(TIME_ZONES),
    left: SideSettingsSchema,
    right: SideSettingsSchema,
    primePodDaily: z.object({
        enabled: z.boolean(),
        time: TimeSchema,
    }),
    temperatureFormat: Temperatures,
    rebootDaily: z.boolean(),
}).strict();
//# sourceMappingURL=settingsSchema.js.map