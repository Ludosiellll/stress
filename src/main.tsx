import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installE2eHooks } from './testing/e2eHooks';
import App from './ui/App';
import './ui/theme.css';

// Only with ?e2e=1 in the address; otherwise nothing is exposed.
installE2eHooks(window);

const container = document.getElementById('root');
if (!container) {
  throw new Error('Элемент #root не найден');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
