const messages = {
  MAILBOX_READ_FAILED: '邮件读取失败，请稍后重试并查看同步诊断',
  MAILBOX_READ_AUTH_FAILED: 'IMAP 认证失败，请检查邮箱账号、客户端授权码及 IMAP 服务是否开启',
  MAILBOX_READ_CONNECTION_FAILED: '无法连接 IMAP 服务，请检查网络或稍后重试',
  MAILBOX_READ_TIMEOUT: '邮件同步超时，请稍后重试',
  MAILBOX_READ_TLS_FAILED: 'IMAP 安全连接验证失败，请检查证书和系统时间',
  MAILBOX_READ_INVALID: '邮箱同步参数或同步位置无效，请检查同步诊断',
  MAILBOX_NOT_CONFIGURED: '请先配置邮箱客户端授权码',
  MAILBOX_CREDENTIAL_FAILED: '本地邮箱凭证无法解密，请重新配置客户端授权码',
  MAILBOX_IDENTITY_CHANGED: '邮箱身份已变化，请刷新后重新同步',
  MAILBOX_SYNC_INVALID: '邮件同步返回的数据无效，本次未保存，请查看同步诊断',
  MAILBOX_SYNC_SAVE_FAILED: '邮件本地保存失败，请检查本地存储后重试',
};
const authCodes = ['EAUTH', 'AUTHENTICATIONFAILED', 'AuthenticationFailed', 'AUTHORIZATIONFAILED'];
const timeoutCodes = ['ETIMEDOUT', 'ETIMEOUT', 'Timeout'];
const connectionCodes = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ConnectionClosed',
  'NoConnection',
];
const tlsCodes = [
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
];
const providerCodes = new Set([
  ...authCodes,
  ...timeoutCodes,
  ...connectionCodes,
  ...tlsCodes,
  'UNAVAILABLE',
  'SERVERBUG',
  'CLIENTBUG',
  'CONTACTADMIN',
  'NOPERM',
  'NONEXISTENT',
  'LIMIT',
  'ERR_SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_FULL',
  'SQLITE_READONLY',
  'ENOSPC',
  'EACCES',
]);
const stages = new Set(['credentials', 'connect', 'folders', 'read', 'validate', 'save']);

// Keep only known codes, never provider text, commands, addresses, credentials or message bodies.
export function mailSyncFailure(error, stage = 'read') {
  stage = stages.has(error?.diagnostic?.stage)
    ? error.diagnostic.stage
    : stages.has(stage)
      ? stage
      : 'read';
  const providerCode = [
    error?.code,
    error?.serverResponseCode,
    error?.diagnostic?.providerCode,
  ].find((value) => providerCodes.has(value));
  const responseStatus = [error?.responseStatus, error?.diagnostic?.responseStatus].find((value) =>
    ['NO', 'BAD', 'BYE'].includes(value),
  );
  let code = Object.hasOwn(messages, error?.code) ? error.code : null;
  if (!code) {
    if (error?.authenticationFailed === true || authCodes.includes(providerCode))
      code = 'MAILBOX_READ_AUTH_FAILED';
    else if (timeoutCodes.includes(providerCode)) code = 'MAILBOX_READ_TIMEOUT';
    else if (connectionCodes.includes(providerCode)) code = 'MAILBOX_READ_CONNECTION_FAILED';
    else if (tlsCodes.includes(providerCode)) code = 'MAILBOX_READ_TLS_FAILED';
    else
      code =
        stage === 'save'
          ? 'MAILBOX_SYNC_SAVE_FAILED'
          : stage === 'validate'
            ? 'MAILBOX_SYNC_INVALID'
            : 'MAILBOX_READ_FAILED';
  }
  if (['MAILBOX_NOT_CONFIGURED', 'MAILBOX_CREDENTIAL_FAILED'].includes(code)) stage = 'credentials';
  if (['MAILBOX_SYNC_INVALID', 'MAILBOX_IDENTITY_CHANGED'].includes(code)) stage = 'validate';
  return {
    message: messages[code],
    diagnostic: {
      code,
      stage,
      ...(providerCode && { providerCode }),
      ...(responseStatus && { responseStatus }),
    },
  };
}
