const fail = (status, message) => Object.assign(new Error(message), { status });

export async function handleOutreach({ request, url, service, readJson, idempotencyKey }) {
  const path = url.pathname.slice('/api/v1/outreach'.length),
    method = request.method;
  if (path === '/state' && method === 'GET') return service.state();
  if (path === '/deliveries' && method === 'GET')
    return service.listDeliveries(Object.fromEntries(url.searchParams));
  if (path === '/conversations' && method === 'GET')
    return service.conversations.list({
      mailboxId: url.searchParams.get('mailboxId') || 'all',
      q: url.searchParams.get('q') || '',
      unread: url.searchParams.get('unread') === '1',
    });
  if (path === '/conversations/sync' && method === 'POST') {
    const body = await readJson(request);
    if (body.mailboxId !== undefined && typeof body.mailboxId !== 'string')
      throw fail(400, '请选择有效邮箱');
    return service.conversations.sync({ mailboxId: body.mailboxId || 'all' });
  }
  const conversation = path.match(/^\/conversations\/([\w-]+)(?:\/(read|draft|reply))?$/);
  if (conversation) {
    const [, id, action] = conversation;
    if (!action && method === 'GET')
      return { ...service.conversations.detail(id), ...service.replies.detailExtras(id) };
    if (action === 'read' && method === 'POST')
      return service.conversations.markRead(id, (await readJson(request)).unread);
    if (action === 'draft' && method === 'GET') return { draft: service.replies.draft(id) };
    if (action === 'draft' && method === 'PUT')
      return { draft: service.replies.saveDraft(id, await readJson(request)) };
    if (action === 'draft' && method === 'DELETE') {
      service.replies.deleteDraft(id, await readJson(request));
      return { draft: null };
    }
    if (action === 'reply' && method === 'POST')
      return service.replies.reply(id, await readJson(request));
    throw fail(405, '不支持的邮件会话操作');
  }
  if (path === '/mailboxes' && method === 'POST')
    return service.mailboxes.save(await readJson(request));
  if (path === '/mailboxes/import' && method === 'POST') {
    const body = await readJson(request);
    return { mailboxes: await service.mailboxes.import(body.items) };
  }
  const mailbox = path.match(/^\/mailboxes\/([\w-]+)(?:\/(verify))?$/);
  if (mailbox) {
    const [, id, action] = mailbox;
    if (action === 'verify' && method === 'POST') return service.mailboxes.verify(id);
    if (!action && method === 'PUT') {
      const body = await readJson(request);
      return service.mailboxes.save({ ...body, id });
    }
  }
  if (path === '/campaigns' && method === 'POST')
    return service.saveCampaign(await readJson(request));
  const campaign = path.match(/^\/campaigns\/([\w-]+)(?:\/(prepare|approve|start|pause|cancel))?$/);
  if (campaign) {
    const [, id, action] = campaign;
    if (!action && method === 'GET') return service.detail(id);
    if (!action && method === 'PUT') return service.saveCampaign(await readJson(request), id);
    if (method === 'POST') {
      const body = await readJson(request);
      if (action === 'prepare') return service.prepare(id);
      if (action === 'approve') return service.approve(id, body.revision);
      if (action === 'start') return service.activate(id, body.revision);
      if (action === 'pause') return service.pause(id);
      if (action === 'cancel') return service.cancel(id, body.revision, body.confirmed);
    }
  }
  if (path === '/internal-test' && method === 'POST')
    return service.internalTest({
      ...(await readJson(request)),
      idempotencyKey: idempotencyKey(request),
    });
  if (path === '/review' && method === 'POST')
    return service.approveReview((await readJson(request)).approved);
  if (path === '/suppress' && method === 'POST') return service.suppress(await readJson(request));
  const receipt = path.match(/^\/internal-test\/([\w-]+)\/received$/);
  if (receipt && method === 'POST') {
    const body = await readJson(request);
    if (body.confirmed !== true) throw fail(400, '请确认已在收件邮箱核对该测试邮件');
    return service.confirmInternalReceipt(receipt[1]);
  }
  throw fail(404, '触达接口不存在');
}
