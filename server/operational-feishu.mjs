import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CustomerBusinessFeishu, safeWrite, sameFields } from './customer-business-feishu.mjs';
import { fieldText } from './feishu.mjs';
import { referenceRows } from '../scripts/fill-follow-up-references.mjs';

const templates = readFileSync(
  new URL('../docs/new-feishu-bitable-filling-spec.md', import.meta.url),
  'utf8',
);
const day = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const countries = {
  Australia: '澳大利亚',
  Canada: '加拿大',
  'United Kingdom': '英国',
  'United States': '美国',
};
const reasons = {
  target_reached: '达到新增目标',
  stopped: '任务已停止',
  research_limit: '达到研究上限',
};
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const webSource = (job) => ['web', 'tavily_web', undefined].includes(job.input.acquisition_channel);
const formalTables = {
  T7: 'tblH2qBpcxE1LDvW',
  T8: 'tblWM32XBo8P3R2L',
  T10: 'tblCYtK6CJtPnyhA',
  T11: 'tblkpGzQTkz5Daxa',
};

export function acquisitionJobs(db, scope) {
  return db
    .prepare("SELECT data FROM jobs WHERE json_extract(data,'$.scope')=? ORDER BY rowid")
    .all(scope)
    .map(({ data }) => JSON.parse(data));
}

export function keywordRow(job) {
  const searches = Array.isArray(job.searchStats) ? job.searchStats : [];
  const completed = searches.filter((item) => item.status === 'completed');
  if (!completed.length) return null;
  assert(completed.every((item) => typeof item.query === 'string' && item.query.trim()));
  const queries = [...new Set(completed.map((item) => item.query.trim()))];
  const incomplete = [
    ...new Set(
      searches
        .filter((item) => item.status !== 'completed' && !queries.includes(item.query))
        .map((item) => item.query)
        .filter(Boolean),
    ),
  ];
  const country = countries[job.input.country] || job.input.country;
  return {
    '国家/地区': [country, job.input.region].filter(Boolean).join(' / '),
    关键词列表: queries.join('\n'),
    适用采集渠道: webSource(job) ? '通用网页搜索' : null,
    是否启用: '关闭',
    备注: [
      `原系统任务编号：${job.id}`,
      `执行开始：${job.createdAt}`,
      `搜索尝试：${searches.length}；完成：${completed.length}；失败：${searches.filter((item) => item.status === 'failed').length}；中断：${searches.filter((item) => item.status === 'interrupted').length}`,
      ...(incomplete.length ? [`尚未完成搜索词：${incomplete.join('；')}`] : []),
    ].join('\n'),
  };
}

export function taskRow(job, keywordIds = []) {
  assert(job.id && job.input && Number.isFinite(Date.parse(job.createdAt)), '获客执行记录不完整');
  const country = countries[job.input.country] || job.input.country;
  const product = job.input.product === 'window coverings' ? '窗饰' : job.input.product || '产品';
  const target = job.target ?? job.input.target_count;
  assert(Number.isSafeInteger(target) && target > 0, '获客新增目标无效');
  assert(!job.completedAt || Number.isFinite(Date.parse(job.completedAt)), '获客结束时间无效');
  const status =
    job.status === 'completed' && job.reason === 'target_reached'
      ? '已完成'
      : job.status === 'partial' && job.reason === 'stopped'
        ? '已停止'
        : job.status === 'partial' && job.reason === 'research_limit'
          ? '研究上限结束'
          : ['running', 'stopping'].includes(job.status)
            ? '执行中'
            : null;
  const log = [
    `原系统任务编号：${job.id}`,
    `执行方式：${job.scheduleId ? '定时' : '手动'}${job.scheduleId ? `；计划编号：${job.scheduleId}` : ''}`,
    `执行渠道：${job.input.acquisition_channel || 'web'}（网页搜索＋官网研究）`,
    `真实状态：${job.status}；完成原因：${reasons[job.reason] || job.reason || '无'}`,
    `实际研究：${count(job.researched) ?? '未记录'}；搜索次数：${count(job.searches) ?? '未记录'}；新增目标：${target}`,
    `不匹配：${count(job.rejected) ?? '未记录'}；待核实：${count(job.pending) ?? '未记录'}；失败：${count(job.failed) ?? '未记录'}`,
  ].join('\n');
  return {
    任务名称: `${country}${product}获客 · 目标${target}家`,
    任务类型: webSource(job) ? '网页搜索与官网研究' : null,
    采集渠道: webSource(job) ? '通用网页搜索' : null,
    '目标国家/区域': [country, job.input.region].filter(Boolean).join(' / '),
    关联关键词组: keywordIds,
    片区: job.input.region || null,
    任务开始时间: Date.parse(job.createdAt),
    任务结束时间: job.completedAt ? Date.parse(job.completedAt) : null,
    新增有效客户数: count(job.inserted),
    重复客户数量: count(job.skipped),
    实际研究候选数: count(job.researched),
    任务状态: status,
    任务日志: log,
  };
}

const required = {
  T7: {
    任务ID: 1005,
    任务名称: 1,
    任务类型: 3,
    采集渠道: 3,
    '目标国家/区域': 1,
    关联关键词组: 18,
    片区: 1,
    任务开始时间: 5,
    任务结束时间: 5,
    新增有效客户数: 2,
    重复客户数量: 2,
    实际研究候选数: 2,
    任务状态: 3,
    任务日志: 1,
  },
  T8: {
    账号ID: 1005,
    业务员名称: 1,
    账号类型: 3,
    '账号地址/号码': 1,
    每日发送额度: 2,
    今日已发送数量: 2,
    账号状态: 3,
    备注: 1,
  },
  T10: {
    模板ID: 1005,
    模板名称: 1,
    沟通场景: 3,
    适用客户等级: 3,
    沟通目标: 1,
    模板主体文案: 1,
    提示词附加业务指引: 1,
    启用状态: 3,
    模板类型: 3,
    适用开发阶段: 3,
    备注: 1,
  },
  T11: {
    关键词组ID: 1005,
    '国家/地区': 1,
    关键词列表: 1,
    适用采集渠道: 3,
    是否启用: 3,
    备注: 1,
  },
};

