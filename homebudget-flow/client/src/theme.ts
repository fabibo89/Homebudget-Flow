import { createTheme } from '@mui/material/styles';

export function createAppTheme(mode: 'light' | 'dark') {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#3dd6c3' : '#0d7a6e' },
      secondary: { main: mode === 'dark' ? '#8ab4ff' : '#1565c0' },
      background: {
        default: mode === 'dark' ? '#0b0f14' : '#f4f7f9',
        paper: mode === 'dark' ? '#121821' : '#ffffff',
      },
    },
    typography: {
      fontFamily: '"DM Sans", "Roboto", "Helvetica", "Arial", sans-serif',
      h4: { fontWeight: 700 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
    },
    shape: { borderRadius: 12 },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            border: mode === 'dark' ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(0,0,0,0.06)',
          },
        },
      },
    },
  });
}
