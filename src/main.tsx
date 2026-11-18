import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WorkspaceProvider } from './app/WorkspaceProvider';
import { App } from './app/App';
import type { InitialPage } from './app/initialPage';
import { leadLibrary } from './services/leadLibrary';
import './theme.css';
import './styles.css';
import './workbench.css';
import './workspace.css';
import './acquisition.css';

const root = document.getElementById('root')!;
const seed = document.getElementById('initial-page');
const initial: InitialPage | undefined = seed ? JSON.parse(seed.textContent!) : undefined;
seed?.remove();
if (initial?.list) leadLibrary.prime(initial.list.key, initial.list.data, initial.detail);
const app = (
  <React.StrictMode>
    <BrowserRouter>
      <WorkspaceProvider>
        <App initial={initial} />
      </WorkspaceProvider>
    </BrowserRouter>
  </React.StrictMode>
);
if (initial) ReactDOM.hydrateRoot(root, app);
else ReactDOM.createRoot(root).render(app);
const embedded = document.querySelector<HTMLStyleElement>('style[data-initial-css]');
if (embedded?.dataset.initialCss) {
  const path = embedded.dataset.initialCss,
    link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = path;
  link.fetchPriority = 'low';
  link.onload = () => {
    embedded.remove();
    document.cookie =
      'sf_style=' +
      path.split('/').pop() +
      '; Path=/; SameSite=Strict; Max-Age=31536000' +
      (location.protocol === 'https:' ? '; Secure' : '');
  };
  document.head.append(link);
}
