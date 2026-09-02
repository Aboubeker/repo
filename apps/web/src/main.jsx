import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider } from './lib.jsx';
import './styles.css';

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Erreur interface :', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, maxWidth: 640, margin: '0 auto' }}>
          <div className="alert error">
            <span>⚠</span>
            <div>
              <strong>Une erreur est survenue dans l'interface.</strong>
              <p style={{ marginTop: 6, fontSize: 12 }}>{String(this.state.error)}</p>
            </div>
          </div>
          <button className="btn primary" onClick={() => location.reload()}>
            Recharger l'application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Boundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </Boundary>
  </React.StrictMode>
);
