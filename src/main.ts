import { App } from './app';
import './style.css';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  // Testovací build pro e2e testy nahradí poskytovatele panoramat náhradou bez sítě.
  if (import.meta.env.VITE_E2E === '1') {
    const { FakeProvider } = await import('./providers/fake');
    const { decodeState } = await import('./core/storage');
    (window as unknown as { ggState?: () => unknown }).ggState = () =>
      decodeState(localStorage.getItem('gg.game.v3') ?? '');
    // Testovací náměstí bez sítě: Staroměstské náměstí, resp. Trafalgar Square.
    const squares = {
      isConfigured: () => true,
      random: async (scope: 'cz' | 'world') =>
        scope === 'cz'
          ? { position: { lat: 50.0875, lng: 14.4213 }, label: 'Staroměstské náměstí, Praha' }
          : { position: { lat: 51.508, lng: -0.1281 }, label: 'Trafalgar Square, London' },
    };
    new App(
      root,
      { mapillary: new FakeProvider('mapillary'), mapy: new FakeProvider('mapy') },
      squares,
    ).start();
    return;
  }
  new App(root).start();
}

void boot();
