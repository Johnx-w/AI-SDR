import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { exclusionConditionsKey } from '../server/exclusion-conditions.mjs';

const target = { country: 'United States', product: 'zip screens', audience: 'BC' };
const site = 'https://excluded.example.org/';
const stamp = (day) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;

function operation(id, scope, day, url, kind = 'exclude') {
  const research =
    kind === 'prescreen'
      ? {
          stage: 'done',
          product_match: 'not_matched',
          review_required: false,
          relevance: { relevant: false },
        }
      : kind === 'clear'
        ? {
            stage: 'done',
            product_match: 'matched',
            entity_type: 'business',
          }
        : kind === 'exclude'
          ? {
              stage: 'done',
              product_match: 'not_matched',
              entity_type: 'business',
            }
          : {};
  return {
    id,
    scope,
    state: 'completed',
    stage: 'research',
    createdAt: stamp(day),
    updatedAt: stamp(day),
    input: { input: target, item: { source_url: url } },
    checked_urls: [url],
    research_pages: [{ source_url: url, text: 'complete page' }],
    incomplete_urls: [],
    research,
    ...(kind === 'exclude' || kind === 'clear'
      ? { research_response: { status: 'completed' } }
      : {}),
    output: {
      outcome:
        kind === 'prescreen' || kind === 'failure'
          ? 'failed'
          : kind === 'clear'
            ? 'review'
            : 'rejected',
      reason: id,
      research,
    },
  };
}

function add(store, op) {
  store.db
    .prepare('INSERT INTO acquisition_operations(id,hash,data) VALUES(?,?,?)')
    .run(op.id, 'fixture', JSON.stringify(op));
}

test('历史回填越过最近100条，识别旧预筛并按时间跳过失败、停止于有效清除', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    const key = exclusionConditionsKey(target);
    add(store, operation('old-exclude', 'scope-a', 1, site));
    add(store, operation('new-failure', 'scope-a', 3, site, 'failure'));
    add(store, operation('old-clear-exclude', 'scope-a', 1, 'https://cleared.example.org/'));
    add(store, operation('new-clear', 'scope-a', 3, 'https://cleared.example.org/', 'clear'));
    add(
      store,
      operation('legacy-prescreen', 'scope-a', 2, 'https://prescreen.example.org/', 'prescreen'),
    );
    add(store, operation('foreign', 'scope-b', 3, 'https://foreign.example.org/'));
    add(store, {
      ...operation('wrapper', 'scope-a', 3, 'https://wrapper.example.org/'),
      input: { mode: 'run', input: target },
    });
    add(store, {
      ...operation('incompatible', 'scope-a', 3, 'https://invalid.example.org/'),
      input: {
        input: { country: 'invalid' },
        item: { source_url: 'https://invalid.example.org/' },
      },
    });
    for (let index = 0; index < 110; index++)
      add(
        store,
        operation(
          'filler-' + index,
          'scope-a',
          4,
          `https://filler-${index}.example.org/`,
          'failure',
        ),
      );
    assert.equal(store.exclusion(key, site)?.operation_id, 'old-exclude');
    assert.equal(
      store.exclusion(key, 'https://prescreen.example.org/')?.operation_id,
      'legacy-prescreen',
    );
    assert.equal(store.exclusion(key, 'https://cleared.example.org/'), null);
    assert.equal(store.exclusion(key, 'https://foreign.example.org/'), null);
    assert.equal(store.exclusion(key, 'https://wrapper.example.org/'), null);
  } finally {
    store.close();
  }
});