function assertFields(fields, kind) {
  for (const [name, type] of Object.entries(required[kind]))
    assert(
      fields.some((field) => field.field_name === name && field.type === type),
      `${kind} 字段缺失或类型不符：${name}`,
    );
}

const tokenFor = (key) => {
  const digest = createHash('sha256').update(key).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

export async function syncOperationalFeishu({
  env,
  jobs,
  mailboxes,
  deliveries,
  client,
  journalPath,
} = {}) {
  const mirror = new CustomerBusinessFeishu({
    env,
    client,
    journalPath:
      journalPath ||
      join(
        dirname(env.CONNECTIONS_PATH || '.data/api-connections.json'),
        'operational-feishu-journal.json',
      ),
  });
  assert(mirror.configured, '飞书连接未配置');
  const tables = await mirror.client.tables();
  assert(
    tables.some((table) => table.table_id === env.FEISHU_TABLE_ID && table.name.startsWith('T2｜')),
    '飞书客户主表与目标 Base 不一致',
  );
  const rows = referenceRows(mailboxes, deliveries, templates, day());
  const sources = {
    T7: jobs.map((job) => ({ key: job.id, fields: taskRow(job) })),
    T8: rows.owners.map((fields) => ({ key: fields['账号地址/号码'].toLowerCase(), fields })),
    T10: rows.templates.map((fields) => ({ key: fields.模板名称, fields })),
    T11: jobs.flatMap((job) => {
      const fields = keywordRow(job);
      return fields ? [{ key: job.id, fields }] : [];
    }),
  };
  const plans = await Promise.all(
    ['T11', 'T7', 'T8', 'T10'].map(async (kind) => {
      const matches = tables.filter((table) => table.name.startsWith(`${kind}｜`));
      assert(matches.length === 1, `未找到唯一的 ${kind} 数据表`);
      const table = matches[0];
      if (env.FEISHU_APP_TOKEN === 'Xat4bgUFuaL6tBsXqRccnYaknEf')
        assert.equal(table.table_id, formalTables[kind], `${kind} 不是正式 Base 原表`);
      const [fields, records] = await Promise.all([
        mirror.client.fields(table.table_id),
        mirror.client.records(table.table_id),
      ]);
      assertFields(fields, kind);
      if (kind === 'T7') {
        const relation = fields.find((field) => field.field_name === '关联关键词组');
        assert(
          relation.property?.table_id ===
            tables.find((item) => item.name.startsWith('T11｜'))?.table_id &&
            relation.property?.multiple === true,
          'T7 关联关键词组目标不符',
        );
      }
      for (const source of sources[kind])
        for (const [name, value] of Object.entries(source.fields)) {
          const field = fields.find((item) => item.field_name === name);
          assert(field, `${kind} 缺少字段：${name}`);
          if (field.type === 3 && value !== null)
            assert(
              field.property?.options?.some((option) => option.name === value),
              `${kind} 缺少选项：${value}`,
            );
        }
      return { kind, table, fields, records };
    }),
  );
  const counts = {};
  const keywordIds = new Map();
  for (const { kind, table, fields, records } of plans) {
    if (kind === 'T7')
      for (const source of sources.T7)
        source.fields.关联关键词组 = keywordIds.has(source.key) ? [keywordIds.get(source.key)] : [];
    const keyOf = (record) =>
      kind === 'T11'
        ? fieldText(record.fields.备注).match(/^原系统任务编号：([\w-]+)/)?.[1]
        : kind === 'T7'
          ? fieldText(record.fields.任务日志).match(/^原系统任务编号：([\w-]+)/)?.[1]
          : kind === 'T8'
            ? fieldText(record.fields['账号地址/号码']).toLowerCase()
            : fieldText(record.fields.模板名称);
    const index = new Map();
    for (const record of records) {
      const key = keyOf(record);
      if (!key) continue;
      assert(!index.has(key), `${kind} 存在重复业务记录：${key}`);
      index.set(key, record);
    }
    for (const source of sources[kind]) {
      let record = index.get(source.key);
      const key = `${mirror.scope}:${kind}:${table.table_id}:${source.key}`;
      await safeWrite(
        {
          journal: mirror.journal,
          checkpoint: () => mirror.persistJournal(),
          retry: Boolean(record),
        },
        key,
        async () => {
          record = await mirror.client.write(
            record ? 'update' : 'insert',
            source.fields,
            record?.record_id,
            tokenFor(key),
            table.table_id,
          );
        },
        async () => {
          const matches = record
            ? [await mirror.client.record(record.record_id, table.table_id)]
            : (await mirror.client.records(table.table_id)).filter(
                (item) => keyOf(item) === source.key,
              );
          assert(matches.length <= 1, `${kind} 存在重复业务记录：${source.key}`);
          if (!matches[0] || !sameFields(matches[0], source.fields, fields)) return false;
          record = matches[0];
          index.set(source.key, record);
          return true;
        },
      );
      if (kind === 'T11') keywordIds.set(source.key, record.record_id);
    }
    counts[kind] = sources[kind].length;
  }
  return counts;
}
