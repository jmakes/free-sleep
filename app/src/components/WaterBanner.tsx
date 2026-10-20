import Alert from '@mui/material/Alert';
import { useWaterStatus } from '@api/water.ts';
import { waterBanner } from '@lib/waterStatus.ts';

// Global low-water banner (all pages). Driven by GET /api/water, which reports
// the Pod firmware's binary low-water flag.
export default function WaterBanner() {
  const { data } = useWaterStatus();
  const banner = waterBanner(data);
  if (!banner) return null;
  return (
    <Alert severity={ banner.severity } sx={ { width: '100%', maxWidth: 700 } }>
      { banner.text }
    </Alert>
  );
}
