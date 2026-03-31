import { Routes, Route, Navigate } from 'react-router-dom';
import { Box } from '@mui/material';
import Layout from './components/Layout';
import SettingsLayout from './components/SettingsLayout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Analyses from './pages/Analyses';
import Transfers from './pages/Transfers';
import DayZero from './pages/DayZero';
import Setup from './pages/Setup';
import Integration from './pages/Integration';
import BankFintsSettings from './pages/BankFintsSettings';
import BankAccountsSettings from './pages/BankAccountsSettings';
import CategoriesSettings from './pages/CategoriesSettings';
import { useAuthStore } from './store/authStore';
import EnrichmentsSettings from './pages/EnrichmentsSettings';
import UserSettings from './pages/UserSettings';

export default function App() {
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = Boolean(token);

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Routes>
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/register" element={isAuthenticated ? <Navigate to="/" replace /> : <Register />} />
        <Route
          path="/"
          element={isAuthenticated ? <Layout /> : <Navigate to="/login" replace />}
        >
          <Route index element={<Dashboard />} />
          <Route path="analysen" element={<Analyses />} />
          <Route path="dayzero" element={<DayZero />} />
          <Route path="umbuchungen" element={<Transfers />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<UserSettings />} />
            <Route path="setup" element={<Setup />} />
            <Route path="fints" element={<BankFintsSettings />} />
            <Route path="accounts" element={<BankAccountsSettings />} />
            <Route path="categories" element={<CategoriesSettings />} />
            <Route path="integration" element={<Integration />} />
            <Route path="enrichments" element={<EnrichmentsSettings />} />
          </Route>
          <Route path="setup" element={<Navigate to="/settings/setup" replace />} />
          <Route path="credentials" element={<Navigate to="/settings/fints" replace />} />
          <Route path="integration" element={<Navigate to="/settings/integration" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Box>
  );
}
