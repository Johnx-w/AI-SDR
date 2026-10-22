import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WorkspaceProvider } from './app/WorkspaceProvider';
import { App } from './app/App';
import './styles.css';
import './workbench.css';
import './green-theme.css';
import './acquisition.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
