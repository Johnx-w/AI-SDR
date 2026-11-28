import { defaultTemplate, normalizeTemplate } from '../src/domain/sequence-email.mjs';
import { mailboxAccountKey } from './mail-conversations.mjs';
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

export function initializeSequencePolicy({ db, mailboxes }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_sequence_policies(revision INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outreach_mailbox_sequence_policies(revision INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_frozen_sequence_snapshot
      ON outreach_sequence_policies(data) WHERE revision < 0;
  `);
  if (readSequencePolicy(db)) {
    initializeBaseDays(db);
    return;
  }
  const current = db
    .prepare('SELECT revision,data FROM outreach_sequence_policies ORDER BY revision DESC LIMIT 1')
    .get();
  db.prepare('INSERT OR IGNORE INTO outreach_sequence_policies VALUES(1,?)').run(
    JSON.stringify(defaults),
  );
  const provisional = db
    .prepare(
      "SELECT revision,data FROM outreach_sequence_policies WHERE revision > 0 AND json_type(data,'$.mailboxes')='object'",
    )
    .all();
  if (provisional.length) {
    const policies = new Map();
    for (const row of provisional) {
      policies.set(row.revision, { revision: row.revision, ...JSON.parse(row.data) });
      db.prepare('INSERT INTO outreach_mailbox_sequence_policies VALUES(?,?)').run(
        row.revision,
        row.data,
      );
      db.prepare('DELETE FROM outreach_sequence_policies WHERE revision=?').run(row.revision);
    }
    const deliveries = db
      .prepare(
        `
      SELECT d.id, p.revision, json_extract(d.data,'$.mailboxId') AS mailboxId,
             json_extract(d.data,'$.from') AS email
      FROM outreach_deliveries d JOIN outreach_mailbox_sequence_policies p
        ON p.revision=json_extract(d.data,'$.sequencePolicyRevision')
    `,
      )
      .all();
    for (const first of deliveries) {
      const frozen = freezeMailbox(db, policies.get(first.revision), {
        id: first.mailboxId,
        email: first.email,
      });
      db.prepare(
        "UPDATE outreach_deliveries SET data=json_set(data,'$.sequencePolicyRevision',?) WHERE id=?",
      ).run(frozen.revision, first.id);
    }
    db.prepare('INSERT OR IGNORE INTO outreach_sequence_policies VALUES(1,?)').run(
      JSON.stringify(defaults),
    );
    initializeBaseDays(db);
    return;
  }
  const {
    revision = 0,
    name,
    steps,
    ...writing
  } = current ? { revision: current.revision, ...JSON.parse(current.data) } : defaults;
  const template = {
    ...writing,
    readyOnce: true,
    firstTemplate: writing.firstTemplate ?? defaultTemplate(true),
    steps: steps.map((s) => ({ ...s, template: s.template ?? defaultTemplate(false) })),
  };
  appendPolicy(db, revision + 1, {
    name,
    steps: steps.map(({ day }) => ({ day })),
    baseDays: steps.map(({ day }) => day),
    activeDays: steps.map(({ day }) => day),
    mailboxes: Object.fromEntries(
      mailboxes.list().map((box) => [mailboxAccountKey(box), template]),
    ),
  });
}

function initializeBaseDays(db) {
  const current = readSequencePolicy(db);
  if (current.baseDays) return;
  // For earlier builds, retain only original days present throughout the saved schedule history.
  const history = db
    .prepare(
      "SELECT json_extract(data,'$.steps') AS steps FROM outreach_mailbox_sequence_policies ORDER BY revision",
    )
    .all();
  let baseDays = JSON.parse(history[0].steps).map(({ day }) => day);
  for (const { steps } of history.slice(1)) {
    const days = new Set(JSON.parse(steps).map(({ day }) => day));
    baseDays = baseDays.filter((day) => days.has(day));
  }
  db.prepare(
    "UPDATE outreach_mailbox_sequence_policies SET data=json_set(data,'$.baseDays',json(?)) WHERE revision=?",
  ).run(JSON.stringify(baseDays), current.revision);
}

function appendPolicy(db, revision, policy) {
  db.prepare('INSERT INTO outreach_mailbox_sequence_policies VALUES(?,?)').run(
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
            'SELECT revision,data FROM outreach_mailbox_sequence_policies ORDER BY revision DESC LIMIT 1',
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
  const activeDays = activatableDays(service, policy);
  return {
    mailboxId,
    mailboxEmail: mailbox.email,
    revision: policy.revision,
    name: policy.name,
    ready: sequenceReady({ ...policy, activeDays }, mailbox),
    activeDays,
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
  if (policy.steps.length === policy.baseDays.length) return policy.baseDays;
  const participants = service
    .followUpSenders()
    .map((box) => mailboxTemplate(policy, box))
    .filter((template) => template?.readyOnce);
  return policy.steps
    .map((s) => s.day)
    .filter(
      (day) =>
        policy.baseDays.includes(day) ||
        (participants.length > 0 &&
          participants.every((t) => t.steps.some((s) => s.day === day && s.template))),
    );
}

export function currentSequencePolicy(service) {
  const policy = sequencePolicy(service.db);
  return { ...policy, activeDays: activatableDays(service, policy) };
}

// Old code reads positive revisions as settings and looks up submitted revisions by exact key.
function freezeMailbox(db, policy, mailbox) {
  const steps = (mailboxTemplate(policy, mailbox)?.steps ?? []).filter(
    (step) => policy.activeDays.includes(step.day) && step.template,
  );
  const snapshot = { name: policy.name, mailboxPolicyRevision: policy.revision, steps };
  const data = JSON.stringify(snapshot);
  const existing = db
    .prepare('SELECT revision FROM outreach_sequence_policies WHERE revision < 0 AND data=?')
    .get(data);
  const revision =
    existing?.revision ??
    db.prepare('SELECT min(0, min(revision)) - 1 AS revision FROM outreach_sequence_policies').get()
      .revision;
  if (!existing)
    db.prepare('INSERT INTO outreach_sequence_policies VALUES(?,?)').run(revision, data);
  return { revision, ...snapshot };
}

export function freezeSequencePolicy(service, mailbox) {
  const { revision, ...policy } = readSequencePolicy(service.db);
  const activeDays = activatableDays(service, policy);
  const current =
    activeDays.length === policy.activeDays.length &&
    activeDays.every((day, index) => day === policy.activeDays[index])
      ? { revision, ...policy }
      : appendPolicy(service.db, revision + 1, { ...policy, activeDays });
  return freezeMailbox(service.db, current, mailbox);
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
      baseDays: days.filter((day) => sourceDays.get(day) === day && current.baseDays.includes(day)),
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
