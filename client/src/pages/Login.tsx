// client/src/pages/Login.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { authApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await authApi.login(email, password);
      setSession(data);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-base px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <Gauge size={26} className="text-accent" />
          </div>
          <div>
            <div className="font-bold text-lg text-primary leading-tight">EKC SmartFactory</div>
            <div className="text-xs text-steel">Everest Kanto Cylinder</div>
          </div>
        </div>

        <div className="panel p-7 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-primary">Sign in</h2>
            <p className="text-sm text-steel mt-0.5">Enter your credentials to access the platform</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label block mb-1.5">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@ekc.in"
                required
                className="w-full bg-raised border border-line rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:ring-1 focus:ring-accent/20 outline-none transition-all text-primary placeholder:text-steel/60"
              />
            </div>
            <div>
              <label className="label block mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-raised border border-line rounded-lg px-3 py-2.5 text-sm focus:border-accent focus:ring-1 focus:ring-accent/20 outline-none transition-all text-primary placeholder:text-steel/60"
              />
            </div>

            {error && (
              <div className="text-sm text-stopped bg-stopped/8 border border-stopped/15 rounded-lg px-3 py-2.5">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-accent text-white font-semibold rounded-lg py-2.5 text-sm hover:bg-accent/90 disabled:opacity-60 transition-colors shadow-sm"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-steel mt-5">
          ITSYBIZZ AI Private Limited · Powered by EKC SmartFactory
        </p>
      </div>
    </div>
  );
}
