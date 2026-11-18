import type { LeadDetail, LeadList } from '../services/leadLibrary';
import type { OutreachDeliveryPage, OutreachState } from '../outreachApi';

export interface InitialPage {
  list?: { key: string; data: LeadList };
  detail?: LeadDetail;
  outreach?: OutreachState & { viewKey: string };
  records?: { key: string; data: OutreachDeliveryPage };
}
