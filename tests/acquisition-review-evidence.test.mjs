import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisitionProvider } from '../server/acquisition-provider.mjs';

test('review evidence 归组同来源同引文的事实并合并产品值', () => {
  const native = {
    store: new Map([
      [
        'operation-1',
        {
          research: {
            facts: [
              {
                field: 'products',
                value: 'curtains',
                quote: 'We offer curtains and blinds.',
                source_url: 'https://buyer.example/products',
              },
              {
                field: 'products',
                value: 'roller blinds',
                quote: 'We offer curtains and blinds.',
                source_url: 'https://buyer.example/products',
              },
              {
                field: 'products',
                value: 'curtains',
                quote: 'We offer curtains and blinds.',
                source_url: 'https://buyer.example/products',
              },
              {
                field: 'products',
                value: 'roman blinds',
                quote: 'We offer curtains and blinds.',
                source_url: 'https://buyer.example/catalogue',
              },
            ],
          },
          checked_urls: [],
        },
      ],
    ]),
  };
  const provider = createAcquisitionProvider({ env: {}, nativeImpl: native });

  assert.deepEqual(provider.reviewEvidence('operation-1').facts, [
    {
      field: 'products',
      value: 'curtains、roller blinds',
      quote: 'We offer curtains and blinds.',
      source_url: 'https://buyer.example/products',
    },
    {
      field: 'products',
      value: 'roman blinds',
      quote: 'We offer curtains and blinds.',
      source_url: 'https://buyer.example/catalogue',
    },
  ]);
});
