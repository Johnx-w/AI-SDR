import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../server/app.mjs';
import { locationOptions, validateTarget } from '../server/search-target.mjs';

const target = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
};
test('国家与州联动，接口不再提供城市筛选选项', () => {
  const florida = locationOptions('United States', 'Florida');
  assert.equal(florida.regions.length, 51);
  assert.equal('cities' in florida, false);
  const nsw = locationOptions('Australia', 'New South Wales');
  assert.equal(nsw.regions.length, 8);
  assert.equal('cities' in nsw, false);
  assert.throws(() => locationOptions('Australia', 'Florida'), /该国家/);
  assert.equal('city' in validateTarget({ ...target, city: 'Sydney' }), false);
});
test('搜索参数允许全州、全国；旧城市参数不再限制范围', () => {
  for (const changes of [
    { city: '' },
    { city: '', region: '' },
    { city: undefined, region: undefined },
  ]) {
    const result = validateInput({
      ...target,
      ...changes,
      search_query: 'outdoor zip screens installers USA',
    });
    assert.equal('city' in result, false);
  }
  assert.equal(validateTarget({ ...target, region: '' }).region, '');
  assert.throws(() => validateTarget({ ...target, product: '' }), /product/);
  assert.equal('city' in validateTarget({ ...target, city: 5 }), false);
});
