import { CircularSliderWithChildren } from 'react-circular-slider-svg';
import { postDeviceStatus } from '@api/deviceStatus.ts';
import { useAppStore } from '@state/appStore';
import styles from './Slider.module.scss';
import TemperatureLabel from './TemperatureLabel.tsx';
import TemperatureButtons from './TemperatureButtons.tsx';
import { useControlTempStore } from './controlTempStore.tsx';
import { useTheme } from '@mui/material/styles';
import { useResizeDetector } from 'react-resize-detector';
import { useSettings } from '@api/settings.ts';
import { MAX_TEMP_F, MIN_TEMP_F, getTemperatureColor } from '@lib/temperatureConversions.ts';

type SliderProps = {
  isOn: boolean;
  currentTargetTemp: number;
  currentTemperatureF: number;
  refetch: any;
  displayCelsius: boolean;
}

/**
 * Dual-handle arc between live temp and target (original free-sleep look).
 *
 * handle1 = min(live, target), handle2 = max(live, target).
 * Only the handle that represents the *target* may write targetTemperatureF —
 * the live-temp handle is display-only. Writing both caused random jumps.
 *
 * Remount when isOn flips so react-circular-slider-svg rebuilds geometry after
 * the disabled → enabled transition (otherwise the first power-on arc is mangled
 * until the next value change).
 */
export default function Slider({ isOn, currentTargetTemp, refetch, currentTemperatureF, displayCelsius }: SliderProps) {
  const { deviceStatus, setDeviceStatus } = useControlTempStore();
  const { isUpdating, setIsUpdating, side } = useAppStore();
  const { data: settings } = useSettings();
  const isInAwayMode = settings?.[side].awayMode;
  const disabled = isUpdating || isInAwayMode || !isOn;
  const { width, ref } = useResizeDetector();
  const theme = useTheme();
  const sideStatus = deviceStatus?.[side];
  const targetTemp = sideStatus?.targetTemperatureF ?? currentTargetTemp;
  const liveTemp = sideStatus?.currentTemperatureF ?? currentTemperatureF;
  const sliderColor = getTemperatureColor(targetTemp);
  const isHeating = liveTemp < targetTemp;
  const minTemp = Math.min(liveTemp, targetTemp);
  const maxTemp = Math.max(liveTemp, targetTemp);
  // Library needs a concrete pixel size; width can be undefined on first paint
  const sliderSize = width && width > 0 ? width : 320;

  const handleControlFinished = async () => {
    if (!deviceStatus) return;

    setIsUpdating(true);
    void postDeviceStatus({
      [side]: {
        targetTemperatureF: deviceStatus[side].targetTemperatureF
      }
    })
      .then(() => {
        return new Promise((resolve) => setTimeout(resolve, 1_500));
      })
      .then(() => refetch())
      .catch(error => {
        console.error(error);
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  const arcBackgroundColor = theme.palette.grey[700];

  const setTargetTemp = (value: number) => {
    if (disabled) return;
    const next = Math.round(value);
    if (next === targetTemp) return;
    if (next < MIN_TEMP_F || next > MAX_TEMP_F) return;
    setDeviceStatus({ [side]: { targetTemperatureF: next } });
  };

  return (
    <div
      ref={ ref }
      style={ { position: 'relative', display: 'inline-block', width: '100%', maxWidth: '400px' } }
    >
      { /* Circular Slider — key remounts cleanly on power transitions */ }
      <div className={ `${styles.Slider} ${disabled && styles.Disabled} ${isHeating && styles.Heating}` }>
        <CircularSliderWithChildren
          key={ `gauge-${side}-${isOn ? 'on' : 'off'}` }
          disabled={ disabled }
          onControlFinished={ handleControlFinished }
          size={ sliderSize }
          trackWidth={ 6 }
          minValue={ MIN_TEMP_F }
          maxValue={ MAX_TEMP_F }
          startAngle={ 60 }
          endAngle={ 300 }
          angleType={ {
            direction: 'cw',
            axis: '-y'
          } }
          handle1={ {
            value: minTemp,
            onChange: (value) => {
              // When cooling, target is the lower handle
              if (!isHeating) setTargetTemp(value);
            },
          } }
          arcColor={ isOn ? sliderColor : arcBackgroundColor }
          arcBackgroundColor={ arcBackgroundColor }
          handle2={ {
            value: maxTemp,
            onChange: (value) => {
              // When heating, target is the upper handle
              if (isHeating) setTargetTemp(value);
            },
          } }
          handleSize={ 8 }
        >
          <TemperatureLabel
            isOn={ isOn }
            sliderTemp={ targetTemp }
            sliderColor={ sliderColor }
            currentTargetTemp={ currentTargetTemp }
            currentTemperatureF={ currentTemperatureF }
            displayCelsius={ displayCelsius }
          />
        </CircularSliderWithChildren>
      </div>
      {
        isOn && (
          <TemperatureButtons refetch={ refetch } currentTargetTemp={ currentTargetTemp }/>
        ) }
    </div>
  );
};
