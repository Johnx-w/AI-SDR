import { validReplyFileIds } from './reply-files.mjs';
import { listSequences, sequenceDetail } from './outreach-sequences.mjs';
import { verifyGrounding } from './mail-reception.mjs';
import { requiresProductOrCommercialReview } from './mail-knowledge.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';
import { composeMailDraft, signedMailDraft, generateMailDraft } from './mail-assisted-draft.mjs';
import { addInternalNote, threadWorkflow, updateThreadWorkflow } from './mail-thread-workflow.mjs';
import { sequencePolicy, saveSequencePolicy } from './outreach-sequence-policy.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

function replySettings(value) {
  if (
    !value ||
    !['manual', 'auto', 'review'].includes(value.replyMode) ||
    typeof value.autoBusinessReplies !== 'boolean' ||
    typeof value.draftPersona !== 'string' ||
    value.draftPersona.length > 2000 ||
    !validReplyFileIds(value.knowledgeProductIds)
  )
    throw fail(400, '回复设置无效');
  return {
    replyMode: value.replyMode,
    autoBusinessReplies: value.replyMode === 'auto' && value.autoBusinessReplies,
    draftPersona: value.draftPersona,
    knowledgeProductIds: value.knowledgeProductIds,
  };
}

export async function handleOutreach({
  request,
  url,
  service,
  readJson,
  idempotencyKey,
  localMailInspection,
  draftModel,
}) {
  const path = url.pathname.slice('/api/v1/outreach'.length),
    method = request.method;
  if (path === '/sequence-policy' && method === 'GET') return sequencePolicy(service.db);
  if (path === '/sequence-policy' && method === 'PUT')
    return saveSequencePolicy(service, await readJson(request));
  if (path === '/sequences' && method === 'GET') return listSequences(service.db, url.searchParams);
  const sequence = path.match(/^\/sequences\/([\w-]+)$/);
  if (sequence && method === 'GET')
    return sequenceDetail(service.db, sequence[1], url.searchParams);
  const tagRoute = path.match(/^\/mailbox-tags(?:\/([\w-]+)(\/merge)?)?$/);
  if (tagRoute) {
    const [, id, merge] = tagRoute;
    if (!id && method === 'GET') return service.tags.list();
    const input = method === 'DELETE' ? {} : await readJson(request);
    return service.transaction(() => {
      if (id === 'assign' && !merge && method === 'POST') service.tags.assign(input || {});
      else if (!id && method === 'POST') service.tags.save(input?.name);
      else if (id && merge && method === 'POST' && typeof input?.targetId === 'string')
        service.tags.remove(id, input.targetId);
      else if (id && !merge && method === 'PATCH') service.tags.save(input?.name, id);
      else if (id && !merge && method === 'DELETE') service.tags.remove(id);
      else throw fail(400, '无效的邮箱标签操作');
      return service.tags.list();
    });
  }
  if (path === '/reply-history' && method === 'GET')
    return service.conversations.replyHistory(Object.fromEntries(url.searchParams));
  if (path === '/state' && method === 'GET') return service.state(url.searchParams);
  const delivery = path.match(/^\/deliveries\/([\w-]+)$/);
  if (delivery && method === 'GET') return service.deliveryRecord(delivery[1]);
  const deliveryAction = path.match(/^\/deliveries\/([\w-]+)\/(reconcile|resolve)$/);
  if (deliveryAction && method === 'POST') {
    const [, id, action] = deliveryAction;
    const result =
      action === 'reconcile'
        ? await service.reconcileDelivery(id)
        : await service.resolveDelivery(id, await readJson(request));
    const { candidate, ...publicResult } = result;
    return publicResult;
  }
  if (path === '/conversations' && method === 'GET')
    return service.conversations.list({
      mailboxId: url.searchParams.get('mailboxId') || 'all',
      customerId: url.searchParams.get('customerId') || '',
      q: url.searchParams.get('q') || '',
      unread: url.searchParams.get('unread') === '1',
      inboundOnly: url.searchParams.get('inboundOnly') === '1',
      hasReply: url.searchParams.get('hasReply') === '1',
      folder: url.searchParams.get('folder') || '',
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
    });
  if (path === '/conversations/sync' && method === 'POST') {
    const body = await readJson(request);
    if (body.mailboxId !== undefined && typeof body.mailboxId !== 'string')
      throw fail(400, '请选择有效邮箱');
    return service.conversations.sync({ mailboxId: body.mailboxId || 'all' });
  }
  if (path === '/reception' && method === 'GET')
    return service.reception.list(Object.fromEntries(url.searchParams));
  const conversation = path.match(
    /^\/conversations\/([\w-]+)(?:\/(read|draft|reply|ownership|regenerate|generate-draft|workflow|notes))?$/,
  );
  if (conversation) {
    const [, id, action] = conversation;
    if (!action && method === 'GET') {
      const detail = service.conversations.detail(id);
      const externalIds = new Set(detail.messages.map((m) => m.messageId).filter(Boolean));
      const mailIds = new Set(detail.messages.map((m) => m.id));
      const graph = service.businessState();
      const records = (graph.messages || []).filter(
        (m) =>
          m.customerId === detail.conversation.customerId &&
          m.account?.toLowerCase() === detail.conversation.account.toLowerCase() &&
          (mailIds.has(m.mailboxMessageId) || externalIds.has(m.externalId)),
      );
      const recordIds = new Set(records.map((m) => m.id));
      const extras = service.replies.detailExtras(id);
      extras.replyContext = { ...extras.replyContext, draftModel: draftModel?.name || null };
      if (localMailInspection && extras.replyContext.canReply)
        extras.replyContext = {
          ...extras.replyContext,
          canSend: false,
          reason: '本地验收可保存草稿，发送已关闭。',
        };
      return {
        ...detail,
        ...extras,
        workflow: threadWorkflow(service.db, id, service.now()),
        reception: service.reception.detail(detail.conversation),
        demands: (graph.demands || []).filter(
          (d) =>
            recordIds.has(d.sourceMessageId) ||
            (d.evidence || []).some((e) => recordIds.has(e.messageId)),
        ),
        demandNotices: records.flatMap((m) =>
          [m.demandReviewReason, m.demandAnalysisError].filter(Boolean),
        ),
      };
    }
    if (
      (action === 'workflow' && method === 'PATCH') ||
      (action === 'notes' && method === 'POST')
    ) {
      const input = await readJson(request);
      return service.transaction(() => {
        service.conversations.detail(id);
        return action === 'workflow'
          ? updateThreadWorkflow(service.db, id, input, service.now())
          : addInternalNote(service.db, id, input, service.now());
      });
    }
    if (action === 'read' && method === 'POST')
      return service.conversations.markRead(id, (await readJson(request)).unread);
    if (action === 'draft' && method === 'GET') return { draft: service.replies.draft(id) };
    if (action === 'generate-draft' && method === 'POST')
      return generateMailDraft(service, id, await readJson(request), draftModel);
    if (action === 'draft' && method === 'PUT')
      return { draft: service.replies.saveDraft(id, await readJson(request)) };
    if (action === 'draft' && method === 'DELETE') {
      service.reception.discardDraft(id, await readJson(request));
      return { draft: null };
    }
    if (action === 'ownership' && method === 'POST')
      return service.reception.ownership(id, (await readJson(request)).action);
    if (action === 'regenerate' && method === 'POST') {
      const { sourceId, revision } = await readJson(request);
      if (typeof sourceId !== 'string' || service.reception.row(sourceId)?.thread_id !== id)
        throw fail(409, '来信或会话已变化');
      if (revision !== (service.replies.draft(id)?.revision || 0))
        throw fail(409, '草稿已被修改，请重新打开会话');
      await service.reception.prepare(sourceId, { regenerate: true });
      return service.replies.detailExtras(id);
    }
    if (action === 'reply' && method === 'POST') {
      const input = await readJson(request);
      if (
        service.replies.draft(id)?.provenance &&
        !service.replies.operations(id).some((op) => op.idempotencyKey === input.idempotencyKey)
      )
        await service.reception.verifyInbox(
          service.mailboxes.get(service.conversations.detail(id).conversation.mailboxId),
        );
      return service.replies.reply(id, input);
    }
    throw fail(405, '不支持的邮件会话操作');
  }
  if (path === '/mailboxes' && method === 'POST')
    return service.mailboxes.save(await readJson(request), () => service.salesProducts());
  if (path === '/mailboxes/import' && method === 'POST') {
    const body = await readJson(request);
    return { mailboxes: await service.mailboxes.import(body.items, () => service.salesProducts()) };
  }
  const mailbox = path.match(
    /^\/mailboxes\/([\w-]+)(?:\/(verify|preview|note|writing|reply-settings))?$/,
  );
  if (mailbox) {
    const [, id, action] = mailbox;
    if (!action && method === 'GET') return service.mailboxes.get(id, { withBusinessNote: true });
    if (action === 'note' && method === 'PATCH')
      return service.mailboxes.saveNote(id, await readJson(request));
    if (action === 'writing' && method === 'PATCH') {
      const body = await readJson(request);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(
          (key) => !['draftPersona', 'knowledgeProductIds', 'businessNote'].includes(key),
        )
      )
        throw fail(400, '请选择此邮箱的起草身份或回复资料');
      service.mailboxes.get(id);
      return service.mailboxes.save({ ...body, id });
    }
    if (action === 'reply-settings' && method === 'PATCH') {
      const settings = replySettings(await readJson(request));
      service.mailboxes.get(id);
      return service.mailboxes.save({ ...settings, id });
    }
    if (action === 'verify' && method === 'POST') {
      const mailbox = await service.mailboxes.verify(id);
      if (url.searchParams.get('check') === 'both') {
        const { folderCoverage } = await service.mailboxes.readMailbox(id, { checkOnly: true });
        if (!folderCoverage?.inbox || !folderCoverage?.sent)
          throw fail(409, 'SMTP 已连接，请在阿里邮箱核对 IMAP 收件箱及已发送文件夹');
      }
      return mailbox;
    }
    if (action === 'preview' && method === 'POST') {
      const { question, subject = '', settings } = await readJson(request);
      if (typeof question !== 'string' || !question.trim() || question.length > 4000)
        throw fail(400, '请输入 1 至 4000 字的问题');
      if (settings !== undefined) {
        if (typeof subject !== 'string' || subject.length > 500) throw fail(400, '邮件主题过长');
        const box = { ...service.mailboxes.get(id), ...replySettings(settings) };
        const answer = service.answerQuestion(box, question, service.now(), {
          subject,
          forDraft: true,
        });
        const signature = renderMailboxSignature(box);
        const businessCorrespondence =
          box.autoBusinessReplies &&
          !answer.parameterQuery &&
          !answer.sources?.length &&
          !requiresProductOrCommercialReview(subject + ' ' + question, box);
        const basis = {
          box,
          mail: { subject },
          question,
          history: [],
          sources: answer.draftSources || answer.sources || [],
          answer,
          businessCorrespondence,
        };
        const result = await composeMailDraft(service, basis, draftModel);
        const automatic =
          box.replyMode === 'auto' &&
          !box.paused &&
          !!signature.text &&
          !result.needsManager &&
          !result.attachments?.length &&
          (answer.automatic || businessCorrespondence) &&
          result.sources.every((s) => answer.sources.includes(s)) &&
          (await verifyGrounding(draftModel, basis, result));
        const decision =
          box.replyMode === 'manual' ? '业务员手动回复' : automatic ? '预计自动回复' : '需人工审核';
        const reason = result.needsManager
          ? '资料未覆盖全部问题，需与上级确认。'
          : automatic
            ? '实际发送仍需核对原信、收件人及会话状态。'
            : box.paused
              ? '邮箱已暂停。'
              : box.replyMode === 'review'
                ? '此邮箱设置为逐封审核。'
                : box.replyMode === 'manual'
                  ? '此邮箱由业务员接待。'
                  : answer.reason;
        return {
          decision,
          reason,
          body: signedMailDraft(result.body, signature).bodyText,
          sources: result.sources,
          ...(result.attachments?.length ? { attachments: result.attachments } : {}),
        };
      }
      return service.answerQuestion(service.mailboxes.get(id), question, service.now());
    }
    if (!action && method === 'PUT') {
      const body = await readJson(request);
      return service.mailboxes.save({ ...body, id }, () => service.salesProducts());
    }
  }
  if (path === '/campaigns' && method === 'POST')
    return service.saveCampaign(await readJson(request));
  const campaign = path.match(/^\/campaigns\/([\w-]+)(?:\/(start|pause|cancel|follow-ups))?$/);
  if (campaign) {
    const [, id, action] = campaign;
    if (!action && method === 'GET') {
      const detail = service.detail(id);
      if (url.searchParams.get('summary') !== '1') return detail;
      return {
        ...detail,
        deliveries: detail.deliveries.map(({ bodyHtml, candidate, ...item }) => item),
      };
    }
    if (action === 'follow-ups' && method === 'POST')
      return service.followUps.control(id, (await readJson(request)).action);
    if (service.campaign(id).acquisitionSource && ['PUT', 'POST'].includes(method))
      throw fail(409, '请在获客任务中管理自动首发');
    if (!action && method === 'PUT') return service.saveCampaign(await readJson(request), id);
    if (method === 'POST') {
      const body = await readJson(request);
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
  if (path === '/suppress' && method === 'POST') return service.suppress(await readJson(request));
  const receipt = path.match(/^\/internal-test\/([\w-]+)\/received$/);
  if (receipt && method === 'POST') {
    const body = await readJson(request);
    if (body.confirmed !== true) throw fail(400, '请确认已在收件邮箱核对该测试邮件');
    return service.confirmInternalReceipt(receipt[1]);
  }
  throw fail(404, '触达接口不存在');
}
