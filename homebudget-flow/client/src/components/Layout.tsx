import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar,
  Avatar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material';
import {
  AccountBalance as AccountBalanceIcon,
  BarChart as BarChartIcon,
  AccountBalanceWallet as AccountBalanceWalletIcon,
  DarkMode as DarkModeIcon,
  Hub as HubIcon,
  LocalOffer as LocalOfferIcon,
  LightMode as LightModeIcon,
  Logout as LogoutIcon,
  Menu as MenuIcon,
  Person as PersonIcon,
  Settings as SettingsIcon,
  VpnKey as VpnKeyIcon,
} from '@mui/icons-material';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCurrentUser } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useThemeModeStore } from '../store/themeModeStore';

const drawerWidth = 260;

function resolveTitle(pathname: string): string {
  if (pathname === '/') return 'Übersicht';
  if (pathname.startsWith('/analysen')) return 'Analysen';
  if (pathname.startsWith('/settings')) return 'Einstellungen';
  return 'HomeBudget Flow';
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAuthStore();
  const { mode, toggle } = useThemeModeStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuAnchor, setUserMenuAnchor] = useState<null | HTMLElement>(null);
  const userMenuOpen = Boolean(userMenuAnchor);

  const token = useAuthStore((s) => s.token);
  useQuery({
    queryKey: ['me'],
    queryFn: fetchCurrentUser,
    enabled: Boolean(token),
    staleTime: 5 * 60_000,
  });
  const emailInitial = (() => {
    if (!token) return 'U';
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      return sub ? sub.charAt(0).toUpperCase() : 'U';
    } catch {
      return 'U';
    }
  })();

  const appBarTitle = resolveTitle(location.pathname);

  const go = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  const openUserMenu = (e: React.MouseEvent<HTMLElement>) => setUserMenuAnchor(e.currentTarget);
  const closeUserMenu = () => setUserMenuAnchor(null);

  const goSettings = (
    sub: 'profile' | 'setup' | 'fints' | 'accounts' | 'categories' | 'integration' | 'enrichments',
  ) => {
    navigate(`/settings/${sub}`);
    closeUserMenu();
  };

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar sx={{ px: 2 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 2,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            mr: 1.5,
            fontSize: '1rem',
          }}
        >
          HB
        </Box>
        <Box>
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            HomeBudget Flow
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            Finanzen im Blick
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <List sx={{ flex: 1, pt: 1 }}>
        <ListItem disablePadding>
          <ListItemButton selected={location.pathname === '/'} onClick={() => go('/')}>
            <ListItemIcon>
              <AccountBalanceIcon />
            </ListItemIcon>
            <ListItemText primary="Übersicht" secondary="Konten, Buchungen & Saldo" />
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton selected={location.pathname.startsWith('/analysen')} onClick={() => go('/analysen')}>
            <ListItemIcon>
              <BarChartIcon />
            </ListItemIcon>
            <ListItemText primary="Analysen" secondary="Diagramme & Auswertungen" />
          </ListItemButton>
        </ListItem>
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', minWidth: 0, overflowX: 'hidden' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          color: 'text.primary',
          width: { xs: '100%', sm: `calc(100% - ${drawerWidth}px)` },
          ml: { xs: 0, sm: `${drawerWidth}px` },
        }}
      >
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={() => setMobileOpen(true)}
            sx={{ mr: 2, display: { sm: 'none' } }}
            aria-label="Menü öffnen"
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontWeight: 700 }}>
            {appBarTitle}
          </Typography>
          <IconButton color="inherit" onClick={toggle} aria-label="Hell/Dunkel">
            {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
          <IconButton
            onClick={openUserMenu}
            size="small"
            aria-controls={userMenuOpen ? 'user-menu' : undefined}
            aria-haspopup="true"
            aria-expanded={userMenuOpen ? 'true' : undefined}
            aria-label="Benutzermenü"
            sx={{ ml: 1 }}
          >
            <Avatar sx={{ width: 36, height: 36, bgcolor: 'secondary.main', fontSize: '0.95rem' }}>
              {emailInitial}
            </Avatar>
          </IconButton>
          <Menu
            id="user-menu"
            anchorEl={userMenuAnchor}
            open={userMenuOpen}
            onClose={closeUserMenu}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ list: { 'aria-labelledby': 'user-menu-button' } }}
          >
            <MenuItem onClick={() => goSettings('profile')}>
              <ListItemIcon>
                <PersonIcon fontSize="small" />
              </ListItemIcon>
              Konto
            </MenuItem>
            <MenuItem onClick={() => goSettings('setup')}>
              <ListItemIcon>
                <SettingsIcon fontSize="small" />
              </ListItemIcon>
              Einrichtung
            </MenuItem>
            <MenuItem onClick={() => goSettings('fints')}>
              <ListItemIcon>
                <VpnKeyIcon fontSize="small" />
              </ListItemIcon>
              Bankzugang (FinTS)
            </MenuItem>
            <MenuItem onClick={() => goSettings('accounts')}>
              <ListItemIcon>
                <AccountBalanceWalletIcon fontSize="small" />
              </ListItemIcon>
              Bankkonten
            </MenuItem>
            <MenuItem onClick={() => goSettings('categories')}>
              <ListItemIcon>
                <LocalOfferIcon fontSize="small" />
              </ListItemIcon>
              Kategorien
            </MenuItem>
            <MenuItem onClick={() => goSettings('integration')}>
              <ListItemIcon>
                <HubIcon fontSize="small" />
              </ListItemIcon>
              Integration
            </MenuItem>
            <MenuItem onClick={() => goSettings('enrichments')}>
              <ListItemIcon>
                <DarkModeIcon fontSize="small" />
              </ListItemIcon>
              Import
            </MenuItem>
            <Divider />
            <MenuItem onClick={closeUserMenu} sx={{ pointerEvents: 'none', opacity: 0.85 }}>
              <ListItemIcon>
                <PersonIcon fontSize="small" />
              </ListItemIcon>
              <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 220 }}>
                {(() => {
                  try {
                    const payload = JSON.parse(atob(token?.split('.')[1] ?? ''));
                    return typeof payload.sub === 'string' ? payload.sub : '';
                  } catch {
                    return '';
                  }
                })()}
              </Typography>
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                closeUserMenu();
                logout();
              }}
            >
              <ListItemIcon>
                <LogoutIcon fontSize="small" />
              </ListItemIcon>
              Abmelden
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { sm: drawerWidth }, flexShrink: { sm: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', sm: 'none' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: drawerWidth },
          }}
        >
          {drawer}
        </Drawer>
        <Drawer
          variant="permanent"
          sx={{
            display: { xs: 'none', sm: 'block' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: drawerWidth },
          }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          p: { xs: 2, sm: 3 },
          width: { xs: '100%', sm: `calc(100% - ${drawerWidth}px)` },
          mt: 8,
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
