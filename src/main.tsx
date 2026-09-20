import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './components/App/App';
import { initializeAnalyticsFromConsent } from './services/analytics/posthog';

const root = document.getElementById('root');

// Vite may place this entry module in a shared chunk used by render.html.
// The headless renderer intentionally has no interactive application root.
if (root) {
  initializeAnalyticsFromConsent();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
