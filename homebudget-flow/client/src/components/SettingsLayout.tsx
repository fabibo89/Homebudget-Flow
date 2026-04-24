import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Box, Tab, Tabs } from '@mui/material';

const TAB_PATHS = [
  'profile',
  'setup',
  'fints',
  'accounts',
  'categories',
  'integration',
  'enrichments',
  'earnings-docs',
] as const;

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const tabIndex = Math.max(
    0,
    TAB_PATHS.findIndex((p) => location.pathname.endsWith(p)),
  );

  return (
    <Box>
      <Tabs
        value={tabIndex}
        onChange={(_, v) => navigate(`/settings/${TAB_PATHS[v]}`)}
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label="Konto" id="settings-tab-profile" aria-controls="settings-panel-profile" />
        <Tab label="Einrichtung" id="settings-tab-setup" aria-controls="settings-panel-setup" />
        <Tab label="Bankzugang (FinTS)" id="settings-tab-fints" aria-controls="settings-panel-fints" />
        <Tab label="Bankkonten" id="settings-tab-accounts" aria-controls="settings-panel-accounts" />
        <Tab label="Kategorien" id="settings-tab-categories" aria-controls="settings-panel-categories" />
        <Tab label="Integration" id="settings-tab-integration" aria-controls="settings-panel-integration" />
        <Tab label="Import" id="settings-tab-enrichments" aria-controls="settings-panel-enrichments" />
        <Tab label="Verdienstnachweise" id="settings-tab-earnings-docs" aria-controls="settings-panel-earnings-docs" />
      </Tabs>
      <Outlet />
    </Box>
  );
}
