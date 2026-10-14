import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { installE2eHooks } from './testing/e2eHooks';
import App from './ui/App';
import './ui/theme.css';

// Only with ?e2e=1 in the address; otherwise nothing is exposed.
const hooks = installE2eHooks(window);

const container = document.getElementById('root');
if (!container) {
  throw new Error('Элемент #root не найден');
}
const root = createRoot(container);
const show = (node: ReactNode): void => {
  root.render(<StrictMode>{node}</StrictMode>);
};

if (hooks.probe === 'pzmr') {
  // The e2e timing probe (Task 17) lives in its own chunk, loaded only on ?e2e=1&probe=pzmr.
  void import('./testing/ProbeHarness').then(({ default: ProbeHarness }) => {
    show(<ProbeHarness />);
  });
} else {
  show(<App />);
}
