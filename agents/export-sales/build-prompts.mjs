import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const shared = (await readFile(path.join(root, 'shared-system.md'), 'utf8')).trim();
const outreach = (await readFile(path.join(root, 'outreach-system.md'), 'utf8')).trim();
const profiles = JSON.parse(await readFile(path.join(root, 'category-profiles.json'), 'utf8'));
const check = process.argv.includes('--check');
const expected = ['shutter', 'venetian', 'indoor', 'outdoor'];
if (
  !Array.isArray(profiles) ||
  profiles.length !== expected.length ||
  !expected.every((id, index) => profiles[index]?.agent_id === id)
) {
  throw new Error('品类配置必须依次包含 shutter、venetian、indoor、outdoor。');
}

const output = path.join(root, 'prompts');
const outreachOutput = path.join(output, 'outreach');
await mkdir(outreachOutput, { recursive: true });
const changed = [];

async function emit(target, content) {
  const normalized = `${content.replaceAll('\r\n', '\n').trim()}\n`;
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current.replaceAll('\r\n', '\n') !== normalized) changed.push(path.relative(root, target));
    return;
  }
  await writeFile(target, normalized, 'utf8');
  process.stdout.write(`${path.relative(root, target)}\n`);
}

for (const profile of profiles) {
  if (
    !profile.name ||
    !profile.specialist_instructions ||
    path.basename(profile.prompt_filename) !== profile.prompt_filename ||
    !profile.prompt_filename.endsWith('.md')
  ) {
    throw new Error(`品类配置不完整或输出文件名不合法：${profile.agent_id}`);
  }
  const conversationContent = [
    `# ${profile.name}｜中国出口 B 端外贸业务员 Agent`,
    '',
    `当前 Agent ID：\`${profile.agent_id}\`。你是中国出口供货卖方的品类业务员，海外 B 端客户是采购我方产品的买方。`,
    '',
    shared.replace('"agent_id": "当前 Agent ID"', `"agent_id": "${profile.agent_id}"`),
    '',
    '## 当前品类的专业任务',
    '',
    profile.specialist_instructions.trim(),
    '',
  ].join('\n');
  const outreachContent = [
    `# ${profile.name}｜主动开发邮件 Agent`,
    '',
    `当前 Agent ID：\`${profile.agent_id}\`。你是中国出口供货卖方的品类业务员；本提示词只用于经过业务系统授权的主动开发邮件，不处理客户来信。`,
    '',
    profile.specialist_instructions.trim(),
    '',
    outreach.replace('"agent_id": "当前 Agent ID"', `"agent_id": "${profile.agent_id}"`),
    '',
  ].join('\n');
  await emit(path.join(output, profile.prompt_filename), conversationContent);
  await emit(path.join(outreachOutput, profile.prompt_filename), outreachContent);
}

if (changed.length) {
  process.stderr.write(
    `以下 Agent 提示词未重新生成：\n${changed.map((file) => `- ${file}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else if (check) {
  process.stdout.write('Agent 提示词已与维护源同步。\n');
}
