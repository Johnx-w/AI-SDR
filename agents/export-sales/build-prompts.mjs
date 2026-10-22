import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const shared = (await readFile(path.join(root, 'shared-system.md'), 'utf8')).trim();
const profiles = JSON.parse(await readFile(path.join(root, 'category-profiles.json'), 'utf8'));
const expected = ['shutter', 'venetian', 'indoor', 'outdoor'];
if (
  !Array.isArray(profiles) ||
  profiles.length !== expected.length ||
  !expected.every((id, index) => profiles[index]?.agent_id === id)
) {
  throw new Error('品类配置必须依次包含 shutter、venetian、indoor、outdoor。');
}

const output = path.join(root, 'prompts');
await mkdir(output, { recursive: true });
for (const profile of profiles) {
  if (
    !profile.name ||
    !profile.specialist_instructions ||
    path.basename(profile.prompt_filename) !== profile.prompt_filename ||
    !profile.prompt_filename.endsWith('.md')
  ) {
    throw new Error(`品类配置不完整或输出文件名不合法：${profile.agent_id}`);
  }
  const content = [
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
  await writeFile(path.join(output, profile.prompt_filename), content, 'utf8');
  process.stdout.write(`${profile.prompt_filename}\n`);
}
