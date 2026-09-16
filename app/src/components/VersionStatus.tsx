import { Alert, AlertTitle, Chip, Typography } from '@mui/material';
import { useServerInfo } from '@api/serverInfo.ts';
import currentServerInfo from '../../../server/src/serverInfo.json';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import UpdateFreeSleepButton from '../pages/SettingsPage/DeviceSettingsSection/UpdateFreeSleepButton.tsx';


export default function VersionStatus() {
  const { data: serverInfo, isLoading, isError } = useServerInfo();
  if (isLoading) return null;

  if (isError) {
    return (
      <Alert severity="warning" sx={ { width: '100%' } }>
        <AlertTitle>Could not check for updates</AlertTitle>
        <Typography variant="body2">
          Failed to reach GitHub for { currentServerInfo.updateCheckUrl || 'serverInfo.json' }.
          Current build: { currentServerInfo.version }
          { currentServerInfo.commit ? ` (${currentServerInfo.commit.slice(0, 7)})` : '' }.
        </Typography>
      </Alert>
    );
  }

  return (
    <>
      {
        serverInfo?.updateAvailable && (
          <>
            <Alert severity="info">
              <AlertTitle>
                Free-sleep update available!
              </AlertTitle>
              <Typography variant="body2">
                Latest: { serverInfo.version }
                { serverInfo.commit ? ` (${serverInfo.commit.slice(0, 7)})` : '' }
              </Typography>
              <Typography variant="body2" sx={ { mb: 1 } }>
                Current: { currentServerInfo.version }
                { currentServerInfo.commit ? ` (${currentServerInfo.commit.slice(0, 7)})` : '' }
              </Typography>
              <UpdateFreeSleepButton/>
            </Alert>
          </>
        )
      }
      {
        !serverInfo?.updateAvailable && (
          <Chip
            icon={ <CheckCircleIcon/> }
            label="Up to date"
            color="success"
            variant="filled"
            size="small"
            sx={ {
              minWidth: '112px',
              width: 'fit-content',
              '.MuiChip-label': {
                overflow: 'visible',
              },
            } }
          />
        )
      }
    </>
  );
}