test('回填事务失败整体回滚并可重试，已有新记录不被覆盖', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    const key = exclusionConditionsKey(target);
    add(store, operation('first', 'scope-a', 1, site));
    add(store, operation('second', 'scope-a', 1, 'https://second.example.org/'));
    store.db
      .prepare(
        `INSERT INTO acquisition_exclusions
      (scope,conditions_key,domain,reason,operation_id,excluded_at,summary) VALUES(?,?,?,?,?,?,?)`,
      )
      .run('scope-a', key, 'excluded.example.org', 'newer reason', 'newer', stamp(5), '{}');
    const original = store.insertExclusion.bind(store);
    let calls = 0;
    store.insertExclusion = (...args) => {
      if (++calls === 2) throw new Error('injected failure');
      return original(...args);
    };
    assert.throws(() => store.backfillExclusions(), /injected failure/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM acquisition_migrations').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM acquisition_exclusions').get().n, 1);
    store.insertExclusion = original;
    store.backfillExclusions();
    assert.equal(store.exclusion(key, site).operation_id, 'newer');
    assert.equal(store.exclusion(key, 'https://second.example.org/').operation_id, 'second');
  } finally {
    store.close();
  }
});

test('复核清除后重启不复活历史排除，完成标记不随查询重跑', () => {
  const folder = mkdtempSync(join(tmpdir(), 'exclusion-history-'));
  const path = join(folder, 'operations.sqlite');
  try {
    const store = new AcquisitionStore(path, 'scope-a');
    const key = exclusionConditionsKey(target);
    add(store, operation('historical', 'scope-a', 1, site));
    assert.equal(store.exclusion(key, site)?.operation_id, 'historical');
    const current = operation('reviewed', 'scope-a', 2, site, 'clear');
    current.state = 'running';
    add(store, current);
    store.completeResearch(current, current.output, key, site);
    assert.equal(store.exclusion(key, site), null);
    store.close();
    const reopened = new AcquisitionStore(path, 'scope-a');
    assert.equal(reopened.exclusion(key, site), null);
    assert.equal(
      reopened.db.prepare('SELECT count(*) AS n FROM acquisition_migrations').get().n,
      1,
    );
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('未知、待核实、失败及未完成采集不作为明确历史排除', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    const key = exclusionConditionsKey(target);
    const cases = [
      [
        'unknown',
        (op) => {
          op.research.product_match = 'unknown';
        },
      ],
      [
        'review',
        (op) => {
          op.output.outcome = 'review';
        },
      ],
      [
        'failure',
        (op) => {
          op.output.outcome = 'failed';
        },
      ],
      [
        'incomplete-research',
        (op) => {
          op.research.incomplete_reason = 'model incomplete';
        },
      ],
      [
        'incomplete-pages',
        (op) => {
          op.incomplete_urls = ['https://missing.example.org/'];
        },
      ],
      [
        'incomplete-response',
        (op) => {
          op.research_response.status = 'incomplete';
        },
      ],
    ];
    for (const [name, change] of cases) {
      const url = `https://${name}.example.org/`;
      const op = operation(name, 'scope-a', 1, url);
      change(op);
      add(store, op);
    }
    for (const [name] of cases)
      assert.equal(store.exclusion(key, `https://${name}.example.org/`), null, name);
  } finally {
    store.close();
  }
});

test('较新定向研究的有效结论阻止旧排除复活，失败仍沿用旧排除', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    const key = exclusionConditionsKey(target);
    for (const [name, newer] of [
      ['clear', 'clear'],
      ['failure', 'failure'],
      ['incomplete', 'clear'],
      ['cached-clear', 'clear'],
    ]) {
      const url = `https://${name}.example.org/`;
      add(store, operation(name + '-old', 'scope-a', 1, url));
      const op = operation(name + '-targeted', 'scope-a', 2, url, newer);
      op.input.item.target_record_id = 'rec-existing';
      if (name === 'incomplete') op.research.incomplete_reason = 'research incomplete';
      if (name === 'cached-clear') {
        delete op.research_response;
        op.research_usage = { cache_hits: 1 };
      }
      add(store, op);
    }
    assert.equal(store.exclusion(key, 'https://clear.example.org/'), null);
    assert.equal(store.exclusion(key, 'https://cached-clear.example.org/'), null);
    assert.equal(store.exclusion(key, 'https://failure.example.org/')?.operation_id, 'failure-old');
    assert.equal(
      store.exclusion(key, 'https://incomplete.example.org/')?.operation_id,
      'incomplete-old',
    );
  } finally {
    store.close();
  }
});
