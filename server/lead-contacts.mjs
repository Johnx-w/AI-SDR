import { fieldText, mapFeishuRecord } from './feishu.mjs';
import { normalizePhone } from './phone-format.mjs';

const names = { contact: '联系人', email: '邮箱', phone: '电话' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const snapshot = (lead) => Object.fromEntries(Object.keys(names).map((key) => [key, lead[key]]));
export function applyContactCorrections(lead, corrections = {}) {
  return {
    ...lead,
    ...Object.fromEntries(
      Object.keys(names)
        .filter((key) => typeof corrections[key]?.value === 'string')
        .map((key) => [key, corrections[key].value]),
    ),
  };
}

export function validateContactEdit(input) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !['contacts', 'expected'].includes(key)) ||
    !object(input.contacts) ||
    !Object.keys(input.contacts).length ||
    Object.keys(input.contacts).some((key) => !Object.hasOwn(names, key)) ||
    !object(input.expected) ||
    Object.keys(input.expected).length !== 3 ||
    Object.keys(names).some((key) => typeof input.expected[key] !== 'string')
  )
    throw fail(400, '请提交联系方式及修改前的记录');
  for (const [key, value] of Object.entries(input.contacts)) {
    if (
      typeof value !== 'string' ||
      value.length > (key === 'contact' ? 200 : 5000) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    )
      throw fail(400, names[key] + '格式不正确或内容过长');
  }
  return input;
}

export async function updateLeadContacts({ feishu, store, id, input }) {
  validateContactEdit(input);
  let record;
  try {
    record = await feishu.record(id);
  } catch (error) {
    if (error.remoteCode === 1254043) throw fail(404, '客户不存在，请刷新客户库');
    throw error;
  }
  const current = applyContactCorrections(mapFeishuRecord(record), store.contactCorrections(id));
  if (Object.keys(names).some((key) => current[key] !== input.expected[key]))
    throw fail(409, '联系方式已被更新，请刷新客户库后重新修改');

  let profile;
  try {
    profile = JSON.parse(fieldText(record.fields['画像JSON']) || '{}');
    if (!object(profile)) throw new Error();
  } catch {
    throw fail(409, '客户画像格式异常，请先核对原始字段');
  }
  const contacts = {};
  for (const [key, text] of Object.entries(input.contacts)) {
    const lines = text
      .split(key === 'email' ? /[\r\n,;，；、]+/ : /\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (key === 'contact') contacts[key] = text.trim();
    if (key === 'email') {
      if (
        lines.some(
          (line) =>
            !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
              line,
            ),
        )
      )
        throw fail(400, '邮箱格式不正确，请每行填写一个邮箱');
      contacts[key] = [...new Map(lines.map((line) => [line.toLowerCase(), line])).values()].join(
        '\n',
      );
    }
    if (key === 'phone') {
      const parsed = lines.map((line) => normalizePhone(line, current.market));
      if (parsed.some((phone) => !phone))
        throw fail(400, '电话格式不正确，请每行填写一个号码，必要时加国际区号');
      contacts[key] = [
        ...new Map(parsed.map((phone) => [phone.normalized, phone.value])).values(),
      ].join('\n');
    }
  }
  const at = new Date().toISOString();
  const manual = { ...profile.manual_contacts, ...store.contactCorrections(id) };
  for (const [key, value] of Object.entries(contacts))
    manual[key] = { value, previous_value: current[key], updated_at: at };
  const definitions = new Map(
    (await feishu.fields()).map((field) => [field.field_name, field.type]),
  );
  const fields = {};
  for (const [key, value] of Object.entries(contacts)) {
    if (key === 'contact' && !definitions.has(names[key])) continue;
    if (definitions.get(names[key]) !== 1)
      throw fail(409, '客户表缺少联系方式文本字段，请先核对表结构');
    fields[names[key]] = value;
  }
  if (definitions.get('画像JSON') === 1)
    fields['画像JSON'] = JSON.stringify({ ...profile, manual_contacts: manual });

  // Read back even after an uncertain write; do not repeat a remote mutation.
  let writeError;
  try {
    if (Object.keys(fields).length) await feishu.write('update', fields, id);
  } catch (error) {
    writeError = error;
  }
  let saved;
  try {
    saved = await feishu.record(id);
  } catch {
    throw fail(502, '尚未确认保存结果，请刷新客户库核对后再修改');
  }
  if (Object.entries(fields).some(([name, value]) => fieldText(saved.fields[name]) !== value))
    throw writeError || fail(502, '保存结果与提交内容不一致，请刷新客户库核对');
  store.saveContactCorrections(id, manual);
  const lead = applyContactCorrections(mapFeishuRecord(saved), manual);
  return { lead, contacts: snapshot(lead) };
}
