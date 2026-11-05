import { AssessmentStore } from './assessment-store.mjs';
import {
  assertAssessmentIdentity,
  formatAssessmentEvidence,
  ASSESSMENT_RULE_VERSION,
} from './customer-assessment.mjs';

const publicEntry = (entry) =>
  entry && entry.snapshot.ruleVersion === ASSESSMENT_RULE_VERSION
    ? {
        ...entry.snapshot,
        evidenceReason: formatAssessmentEvidence(entry.snapshot),
        recordId: entry.recordId,
        savedAt: entry.savedAt || entry.updatedAt || entry.createdAt,
      }
    : null;

// The current evaluation belongs to the local customer dossier. Feishu only
// stores the customer's current rating; evaluation persistence has no T12 I/O.
export class AssessmentService {
  constructor({ env, store } = {}) {
    this.scope = String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID);
    this.store =
      store ||
      new AssessmentStore(
        env.ASSESSMENT_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        this.scope,
      );
  }
  summary(assessmentId) {
    return publicEntry(this.store.get(assessmentId));
  }
  latest(recordId) {
    return publicEntry(this.store.latest(recordId));
  }
  save(snapshot, customer) {
    assertAssessmentIdentity(snapshot, customer);
    if (snapshot.ruleVersion !== ASSESSMENT_RULE_VERSION)
      throw Object.assign(new Error('仅保存当前规则版本的评估，请先核对旧操作'), { status: 409 });
    return publicEntry(this.store.saveCurrent(snapshot, customer.record_id));
  }
  close() {
    this.store.close();
  }
}
