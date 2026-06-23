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

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10000 } },
});

const P = (module: string, el: ReactElement): ReactElement => (
  <RequirePermission module={module}>{el}</RequirePermission>
);

export default function App() {
  return (
    <QueryClientProvider client={qc}>
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
            <Route path="/roles"                  element={P('roles', <Roles />)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
