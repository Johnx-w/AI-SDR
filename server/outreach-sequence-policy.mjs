import { defaultTemplate, normalizeTemplate } from '../src/domain/sequence-email.mjs';
import { mailboxAccountKey } from './mail-conversations.mjs';
import { normalizeWritingOptions } from './mail-writing-options.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';
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

export function initializeSequencePolicy({ db, mailboxes }) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS outreach_sequence_policies(revision INTEGER PRIMARY KEY, data TEXT NOT NULL)',
  );
  const current = readSequencePolicy(db);
  if (current?.mailboxes) return;
  const { revision = 0, name, steps, ...writing } = current || defaults;
  const template = {
    ...writing,
    readyOnce: true,
    firstTemplate: writing.firstTemplate ?? defaultTemplate(true),
    steps: steps.map((s) => ({ ...s, template: s.template ?? defaultTemplate(false) })),
  };
  appendPolicy(db, revision + 1, {
    name,
    steps: steps.map(({ day }) => ({ day })),
    activeDays: steps.map(({ day }) => day),
    mailboxes: Object.fromEntries(
      mailboxes.list().map((box) => [mailboxAccountKey(box), template]),
    ),
  });
}

function appendPolicy(db, revision, policy) {
  db.prepare('INSERT INTO outreach_sequence_policies VALUES(?,?)').run(
    revision,
    JSON.stringify(policy),
  );
  return { revision, ...policy };
}

function readSequencePolicy(db, revision) {
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
  return row && { revision: row.revision, ...JSON.parse(row.data) };
}

export function sequencePolicy(db, revision) {
  const policy = readSequencePolicy(db, revision);
  if (!policy) throw fail(409, '原跟进策略版本不存在');
  return policy;
}

export function mailboxTemplate(policy, mailbox) {
  return policy.mailboxes?.[mailboxAccountKey(mailbox)];
}

export function sequenceReady(policy, mailbox) {
  const template = mailboxTemplate(policy, mailbox);
  return template?.readyOnce === true && hasMailForDays(template, policy.activeDays);
}

function hasMailForDays(template, days) {
  return Boolean(
    template.firstTemplate &&
      days.every((day) => template.steps.some((s) => s.day === day && s.template)),
  );
}

export function mailboxSequencePolicy(service, mailboxId, policy = sequencePolicy(service.db)) {
  const mailbox = typeof mailboxId === 'string' && service.mailboxes.get(mailboxId);
  if (!mailbox) throw fail(400, '请选择发件邮箱');
  const template = mailboxTemplate(policy, mailbox);
  return {
    mailboxId,
    mailboxEmail: mailbox.email,
    revision: policy.revision,
    name: policy.name,
    ready: sequenceReady(policy, mailbox),
    activeDays: policy.activeDays,
    firstInstruction: template?.firstInstruction ?? '',
    firstBodyInstruction: template?.firstBodyInstruction ?? '',
    firstTemplate: template?.firstTemplate,
    firstWriting: template?.firstWriting,
    steps: policy.steps.map(({ day }) => {
      const step = template?.steps.find((s) => s.day === day);
      return step ?? { day, instruction: '' };
    }),
  };
}

export function checkSequenceMailbox(email, expectedEmail) {
  if (expectedEmail !== undefined && expectedEmail !== email)
    throw fail(409, '发件地址已变更，请刷新后重新选择邮箱');
}

function activatableDays(service, policy) {
  if (policy.steps.length === policy.activeDays.length) return policy.activeDays;
  const products = service.salesProducts().filter((p) => p.status === 'approved');
  const participants = service.mailboxes
    .list()
    .filter(
      (box) =>
        box.configured &&
        !box.paused &&
        box.smtpStatus === 'connected' &&
        box.displayName?.trim() &&
        box.signature?.trim() &&
        sequenceReady(policy, box) &&
        products.some((p) => box.productIds?.includes(p.id) && siteAllowsProduct(p, box)),
    )
    .map((box) => mailboxTemplate(policy, box));
  if (!participants.length) return policy.activeDays;
  return policy.steps
    .map((s) => s.day)
    .filter(
      (day) =>
        policy.activeDays.includes(day) ||
        participants.every((t) => t.steps.some((s) => s.day === day && s.template)),
    );
}

// A submission pins an immutable revision even if eligible mailboxes changed since the editor saved.
export function freezeSequencePolicy(service) {
  const { revision, ...policy } = readSequencePolicy(service.db);
  const activeDays = activatableDays(service, policy);
  if (activeDays.length === policy.activeDays.length) return { revision, ...policy };
  return appendPolicy(service.db, revision + 1, { ...policy, activeDays });
}

export function writingInstruction(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length > 1200 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  )
    throw fail(400, '写作要求最多 1200 字，请核对格式');
  return value.trim();
}

