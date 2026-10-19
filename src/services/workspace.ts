import type { Workspace, WorkspaceRepository } from '../domain/types';
import { seedWorkspace } from '../data/fixtures';

const STORAGE_KEY = 'shadeflow:workspace:v3';
const fresh = (): Workspace => structuredClone(seedWorkspace);

class MockWorkspaceRepository implements WorkspaceRepository {
  async load() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return fresh();
    try {
      const data: unknown = JSON.parse(stored);
      if (
        typeof data === 'object' &&
        data !== null &&
        'schemaVersion' in data &&
        data.schemaVersion === 1 &&
        'leads' in data &&
        Array.isArray(data.leads) &&
        'campaigns' in data &&
        Array.isArray(data.campaigns) &&
        'conversations' in data &&
        Array.isArray(data.conversations) &&
        'tasks' in data &&
        Array.isArray(data.tasks) &&
        'preferences' in data
      )
        return data as Workspace;
    } catch {
      /* 损坏的演示缓存回退到种子数据。 */
    }
    return fresh();
  }
  async save(data: Workspace) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
  async reset() {
    const data = fresh();
    await this.save(data);
    return data;
  }
}

// 后续业务后端实现 GET/PUT /api/v1/workspace 后，可直接替换此适配器。
export class HttpWorkspaceRepository implements WorkspaceRepository {
  constructor(private baseUrl = '/api/v1') {}
  async load(): Promise<Workspace> {
    const response = await fetch(`${this.baseUrl}/workspace`);
    if (!response.ok) throw new Error('业务数据加载失败');
    return response.json();
  }
  async save(data: Workspace) {
    const response = await fetch(`${this.baseUrl}/workspace`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error('业务数据保存失败');
  }
  async reset(): Promise<Workspace> {
    throw new Error('生产环境不支持重置演示数据');
  }
}
export const workspaceRepository: WorkspaceRepository = new MockWorkspaceRepository();

export function exportCsv(rows: Record<string, string | number>[], filename: string) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cell = (value: string | number) => {
    const raw = String(value);
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const content =
    '\uFEFF' +
    [
      keys.map(cell).join(','),
      ...rows.map((row) => keys.map((key) => cell(row[key])).join(',')),
    ].join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
