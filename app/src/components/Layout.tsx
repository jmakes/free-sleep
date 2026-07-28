import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';
import Box from '@mui/material/Box';
import GestureToast from './GestureToast';
import AnalyzeSleepBanner from './AnalyzeSleepBanner';


export default function Layout() {
  return (
    <Box
      id="Layout"
      sx={ {
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        alignItems: 'center',
        gap: 2,
        // padding: 0,
        margin: 0,
        justifyContent: 'center',
      } }
    >
      <AnalyzeSleepBanner />
      { /* Renders current route */ }
      <Outlet/>
      <Navbar/>
      <GestureToast />
    </Box>
  );
}
