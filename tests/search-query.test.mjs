import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../server/app.mjs';
import { validateTarget } from '../server/search-target.mjs';

const target = {
  country: 'United States',
  region: '',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
};
test('全国搜索兼容未填写地区的历史输入', () => {
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
