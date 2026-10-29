export const developmentStatuses = [
  '待开发',
  '已联系',
  '已回复',
  '跟进中',
  '已成交',
  '暂缓开发',
  '停止开发',
];

const marketNames: Record<string, string> = {
  'United States': '美国',
  Australia: '澳大利亚',
  Canada: '加拿大',
  'United Kingdom': '英国',
  Europe: '欧洲',
  'United Arab Emirates': '阿联酋',
  'New Zealand': '新西兰',
};
export const marketLabel = (value?: string | null) => {
  const market = value?.trim() || '';
  return !market || /^(unknown|未知|未记录|待核实)$/i.test(market)
    ? '待核实'
    : marketNames[market] || market;
};

export const leadProductCategoryLabels = {
  plantation: 'Plantation Shutters（透气窗）',
  venetian: 'Venetian Blinds（百叶窗）',
  outdoor: 'Outdoor Shading（户外遮阳）',
  indoor: 'Indoor Window Coverings（室内成品帘）',
  materials: 'Fabrics & Components（面料与配件）',
};

// shortcut: 按现有产品名称关键词归类，出现未识别的新别名时补充规则。
const productGroups: [string, RegExp][] = [
  [
    leadProductCategoryLabels.materials,
    /\bfabrics?\b(?!\s+(?:curtains?|drapes?|drapery)\b)|\b(?:components?|parts?|motors?|profiles?|extrusions?|hardware|samples?|displays?)\b|面料|配件|零件|电机|型材|样本|样册|展示/i,
  ],
  [
    leadProductCategoryLabels.outdoor,
    /\bzip(?:[\s-]?(?:track|screen)s?|trak)?\b|\bscreens?\b|\b(?:outdoor|exterior|external)\s+(?:(?:\w+)[\s-]+){0,3}(?:blinds?|shades?|shutters?)\b|\broller\s+shutters?\b|\bawnings?\b|\bpergolas?\b|\bshade\s+sails?\b|防风帘|拉链帘|纱网|纱窗|户外|室外|卷闸|遮阳篷|遮阳棚|窗篷|天幕|廊架|凉亭|遮阳帆/i,
  ],
  [leadProductCategoryLabels.plantation, /\bshutters?\b|透气窗|种植园百叶/i],
  [
    leadProductCategoryLabels.venetian,
    /\b(?:venetian|horizontal)\s+blinds?\b|\b(?:wood(?:en)?|faux[\s-]wood|alumin(?:um|ium)|pvc|ps)\s+blinds?\b|百叶窗|百叶帘|横百叶/i,
  ],
  [
    leadProductCategoryLabels.indoor,
    /\bblinds?\b|\bshades?\b|\bcurtains?\b|\bdrap(?:es?|ery)\b|室内成品帘|卷帘|蜂巢帘|罗马帘|斑马帘|竹木帘|百褶帘|香格里拉帘|布艺帘|布帘|纱帘|梦幻帘|垂直帘|推拉板帘|天窗帘/i,
  ],
];

export function leadProductCategories(value: string): string[] {
  return [
    ...new Set(
      value.split(/[\n;；,，、]|\s+(?:and|&|\+|\/)\s+/i).flatMap((item) => {
        const group = productGroups.find(([, pattern]) => pattern.test(item));
        return group ? [group[0]] : [];
      }),
    ),
  ];
}
