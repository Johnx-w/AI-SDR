import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCustomerProducts, formatRelatedProducts } from '../server/product-format.mjs';
import { encodeCustomerFields } from '../server/customer-fields.mjs';

test('经营产品按类分行，保留品牌系列和产品差异，只合并大小写及空白重复', () => {
  const raw = [
    'E ZIP Blinds',
    'Roller Blinds',
    'roller blinds',
    'Roller Shades',
    'Plantation Shutters',
    'Security Screen Doors',
    'Retractable Screens',
    'Curtain Fabrics',
    'Curtain Tracks',
    'Somfy Motors',
    'Ziptrak® Interior Blinds',
    'Patios',
    'Shutters（Alto Polyresin、Adagio Timber）',
  ].join('\n');
  const grouped = groupCustomerProducts(raw);
  assert.equal(
    grouped,
    [
      '户外遮阳｜E ZIP Blinds',
      '室内窗饰｜Roller Blinds、Roller Shades、Ziptrak® Interior Blinds',
      '百叶窗｜Plantation Shutters、Shutters（Alto Polyresin、Adagio Timber）',
      '纱门纱窗｜Security Screen Doors、Retractable Screens',
      '面料与配件｜Curtain Fabrics、Curtain Tracks',
      '电机与控制｜Somfy Motors',
      '其他经营产品｜Patios',
    ].join('\n'),
  );
  assert.equal(groupCustomerProducts(grouped), grouped);
  assert.equal(formatRelatedProducts(grouped), grouped, '项目读取时不能重复翻译类别和产品');
  assert.equal(groupCustomerProducts(''), '');
  assert.equal(groupCustomerProducts('Zipscreens'), '户外遮阳｜Zipscreens');
});

test('格式化仅用于原T2经营产品，其他表结构和原始输入不变', () => {
  const fields = { 企业经营产品: 'E ZIP Blinds\nRoller Blinds', 主营产品概况: '主营窗饰' };
  const definitions = [
    { field_name: '客户ID', type: 1005 },
    { field_name: '官网链接', type: 1 },
    { field_name: '企业经营产品', type: 1 },
    { field_name: '主营产品概况', type: 1 },
  ];
  assert.equal(
    encodeCustomerFields(fields, definitions).企业经营产品,
    '户外遮阳｜E ZIP Blinds\n室内窗饰｜Roller Blinds',
  );
  assert.deepEqual(
    encodeCustomerFields(
      fields,
      definitions.filter((field) => field.field_name !== '客户ID'),
    ),
    fields,
  );
  assert.equal(fields.企业经营产品, 'E ZIP Blinds\nRoller Blinds');
  assert.equal(encodeCustomerFields({ 企业经营产品: null }, definitions).企业经营产品, null);
});
