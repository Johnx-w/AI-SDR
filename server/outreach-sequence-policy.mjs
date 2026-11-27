import { normalizeTemplate } from '../src/domain/sequence-email.mjs';
import { normalizeWritingOptions } from './mail-writing-options.mjs';
const defaults = {
  name: '首封未回复跟进',
  steps: [
    {
      day: 3,
      instruction:
        '简短承接首封邮件，可以补充一条尚未提到的已核实产品事实，询问对方是否从外部采购该产品。',
    },
    {
      day: 7,
      instruction: '围绕匹配产品简短跟进，可邀请对方进一步了解相关产品。',
    },
  ],
};
const fail = (status, message) => Object.assign(new Error(message), { status });

export function initializeSequencePolicy(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS outreach_sequence_policies(revision INTEGER PRIMARY KEY, data TEXT NOT NULL)',
  );
  db.prepare('INSERT OR IGNORE INTO outreach_sequence_policies VALUES(1,?)').run(
    JSON.stringify(defaults),
  );
}

export function sequencePolicy(db, revision) {
  const row =
    revision === undefined
      ? db
          .prepare(
            'SELECT revision,data FROM outreach_sequence_policies ORDER BY revision DESC LIMIT 1',
          )
          .get()
      : db
          .prepare('SELECT revision,data FROM outreach_sequence_policies WHERE revision=?')
          .get(revision);
  if (!row) throw fail(409, '原跟进策略版本不存在');
  return {
    revision: row.revision,
    firstInstruction: '',
    firstBodyInstruction: '',
    ...JSON.parse(row.data),
  };
}

export function writingInstruction(value, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.trim().length > 1200 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  )
    throw fail(400, '写作要求最多 1200 字，跟进步骤必须填写写作要求');
  return value.trim();
}

export function saveSequencePolicy(service, input) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 1)
    throw fail(400, '请提交读取到的策略版本');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/u.test(name))
    throw fail(400, '请输入不超过 100 字的策略名称');
  if (!Array.isArray(input.steps) || input.steps.length > 12)
    throw fail(400, '一个策略最多设置 12 个跟进步骤');
  return service.transaction(() => {
    const current = sequencePolicy(service.db);
    const steps = input.steps
      .map((item) => {
        const day = item?.day;
        if (!Number.isSafeInteger(day) || day < 1 || day > 365)
          throw fail(400, '跟进日必须为首封后 1 至 365 的整数天');
        const existing = current.steps.find((step) => step.day === day);
        const writing =
          item.writing === undefined ? existing?.writing : normalizeWritingOptions(item.writing);
        const template =
          item.template === undefined
            ? existing?.template
            : normalizeTemplate(item.template, false);
        const instruction = writingInstruction(
          item.instruction,
          !!(template || writing?.angle || writing?.reply),
        );
        return { day, instruction, ...(writing && { writing }), ...(template && { template }) };
      })
      .sort((a, b) => a.day - b.day);
    if (new Set(steps.map((item) => item.day)).size !== steps.length)
      throw fail(400, '同一天只能安排一个跟进步骤');
    const firstTemplate =
      input.firstTemplate === undefined
        ? current.firstTemplate
        : normalizeTemplate(input.firstTemplate, true);
    const firstWriting =
      input.firstWriting === undefined
        ? current.firstWriting
        : normalizeWritingOptions(input.firstWriting);
    const firstInstruction =
      input.firstInstruction === undefined
        ? current.firstInstruction
        : writingInstruction(input.firstInstruction, true);
    const firstBodyInstruction =
      input.firstBodyInstruction === undefined
        ? current.firstBodyInstruction
        : writingInstruction(input.firstBodyInstruction, true);
    if (
      JSON.stringify(firstTemplate) === JSON.stringify(current.firstTemplate) &&
      JSON.stringify(firstWriting) === JSON.stringify(current.firstWriting) &&
      firstBodyInstruction === current.firstBodyInstruction &&
      firstInstruction === current.firstInstruction &&
      input.revision <= current.revision &&
      name === current.name &&
      JSON.stringify(steps) === JSON.stringify(current.steps)
    )
      return current;
    if (input.revision !== current.revision)
      throw fail(409, '其他人已更新跟进策略，请刷新后再保存');
    const revision = current.revision + 1;
    const policy = {
      name,
      firstInstruction,
      firstBodyInstruction,
      ...(firstTemplate && { firstTemplate }),
      ...(firstWriting && { firstWriting }),
      steps,
    };
    service.db
      .prepare('INSERT INTO outreach_sequence_policies VALUES(?,?)')
      .run(revision, JSON.stringify(policy));
    return { revision, ...policy };
  });
}

export function legacyFollowUpStep(step) {
  return defaults.steps[step - 1];
}
