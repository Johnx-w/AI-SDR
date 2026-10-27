import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createModuleLoader } from './helpers/modules.mjs';

function logoHarness() {
  const slots = [];
  let cursor = 0;
  const pending = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const load = createModuleLoader((name) => (name === 'react' ? react : undefined));
  const { CompanyLogo } = load(new URL('../src/components/CompanyLogo.tsx', import.meta.url));
  return {
    render(props = { id: 'customer-1', name: 'Shade Flow' }) {
      cursor = 0;
      const tree = CompanyLogo(props);
      while (pending.length) pending.shift()();
      return tree;
    },
    dispose() {
      slots.forEach((slot) => slot?.cleanup?.());
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const imageOf = (tree) => [tree.props.children].flat().find((child) => child?.type === 'img');

test('候选图已返回但图片尚未完成时持续显示企业缩写，加载成功后才展示图片', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ candidates: [{ url: '/api/v1/branding/assets/logo', kind: 'logo' }] }),
  );
  const logo = logoHarness();
  try {
    assert.match(renderToStaticMarkup(logo.render()), /SF/);
    await settle();
    const pending = logo.render();
    assert.match(renderToStaticMarkup(pending), /SF/, '远程图片等待期间不能把缩写替换成空白');
    const image = imageOf(pending);
    image.props.onLoad({ currentTarget: { naturalWidth: 300, naturalHeight: 100 } });
    assert.doesNotMatch(renderToStaticMarkup(logo.render()), />SF</);
  } finally {
    logo.dispose();
  }
});

test('16像素网站图标以原尺寸显示，图片读取失败后恢复清晰缩写', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ candidates: [{ url: '/api/v1/branding/assets/icon', kind: 'website_icon' }] }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    const image = imageOf(logo.render());
    assert.equal(typeof image.props.onLoad, 'function', '图标需要按实际图片像素限制尺寸');
    image.props.onLoad({ currentTarget: { naturalWidth: 16, naturalHeight: 16 } });
    const loaded = imageOf(logo.render());
    assert.equal(loaded.props.style.width, 16);
    assert.equal(loaded.props.style.height, 16);
    loaded.props.onError();
    assert.match(renderToStaticMarkup(logo.render()), /SF/);
  } finally {
    logo.dispose();
  }
});

test('视口外图片也立即开始读取，慢图限时切换下一个候选并始终保留缩写', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      candidates: [
        { url: '/api/v1/branding/assets/slow', kind: 'logo' },
        { url: '/api/v1/branding/assets/fallback', kind: 'website_icon' },
      ],
    }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    let pending = logo.render();
    assert.equal(imageOf(pending).props.loading, 'eager');
    assert.match(renderToStaticMarkup(pending), /SF/);
    t.mock.timers.tick(4500);
    pending = logo.render();
    assert.equal(imageOf(pending).props.src, '/api/v1/branding/assets/fallback');
    assert.match(renderToStaticMarkup(pending), /SF/);
    t.mock.timers.tick(4500);
    assert.equal(imageOf(logo.render()), undefined);
    assert.match(renderToStaticMarkup(logo.render()), /SF/);
  } finally {
    logo.dispose();
  }
});

test('同源缓存后的白色Logo仍依据品牌元数据使用深色底', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      candidates: [{ url: '/api/v1/branding/assets/abc123', kind: 'logo', background: 'dark' }],
    }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    const image = imageOf(logo.render());
    image.props.onLoad({ currentTarget: { naturalWidth: 240, naturalHeight: 80 } });
    assert.match(logo.render().props.className, /brand-on-dark/);
  } finally {
    logo.dispose();
  }
});

test('名称不含white的透明白色Logo通过像素检测获得深色底', async (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const pixels = new Uint8ClampedArray(128 * 128 * 4);
  for (let i = 100; i < 400; i++) pixels.set([255, 255, 255, 255], i * 4);
  const drawn = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          drawImage: (...args) => drawn.push(args),
          getImageData: () => ({ data: pixels }),
        }),
      }),
    },
  });
  t.after(() =>
    documentDescriptor
      ? Object.defineProperty(globalThis, 'document', documentDescriptor)
      : delete globalThis.document,
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ candidates: [{ url: '/api/v1/branding/assets/vtrack', kind: 'logo' }] }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    const image = imageOf(logo.render());
    image.props.onLoad({ currentTarget: { naturalWidth: 2000, naturalHeight: 2000 } });
    assert.match(logo.render().props.className, /brand-on-dark/);
    assert.ok(drawn.length >= 1);
  } finally {
    logo.dispose();
  }
});

