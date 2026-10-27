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
export const marketLabel = (value: string) => marketNames[value] || value;

// shortcut: 按现有产品名称关键词归类，出现未识别的新别名时补充规则。
const productGroups: [string, RegExp][] = [
  ['Samples & Displays（样本与展示）', /\bsamples?\b|\bdisplays?\b|样本|展示/i],
  [
    'Materials & Parts（面料与配件）',
    /\bfabrics?\b|\bcomponents?\b|\bparts?\b|\bmotors?\b|面料|配件|零件|电机/i,
  ],
  ['Screens（防风帘与纱网）', /\bzip[\s-]?(?:track|screen)?|\bscreens?\b|防风帘|拉链帘|纱网|纱窗/i],
  ['Shutters（百叶窗与卷闸）', /\bshutters?\b|百叶窗|卷闸/i],
  [
    'Outdoor Shading（户外遮阳）',
    /\bawnings?\b|\bpergolas?\b|\bshade\s+sails?\b|遮阳篷|天幕|廊架|凉亭|遮阳帆/i,
  ],
  ['Curtains（布艺帘）', /\bcurtains?\b|\bdrap(?:es?|ery)\b|布艺帘|布帘|纱帘|梦幻帘/i],
  [
    'Blinds & Shades（百叶帘与卷帘）',
    /\bblinds?\b|\bshades?\b|百叶帘|卷帘|蜂巢帘|罗马帘|斑马帘|竹木帘|百褶帘|香格里拉帘/i,
  ],
];

export function leadProductCategories(value: string): string[] {
  if (!value.trim()) return ['Unverified（待核实）'];
  return [
    ...new Set(
      value
        .split(/[\n;；]/)
        .filter((item) => item.trim())
        .map(
          (item) =>
            productGroups.find(([, pattern]) => pattern.test(item))?.[0] || 'Other（其他窗饰）',
        ),
    ),
  ];
}
