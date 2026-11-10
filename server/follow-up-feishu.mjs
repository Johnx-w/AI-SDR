import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CustomerBusinessFeishu, safeWrite, sameFields } from './customer-business-feishu.mjs';
import { fieldText } from './feishu.mjs';
import { domainKey } from './website-identity.mjs';

export const followUpChannels = {
  email: '邮件触达',
  whatsapp: 'WhatsApp触达',
  form: '网站留言',
  phone: '人工电话外呼',
};
const statuses = { pending: '待执行', completed: '已完成', skipped: '跳过', cancelled: '终止' };
const text = fieldText;
export function followUpEnvironment(env) {
  return {
    ...env,
    FEISHU_APP_ID: env.FOLLOWUP_FEISHU_APP_ID,
    FEISHU_APP_SECRET: env.FOLLOWUP_FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: env.FOLLOWUP_FEISHU_APP_TOKEN,
    FEISHU_TABLE_ID: env.FOLLOWUP_FEISHU_TABLE_ID,
    FEISHU_TASKS_TABLE_ID: env.FOLLOWUP_FEISHU_TABLE_ID,
    FEISHU_DEMANDS_TABLE_ID: '',
    FEISHU_MESSAGES_TABLE_ID: '',
    FEISHU_PRODUCTS_TABLE_ID: '',
  };
}
const links = (value) =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : v.record_id)).filter(Boolean)
    : [];

