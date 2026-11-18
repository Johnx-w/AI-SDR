import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { App } from './app/App';
import { WorkspaceProvider } from './app/WorkspaceProvider';
import type { InitialPage } from './app/initialPage';
import { LeadLibraryClient } from './services/leadLibrary';

export function renderPage(path: string, initial: InitialPage) {
  const library = new LeadLibraryClient();
  if (initial.list) library.prime(initial.list.key, initial.list.data, initial.detail);
  return renderToString(
    <StaticRouter location={path}>
      <WorkspaceProvider>
        <App library={library} initial={initial} />
      </WorkspaceProvider>
    </StaticRouter>,
  );
}
