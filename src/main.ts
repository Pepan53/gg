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
    new App(root, {
      mapillary: new FakeProvider('mapillary'),
      mapy: new FakeProvider('mapy'),
    }).start();
    return;
  }
  new App(root).start();
}

void boot();