test('大viewBox中的小Logo裁去透明边缘后保持高清，二次onLoad不会反复裁切', async (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const pixels = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 55; y < 70; y++)
    for (let x = 45; x < 80; x++) pixels.set([255, 255, 255, 255], (y * 128 + x) * 4);
  const canvases = [];
  const draws = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = {
          getContext: () => ({
            drawImage: (...args) => draws.push(args),
            getImageData: () => ({ data: pixels }),
          }),
          toDataURL: () => 'data:image/png;base64,Y3JvcHBlZA==',
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  });
  t.after(() =>
    documentDescriptor
      ? Object.defineProperty(globalThis, 'document', documentDescriptor)
      : delete globalThis.document,
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ candidates: [{ url: '/api/v1/branding/assets/vtrack-crop', kind: 'logo' }] }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    imageOf(logo.render()).props.onLoad({
      currentTarget: { naturalWidth: 2000, naturalHeight: 2000 },
    });
    const loaded = logo.render();
    assert.equal(imageOf(loaded).props.src, 'data:image/png;base64,Y3JvcHBlZA==');
    assert.match(loaded.props.className, /brand-on-dark/);
    assert.equal(canvases[1].width, 512);
    assert.ok(canvases[1].height < 512);
    assert.ok(draws[1][3] < 2000 / 2, '仅重画内容区域，不能把整个2000px画布再次缩小');
    imageOf(loaded).props.onLoad({ currentTarget: { naturalWidth: 512, naturalHeight: 250 } });
    assert.equal(canvases.length, 2);
  } finally {
    logo.dispose();
  }
});

test('跨域或不支持的图片禁止读取像素时仍正常展示Logo', async (t) => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData() {
            throw new Error('SecurityError: tainted canvas');
          },
        }),
      }),
    },
  });
  t.after(() =>
    documentDescriptor
      ? Object.defineProperty(globalThis, 'document', documentDescriptor)
      : delete globalThis.document,
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ candidates: [{ url: '/api/v1/branding/assets/tainted', kind: 'logo' }] }),
  );
  const logo = logoHarness();
  try {
    logo.render();
    await settle();
    imageOf(logo.render()).props.onLoad({
      currentTarget: { naturalWidth: 240, naturalHeight: 80 },
    });
    const loaded = logo.render();
    assert.doesNotMatch(renderToStaticMarkup(loaded), />SF</);
    assert.doesNotMatch(loaded.props.className, /brand-on-dark/);
    assert.equal(imageOf(loaded).props.src, '/api/v1/branding/assets/tainted');
  } finally {
    logo.dispose();
  }
});

test('切换客户后旧客户迟到的Logo响应不能覆盖当前客户', async (t) => {
  let oldResponse;
  t.mock.method(globalThis, 'fetch', (url) =>
    url.includes('customer-1')
      ? new Promise((resolve) => {
          oldResponse = resolve;
        })
      : Promise.resolve(
          Response.json({ candidates: [{ url: '/api/v1/branding/assets/current', kind: 'logo' }] }),
        ),
  );
  const logo = logoHarness();
  const current = { id: 'customer-2', name: 'Other Buyer', website: 'https://other.com/' };
  try {
    logo.render();
    logo.render(current);
    await settle();
    assert.equal(imageOf(logo.render(current)).props.src, '/api/v1/branding/assets/current');
    oldResponse(
      Response.json({ candidates: [{ url: '/api/v1/branding/assets/old', kind: 'logo' }] }),
    );
    await settle();
    assert.equal(imageOf(logo.render(current)).props.src, '/api/v1/branding/assets/current');
  } finally {
    logo.dispose();
  }
});
