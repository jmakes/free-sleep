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
 * Dual-handle arc: handle1 = live current temp (display only),
 * handle2 = target temp (interactive).
 *
 * IMPORTANT: never write currentTemperatureF into targetTemperatureF.
 * The library can fire onChange when values re-render after a gesture/
 * refetch; if both handles mutate target, the gauge jumps to "currently at".
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

  const handleControlFinished = async () => {
    if (!deviceStatus) return;

    setIsUpdating(true);
    void postDeviceStatus({
      [side]: {
        targetTemperatureF: deviceStatus[side].targetTemperatureF
      }
    })
      .then(() => {
        // Wait 1 second before refreshing the device status
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
    setDeviceStatus({ [side]: { targetTemperatureF: next } });
  };

  return (
    <div
      ref={ ref }
      style={ { position: 'relative', display: 'inline-block', width: '100%', maxWidth: '400px' } }
    >
      { /* Circular Slider */ }
      <div className={ `${styles.Slider} ${disabled && styles.Disabled} ${isHeating && styles.Heating}` }>
        <CircularSliderWithChildren
          disabled={ disabled }
          onControlFinished={ handleControlFinished }
          size={ width }
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
            // Live current temperature — display only, never writes target
            value: liveTemp,
            onChange: () => {},
          } }
          arcColor={ isOn ? sliderColor : arcBackgroundColor }
          arcBackgroundColor={ arcBackgroundColor }
          handle2={ {
            // Target temperature — the only interactive handle
            value: targetTemp,
            onChange: setTargetTemp,
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
