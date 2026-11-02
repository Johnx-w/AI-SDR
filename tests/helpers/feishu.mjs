export const feishuEnv = {
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-base',
  FEISHU_TABLE_ID: 'fixture-table',
};

export function withFeishuAuth(fetchImpl) {
  return async (url, options) =>
    new URL(url).pathname.endsWith('/auth/v3/tenant_access_token/internal')
      ? Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 3600 })
      : fetchImpl(url, options);
}