function templateChange(input, previous, first) {
  if (input === undefined) return previous;
  if (input === null) return undefined;
  return normalizeTemplate(input, first) ?? defaultTemplate(first);
}

export function saveSequencePolicy(service, input, mailboxId = input?.mailboxId) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 1)
    throw fail(400, '请提交读取到的策略版本');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/u.test(name))
    throw fail(400, '请输入不超过 100 字的策略名称');
  if (!Array.isArray(input.steps) || input.steps.length > 12)
    throw fail(400, '一个策略最多设置 12 个跟进步骤');
  return service.transaction(() => {
    const current = readSequencePolicy(service.db);
    const previous = mailboxSequencePolicy(service, mailboxId, current);
    checkSequenceMailbox(previous.mailboxEmail, input.expectedMailboxEmail);
    const key = mailboxAccountKey({ id: mailboxId, email: previous.mailboxEmail });
    const sourceDays = new Map();
    const steps = input.steps
      .map((item) => {
        const day = item?.day;
        if (!Number.isSafeInteger(day) || day < 1 || day > 365)
          throw fail(400, '跟进日必须为首封后 1 至 365 的整数天');
        const sourceDay = item.previousDay ?? day;
        if (!Number.isSafeInteger(sourceDay) || sourceDay < 1 || sourceDay > 365)
          throw fail(400, '原跟进日无效');
        sourceDays.set(day, sourceDay);
        const existing = previous.steps.find((step) => step.day === sourceDay);
        const writing =
          item.writing === undefined ? existing?.writing : normalizeWritingOptions(item.writing);
        const template = templateChange(item.template, existing?.template, false);
        const instruction = writingInstruction(
          item.instruction === undefined ? (existing?.instruction ?? '') : item.instruction,
        );
        return { day, instruction, ...(writing && { writing }), ...(template && { template }) };
      })
      .sort((a, b) => a.day - b.day);
    if (new Set(steps.map((item) => item.day)).size !== steps.length)
      throw fail(400, '同一天只能安排一个跟进步骤');
    const firstTemplate = templateChange(input.firstTemplate, previous.firstTemplate, true);
    const firstWriting =
      input.firstWriting === undefined
        ? previous.firstWriting
        : normalizeWritingOptions(input.firstWriting);
    const firstInstruction =
      input.firstInstruction === undefined
        ? previous.firstInstruction
        : writingInstruction(input.firstInstruction);
    const firstBodyInstruction =
      input.firstBodyInstruction === undefined
        ? previous.firstBodyInstruction
        : writingInstruction(input.firstBodyInstruction);
    if (
      JSON.stringify(firstTemplate) === JSON.stringify(previous.firstTemplate) &&
      JSON.stringify(firstWriting) === JSON.stringify(previous.firstWriting) &&
      firstBodyInstruction === previous.firstBodyInstruction &&
      firstInstruction === previous.firstInstruction &&
      input.revision <= current.revision &&
      ![...sourceDays].some(
        ([day, from]) => day !== from && current.steps.some((s) => s.day === from),
      ) &&
      name === current.name &&
      JSON.stringify(steps) === JSON.stringify(previous.steps)
    )
      return previous;
    if (input.revision !== current.revision)
      throw fail(409, '其他人已更新跟进策略，请刷新后再保存');
    if (
      new Set(sourceDays.values()).size !== steps.length ||
      [...sourceDays].some(
        ([day, from]) => day !== from && !current.steps.some((s) => s.day === from),
      )
    )
      throw fail(400, '原跟进日无效或被重复使用');
    const days = steps.map(({ day }) => day);
    const mailboxes = Object.fromEntries(
      Object.entries(current.mailboxes).map(([id, value]) => [
        id,
        {
          ...value,
          steps: days.flatMap((day) => {
            const step = value.steps.find((s) => s.day === sourceDays.get(day));
            return step ? [{ ...step, day }] : [];
          }),
        },
      ]),
    );
    mailboxes[key] = {
      readyOnce: current.mailboxes[key]?.readyOnce ?? false,
      firstInstruction,
      firstBodyInstruction,
      firstTemplate,
      firstWriting,
      steps,
    };
    for (const template of Object.values(mailboxes))
      template.readyOnce ||= hasMailForDays(template, days);
    const policy = {
      name,
      steps: days.map((day) => ({ day })),
      activeDays: days.filter(
        (day) => sourceDays.get(day) === day && current.activeDays.includes(day),
      ),
      mailboxes,
    };
    policy.activeDays = activatableDays(service, policy);
    return mailboxSequencePolicy(
      service,
      mailboxId,
      appendPolicy(service.db, current.revision + 1, policy),
    );
  });
}

export function legacyFollowUpStep(step) {
  return defaults.steps[step - 1];
}