// This destination writes T4 only; its related tables are read-only references.
export class FollowUpFeishu extends CustomerBusinessFeishu {
  async definition() {
    const table = this.env.FEISHU_TASKS_TABLE_ID;
    const fields = await this.client.fields(table);
    const required = {
      任务ID: 1005,
      客户: 18,
      关联沟通: 18,
      渠道: 3,
      计划执行时间: 5,
      任务状态: 3,
      使用模板: 18,
      任务说明: 1,
      负责业务员: 18,
    };
    for (const [name, type] of Object.entries(required))
      assert(
        fields.some((f) => f.field_name === name && f.type === type),
        'T4 字段缺失或类型不符：' + name,
      );
    for (const [name, values] of [
      ['渠道', ['邮件', 'WhatsApp', '网页留言', '电话']],
      ['任务状态', Object.values(statuses)],
    ])
      assert(
        values.every((value) =>
          fields
            .find((f) => f.field_name === name)
            .property?.options?.some((o) => o.name === value),
        ),
        'T4 选项不完整：' + name,
      );
    const related = Object.fromEntries(
      ['客户', '关联沟通', '使用模板', '负责业务员'].map((name) => [
        name,
        fields.find((f) => f.field_name === name).property?.table_id,
      ]),
    );
    assert(
      Object.values(related).every((id) => id && id !== table),
      'T4 关联表配置无效',
    );
    return { table, fields, related };
  }
  async info() {
    try {
      const { table } = await this.definition();
      return { configured: true, status: 'ready', tables: { tasks: table }, tasksOnly: true };
    } catch (error) {
      return { configured: false, status: 'pending', error: error.message, tasksOnly: true };
    }
  }
  async references(definition) {
    const { related } = definition || (await this.definition());
    const [owners, templates] = await Promise.all([
      this.client.records(related.负责业务员),
      this.client.records(related.使用模板),
    ]);
    return {
      owners: owners
        .filter((r) => text(r.fields.业务员名称))
        .map((r) => ({
          id: r.record_id,
          name: text(r.fields.业务员名称),
          accountType: text(r.fields.账号类型),
          account: text(r.fields['账号地址/号码']),
          status: text(r.fields.账号状态),
        })),
      templates: templates
        .filter((r) => text(r.fields.模板名称))
        .map((r) => ({
          id: r.record_id,
          name: text(r.fields.模板名称),
          type: text(r.fields.模板类型),
          status: text(r.fields.启用状态),
          scenario: text(r.fields.沟通场景),
          body: text(r.fields.模板主体文案),
        })),
    };
  }
  async syncCurrent(workspace, _products, customers) {
    try {
      const definition = await this.definition();
      const { table, fields, related } = definition;
      if (!workspace.tasks.length)
        return { status: 'synced', counts: { tasks: 0 }, tasksOnly: true };
      const [references, remoteTasks, remoteCustomers, remoteMessages] = await Promise.all([
        this.references(definition),
        this.client.records(table),
        this.client.records(related.客户),
        this.client.records(related.关联沟通),
      ]);
      const mappedKey = (id) => `${this.scope}:task-record:${table}:${id}`;
      for (const task of workspace.tasks) {
        assert(
          Object.hasOwn(statuses, task.status) && Object.hasOwn(followUpChannels, task.channel),
          '任务状态或类型无效',
        );
        const localCustomer = customers.find((r) => r.id === task.customerId);
        const domain = domainKey(localCustomer?.website || '');
        const matches = remoteCustomers.filter(
          (r) =>
            r.record_id === task.customerId ||
            (domain && domainKey(text(r.fields.官网链接 || r.fields.企业官网)) === domain),
        );
        assert(matches.length <= 1, '新 T2 存在重复企业，无法确定任务关联');
        const customerIds = matches.map((r) => r.record_id);
        const messageIds = [
          ...new Set(
            [...(task.messageIds || []), task.basisMessageId, task.resultMessageId].filter(Boolean),
          ),
        ];
        const communicationIds = [];
        for (const id of messageIds) {
          const message = workspace.messages.find((r) => r.id === id);
          assert(
            message && message.customerId === task.customerId && message.channel === task.channel,
            '任务关联沟通不存在或不属于当前客户及渠道',
          );
          const channel = {
            email: '邮件',
            whatsapp: 'WhatsApp',
            form: '网站留言',
            phone: '人工电话',
          }[message.channel];
          const candidates = remoteMessages.filter(
            (r) =>
              customerIds.some((id) => links(r.fields.关联客户).includes(id)) &&
              text(r.fields.触达渠道) === channel &&
              Number(r.fields['发送/沟通时间']) === Date.parse(message.occurredAt) &&
              text(
                r.fields[
                  message.direction === 'outbound'
                    ? '发送内容摘要'
                    : message.direction === 'note'
                      ? '业务员纪要'
                      : '收到回复内容'
                ],
              ) === message.body,
          );
          assert(candidates.length <= 1, '新 T3 存在重复沟通记录，请先核对');
          if (candidates[0]) communicationIds.push(candidates[0].record_id);
        }
        for (const [key, options] of [
          ['ownerIds', references.owners],
          ['templateIds', references.templates],
        ])
          assert(
            (task[key] || []).every((id) => options.some((r) => r.id === id)),
            '关联业务员或模板已不存在，请编辑任务重新选择',
          );
        const expected = {
          客户: customerIds,
          关联沟通: [...new Set(communicationIds)],
          渠道: { email: '邮件', whatsapp: 'WhatsApp', form: '网页留言', phone: '电话' }[
            task.channel
          ],
          计划执行时间: Date.parse(task.dueAt),
          任务状态: statuses[task.status],
          使用模板: task.templateIds || [],
          任务说明: task.notes || null,
          负责业务员: task.ownerIds || [],
        };
        assert(Number.isFinite(expected.计划执行时间), '任务计划时间无效');
        const mapping = this.journal.findLast(
          (r) => r.key === mappedKey(task.id) && r.state === 'mapped',
        );
        let remote = mapping && remoteTasks.find((r) => r.record_id === mapping.recordId);
        assert(!mapping || remote, '已同步的 T4 任务不存在，请核对同步记录');
        assert(!mapping || mapping.version <= task.version, 'T4 任务已有更高同步版本');
        const saveMapping = async () => {
          this.journal.push({
            key: mappedKey(task.id),
            state: 'mapped',
            recordId: remote.record_id,
            version: task.version,
            displayId: text(remote.fields?.任务ID),
          });
          await this.persistJournal();
        };
        const key = mappedKey(task.id) + (remote ? ':' + task.version : ':create');
        const digest = createHash('sha256').update(key).digest('hex');
        const token = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await safeWrite(
          {
            journal: this.journal,
            checkpoint: () => this.persistJournal(),
            retry: Boolean(remote),
          },
          key,
          async () => {
            remote = await this.client.write(
              remote ? 'update' : 'insert',
              expected,
              remote?.record_id,
              token,
              table,
            );
            await saveMapping();
          },
          async () => {
            if (!remote) return false;
            const readback = await this.client.record(remote.record_id, table);
            if (!sameFields(readback, expected, fields)) return false;
            remote = readback;
            if (
              mapping?.version !== task.version ||
              mapping?.displayId !== text(remote.fields.任务ID)
            )
              await saveMapping();
            return true;
          },
        );
      }
      return { status: 'synced', counts: { tasks: workspace.tasks.length }, tasksOnly: true };
    } catch (error) {
      return { status: 'pending', error: error.message, tasksOnly: true };
    }
  }
}
