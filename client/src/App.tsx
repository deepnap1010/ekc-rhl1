// client/src/App.tsx
import type { ReactElement } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppLayout from './layouts/AppLayout';
import { RequireAuth, RequirePermission } from './components/Guard';
import Toaster from './components/Toaster';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Machines from './pages/Machines';
import MachineDetail from './pages/MachineDetail';
import Roles from './pages/Roles';
import Employees from './pages/Employees';
import Downtime from './pages/Downtime';
import History from './pages/History';
import Reports from './pages/Reports';
import Alerts from './pages/Alerts';
import OrgChart from './pages/OrgChart';
import OrgPersonDetail from './pages/OrgPersonDetail';
import Departments from './pages/Departments';
import Settings from './pages/Settings';
import ProductionSetup from './pages/ProductionSetup';
import DiaTrace from './pages/DiaTrace';
import { useMachineLabelsSync } from './lib/machineName';
import ErrorBoundary from './components/ErrorBoundary';

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10000 } },
});

const P = (module: string, el: ReactElement): ReactElement => (
  <RequirePermission module={module}>{el}</RequirePermission>
);

// Hooks that need the QueryClient live INSIDE the provider, never in App
// itself — App is what renders it, so a useQuery up there throws "No
// QueryClient set" and takes the whole app down with it.
function AppData(): null {
  // Custom machine names, fetched once for the whole app (lib/machineName).
  useMachineLabelsSync();
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={qc}>
      <AppData />
      <Toaster />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
            <Route path="/"                       element={P('dashboard', <Dashboard />)} />
            <Route path="/machines"               element={P('machines', <Machines />)} />
            <Route path="/machines/:code"         element={P('machines', <MachineDetail />)} />
            <Route path="/downtime"               element={P('downtime', <Downtime />)} />
            <Route path="/history"                element={P('history', <History />)} />
            <Route path="/reports"                element={P('reports', <Reports />)} />
            <Route path="/alerts"                 element={P('alerts', <Alerts />)} />
            <Route path="/employees"              element={P('employees', <Employees />)} />
            <Route path="/orgchart"               element={P('orgchart', <OrgChart />)} />
            <Route path="/orgchart/:id"           element={P('orgchart', <OrgPersonDetail />)} />
            <Route path="/departments"            element={P('orgchart', <Departments />)} />
            <Route path="/production"             element={P('production', <ProductionSetup />)} />
            <Route path="/production/trace"       element={P('production', <DiaTrace />)} />
            <Route path="/roles"                  element={P('roles', <Roles />)} />
            <Route path="/settings"               element={P('settings', <Settings />)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
