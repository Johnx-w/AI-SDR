import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function pageRenderer(dist) {
  let template;
  return async (path, initial, cookies = '') => {
    template ??= Promise.all([
      import(pathToFileURL(join(dist, 'server-render', 'entry-server.js')).href),
      readFile(join(dist, 'index.html'), 'utf8').then(async (html) => {
        const link = html.match(
          /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(\/assets\/[\w.-]+\.css)"[^>]*>/,
        );
        if (!link) return { html, cold: html };
        const css = await readFile(join(dist, link[1]), 'utf8');
        return {
          html,
          cold: html.replace(
            link[0],
            () => '<style data-initial-css="' + link[1] + '">' + css + '</style>',
          ),
          cookie: 'sf_style=' + link[1].split('/').pop(),
        };
      }),
    ]);
    const [{ renderPage }, styles] = await template;
    const html =
      styles.cookie && cookies.split(';').some((value) => value.trim() === styles.cookie)
        ? styles.html
        : styles.cold;
    const data = JSON.stringify(initial).replaceAll('<', '\\u003c');
    return html.replace(
      '<div id="root"></div>',
      () =>
        '<div id="root">' +
        renderPage(path, initial) +
        '</div><script type="application/json" id="initial-page">' +
        data +
        '</script>',
    );
  };
}
