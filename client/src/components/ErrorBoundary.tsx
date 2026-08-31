// client/src/components/ErrorBoundary.tsx
// A crash anywhere in the tree currently paints a white page: no message, no
// clue, and on a shop floor nobody is going to open DevTools. This turns that
// into something a supervisor can act on and read down the phone.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24,
        background: '#F4F6F9', color: '#0F172A', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div style={{ maxWidth: 560, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, padding: 28 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>This screen stopped loading</h1>
          <p style={{ fontSize: 14, color: '#475569', margin: '0 0 16px', lineHeight: 1.6 }}>
            The machines keep recording — this is the display, not the plant. Reload
            to carry on; if it happens again, send this line to whoever maintains the app.
          </p>
          <pre style={{ fontSize: 12, background: '#0F172A', color: '#E2E8F0', padding: '12px 14px',
            borderRadius: 6, overflowX: 'auto', margin: '0 0 16px' }}>{error.message}</pre>
          <button onClick={() => window.location.reload()}
            style={{ background: '#0D9488', color: '#fff', border: 0, borderRadius: 8,
              padding: '9px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
