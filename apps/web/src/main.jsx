import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider, bootTheme } from './lib.jsx';
import './styles.css';

/*
 * Thème appliqué avant le premier rendu.
 *
 * L'appel est lancé sans être attendu : le style compilé s'affiche
 * immédiatement et les couleurs de la clinique se substituent dès la réponse.
 * Attendre le réseau pour peindre l'écran ferait clignoter une page blanche
 * à chaque chargement, y compris quand le serveur ne répond pas.
 */
bootTheme();

/*
 * Barrière d'erreur.
 *
 * La version précédente n'affichait que `String(error)`, soit
 * « TypeError: r is not a function » sur un bundle minifié : un message
 * strictement inexploitable, ni pour l'utilisateur ni pour le diagnostic.
 * Elle jetait la pile d'appel et la hiérarchie de composants, pourtant les
 * deux seules informations utiles.
 *
 * Elle conserve désormais l'arborescence React (`componentStack`), qui reste
 * lisible même minifiée, et propose de copier le rapport complet — ce que
 * l'utilisateur peut transmettre sans savoir ouvrir la console.
 */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null, info: null, copied: false }; }
  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('Erreur interface :', error, info?.componentStack);
  }

  /** Rapport textuel : le contenu de la console, à portée d'un clic. */
  report() {
    const { error, info } = this.state;
    return [
      `CliniRDV — rapport d'erreur`,
      `Date    : ${new Date().toISOString()}`,
      `Page    : ${location.hash || '(accueil)'}`,
      `Message : ${error?.message || String(error)}`,
      ``,
      `Pile d'appel :`,
      error?.stack || '(indisponible)',
      ``,
      `Composants :`,
      info?.componentStack || '(indisponible)',
    ].join('\n');
  }

  render() {
    if (!this.state.error) return this.props.children;

    // Dernier composant nommé de la pile : indique l'écran fautif même
    // lorsque le nom de la variable a été minifié.
    const stack = this.state.info?.componentStack || '';
    const culprit = (stack.match(/^\s*(?:at|in)\s+([A-Z]\w+)/m) || [])[1];

    return (
      <div style={{ padding: 40, maxWidth: 760, margin: '0 auto' }}>
        <div className="alert error">
          <span>⚠</span>
          <div>
            <strong>Une erreur est survenue dans l'interface.</strong>
            <p style={{ marginTop: 6, fontSize: 13 }}>
              {this.state.error?.message || String(this.state.error)}
            </p>
            {culprit && (
              <p style={{ marginTop: 4, fontSize: 12 }}>
                Écran concerné : <strong>{culprit}</strong>
              </p>
            )}
            <p style={{ marginTop: 8, fontSize: 12 }}>
              Vos données ne sont pas affectées : rien n'a été perdu.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => location.reload()}>
            Recharger l'application
          </button>
          <button className="btn" onClick={() => {
            navigator.clipboard?.writeText(this.report())
              .then(() => this.setState({ copied: true }));
          }}>
            {this.state.copied ? 'Rapport copié ✓' : 'Copier le rapport d\'erreur'}
          </button>
        </div>

        <details style={{ marginTop: 18 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#6b7b77' }}>
            Détail technique
          </summary>
          <pre style={{ marginTop: 10, padding: 12, background: '#f7f8f8',
                        border: '1px solid #e3e6e5', borderRadius: 8,
                        fontSize: 11.5, overflow: 'auto', maxHeight: 340,
                        whiteSpace: 'pre-wrap' }}>
            {this.report()}
          </pre>
        </details>
      </div>
    );
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
